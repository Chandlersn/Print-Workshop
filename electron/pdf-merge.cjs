/**
 * PDF 合并（S1.3-b）：对象级流式拼接，**不重栅格化、不重编码**。
 *
 * 为什么不用 pdf-lib 之类的内存型合并库：照片作业 500 页 × ~15MB/页 ≈ 7.5GB，
 * 整份载入内存再 save 必然 OOM。本模块按对象位置读取、顺序写出，峰值内存
 * O(单个对象头部)——大 PDF 的 stream 载荷按 1MB 块边读边写。
 *
 * 合并语义：只拼对象与页树。每条 content stream、每个字体/图片 XObject 都按
 * 原字节拷贝（PDF 内表征与 Chromium 产出逐字节一致；S1 报告里「大图被降采样
 * Flate 重编码」是 Chromium 打印管线决定的，与本模块无关）。
 *
 * 支持范围刻意收窄到 **Chromium printToPDF 的产物形态**（探针实证，见
 * docs/S1压测基准报告.md）：经典 xref 表 + trailer + 扁平/嵌套页树 + 无对象流。
 * 遇到以下结构一律抛 UnsupportedPdfError——宁可不出片，也不产出损坏文件：
 * xref 流（/Type /XRef）、对象流（/Type /ObjStm）、加密（/Encrypt）、
 * /Prev 增量更新链、无法解析的 /Length。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/** 结构不支持（输入 PDF 超出收窄的支持范围）——调用方应原样抛给用户，不重试 */
class UnsupportedPdfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsupportedPdfError'
    this.unsupported = true
  }
}

const HEAD_MIN = 64 * 1024        // 对象头扫描窗口初始值
const HEAD_MAX = 64 * 1024 * 1024 // 单个对象头部扫描上限（stream 之前的字典部分）
const COPY_CHUNK = 1024 * 1024    // stream 载荷拷贝块大小

// ---------------------------------------------------------------------------
// 词法扫描：latin1 逐字节。PDF 对象头部（stream 之前的字典）才会走到这里，
// 体积小；stream 载荷从不扫描，只按 /Length 位置拷贝。
// ---------------------------------------------------------------------------

const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0'])
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

function isWs(c) { return WS.has(c) }

function skipWs(s, i) {
  while (i < s.length) {
    const c = s[i]
    if (isWs(c)) { i++; continue }
    if (c === '%') { // 注释到行尾
      while (i < s.length && s[i] !== '\r' && s[i] !== '\n') i++
      continue
    }
    break
  }
  return i
}

function scanName(s, i) {
  // i 指向 '/'；#xx 转义按 PDF 语义属于名字的一部分，原样拷贝即可
  i++
  while (i < s.length) {
    const c = s[i]
    if (isWs(c) || DELIM.has(c)) break
    i++
  }
  return i
}

function scanLiteralString(s, i) {
  // i 指向 '('；嵌套括号 + 反斜杠转义
  i++
  let depth = 1
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    i++
  }
  throw new Error('PDF 字符串未闭合')
}

function scanHexString(s, i) {
  // i 指向 '<'（已排除 '<<'）
  i++
  while (i < s.length && s[i] !== '>') i++
  if (i >= s.length) throw new Error('PDF 十六进制字符串未闭合')
  return i + 1
}

const NUM_START = /[-+.\d]/

function scanNumber(s, i) {
  const start = i
  if (s[i] === '+' || s[i] === '-') i++
  while (i < s.length && s[i] >= '0' && s[i] <= '9') i++
  if (s[i] === '.') { i++; while (i < s.length && s[i] >= '0' && s[i] <= '9') i++ }
  if (i === start || (!/\d/.test(s.slice(start, i)))) throw new Error(`PDF 数字形态异常: ${JSON.stringify(s.slice(start, start + 20))}`)
  return i
}

function scanKeyword(s, i) {
  const start = i
  while (i < s.length && !isWs(s[i]) && !DELIM.has(s[i])) i++
  if (i === start) throw new Error(`PDF 关键字位置异常: ${JSON.stringify(s.slice(i, i + 20))}`)
  return i
}

/**
 * 扫描一个值的终点（跳过字符串内部的假分隔符）。
 * 数字后跟「数字 R」视为间接引用整体跨越——数组 [1 0 R 2 0 R] 才不会错切。
 */
function scanValue(s, i) {
  i = skipWs(s, i)
  if (i >= s.length) throw new Error('PDF 值缺失')
  const c = s[i]
  if (c === '/') return scanName(s, i)
  if (c === '(') return scanLiteralString(s, i)
  if (c === '<') {
    if (s[i + 1] === '<') return parseDict(s, i).end
    return scanHexString(s, i)
  }
  if (c === '[') {
    i++
    for (;;) {
      i = skipWs(s, i)
      if (i >= s.length) throw new Error('PDF 数组未闭合')
      if (s[i] === ']') return i + 1
      const next = scanValue(s, i)
      if (next <= i) throw new Error('PDF 数组元素解析无进展')
      i = next
    }
  }
  if (NUM_START.test(c)) {
    i = scanNumber(s, i)
    const j = skipWs(s, i)
    if (NUM_START.test(s[j] || '')) {
      const k = scanNumber(s, j)
      const m = skipWs(s, k)
      if (s[m] === 'R' && !(s[m + 1] && !isWs(s[m + 1]) && !DELIM.has(s[m + 1]))) return m + 1
    }
    return i
  }
  if (/[a-zA-Z]/.test(c)) {
    const end = scanKeyword(s, i)
    const kw = s.slice(i, end)
    if (kw === 'stream' || kw === 'endstream') throw new Error(`PDF 值位置出现关键字 ${kw}`)
    return end
  }
  throw new Error(`PDF 值起始字符无法识别: ${JSON.stringify(s.slice(i, i + 20))}`)
}

/** 解析字典为条目表（值为字节区间，发射时再扫描，避免实现两套遍历） */
function parseDict(s, i) {
  i = skipWs(s, i)
  if (s[i] !== '<' || s[i + 1] !== '<') throw new Error(`字典应以 << 开始: ${JSON.stringify(s.slice(i, i + 20))}`)
  i += 2
  const entries = []
  for (;;) {
    i = skipWs(s, i)
    if (i >= s.length) throw new Error('PDF 字典未闭合')
    if (s[i] === '>' && s[i + 1] === '>') return { entries, end: i + 2 }
    if (s[i] !== '/') throw new Error(`字典键必须是名称: ${JSON.stringify(s.slice(i, i + 20))}`)
    const keyStart = i
    i = scanName(s, i)
    const key = s.slice(keyStart, i)
    i = skipWs(s, i)
    const vStart = i
    const vEnd = scanValue(s, i)
    if (vEnd <= vStart) throw new Error(`字典值为空: ${key}`)
    entries.push({ key, vStart, vEnd })
    i = vEnd // 推进游标——漏了这行，循环会在值中段反复找键
  }
}

function findEntry(dict, key) {
  return dict.entries.find((e) => e.key === key) || null
}

function entryText(s, dict, key) {
  const e = findEntry(dict, key)
  return e ? s.slice(e.vStart, e.vEnd).trim() : null
}

const REF_RE = /^(\d+)\s+(\d+)\s+R$/

/** 条目文本 → [num, gen]；不是间接引用返回 null */
function entryRef(s, dict, key) {
  const t = entryText(s, dict, key)
  if (!t) return null
  const m = REF_RE.exec(t)
  return m ? [Number(m[1]), Number(m[2])] : null
}

// ---------------------------------------------------------------------------
// 发射层：把扫描到的字节重写为「对象号平移后」的形态。
// 字符串/十六进制串原样拷贝（内部绝不出现需要重写的引用）；
// 间接引用 num gen R 的第一个数字经 map 平移。
// ---------------------------------------------------------------------------

/** 发射一个值；parentTarget 仅作用于对象顶层字典的 /Parent 条目 */
function emitValue(s, i, out, ctx) {
  i = skipWs(s, i)
  const c = s[i]
  if (c === '/') {
    const end = scanName(s, i)
    out.push(s.slice(i, end))
    return end
  }
  if (c === '(') {
    const end = scanLiteralString(s, i)
    out.push(s.slice(i, end))
    return end
  }
  if (c === '<') {
    if (s[i + 1] === '<') {
      // 嵌套字典断绝顶层改写语义：/Parent 与 /Length 只属于对象顶层
      return emitDict(s, i, out, { map: ctx.map, parentTarget: null, directLength: null })
    }
    const end = scanHexString(s, i)
    out.push(s.slice(i, end))
    return end
  }
  if (c === '[') {
    out.push('[')
    i++
    for (;;) {
      i = skipWs(s, i)
      if (s[i] === ']') { out.push(']'); return i + 1 }
      const next = emitValue(s, i, out, ctx)
      if (next <= i) throw new Error('PDF 数组发射无进展')
      out.push(' ')
      i = next
    }
  }
  if (NUM_START.test(c)) {
    const numEnd = scanNumber(s, i)
    const j = skipWs(s, numEnd)
    if (NUM_START.test(s[j] || '')) {
      const secondEnd = scanNumber(s, j)
      const m = skipWs(s, secondEnd)
      if (s[m] === 'R' && !(s[m + 1] && !isWs(s[m + 1]) && !DELIM.has(s[m + 1]))) {
        // 间接引用：平移第一个数字，gen 与 R 原样
        const old = Number(s.slice(i, numEnd))
        const mapped = ctx.map.get(old)
        if (mapped === undefined) throw new Error(`引用了不存在的对象 ${old}`)
        out.push(`${mapped} ${s.slice(j, secondEnd)} R`)
        return m + 1
      }
    }
    out.push(s.slice(i, numEnd))
    return numEnd
  }
  if (/[a-zA-Z]/.test(c)) {
    const end = scanKeyword(s, i)
    out.push(s.slice(i, end))
    return end
  }
  throw new Error(`PDF 值起始字符无法识别: ${JSON.stringify(s.slice(i, i + 20))}`)
}

/**
 * 发射字典。
 * - parentTarget 非 null 且遇到 /Parent 条目：改写为新的页树节点引用
 *   （各批页对象的 /Parent 原本指向自己那份的页树节点，合并后必须改指新页树）
 * - /Length 若是间接引用：解析成直接整数（stream 载荷原样拷贝，长度不变）
 */
function emitDict(s, i, out, ctx) {
  const d = parseDict(s, i)
  out.push('<<')
  for (const e of d.entries) {
    out.push('\n', e.key, ' ')
    if (e.key === '/Parent' && ctx.parentTarget !== null && ctx.parentTarget !== undefined) {
      out.push(`${ctx.parentTarget} 0 R`)
      continue
    }
    if (e.key === '/Length') {
      const t = s.slice(e.vStart, e.vEnd).trim()
      if (/^\d+$/.test(t)) {
        out.push(t)
        continue
      }
      // 间接 /Length：调用方已解析出整数值，这里直排；未解析则维持原样由上层报错
      if (ctx.directLength !== null && ctx.directLength !== undefined) {
        out.push(String(ctx.directLength))
        continue
      }
    }
    emitValue(s, e.vStart, out, ctx)
  }
  out.push('\n>>')
  return d.end
}

// ---------------------------------------------------------------------------
// PdfFile：结构解析（尾区 → xref → trailer）+ 定位读 + 页树遍历。
// 只支持经典 xref；任何意外结构都尽早抛错，不猜。
// ---------------------------------------------------------------------------

class PdfFile {
  constructor(filePath) {
    this.path = filePath
    this.name = path.basename(filePath)
    const st = fs.statSync(filePath)
    this.size = st.size
    if (this.size < 64) throw new UnsupportedPdfError(`${this.name}: 文件过小，不是有效 PDF`)
    this.fd = fs.openSync(filePath, 'r')
    try {
      this._parseStructure()
    } catch (err) {
      fs.closeSync(this.fd)
      throw err
    }
    this._dictCache = new Map()
  }

  close() {
    if (this.fd !== null && this.fd !== undefined) {
      try { fs.closeSync(this.fd) } catch { /* 关闭失败不影响已读出的数据 */ }
      this.fd = null
    }
  }

  readAt(offset, len) {
    if (offset < 0 || len < 0 || offset + len > this.size) throw new Error(`${this.name}: 读取越界`)
    const buf = Buffer.allocUnsafe(len)
    const got = fs.readSync(this.fd, buf, 0, len, offset)
    if (got !== len) throw new Error(`${this.name}: 读取不完整（${got}/${len}）`)
    return buf
  }

  /**
   * 读对象头部窗口（从对象起点开始，至少 HEAD_MIN 字节）。
   * 扫描器在窗口尽头未完成会抛 NeedMore，由调用方翻倍重试。
   */
  readHead(offset, len = HEAD_MIN) {
    return this.readAt(offset, Math.min(Math.max(len, HEAD_MIN), this.size - offset)).toString('latin1')
  }

  _parseStructure() {
    const tailLen = Math.min(this.size, 256 * 1024)
    const tail = this.readAt(this.size - tailLen, tailLen).toString('latin1')
    const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail)
    if (!m) throw new UnsupportedPdfError(`${this.name}: 找不到 startxref/%%EOF（不是单体 PDF 或尾部损坏）`)
    const xrefOffset = Number(m[1])
    if (!(xrefOffset > 0 && xrefOffset < this.size)) throw new UnsupportedPdfError(`${this.name}: startxref 偏移越界`)

    // 从 xrefOffset 到 EOF 就是尾部区域，整体读入（xref 表 + trailer）
    const region = this.readAt(xrefOffset, this.size - xrefOffset).toString('latin1')
    if (!/^xref[\s\r\n]/.test(region)) {
      if (/\/Type\s*\/XRef/.test(region.slice(0, 200))) {
        throw new UnsupportedPdfError(`${this.name}: 交叉引用流（xref stream）不在支持范围内`)
      }
      throw new UnsupportedPdfError(`${this.name}: xref 段定位失败（偏移处不是 xref 表）`)
    }
    this.xref = new Map() // objNum → { offset, gen, free }
    this._parseXrefRegion(region)

    const tpos = region.indexOf('trailer')
    if (tpos < 0) throw new UnsupportedPdfError(`${this.name}: 找不到 trailer 字典`)
    const trailer = parseDict(region, tpos + 'trailer'.length)
    this.trailerDict = trailer
    const prev = entryText(region, trailer, '/Prev')
    if (prev) throw new UnsupportedPdfError(`${this.name}: /Prev 增量更新链不在支持范围内`)
    if (entryText(region, trailer, '/Encrypt')) throw new UnsupportedPdfError(`${this.name}: 加密 PDF 不在支持范围内`)
    this.sizeRef = entryRef(region, trailer, '/Size')
    this.rootRef = entryRef(region, trailer, '/Root')
    if (!this.rootRef) throw new UnsupportedPdfError(`${this.name}: trailer 缺 /Root`)
    this.infoRef = entryRef(region, trailer, '/Info')
    // 最大在用对象号：累加求值，不用 Math.max(...keys)——大文档摊参数会爆调用栈
    let maxObjNum = 0
    for (const [n, e] of this.xref) if (!e.free && n > maxObjNum) maxObjNum = n
    this.maxObjNum = maxObjNum
    if (this.maxObjNum < 1) throw new UnsupportedPdfError(`${this.name}: xref 没有任何在用对象`)
  }

  _parseXrefRegion(region) {
    let i = skipWs(region, region.indexOf('xref') + 'xref'.length)
    for (;;) {
      i = skipWs(region, i)
      if (region.startsWith('trailer', i)) break
      const head = /^(\d+)\s+(\d+)[\s\r\n]/.exec(region.slice(i))
      if (!head) throw new UnsupportedPdfError(`${this.name}: xref 子段头无法解析`)
      const start = Number(head[1])
      const count = Number(head[2])
      i += head[0].length
      for (let k = 0; k < count; k++) {
        const line = /^(\d+)\s+(\d+)\s+([nf])[ \t]*\r?\n/.exec(region.slice(i))
        if (!line) throw new UnsupportedPdfError(`${this.name}: xref 条目无法解析（对象 ${start + k}）`)
        this.xref.set(start + k, { offset: Number(line[1]), gen: Number(line[2]), free: line[3] === 'f' })
        i += line[0].length
      }
    }
    if (this.xref.size === 0) throw new UnsupportedPdfError(`${this.name}: xref 表为空`)
  }

  /**
   * 解析对象头：win 窗口 + 值（字典时为条目表）+ stream 关键字位置。
   * 窗口耗尽导致的解析失败一律翻倍窗口重试（HEAD_MAX 封顶）；
   * 重试到顶仍失败 = 文件真的损坏，原样抛出。
   */
  objectAt(num) {
    const cached = this._dictCache.get(num)
    if (cached) return cached
    const entry = this.xref.get(num)
    if (!entry || entry.free) throw new Error(`${this.name}: 对象 ${num} 不在用`)
    const maxWin = this.size - entry.offset
    let win = this.readHead(entry.offset, HEAD_MIN)
    for (;;) {
      try {
        const i0 = skipWs(win, 0)
        const hdr = /^(\d+)\s+(\d+)\s+obj/.exec(win.slice(i0))
        if (!hdr) throw new Error(`${this.name}: 对象 ${num} 头部不是 N G obj`)
        if (Number(hdr[1]) !== num || Number(hdr[2]) !== entry.gen) {
          throw new Error(`${this.name}: 对象 ${num} 头部编号与 xref 不符（${hdr[1]} ${hdr[2]}）`)
        }
        const bodyStart = i0 + hdr[0].length
        let dict = null
        const vi = skipWs(win, bodyStart)
        if (win[vi] === '<' && win[vi + 1] === '<') {
          dict = parseDict(win, vi)
        } else {
          scanValue(win, vi) // 非字典值：只为验证窗口足够
        }
        // stream 关键字可能在字典后若干字节；贴窗口末尾时必须扩窗确认
        let streamAt = -1
        if (dict) {
          const j = skipWs(win, dict.end)
          if (win.length - j < 16 && win.length < maxWin) throw new NeedMore('stream 判定贴边')
          if (win.startsWith('stream', j)) {
            const after = win[j + 6]
            if (!after || isWs(after)) streamAt = j
          }
        }
        const result = { win, offset: entry.offset, gen: entry.gen, bodyStart, dict, streamAt }
        if (this._dictCache.size > 20000) this._dictCache.clear()
        this._dictCache.set(num, result)
        return result
      } catch (err) {
        if (win.length < HEAD_MAX && win.length < maxWin) {
          win = this.readHead(entry.offset, win.length * 2)
          continue
        }
        throw err
      }
    }
  }

  /** 对象值是字典时返回 { s, dict }；否则 null */
  dictAt(num) {
    const o = this.objectAt(num)
    if (!o.dict) return null
    return { s: o.win, dict: o.dict }
  }

  /** 解析一个「纯数字对象」（间接 /Length 的解值只接受这种） */
  resolveNumber(num) {
    const o = this.objectAt(num)
    const i = skipWs(o.win, o.bodyStart)
    const end = scanValue(o.win, i)
    const text = o.win.slice(i, end).trim()
    if (!/^\d+(\.\d+)?$/.test(text)) {
      throw new UnsupportedPdfError(`${this.name}: 间接 /Length 指向的不是数字对象（对象 ${num}）`)
    }
    return Math.floor(Number(text))
  }

  /** 从 catalog 出发遍历页树，返回页对象号（文档序） */
  pageOrder() {
    const root = this.dictAt(this.rootRef[0])
    if (!root) throw new Error(`${this.name}: catalog 不是字典`)
    const type = entryText(root.s, root.dict, '/Type')
    if (type !== '/Catalog') throw new UnsupportedPdfError(`${this.name}: /Root 指向的不是 Catalog（${type}）`)
    const pagesRef = entryRef(root.s, root.dict, '/Pages')
    if (!pagesRef) throw new Error(`${this.name}: catalog 缺 /Pages`)
    const out = []
    this._walkPages(pagesRef[0], out, new Set())
    if (!out.length) throw new Error(`${this.name}: 页树没有任何页面`)
    return out
  }

  _walkPages(num, out, seen) {
    if (seen.has(num)) throw new Error(`${this.name}: 页树成环（对象 ${num}）`)
    seen.add(num)
    const node = this.dictAt(num)
    if (!node) throw new Error(`${this.name}: 页树节点 ${num} 不是字典`)
    const kidsEntry = findEntry(node.dict, '/Kids')
    if (kidsEntry) {
      const kidsText = node.s.slice(kidsEntry.vStart, kidsEntry.vEnd)
      const refs = [...kidsText.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((m) => Number(m[1]))
      if (!refs.length) throw new Error(`${this.name}: /Kids 无有效引用`)
      for (const k of refs) this._walkPages(k, out, seen)
      return
    }
    out.push(num)
  }

  /** 快速页数（/Count 优先；缺失时退化为页树遍历） */
  quickPageCount() {
    const root = this.dictAt(this.rootRef[0])
    if (!root) throw new Error(`${this.name}: catalog 不是字典`)
    const pagesRef = entryRef(root.s, root.dict, '/Pages')
    if (!pagesRef) throw new Error(`${this.name}: catalog 缺 /Pages`)
    const node = this.dictAt(pagesRef[0])
    if (!node) throw new Error(`${this.name}: 页树根不是字典`)
    const countRef = entryRef(node.s, node.dict, '/Count')
    if (countRef) return this.resolveNumber(countRef[0])
    const t = entryText(node.s, node.dict, '/Count')
    if (t && /^\d+$/.test(t)) return Number(t)
    return this.pageOrder().length
  }
}

/** 扫描器需要更多字节时抛出（objectAt 负责翻倍窗口重试） */
class NeedMore extends Error {}

// ---------------------------------------------------------------------------
// 合并驱动：对象号平移 + 顺序写出 + 自校验。
// 内存画像：每个输入保持一个 64KB~ 的对象头缓存（页树遍历用），stream 载荷
// 按 1MB 块边读边写——500 页照片作业（~7.5GB）也不会整份进内存。
// ---------------------------------------------------------------------------

const HEADER_BYTES = Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]) // %PDF 行尾的二进制注释（4 个高位字节）

/** 统一的写出记账：所有字节都经这里走，pos 才不会和文件实际长度脱节。
 *  背压等待与错误传播各只要**一对**持久监听——逐次挂 once 会在
 *  几百页的流式拷贝里堆出 MaxListenersExceededWarning。 */
function makeSink(ws) {
  const sink = { pos: 0 }
  const waiters = []
  let failure = null
  const release = (arg) => { while (waiters.length) waiters.shift()(arg) }
  ws.on('error', (err) => { failure = err; release(err) })
  ws.on('drain', () => release(null))
  sink.write = async (chunk) => {
    if (failure) throw failure
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1')
    if (!ws.write(buf)) await new Promise((resolve) => waiters.push(resolve))
    if (failure) throw failure
    sink.pos += buf.length
  }
  return sink
}

async function copyRange(file, offset, length, sink) {
  let at = offset
  let left = length
  while (left > 0) {
    const n = Math.min(COPY_CHUNK, left)
    // latin1 字符串中转：逐字节可逆，避免按 UTF-8 解码破坏二进制载荷
    await sink.write(file.readAt(at, n).toString('latin1'))
    at += n
    left -= n
  }
}

/**
 * 合并多个 PDF 为单文件（页序 = 输入顺序的页树展开序）。
 * @returns { pages, bytes, objects }
 */
async function mergePdfs(inputPaths, outputPath, { onProgress } = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('合并输入为空')
  const files = inputPaths.map((p) => new PdfFile(p))
  const ws = fs.createWriteStream(outputPath)
  try {
    // 1) 各输入的页序（以真实页树为准，不信任调用方的计划页数）
    const orders = files.map((f) => f.pageOrder())
    const totalPages = orders.reduce((s, o) => s + o.length, 0)

    // 2) 对象号平移基线：base_i 累加 maxObjNum+1，各输入新区间互不重叠
    const bases = []
    const maps = []
    let next = 0
    for (const f of files) {
      bases.push(next)
      const m = new Map()
      for (let n = 1; n <= f.maxObjNum; n++) m.set(n, next + n)
      maps.push(m)
      next += f.maxObjNum + 1
    }
    const newPagesNum = next
    const newCatalogNum = next + 1

    // 3) 顺序写出：头部 → 全部在用对象（页对象改 /Parent）→ 新页树 → 新 catalog → xref → trailer
    const newXref = new Map()
    const sink = makeSink(ws)
    await sink.write('%PDF-1.7\n')
    await sink.write(HEADER_BYTES)

    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi]
      const map = maps[fi]
      if (onProgress) onProgress({ phase: 'copy', file: fi + 1, files: files.length, name: f.name })
      for (let n = 1; n <= f.maxObjNum; n++) {
        const e = f.xref.get(n)
        if (!e || e.free) continue
        const o = f.objectAt(n)
        const objOffset = sink.pos
        const out = []
        out.push(`${map.get(n)} ${o.gen} obj\n`)
        let typeName = null
        let length = null
        if (o.dict) {
          typeName = entryText(o.win, o.dict, '/Type')
          const lengthEntry = findEntry(o.dict, '/Length')
          if (lengthEntry) {
            const t = o.win.slice(lengthEntry.vStart, lengthEntry.vEnd).trim()
            if (/^\d+$/.test(t)) length = Number(t)
            else {
              const rm = REF_RE.exec(t)
              if (!rm) throw new UnsupportedPdfError(`${f.name}: /Length 形态无法解析（对象 ${n}）`)
              length = f.resolveNumber(Number(rm[1]))
            }
          }
        }
        await sink.write(out.join(''))
        const body = []
        if (o.dict) {
          emitDict(o.win, skipWs(o.win, o.bodyStart), body, {
            map,
            parentTarget: typeName === '/Page' ? newPagesNum : null,
            directLength: length,
          })
          if (o.streamAt >= 0) {
            if (length == null) throw new UnsupportedPdfError(`${f.name}: stream 缺 /Length（对象 ${n}）`)
            // stream 关键字后恰有一个 EOL（\n 或 \r\n）；数据从 EOL 之后开始
            let k = o.streamAt + 6
            if (o.win[k] === '\r') k++
            if (o.win[k] === '\n') k++
            else throw new Error(`${f.name}: stream 关键字后缺少 EOL（对象 ${n}）`)
            const dataStart = o.offset + k
            body.push('\nstream\n')
            await sink.write(body.join(''))
            body.length = 0
            await copyRange(f, dataStart, length, sink)
            // /Length 之后必须是 endstream：防「长度错位静默产出坏文件」
            const after = f.readAt(dataStart + length, Math.min(32, Math.max(0, f.size - dataStart - length))).toString('latin1')
            if (!/^\s*endstream/.test(after)) {
              throw new Error(`${f.name}: stream /Length 与 endstream 不符（对象 ${n}，文件可能损坏）`)
            }
            await sink.write('\nendstream\n')
          } else {
            body.push('\n')
          }
        } else {
          emitValue(o.win, skipWs(o.win, o.bodyStart), body, { map })
          body.push('\n')
        }
        body.push('endobj\n')
        await sink.write(body.join(''))
        newXref.set(map.get(n), { offset: objOffset, gen: o.gen, free: false })
      }
    }

    // 4) 新页树节点 + 新 catalog（各批页对象的 /Parent 已改指 newPagesNum）
    const kids = []
    orders.forEach((order, fi) => {
      for (const n of order) kids.push(`${maps[fi].get(n)} 0 R`)
    })
    newXref.set(newPagesNum, {
      offset: sink.pos, gen: 0, free: false,
    })
    await sink.write(`${newPagesNum} 0 obj\n<< /Type /Pages /Count ${totalPages} /Kids [${kids.join(' ')}] >>\nendobj\n`)
    newXref.set(newCatalogNum, { offset: sink.pos, gen: 0, free: false })
    await sink.write(`${newCatalogNum} 0 obj\n<< /Type /Catalog /Pages ${newPagesNum} 0 R >>\nendobj\n`)

    // 5) xref（单一 0..maxNew 子段，free 条目占位）+ trailer + startxref
    if (sink.pos > 9999999999) throw new Error('合并结果超过 10GB，xref 偏移无法表示')
    const xrefOffset = sink.pos
    const maxNew = newCatalogNum
    let x = `xref\n0 ${maxNew + 1}\n`
    for (let n = 0; n <= maxNew; n++) {
      const e = newXref.get(n)
      x += e
        ? `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`
        : '0000000000 65535 f \n'
    }
    const infoNew = files[0].infoRef ? maps[0].get(files[0].infoRef[0]) : null
    const idHex = crypto.createHash('sha256').update(inputPaths.join('|')).digest('hex').slice(0, 32)
    x += `trailer\n<< /Size ${maxNew + 1} /Root ${newCatalogNum} 0 R`
    if (infoNew) x += ` /Info ${infoNew} 0 R`
    x += ` /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    await sink.write(x)

    await new Promise((resolve, reject) => {
      ws.end(resolve)
      ws.on('error', reject)
    })

    // 6) 自校验：重开产物走一遍页数（写飞了当场炸，不留给下游）
    const check = new PdfFile(outputPath)
    try {
      const pages = check.quickPageCount()
      if (pages !== totalPages) {
        throw new Error(`合并自校验失败：写出 ${totalPages} 页，重读 ${pages} 页`)
      }
    } finally {
      check.close()
    }
    return { pages: totalPages, bytes: sink.pos, objects: newXref.size }
  } catch (err) {
    // 半成品输出必须清掉：调用方的「临时件失败即整体失败」依赖这里不留下坑
    if (!ws.writableEnded) ws.destroy()
    try { fs.unlinkSync(outputPath) } catch { /* 未写出或已删都视为干净 */ }
    throw err
  } finally {
    for (const f of files) f.close()
    if (!ws.writableEnded) ws.destroy()
  }
}

/**
 * 文件级快速页数（只读尾区 + catalog + 页树根，不载入全文）。
 * 用于分批导出的批内校验与合并校验。
 */
function countPdfPagesFromFile(filePath) {
  const f = new PdfFile(filePath)
  try {
    return f.quickPageCount()
  } finally {
    f.close()
  }
}

module.exports = { mergePdfs, countPdfPagesFromFile, PdfFile, UnsupportedPdfError }

/**
 * 测试共用夹具：手写合法 PDF 构造器 + **独立校验器**。
 * 独立 = 不复用 electron/pdf-merge.cjs 的解析代码（用被测代码校验自己
 * 会漏掉共谋错误），只用正则 + 位置读取。
 */
const fs = require('fs')

/** 二进制载荷：全字节值扫描 + 「陷阱」字节串（内部出现 endstream/obj 字样与 \r\n） */
function makeBinaryPayload(seed) {
  const arr = []
  for (let i = 0; i < 300; i++) arr.push((i * 37 + seed.length * 11) % 256)
  const trap = Buffer.from('\r\nendstream\r\n99 0 obj\n<< /Length 7 >>\n', 'latin1')
  const base = Buffer.from(arr)
  return Buffer.concat([base.slice(0, 100), trap, base.slice(100)]).toString('latin1')
}

/**
 * 手写合法 PDF。编号手工预排，页对象才能拿到正确的 /Parent。
 * nestedTree：中间加一层 /Pages 节点（合并器必须会走嵌套页树）。
 * indirectLength：第一个 content stream 的 /Length 走间接引用。
 */
function buildPdf({ tag, pages, nestedTree = false, indirectLength = false, binary = false, extraTrailer = '' }) {
  const objs = new Map()
  let n = 0
  const infoNum = ++n
  const contentNums = []
  for (let i = 0; i < pages; i++) contentNums.push(++n)
  const gsNum = ++n
  const pageNums = []
  for (let i = 0; i < pages; i++) pageNums.push(++n)
  const midNum = nestedTree ? ++n : null
  const treeNum = ++n
  const catNum = ++n
  const parentNum = nestedTree ? midNum : treeNum

  objs.set(infoNum, `<< /Producer (fixture-${tag}\\(esc\\)) /Title (${tag}) >>`)
  for (let i = 0; i < pages; i++) {
    const payload = binary ? makeBinaryPayload(`${tag}-${i}`) : `BT /F1 12 Tf 20 60 Td (${tag}-page-${i + 1}) Tj ET\n`
    if (indirectLength && i === 0) {
      const lenNum = ++n
      objs.set(lenNum, String(payload.length))
      objs.set(contentNums[i], `<< /Length ${lenNum} 0 R >> stream\n${payload}\nendstream`)
    } else {
      objs.set(contentNums[i], `<< /Length ${payload.length} >> stream\n${payload}\nendstream`)
    }
  }
  objs.set(gsNum, '<< /ca 0.5 /BM /Normal >>')
  const kidList = pageNums.map((x) => `${x} 0 R`).join(' ')
  for (let i = 0; i < pages; i++) {
    objs.set(pageNums[i], `<< /Type /Page /MediaBox [0 0 200 100] `
      + `/Resources << /ExtGState <</G0 ${gsNum} 0 R>> /ProcSet [/PDF /Text] >> `
      + `/Contents ${contentNums[i]} 0 R /Parent ${parentNum} 0 R /StructParents ${i} >>`)
  }
  if (nestedTree) {
    objs.set(midNum, `<< /Type /Pages /Parent ${treeNum} 0 R /Count ${pages} /Kids [${kidList}] >>`)
    objs.set(treeNum, `<< /Type /Pages /Count ${pages} /Kids [${midNum} 0 R] >>`)
  } else {
    objs.set(treeNum, `<< /Type /Pages /Count ${pages} /Kids [${kidList}] >>`)
  }
  objs.set(catNum, `<< /Type /Catalog /Pages ${treeNum} 0 R >>`)

  let out = '%PDF-1.4\n' + Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]).toString('latin1')
  const offsets = new Map()
  for (let k = 1; k <= n; k++) {
    offsets.set(k, out.length)
    out += `${k} 0 obj\n${objs.get(k)}\nendobj\n`
  }
  const xrefOff = out.length
  out += `xref\n0 ${n + 1}\n`
  for (let k = 0; k <= n; k++) {
    out += k === 0 ? '0000000000 65535 f \n' : `${String(offsets.get(k)).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${n + 1} /Root ${catNum} 0 R /Info ${infoNum} 0 R${extraTrailer} >>\n`
  out += `startxref\n${xrefOff}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function readPdfLike(buf) {
  const s = buf.toString('latin1')
  const tail = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(s)
  if (!tail) throw new Error('找不到 startxref/%%EOF')
  const xrefOff = Number(tail[1])
  const region = s.slice(xrefOff)
  if (!/^xref[\s\r\n]/.test(region)) throw new Error('startxref 偏移处不是 xref 表')

  const entries = new Map()
  let i = 4
  for (;;) {
    while (i < region.length && /[\s\r\n]/.test(region[i])) i++
    if (region.startsWith('trailer', i)) break
    const head = /^(\d+)\s+(\d+)[\s\r\n]/.exec(region.slice(i))
    if (!head) throw new Error('xref 子段头异常')
    const start = Number(head[1])
    const count = Number(head[2])
    i += head[0].length
    for (let k = 0; k < count; k++) {
      const line = /^(\d+) (\d+) ([nf]) ?\r?\n/.exec(region.slice(i))
      if (!line) throw new Error(`xref 条目异常（对象 ${start + k}）`)
      entries.set(start + k, { offset: Number(line[1]), gen: Number(line[2]), free: line[3] === 'f' })
      i += line[0].length
    }
  }
  const trailerText = region.slice(i + 'trailer'.length)
  const size = Number(/\/Size\s+(\d+)/.exec(trailerText)[1])
  const root = Number(/\/Root\s+(\d+)\s+\d+\s+R/.exec(trailerText)[1])
  const infoRef = /\/Info\s+(\d+)\s+\d+\s+R/.exec(trailerText)

  const objAt = (num) => {
    const e = entries.get(num)
    if (!e || e.free) throw new Error(`对象 ${num} 不在用`)
    const from = e.offset
    const m = new RegExp(`^${num}\\s+${e.gen}\\s+obj`).exec(s.slice(from, from + 40))
    if (!m) throw new Error(`xref 偏移 ${from} 处不是对象 ${num} 的头`)
    return { text: s.slice(from, s.indexOf('endobj', from)), offset: from }
  }

  const cat = objAt(root)
  const pagesRef = Number(/\/Pages\s+(\d+)\s+\d+\s+R/.exec(cat.text)[1])
  const pageNums = []
  const walk = (num, seen) => {
    if (seen.has(num)) throw new Error(`页树成环（对象 ${num}）`)
    seen.add(num)
    const t = objAt(num).text
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(t)
    if (kids) {
      const refs = [...kids[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((mm) => Number(mm[1]))
      if (!refs.length) throw new Error('/Kids 无有效引用')
      for (const r of refs) walk(r, seen)
      return
    }
    pageNums.push(num)
  }
  walk(pagesRef, new Set())

  const detail = pageNums.map((num) => {
    const t = objAt(num).text
    const parent = Number(/\/Parent\s+(\d+)\s+\d+\s+R/.exec(t)[1])
    const cRef = Number(/\/Contents\s+(\d+)\s+\d+\s+R/.exec(t)[1])
    const ct = objAt(cRef)
    let len
    const ind = /\/Length\s+(\d+)\s+\d+\s+R/.exec(ct.text)
    if (ind) {
      const lt = objAt(Number(ind[1])).text
      len = Number(/^\s*\d+\s+0\s+obj\s+(\d+)/.exec(lt)[1])
    } else {
      len = Number(/\/Length\s+(\d+)/.exec(ct.text)[1])
    }
    let p = ct.text.indexOf('stream') + 'stream'.length
    if (ct.text[p] === '\r') p++
    if (ct.text[p] === '\n') p++
    const abs = ct.offset + p
    return { num, parent, payload: buf.slice(abs, abs + len), objectText: ct.text }
  })

  let maxInUse = 0
  for (const [num, e] of entries) if (!e.free && num > maxInUse) maxInUse = num
  return { entries, size, root, infoRef, objAt, pageNums, detail, maxInUse, ends: s.endsWith('%%EOF\n') }
}

/** 合并/批产出物的结构体检（独立校验器视角）；ok 为调用方的断言函数 */
function checkMergedStructure(label, buf, expectPages, ok) {
  const r = readPdfLike(buf)
  ok(r.pageNums.length === expectPages, `${label}: 页数 = ${expectPages}`, r.pageNums.length)
  ok(r.size === r.maxInUse + 1, `${label}: trailer /Size = 最大在用对象号+1`, { size: r.size, max: r.maxInUse })
  ok(r.ends, `${label}: %%EOF 收尾`)
  let parentsOk = true
  for (const pg of r.detail) {
    const node = r.objAt(pg.parent)
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.text)
    const has = kids && new Set([...kids[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))).has(pg.num)
    if (!has) parentsOk = false
  }
  ok(parentsOk, `${label}: 每页 /Parent 指向的页树节点真的把它列进 /Kids`)
  return r
}

function payloadsOf(r) { return r.detail.map((d) => d.payload) }

function bufEq(a, b) {
  return a.length === b.length && Buffer.compare(a, b) === 0
}

module.exports = { buildPdf, readPdfLike, checkMergedStructure, payloadsOf, bufEq, makeBinaryPayload }

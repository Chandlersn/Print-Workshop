/**
 * `.ppdesign` 工程包的 ZIP 读写与资源限额（纯 Node，零 electron 依赖）。
 *
 * ── 为什么读用库、写自己实现 ──────────────────────────────────
 * 读的是**不可信输入**（用户从别处拷来的包）。路径越界、zip bomb、加密条目、
 * 符号链接、重复/大小写冲突条目，全靠解码器的严谨性兜住；自己写解码器错一次
 * 就是一次任意文件写入，所以读一律走 `yauzl`（显式依赖，不能靠传递依赖）。
 *
 * 写的是**我们自己生成的内容**：条目名与字节都由调用方决定，自实现编码器的风险
 * 只在于「产出的包别人打不开」——而这一点可以用 yauzl 回读 + 系统解压验证，
 * 属于能被测试覆盖的风险。代价是少一个依赖（`archiver` 会拖进十几个传递包）。
 *
 * ── 三条硬边界 ────────────────────────────────────────────────
 * 1. **不能只信 ZIP 头里声明的大小**：声明值只用来做「读之前」的预算拦截，
 *    真正的判定用**实际流出字节**（zip bomb 的典型手法就是头里写小、实际无限吐）。
 * 2. **不能先整体解压再检查**：逐条流式落盘 + 边落边计数，超预算立刻中断。
 * 3. **条目名先归一化再落盘**：越界路径必须在打开写流之前被拒绝。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const yauzl = require('yauzl')

// ─────────────────────────── 限额 ───────────────────────────

/**
 * 初始限额（计划 §4.4 的表格）。实施时用代表性大工程校准。
 *
 * 单位是**实际流出字节**，不是 ZIP 头声明值。
 */
const LIMITS = Object.freeze({
  maxEntries: 650,
  maxManifestBytes: 1024 * 1024,            // 清单 1 MiB
  maxProjectBytes: 32 * 1024 * 1024,        // 工程 JSON 32 MiB
  maxImageBytes: 64 * 1024 * 1024,          // 单张图片 64 MiB（与 designs.cjs 一致）
  maxProjectImageBytes: 512 * 1024 * 1024,  // 工程累计图片 512 MiB（与 designs.cjs 一致）
  maxFontBytes: 32 * 1024 * 1024,           // 单个字体 32 MiB
  maxTotalFontBytes: 128 * 1024 * 1024,     // 字体累计 128 MiB
  maxTotalBytes: 768 * 1024 * 1024,         // 总解压体积 768 MiB
  maxRatio: 200,                            // 压缩比上限（声明值 / 压缩值），超了按炸弹处理
  maxNameLength: 200,
  timeoutMs: 120000,                        // 解码超时（挂住的流不能无限等）
})

/** 包内允许出现的条目名。**只接受这个白名单**——不认识的一律拒，绝不落盘。 */
const ENTRY_PATTERNS = [
  { role: 'manifest', re: /^manifest\.json$/ },
  { role: 'project', re: /^project\.json$/ },
  { role: 'image', re: /^images\/[a-f0-9]{64}\.(png|jpg)$/ },
  { role: 'font', re: /^fonts\/[a-f0-9]{64}\.(ttf|otf|ttc|woff2?)$/ },
]

class CancelledError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'CancelledError'
    this.code = 'CANCELLED'
  }
}

// ─────────────────────────── 写入 ───────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let n = i
  for (let b = 0; b < 8; b++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function writeAll(fd, buf, position) {
  let written = 0
  while (written < buf.length) {
    written += fs.writeSync(fd, buf, written, buf.length - written, position + written)
  }
  return written
}

/**
 * 把临时文件替换到目标路径，**失败时保留原目标文件**。
 *
 * Windows 上 `rename` 覆盖已存在的文件可能会 EPERM。此时先把旧目标改名
 * 到同目录备份，再把完整临时文件改名到目标；第二步失败就恢复旧目标。
 * 不能直接复制覆盖目标：复制中断会把原先完整的包截成半个包。
 */
function replaceFile(temp, target) {
  try {
    fs.renameSync(temp, target)
    return
  } catch (err) {
    let replaceable = false
    try { replaceable = fs.lstatSync(target).isFile() } catch { /* 目标可能刚被移走 */ }
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY', 'EBUSY'].includes(err.code) || !replaceable) {
      try { fs.unlinkSync(temp) } catch { /* 清理失败不影响主错误 */ }
      throw err
    }
  }
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.bak`)
  let movedOld = false
  try {
    fs.renameSync(target, backup)
    movedOld = true
    fs.renameSync(temp, target)
  } catch (err) {
    if (movedOld) {
      try { fs.renameSync(backup, target) } catch (restoreError) {
        throw new Error(`工程包替换失败，原文件保存在 ${backup}；恢复失败：${restoreError.message}`, { cause: err })
      }
    }
    throw err
  } finally {
    try { fs.unlinkSync(temp) } catch { /* 已改名或不存在 */ }
  }
  try { fs.unlinkSync(backup) } catch { /* 备份清理可留待人工处理，不影响已完成的导出 */ }
}

/**
 * 写包。条目：`{ name, buffer }` 或 `{ name, filePath }`；`store: true` 表示不压缩
 * （PNG/JPEG 本身就是压缩格式，再 deflate 只是白烧 CPU）。
 *
 * @returns {{path: string, bytes: number, entries: number}}
 */
function writeArchive(targetPath, entries, options = {}) {
  const { onProgress, shouldCancel } = options
  if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('工程包输出路径无效')
  if (!Array.isArray(entries) || !entries.length) throw new Error('工程包内容为空')
  const dir = path.dirname(path.resolve(targetPath))
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(targetPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const total = entries.length
  const central = []
  let offset = 0
  const fd = fs.openSync(temp, 'wx')
  try {
    const stamp = dosDateTime()
    entries.forEach((entry, index) => {
      if (shouldCancel && shouldCancel()) throw new CancelledError('导出已取消')
      const name = String(entry && entry.name || '')
      if (!name) throw new Error('工程包条目缺少名称')
      let raw = entry.buffer
      if (raw === undefined || raw === null) {
        if (typeof entry.filePath !== 'string') throw new Error(`工程包条目 ${name} 缺少内容`)
        raw = fs.readFileSync(entry.filePath)
      }
      if (!Buffer.isBuffer(raw)) throw new Error(`工程包条目 ${name} 内容无效`)
      const compressed = entry.store ? null : zlib.deflateRawSync(raw)
      // 自己写出的高重复 JSON 也必须能通过读取端的压缩比限制。
      const method = compressed && compressed.length && raw.length / compressed.length <= LIMITS.maxRatio ? 8 : 0
      const payload = method === 8 ? compressed : raw
      const nameBytes = Buffer.from(name, 'utf8')
      if (nameBytes.length > 0xffff || raw.length > 0xffffffff || payload.length > 0xffffffff || offset > 0xffffffff) throw new Error('工程包超出 ZIP32 格式容量')
      const headerOffset = offset
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)       // version needed
      local.writeUInt16LE(0x0800, 6)   // 条目名按 UTF-8 编码
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(stamp.time, 10)
      local.writeUInt16LE(stamp.date, 12)
      local.writeUInt32LE(crc32(raw), 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(nameBytes.length, 26)
      local.writeUInt16LE(0, 28)       // extra length
      offset += writeAll(fd, local, offset)
      offset += writeAll(fd, nameBytes, offset)
      offset += writeAll(fd, payload, offset)
      central.push({ nameBytes, method, crc: crc32(raw), csize: payload.length, usize: raw.length, headerOffset })
      if (onProgress) onProgress({ phase: 'write', index: index + 1, total, name, bytes: raw.length })
    })
    if (shouldCancel && shouldCancel()) throw new CancelledError('导出已取消')
    const centralOffset = offset
    if (central.length > 0xffff) throw new Error('工程包条目数量超出 ZIP32 格式容量')
    for (const item of central) {
      const head = Buffer.alloc(46)
      head.writeUInt32LE(0x02014b50, 0)
      head.writeUInt16LE(20, 4)        // version made by
      head.writeUInt16LE(20, 6)        // version needed
      head.writeUInt16LE(0x0800, 8)
      head.writeUInt16LE(item.method, 10)
      head.writeUInt16LE(stamp.time, 12)
      head.writeUInt16LE(stamp.date, 14)
      head.writeUInt32LE(item.crc, 16)
      head.writeUInt32LE(item.csize, 20)
      head.writeUInt32LE(item.usize, 24)
      head.writeUInt16LE(item.nameBytes.length, 28)
      head.writeUInt16LE(0, 30)        // extra
      head.writeUInt16LE(0, 32)        // comment
      head.writeUInt16LE(0, 34)        // disk number start
      head.writeUInt16LE(0, 36)        // internal attrs
      head.writeUInt32LE(0, 38)        // external attrs
      head.writeUInt32LE(item.headerOffset, 42)
      offset += writeAll(fd, head, offset)
      offset += writeAll(fd, item.nameBytes, offset)
    }
    const end = Buffer.alloc(22)
    if (offset - centralOffset > 0xffffffff || centralOffset > 0xffffffff) throw new Error('工程包超出 ZIP32 格式容量')
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(offset - centralOffset, 12)
    end.writeUInt32LE(centralOffset, 16)
    end.writeUInt16LE(0, 20)
    offset += writeAll(fd, end, offset)
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* 已不存在 */ }
    throw err
  }
  fs.closeSync(fd)
  replaceFile(temp, targetPath)
  return { path: targetPath, bytes: fs.statSync(targetPath).size, entries: central.length }
}

// ─────────────────────────── 读取 ───────────────────────────

/**
 * 条目名归一化：**先判定再落盘**，越界的一律抛错。
 *
 * 挡的是这一批：绝对路径 / 盘符 / UNC、`..`、反斜杠变体（`..\..`）、
 * Windows ADS（`file.png:stream`）、空名、控制字符、目录条目、超长名，
 * 以及**不在白名单里**的任何名字（不认识的条目绝不落盘）。
 */
function entryRole(name) {
  if (typeof name !== 'string' || !name) throw new Error('包内条目名为空')
  if (name.length > LIMITS.maxNameLength) throw new Error(`包内条目名过长：${name.slice(0, 60)}`)
  if (/[\x00-\x1f]/.test(name)) throw new Error('包内条目名含控制字符')
  if (name.endsWith('/') || name.endsWith('\\')) throw new Error(`包内不支持目录条目：${name}`)
  if (name.includes('\\') || name.includes(':')) throw new Error(`包内条目名含非法字符：${name.slice(0, 60)}`)
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.startsWith('//')) {
    throw new Error(`包内条目名不能是绝对路径：${name.slice(0, 60)}`)
  }
  if (name.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error(`包内条目名越界：${name.slice(0, 60)}`)
  }
  for (const { role, re } of ENTRY_PATTERNS) if (re.test(name)) return role
  throw new Error(`包内出现了未知条目：${name.slice(0, 60)}`)
}

function roleLimit(role) {
  if (role === 'manifest') return LIMITS.maxManifestBytes
  if (role === 'project') return LIMITS.maxProjectBytes
  if (role === 'image') return LIMITS.maxImageBytes
  return LIMITS.maxFontBytes
}

/**
 * yauzl 的报错是英文且带着实现细节（"invalid relative path: ../../x"），
 * 直接抛给用户既看不懂、也等于把包内路径回显出来。统一翻成中文且不回显原文。
 */
const FRIENDLY_ERRORS = [
  [/invalid relative path/i, '工程包内含有越界的条目路径，已拒绝读取'],
  [/absolute path/i, '工程包内含有绝对路径条目，已拒绝读取'],
  [/invalid characters in fileName/i, '工程包内含有非法字符的条目名，已拒绝读取'],
  [/end of central directory record signature not found/i, '这不是有效的工程包文件（内容已损坏或不是 .ppdesign）'],
  [/compressed\/uncompressed size mismatch/i, '工程包内条目大小与记录不一致，文件可能已损坏'],
  [/unexpected EOF/i, '工程包文件不完整，请重新导出或拷贝'],
  [/unsupported compression method/i, '工程包使用了不支持的压缩方式'],
  [/encrypted/i, '不支持加密的工程包'],
  [/multi-disk/i, '不支持分卷压缩包'],
]
function friendlyError(err) {
  if (err instanceof CancelledError) return err
  const message = String((err && err.message) || err)
  for (const [pattern, text] of FRIENDLY_ERRORS) if (pattern.test(message)) {
    const mapped = new Error(text)
    mapped.code = err && err.code
    return mapped
  }
  return err
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    // validateEntrySizes: yauzl 会核对「实际流出」与「头里声明」是否一致，
    // 头里写小、实际吐多的 zip bomb 会在流结束时报出来（我们另有一道累计字节闸门）。
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) reject(err)
      else resolve(zip)
    })
  })
}

function readStream(entry, zip) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err)
      resolve(stream)
    })
  })
}

/**
 * 把包逐条读到暂存目录。
 *
 * 每一条都：先判名 → 再按角色判声明大小 → 边落盘边算 sha256 与实际字节 →
 * 任何一项超限立即中断并抛错（**绝不留下半截包继续跑后面的条目**）。
 *
 * @returns {{entries: Array<{name:string, role:string, path:string, bytes:number, sha256:string}>, totalBytes:number}}
 */
async function extractToDir(zipPath, destDir, options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) }
  const { onProgress, shouldCancel } = options
  const startedAt = Date.now()
  let zip
  try {
    zip = await openZip(zipPath)
  } catch (err) {
    throw friendlyError(err)
  }
  fs.mkdirSync(destDir, { recursive: true })
  const entries = []
  const seen = new Set()
  const seenLower = new Set()
  let totalBytes = 0
  let imageBytes = 0
  let fontBytes = 0
  let aborted = false

  const fail = (message) => {
    aborted = true
    throw new Error(message)
  }
  const checkCancel = (where) => {
    if (aborted) throw new Error('包读取已中断')
    if (shouldCancel && shouldCancel()) throw new CancelledError(where)
    if (Date.now() - startedAt > limits.timeoutMs) fail('读取工程包超时，请确认文件未损坏')
  }

  /** 处理单条：校验 → 流式落盘 → 记一条。**一次只解一条**，内存里永远只有一条。 */
  const handleEntry = async (entry) => {
    checkCancel('导入已取消')
    if (entries.length + 1 > limits.maxEntries) fail(`工程包条目数量超过 ${limits.maxEntries} 个`)
    const name = entry.fileName
    const role = entryRole(name)
    if (seen.has(name)) fail(`工程包内条目重复：${name}`)
    // Windows 大小写不敏感：同名不同大小写会在落盘时互相覆盖 ⇒ 直接拒
    const lower = name.toLowerCase()
    if (seenLower.has(lower)) fail(`工程包内条目名大小写冲突：${name}`)
    seen.add(name)
    seenLower.add(lower)
    // 加密条目（通用位标记 bit 0）：内容读不出来，也就无从校验
    if (entry.generalPurposeBitFlag & 0x1) fail('不支持加密的工程包')
    // 符号链接（unix 高 16 位的文件类型位）：落盘后可能被当成跳板写出包外
    if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) fail(`工程包内含符号链接条目：${name}`)
    if (![0, 8].includes(entry.compressionMethod)) fail(`工程包使用了不支持的压缩方式：${name}`)

    const declared = entry.uncompressedSize
    const limit = roleLimit(role)
    if (declared > limit) fail(`工程包内 ${name} 超过 ${Math.round(limit / 1024 / 1024)} MB 上限`)
    // 压缩比：声明值远大于压缩值 ⇒ 典型 zip bomb。STORE 条目比值为 1，天然安全。
    const compressed = entry.compressedSize
    if (declared > 0 && (compressed === 0 || declared / compressed > limits.maxRatio)) fail(`工程包压缩比异常（疑似炸弹）：${name}`)
    if (role === 'image' && imageBytes + declared > limits.maxProjectImageBytes) fail('工程包内图片总量超过 512 MB')
    if (role === 'font' && fontBytes + declared > limits.maxTotalFontBytes) fail('工程包内字体总量超过 128 MB')
    if (totalBytes + declared > limits.maxTotalBytes) fail('工程包解压后体积超过 768 MB')

    const target = path.join(destDir, ...name.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const stream = await readStream(entry, zip)
    const hash = crypto.createHash('sha256')
    let written = 0
    await new Promise((resolve, reject) => {
      // 排他创建：目标已存在说明暂存区被污染（重名条目 / 上一轮残留），拒绝继续
      const out = fs.createWriteStream(target, { flags: 'wx' })
      let settled = false
      const watchdog = setInterval(() => {
        try { checkCancel('导入已取消') } catch (err) { stop(err) }
      }, 100)
      const stop = (err) => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        out.destroy()
        stream.destroy()
        reject(err)
      }
      stream.on('data', (chunk) => {
        if (settled) return
        try { checkCancel('导入已取消') } catch (err) { return stop(err) }
        written += chunk.length
        // 边收边判：**实际流出字节**才是准的，头里声明的只用于预算
        if (written > limit) return stop(new Error(`工程包内 ${name} 实际超过 ${Math.round(limit / 1024 / 1024)} MB`))
        if (totalBytes + written > limits.maxTotalBytes) return stop(new Error('工程包解压后体积超过 768 MB'))
        hash.update(chunk)
      })
      stream.on('error', (err) => stop(err))
      out.on('error', (err) => stop(err))
      out.on('finish', () => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        resolve()
      })
      stream.pipe(out)
    })

    totalBytes += written
    if (role === 'image') imageBytes += written
    if (role === 'font') fontBytes += written
    entries.push({ name, role, path: target, bytes: written, sha256: hash.digest('hex') })
    if (onProgress) onProgress({ phase: 'read', index: entries.length, total: zip.entryCount, name, bytes: written })
  }

  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', () => resolve())
      zip.on('entry', (entry) => {
        handleEntry(entry).then(() => {
          if (!aborted) zip.readEntry()
        }).catch(reject)
      })
      zip.readEntry()
    })
  } catch (err) {
    throw friendlyError(err)
  } finally {
    try { zip.close() } catch { /* 关不掉不影响结果 */ }
  }
  return { entries, totalBytes }
}

module.exports = {
  LIMITS,
  CancelledError,
  crc32,
  entryRole,
  writeArchive,
  extractToDir,
  ENTRY_PATTERNS,
}

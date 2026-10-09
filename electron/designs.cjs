/** Versioned background artwork. Original image bytes are retained indefinitely. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const os = require('os')
const { loadJson, saveJson, resolveInsideDataDir } = require('./store.cjs')
const { imageSizeFromBuffer, sniffImageExt } = require('./images.cjs')
const { normalizeDesign, collectFontFamilies } = require('./design-layout.cjs')

const MAX_BYTES = 64 * 1024 * 1024
const MAX_PROJECT_BYTES = 512 * 1024 * 1024
const MAX_PIXELS = 80000000
const ASSET_ID = /^asset_([a-f0-9]{64})$/
const DESIGN_ID = /^design_[a-f0-9]{24}$/
const DATA_DIR = process.env.PRINTPRESS_DATA_DIR
/**
 * 保存锁的最终兜底超时（与 PID 无关）。
 *
 * `withLock` 的临界区只做「读索引 + 读单个版本 JSON + statSync 字体 + 两次原子写」，
 * 素材字节的哈希与校验都在锁外，正常远低于 1 分钟。活着的 PID 却持有超过 1 小时的锁，
 * 只可能是「旧进程崩溃后 PID 被复用」——此时 `process.kill(pid, 0)` 会误判为活锁，
 * 没有这条兜底就会永久锁死保存（且没有任何自助恢复入口）。
 */
const LOCK_TTL_MS = 60 * 60 * 1000
// Metadata only: source bytes are hashed on every read, but a known hash need not be inflated again.
const VERIFIED_IMAGES = new Map()

function projectId(id) {
  if (typeof id !== 'string' || !DESIGN_ID.test(id)) throw new Error('底图工程标识无效')
  return id
}
function index() { return loadJson('designs', { expect: 'array' }) || [] }
function withLock(run) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const lock = path.join(DATA_DIR, 'designs.write.lock')
  const ownerName = `${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`
  const pending = path.join(DATA_DIR, `.design-lock-${ownerName}`)
  fs.mkdirSync(pending)
  fs.writeFileSync(path.join(pending, ownerName), JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
  let acquired = false
  try {
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try { fs.renameSync(pending, lock); acquired = true } catch (err) {
        if (!fs.existsSync(lock)) throw err
        if (!recoverAbandonedLock(lock)) {
          // 把锁的绝对路径写进报错：重试解决不了残留锁，用户/agent 需要知道删什么。
          throw new Error(`底图工程正在由另一个进程保存，请稍后重试（若长期如此，可关闭所有批印坊窗口后删除：${lock}）`)
        }
      }
    }
    if (!acquired) throw new Error('底图工程正在保存，请稍后重试')
    return run()
  } finally {
    // 清理失败绝不能顶掉 run() 的真实结果：这里只尽力而为，剩下的由下一次
    // withLock 的 recoverAbandonedLock 回收（空目录会被直接 rmdir 掉）。
    const owned = acquired ? lock : pending
    try { fs.unlinkSync(path.join(owned, ownerName)) } catch { /* 已被清理或不可删 */ }
    try { fs.rmdirSync(owned) } catch { /* 非空/占用/已不存在都留给下一次回收 */ }
  }
}
function recoverAbandonedLock(lock) {
  let stat
  try { stat = fs.statSync(lock) } catch (err) { if (err.code === 'ENOENT') return true; throw err }
  // 本模块的锁一律是目录（由 rename 一个非空 pending 目录产生）。这个位置出现普通文件
  // 只可能是外部误建（杀软 / 同步盘 / 手工），它永远不会被我们释放——直接清掉，
  // 否则保存会永久报「另一个进程正在保存」且无路可走。
  if (!stat.isDirectory()) {
    try { fs.unlinkSync(lock); return true } catch (err) { return err.code === 'ENOENT' }
  }
  const owners = fs.readdirSync(lock)
  for (const name of owners) {
    if (!/^\d+-[a-f0-9]+\.json$/.test(name)) return false
    const file = path.join(lock, name)
    let owner
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
      if (err.code === 'ENOENT') continue
      return false
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.createdAt)) return false
    let alive = true
    try { process.kill(owner.pid, 0) } catch (err) { if (err.code === 'ESRCH') alive = false }
    // 早于本次开机 = 上一次开机留下的残留。
    if (owner.createdAt < Date.now() - os.uptime() * 1000 - 5000) alive = false
    // PID 复用兜底：临界区远短于 TTL，所以「PID 还活着但锁已超过 TTL」只可能是残留锁。
    if (owner.createdAt < Date.now() - LOCK_TTL_MS) alive = false
    if (alive) return false
    // Only remove the unique dead owner's file; another process's new lock is nonempty.
    try { fs.unlinkSync(file) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
  try { fs.rmdirSync(lock); return true } catch (err) {
    if (err.code === 'ENOENT') return true
    if (['ENOTEMPTY', 'EEXIST'].includes(err.code)) return false
    throw err
  }
}
function atomicFile(file, bytes) {
  // assertRealDataPath 会 realpathSync(DATA_DIR)，所以数据目录必须先存在。
  // 导入素材这条路径不持锁（importBuffer 不做 withLock），不能依赖 withLock 建目录：
  // 否则全新数据目录下第一次导入会抛原生 ENOENT。
  fs.mkdirSync(DATA_DIR, { recursive: true })
  let existing = path.dirname(file)
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  assertRealDataPath(existing)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  assertRealDataPath(path.dirname(file))
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
function revisionPath(id, revision) {
  projectId(id)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('底图版本无效')
  return resolveInsideDataDir(`designs/${id}/${revision}.json`)
}
function readRevision(id, revision) {
  revisionPath(id, revision)
  const file = guardedFile(`designs/${id}/${revision}.json`, 'designs')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function guardedFile(relative, directory) {
  const absolute = resolveInsideDataDir(relative)
  const allowed = resolveInsideDataDir(directory)
  const real = fs.realpathSync(absolute)
  const root = fs.realpathSync(allowed)
  assertRealDataPath(root)
  const inside = path.relative(root, real)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('素材路径越界')
  return real
}
function assertRealDataPath(file) {
  const root = fs.realpathSync(DATA_DIR)
  const real = fs.realpathSync(file)
  const relative = path.relative(root, real)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('存储路径越界（符号链接）')
}
function readAsset(id, claimedPath) {
  const match = typeof id === 'string' && ASSET_ID.exec(id)
  if (!match) throw new Error('素材标识无效')
  let asset
  try { asset = JSON.parse(fs.readFileSync(guardedFile(`design-assets/${match[1]}.json`, 'design-assets'), 'utf8')) } catch (err) {
    throw new Error(`找不到底图素材 ${id}：${err.message}`)
  }
  if (!asset || asset.id !== id || !['image/png', 'image/jpeg'].includes(asset.mime)) throw new Error('底图素材记录损坏')
  const expected = `design-assets/${match[1]}.${asset.mime === 'image/png' ? 'png' : 'jpg'}`
  if (asset.path !== expected || (claimedPath !== undefined && claimedPath !== expected)) throw new Error('底图素材路径不一致')
  const abs = guardedFile(expected, 'design-assets')
  const size = fs.statSync(abs).size
  if (size <= 0 || size > MAX_BYTES) throw new Error('底图素材文件大小无效')
  const bytes = fs.readFileSync(abs)
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new Error('底图素材原件已改变，请重新导入')
  const measured = VERIFIED_IMAGES.get(match[1]) || validateImage(bytes)
  VERIFIED_IMAGES.set(match[1], measured)
  if (asset.width !== measured.width || asset.height !== measured.height || asset.mime !== measured.mime) throw new Error('底图素材尺寸记录不一致')
  return { asset: { id, path: expected, name: String(asset.name || '图片').slice(0, 200), width: measured.width, height: measured.height, mime: measured.mime }, bytes: size }
}
function canonicalAssets(doc) {
  let total = 0
  for (const [id, asset] of Object.entries(doc.assets)) {
    const trusted = readAsset(id, asset.path)
    doc.assets[id] = trusted.asset
    total += trusted.bytes
  }
  if (total > MAX_PROJECT_BYTES) throw new Error('底图素材总大小不能超过 512 MB')
  return doc
}
function canonicalFonts(doc, previous = {}) {
  const uploaded = require('./fonts.cjs').uploadedFonts()
  const references = {}
  for (const family of collectFontFamilies(doc)) {
    const file = (Object.hasOwn(doc.fontAssets, family) ? doc.fontAssets[family] : null) ||
      (Object.hasOwn(previous, family) ? previous[family] : null) || (uploaded.find(font => font.family === family) || {}).file
    if (!file) continue
    const expectedFamily = file.replace(/\.[^.]+$/, '')
    if (expectedFamily !== family) throw new Error(`底图字体素材与名称不一致：${family}`)
    try {
      const absolute = guardedFile(`print-fonts/${file}`, 'print-fonts')
      if (!fs.statSync(absolute).isFile() || fs.statSync(absolute).size === 0) throw new Error('文件为空')
    } catch (err) { throw new Error(`底图所用上传字体缺失或不可读：${family}（${err.message}）`) }
    references[family] = file
  }
  doc.fontAssets = references
  return doc
}
function listDesigns() {
  return index().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}
function getDesign(id, revision) {
  projectId(id)
  const head = index().find(d => d.id === id)
  if (!head) throw new Error('底图工程不存在或已删除')
  const rev = revision === undefined ? head.revision : revision
  if (!Number.isSafeInteger(rev) || rev < 1 || rev > head.revision) throw new Error('底图版本不存在或尚未提交')
  let doc
  try { doc = normalizeDesign(readRevision(id, rev)) } catch (err) {
    throw new Error(`读取底图工程失败：${err.message}`)
  }
  if (doc.id !== id || doc.revision !== rev) throw new Error('底图版本记录损坏')
  return canonicalFonts(canonicalAssets(doc))
}
function resolveDesign(ref) {
  if (!ref || typeof ref !== 'object') throw new Error('底图工程引用无效')
  // Templates must pin a committed revision, never silently follow the head.
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('底图模板必须指定已保存的版本')
  return getDesign(ref.id, ref.revision)
}

/** Validate a current editing snapshot for output without committing a revision. */
function resolveDraft(input) {
  const doc = normalizeDesign(input)
  let previousFonts = {}
  if (doc.id && doc.revision > 0) previousFonts = readRevision(doc.id, doc.revision).fontAssets || {}
  return canonicalFonts(canonicalAssets(doc), previousFonts)
}
function saveDesign(input) {
  const doc = canonicalAssets(normalizeDesign(input))
  return withLock(() => {
    const all = index()
    const head = doc.id ? all.find(d => d.id === projectId(doc.id)) : null
    if (doc.id && !head) throw new Error('底图工程不存在，若要恢复副本请使用另存为')
    if (head && doc.revision !== head.revision) {
      const err = new Error(`底图已更新至版本 ${head.revision}，当前版本 ${doc.revision} 不能覆盖，请重新打开或另存副本`)
      err.code = 'DESIGN_CONFLICT'
      throw err
    }
    if (!head && doc.revision !== 0) throw new Error('新工程版本必须为 0')
    const previousFonts = head ? readRevision(head.id, head.revision).fontAssets || {} : {}
    canonicalFonts(doc, previousFonts)
    const now = new Date().toISOString()
    const saved = { ...doc, id: head ? head.id : `design_${crypto.randomBytes(12).toString('hex')}`, revision: head ? head.revision + 1 : 1, createdAt: head ? head.createdAt : now, updatedAt: now }
    const target = revisionPath(saved.id, saved.revision)
    // An uncommitted orphan from a terminated write may be replaced; committed files never are.
    atomicFile(target, JSON.stringify(saved, null, 2))
    const summary = { id: saved.id, revision: saved.revision, name: saved.name, artboard: saved.artboard, layerCount: saved.layers.length, createdAt: saved.createdAt, updatedAt: now }
    const updated = all.filter(d => d.id !== saved.id).concat(summary)
    try { saveJson('designs', updated) } catch (err) {
      try { fs.unlinkSync(target) } catch { /* Orphan is unreachable until a successful retry. */ }
      throw err
    }
    return saved
  })
}
function deleteDesign(id) {
  projectId(id)
  return withLock(() => {
    const all = index()
    if (!all.some(d => d.id === id)) throw new Error('底图工程不存在或已删除')
    const used = (loadJson('templates', { expect: 'array' }) || []).filter(t => t.backgroundDesign && t.backgroundDesign.id === id)
    if (used.length) throw new Error(`底图正在被模板使用：${used.map(t => t.name).join('、')}，请先移除引用`)
    saveJson('designs', all.filter(d => d.id !== id))
    // Keep source bytes and revision documents for unsaved drafts and undo history.
    return { ok: true }
  })
}

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
function validatePng(buf, size) {
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG 文件签名损坏')
  let offset = 8
  const compressed = []
  let header = null
  let ended = false
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    if (offset + length + 12 > buf.length) throw new Error('PNG 文件内容不完整')
    const type = buf.toString('ascii', offset + 4, offset + 8)
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== buf.readUInt32BE(offset + 8 + length)) throw new Error('PNG 文件校验失败')
    const chunk = buf.subarray(offset + 8, offset + 8 + length)
    if (offset === 8 && type !== 'IHDR') throw new Error('PNG 缺少图像头')
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('PNG 图像头无效')
      header = chunk
    }
    if (type === 'IDAT') compressed.push(chunk)
    offset += length + 12
    if (type === 'IEND') { ended = length === 0 && offset === buf.length; break }
  }
  if (!header || !ended || !compressed.length) throw new Error('PNG 文件内容不完整')
  const depth = header[8]
  const type = header[9]
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[type]
  if (!channels || !depths.includes(depth) || header[10] || header[11] || header[12] > 1) throw new Error('PNG 图像编码无效')
  const passes = header[12] === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
  const rows = []
  let expected = 0
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((size.width - x) / dx))
    const h = Math.max(0, Math.ceil((size.height - y) / dy))
    if (!w || !h) continue
    const row = Math.ceil(w * channels * depth / 8) + 1
    rows.push([row, h]); expected += row * h
  }
  if (expected > 256 * 1024 * 1024) throw new Error('PNG 解码内存超过 256 MB，请减少图片像素')
  let decoded
  try { decoded = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }) } catch { throw new Error('PNG 图片像素数据损坏') }
  if (decoded.length !== expected) throw new Error('PNG 图片像素数据长度不符')
  let pos = 0
  for (const [row, count] of rows) for (let i = 0; i < count; i++) {
    if (decoded[pos] > 4) throw new Error('PNG 像素过滤器无效')
    pos += row
  }
}
function validateImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_BYTES) throw new Error('图片内容为空或超过 64 MB')
  const ext = sniffImageExt(buf)
  let size
  try { size = imageSizeFromBuffer(buf) } catch { throw new Error('图片内容不完整') }
  if (!ext || !size || !size.width || !size.height || size.width > 24000 || size.height > 24000 || size.width * size.height > MAX_PIXELS) throw new Error('仅支持有效的 PNG/JPEG 图片，单边不超过 24000 像素且总像素不超过 8000 万')
  if (ext === '.png') validatePng(buf, size)
  else if (buf.lastIndexOf(Buffer.from([255, 217])) < 4 || buf.indexOf(Buffer.from([255, 218])) < 4) throw new Error('JPEG 图片内容不完整')
  const orientation = ext === '.jpg' ? jpegOrientation(buf) : 1
  return { ...(orientation >= 5 ? { width: size.height, height: size.width } : size), ext, mime: ext === '.png' ? 'image/png' : 'image/jpeg' }
}
function jpegOrientation(buf) {
  let offset = 2
  while (offset + 4 <= buf.length && buf[offset] === 255) {
    const marker = buf[offset + 1]
    if (marker === 218 || marker === 217) break
    const length = buf.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buf.length) break
    const start = offset + 4
    if (marker === 225 && length >= 16 && buf.toString('ascii', start, start + 6) === 'Exif\0\0') {
      const tiff = start + 6
      const end = offset + 2 + length
      const little = buf.toString('ascii', tiff, tiff + 2) === 'II'
      if (!little && buf.toString('ascii', tiff, tiff + 2) !== 'MM') return 1
      const u16 = pos => little ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos)
      const u32 = pos => little ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos)
      if (tiff + 8 > end || u16(tiff + 2) !== 42) return 1
      const directory = tiff + u32(tiff + 4)
      if (directory < tiff + 8 || directory + 2 > end) return 1
      const count = u16(directory)
      for (let i = 0; i < count; i++) {
        const entry = directory + 2 + i * 12
        if (entry + 12 > end) break
        if (u16(entry) === 274 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
          const value = u16(entry + 8)
          return value >= 1 && value <= 8 ? value : 1
        }
      }
    }
    offset += length + 2
  }
  return 1
}
function importBuffer(buf, name) {
  const size = validateImage(buf)
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  VERIFIED_IMAGES.set(hash, size)
  const id = `asset_${hash}`
  const relative = `design-assets/${hash}${size.ext}`
  const asset = { id, path: relative, width: size.width, height: size.height, mime: size.mime, name: path.basename(String(name || '图片')).replace(/[\x00-\x1f]/g, '').slice(0, 200) || '图片' }
  const target = resolveInsideDataDir(relative)
  const metadata = resolveInsideDataDir(`design-assets/${hash}.json`)
  if (fs.existsSync(metadata)) return readAsset(id).asset
  atomicFile(target, buf)
  atomicFile(metadata, JSON.stringify(asset, null, 2))
  return asset
}
function importImageBytes({ name, base64 } = {}) {
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('图片 base64 内容无效或超过 64 MB')
  return importBuffer(Buffer.from(base64, 'base64'), name)
}
function importImageFile(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('图片文件无效或超过 64 MB')
  return importBuffer(fs.readFileSync(filePath), path.basename(filePath))
}
function importLegacyBackground({ background, w, h, name } = {}) {
  if (typeof background !== 'string' || !/^print-bg\/[^/\\]+\.(png|jpe?g)$/i.test(background)) throw new Error('旧底图路径无效')
  const board = normalizeDesign({ name: name || '导入底图', artboard: { w, h }, layers: [], assets: {} })
  const asset = importImageFile(guardedFile(background, 'print-bg'))
  return normalizeDesign({ ...board, assets: { [asset.id]: asset }, layers: [{ id: `layer_${crypto.randomBytes(6).toString('hex')}`, type: 'image', name: '原有底图', assetId: asset.id, x: 0, y: 0, w: board.artboard.w, h: board.artboard.h, locked: true }] })
}
function fontUsedBy(family) {
  const names = new Set()
  for (const head of index()) {
    for (let revision = 1; revision <= head.revision; revision++) {
      const doc = normalizeDesign(readRevision(head.id, revision))
      if (collectFontFamilies(doc).includes(family)) names.add(`${head.name}（底图版本 ${revision}）`)
    }
  }
  return [...names]
}

module.exports = { listDesigns, getDesign, resolveDesign, resolveDraft, saveDesign, deleteDesign, importImageBytes, importImageFile, importLegacyBackground, fontUsedBy }

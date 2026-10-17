/**
 * 本地素材库：在现有**内容寻址**原件之上加一层「给人看的」元数据。
 *
 * ── 它和底图素材的关系（本模块最重要的一条边界）────────────────────
 * 原件**已经**按内容寻址存在两个池子里（见 designs.cjs，I-51）：
 *   - `design-assets/`：素材库受管理原件（managed）——本模块服务的就是这个池；
 *   - `ephemeral-assets/`：临时底图原件（ephemeral，模板页上传 / 制作页粘贴拖入）。
 * 同一字节内容天然只存一份。本模块**不复制、不移动、不重命名**任何原件，
 * 只在 `asset-library.json` 里记「这个原件叫什么、有什么标签、收不收藏、归档了没」。
 *
 * 由此推出三条硬性质（改代码前先读）：
 *   1. **同一内容对应一份原件**：条目以 `assetId`（= `asset_<sha256>`）为主键，
 *      重复导入只会合并条目，不会多出一份字节。
 *   2. **改库名 / 标签 / 收藏不改写旧工程**：展示元数据只活在本文件里，
 *      旧工程的 `assets[].name` 一概不动——改名是「素材库里的叫法」，不是「工程里的名字」。
 *   3. **归档不删原件**：归档只是从常用列表隐藏（`archivedAt` 非空），
 *      原件与仍引用它的历史工程照常打开、照常打印。
 *
 * ── 缩略图 ────────────────────────────────────────────────────────
 * `design-thumbnails/<sha256>.png`，最长边 320 像素，**只是列表用的缓存**：
 * 画板、打印和工程包一律读原件，绝不读缩略图。缓存随时可删、可重建。
 *
 * 生成缩略图要解码 PNG/JPEG，纯 Node 没有这个能力 ⇒ 走**注入回调**
 * `options.makeThumbnail`（宿主用 Electron 的 nativeImage 实现）。
 * 本模块因此保持**零 electron 依赖**——纯 Node 下列表、搜索、归档全部可用，
 * 只是没有缩略图（调用方不传回调即可，不会报错）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { loadJson, saveJson, resolveInsideDataDir } = require('./store.cjs')
const assetStorage = require('./asset-storage.cjs')
const designs = require('./designs.cjs')
const { normalizeSource } = require('./design-layout.cjs')

const ASSET_ID = /^asset_([a-f0-9]{64})$/
const THUMB_DIR = 'design-thumbnails'
const THUMB_MAX_SIDE = 320
const LIMITS = { displayName: 80, tags: 20, tag: 24, pageSize: 200, defaultPageSize: 60 }

function index() {
  return loadJson('asset-library', { expect: 'array' }) || []
}
function persist(all) {
  saveJson('asset-library', all)
}
function effectiveSource(entry) {
  const id = entry && entry.assetId
  if (typeof id !== 'string' || !ASSET_ID.test(id)) return normalizeSource(entry && entry.source)
  const originalSource = designs.assetSource(id)
  // The immutable original metadata is authoritative when it has an explicit
  // lifecycle marker. Older metadata falls back to the index; missing values
  // remain managed for backwards-compatible, fail-safe retention.
  return originalSource || normalizeSource(entry.source)
}
function pruneEphemeralEntries(entries = index()) {
  const managed = entries.filter(entry => effectiveSource(entry) !== 'ephemeral')
  if (managed.length !== entries.length) persist(managed)
  return managed
}
function assetIdOf(id) {
  if (typeof id !== 'string' || !ASSET_ID.test(id)) throw new Error('素材标识无效')
  return id
}
/** `asset_<sha256>` → 64 位十六进制；缩略图文件名只由它推导，不含任何用户输入。 */
function hashOf(assetId) {
  return ASSET_ID.exec(assetIdOf(assetId))[1]
}
function thumbRelative(assetId) {
  return `${THUMB_DIR}/${hashOf(assetId)}.png`
}
/**
 * 素材库原件所在目录的**绝对路径**（默认 `<dataDir>/design-assets`，可由后端配置独立目录）。
 *
 * 只服务于「打开素材库文件夹」这一个动作。路径完全由本模块按数据目录推导，
 * **不接受任何外部输入**——它会交给 `shell.openPath`（启动系统程序），
 * 渲染进程若能指定路径就等于拿到「以当前用户身份打开任意文件」的能力（同 I-28 口径）。
 * 目录可能尚不存在（从未导入过素材），这里顺手建出来，保证按钮点了总能用。
 *
 * 临时底图在另一个池（`ephemeral-assets/`，I-51），不是素材库的一部分，不开这里。
 */
function originalsDir() {
  const dir = assetStorage.poolDir(designs.POOL_MANAGED)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function cleanText(value, max, fallback) {
  const text = String(value == null ? '' : value).replace(/[\x00-\x1f]/g, '').trim().slice(0, max)
  return text || fallback
}
function cleanTags(value, fallback) {
  const raw = Array.isArray(value) ? value : fallback
  const seen = new Set()
  const tags = []
  for (const item of raw) {
    const tag = cleanText(item, LIMITS.tag, '')
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= LIMITS.tags) break
  }
  return tags
}
/** 原子写：先写临时文件再 rename，中途被杀不会留半截缩略图。 */
function atomicWrite(absolute, bytes) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temp = `${absolute}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' })
    fs.renameSync(temp, absolute)
  } finally {
    try { fs.unlinkSync(temp) } catch { /* 已改名成功 */ }
  }
}

// ─────────────────────────── 缩略图 ───────────────────────────

/**
 * 生成（或重建）缩略图。
 *
 * 失败一律吞掉：缩略图是缓存，**它的成败绝不能影响入库和使用**。
 * 没有 `makeThumbnail` 回调（纯 Node）或缩略图已存在时直接返回原样。
 */
function ensureThumbnail(entry, options, force = false) {
  const make = options && options.makeThumbnail
  if (!make) return entry
  const relative = thumbRelative(entry.assetId)
  const absolute = resolveInsideDataDir(relative)
  if (!force && entry.thumbFile === relative && fs.existsSync(absolute)) return entry
  try {
    // 原件经 designs 校验（哈希核对）后才解码：绝不缩略一个已被改动的文件
    const { buffer } = designs.assetBytes(entry.assetId)
    const png = make({ buffer, maxSide: THUMB_MAX_SIDE })
    if (!Buffer.isBuffer(png) || !png.length) return entry
    atomicWrite(absolute, png)
    entry.thumbFile = relative
  } catch {
    // 缩略图生成失败：条目照常可用，列表退化为「无缩略图」占位
  }
  return entry
}

// ─────────────────────────── 读 ───────────────────────────

/**
 * 原件还在不在（只做**存在性**探测：不读字节、不校验哈希——列表要快）。
 *
 * 素材库索引与原件是两套东西：用户在文件管理器里删掉 `design-assets/<hash>.png`，
 * 或清理工具误删，索引里那条记录**不会自动消失**。这种「点开就是空图」的条目
 * 不该继续出现在列表里，但也不能静默丢掉记录 ⇒ 列表把它们单独报出来（`missing`），
 * 由界面提示用户「文件已被删除」。
 *
 * 两个池子都探（managed 优先）：受管理件正常只应在 `design-assets/`，但 adopt 迁移 /
 * 旧数据的中间态可能还在另一个池——探测到哪份算哪份，路由交给 designs.cjs。
 *
 * @returns {string|null} `<pool>/<hash>.<ext>` 相对路径；原件不在则 null
 */
function originalRelative(assetId) {
  let hash
  try { hash = hashOf(assetId) } catch { return null }
  for (const pool of designs.ASSET_POOLS) {
    for (const ext of ['png', 'jpg']) {
      const relative = `${pool}/${hash}.${ext}`
      try { if (fs.existsSync(assetStorage.resolveAssetPath(relative))) return relative } catch { /* 越界或不存在 */ }
    }
  }
  return null
}

/**
 * 素材列表：搜索 + 标签筛选 + 收藏 + 归档 + 分页。
 *
 * 排序：**收藏的排前面**，再按更新时间倒序——「常用素材」应该一眼看到，
 * 而不是被最近一次批量导入淹掉。
 *
 * 标签筛选是 **AND**（选中的标签要全部命中）：多点是收窄，不是扩大。
 * 分页是硬要求（计划 §3.2「列表分页并限制单页数量」），大素材库不能一次全量返回。
 *
 * **原件已被删除的条目不进列表**（`items` / `total` 都不含），另外经 `missing`
 * 单独报给界面——它们既渲染不出来也插不进画布，混在列表里只会让用户白点一次。
 */
function listLibrary(opts = {}) {
  const category = ['design', 'photo', 'all'].includes(opts.category) ? opts.category : 'design'
  const photoIds = new Set()
  for (const binding of loadJson('photo-bindings', { expect: 'array' }) || []) {
    for (const file of binding.files || []) if (file.assetId) photoIds.add(file.assetId)
  }
  const designIds = new Set()
  for (const head of designs.listDesigns()) {
    const doc = designs.getDesign(head.id)
    for (const id of Object.keys(doc.assets || {})) designIds.add(id)
  }
  for (const id of require('./templates.cjs').listReferencedAssetIds()) designIds.add(id)
  const query = cleanText(opts.query, 80, '').toLowerCase()
  const tags = Array.isArray(opts.tags) ? opts.tags.map((t) => cleanText(t, LIMITS.tag, '').toLowerCase()).filter(Boolean) : []
  const includeArchived = opts.includeArchived === true
  const favoriteOnly = opts.favoriteOnly === true
  const page = Math.max(1, Number.parseInt(opts.page, 10) || 1)
  const pageSize = Math.min(LIMITS.pageSize, Math.max(1, Number.parseInt(opts.pageSize, 10) || LIMITS.defaultPageSize))

  const matched = pruneEphemeralEntries().filter((entry) => {
    const photo = entry.roles?.includes('photo') || photoIds.has(entry.assetId)
    const design = entry.roles?.includes('design') || designIds.has(entry.assetId) || !photo
    if (category === 'photo' && !photo || category === 'design' && !design) return false
    if (!includeArchived && entry.archivedAt) return false
    // 分流切口：list 只展示「受管理」原件（normalizeSource !== 'ephemeral'）。
    // 模板页上传 / 底图制作页直接加图的底图落在另一个池（ephemeral-assets/）、受引用扫描保护，
    // 但不进素材库列表（用户明确：列表只来源于受管理件）。
    if (favoriteOnly && !entry.favorite) return false
    if (tags.length && !tags.every((tag) => (entry.tags || []).some((t) => t.toLowerCase() === tag))) return false
    if (!query) return true
    return entry.displayName.toLowerCase().includes(query) ||
      (entry.tags || []).some((tag) => tag.toLowerCase().includes(query))
  })
  matched.sort((a, b) => {
    if (Boolean(a.favorite) !== Boolean(b.favorite)) return a.favorite ? -1 : 1
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })

  // 分流必须在分页**之前**：否则 total 会把死条目算进去，末页还会出现「空一格」。
  const alive = []
  const missing = []
  for (const entry of matched) {
    if (originalRelative(entry.assetId)) alive.push(entry)
    else missing.push({ assetId: entry.assetId, displayName: entry.displayName })
  }

  const start = (page - 1) * pageSize
  return {
    items: alive.slice(start, start + pageSize),
    total: alive.length,
    category,
    page,
    pageSize,
    missing,
  }
}

function getEntry(assetId) {
  const id = assetIdOf(assetId)
  const found = pruneEphemeralEntries().find((entry) => entry.assetId === id)
  if (!found) throw new Error('素材库里没有这个素材')
  return found
}

function snapshotImportEntry(assetId) {
  const id = assetIdOf(assetId)
  return pruneEphemeralEntries().find(entry => entry.assetId === id) || null
}
function restoreImportEntry(assetId, previous, removeOriginal = true) {
  const id = assetIdOf(assetId)
  const all = index().filter(entry => entry.assetId !== id)
  if (previous && previous.assetId === id) all.push(previous)
  persist(all)
  if (!previous && removeOriginal) return removeImportAssetIfUnreferenced(id)
  return { removed: false }
}

/** 全部标签（供筛选器用），按使用次数倒序。 */
function listTags() {
  const counts = new Map()
  for (const entry of pruneEphemeralEntries()) {
    if (entry.archivedAt) continue
    for (const tag of entry.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }))
}

// ─────────────────────────── 写 ───────────────────────────

/**
 * 入库（或合并已有条目）。`asset` 是 designs 导入原件后返回的描述
 * （`{ id, path, width, height, mime, name }`），本模块不自己读文件。
 *
 * ⚠️ **同内容重复导入 = 合并并恢复归档**，不是报错也不是新建第二条：
 * 用户把同一张图换个名字再导一次，是他想「找回来」，不是想多一份。
 */
function upsert(asset, metadata = {}, options = {}) {
  const id = assetIdOf(asset && asset.id)
  const all = pruneEphemeralEntries()
  const now = new Date().toISOString()
  const existing = all.find((entry) => entry.assetId === id)
  const entry = {
    assetId: id,
    displayName: cleanText(metadata.displayName, LIMITS.displayName, existing ? existing.displayName : cleanText(asset.name, LIMITS.displayName, '图片')),
    tags: metadata.tags === undefined ? (existing ? existing.tags : []) : cleanTags(metadata.tags, []),
    favorite: metadata.favorite === undefined ? Boolean(existing && existing.favorite) : metadata.favorite === true,
    roles: [...new Set([...(Array.isArray(existing?.roles) ? existing.roles.filter(role => ['design', 'photo'].includes(role)) : []),
      ...(['design', 'photo'].includes(metadata.role) ? [metadata.role] : [])])],
    // source 分流：缺省视为 'managed'（受管理，绝不误删既有图）；
    // 单向升级——已是 managed 绝不降级回 ephemeral（一旦进过素材库即受管理）。
    source: existing && normalizeSource(existing.source) === 'managed' ? 'managed' : normalizeSource(metadata.source),
    archivedAt: null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    thumbFile: existing ? existing.thumbFile : null,
  }
  ensureThumbnail(entry, options)
  persist(all.filter((item) => item.assetId !== id).concat(entry))
  return entry
}

/**
 * 把**已有工程里的图片**建成素材库条目（计划 §3.1 第 5 条）。
 *
 * 与 `upsert` 的区别：不导入任何新字节（原件早就在），只补一条展示元数据。
 * 原文件缺失会抛错——不能给用户建一条点开就丢图的条目。
 */
function adopt(assetId, metadata = {}, options = {}) {
  const id = assetIdOf(assetId)
  const info = designs.assetInfo(id) // 原件不存在会在这里抛错
  // 单向升级：把原件 source 从可能的 'ephemeral' 升为 'managed'，
  // 这样模板即便仍引用它，discard 也不再即时删除（受管理）。
  designs.setAssetSource(id, 'managed')
  return upsert(info, { ...metadata, role: 'design', source: 'managed' }, options)
}

/** 改展示信息：只动 displayName / tags / favorite 三项，其余字段调用方说了不算。 */
function updateMetadata(assetId, patch = {}, options = {}) {
  const id = assetIdOf(assetId)
  const all = pruneEphemeralEntries()
  const found = all.find((entry) => entry.assetId === id)
  if (!found) throw new Error('素材库里没有这个素材')
  const entry = {
    ...found,
    displayName: patch.displayName === undefined ? found.displayName : cleanText(patch.displayName, LIMITS.displayName, found.displayName),
    tags: patch.tags === undefined ? found.tags : cleanTags(patch.tags, []),
    favorite: patch.favorite === undefined ? found.favorite : patch.favorite === true,
    updatedAt: new Date().toISOString(),
  }
  persist(all.map((item) => (item.assetId === id ? entry : item)))
  return entry
}

/** 归档：只是隐藏，原件与引用它的历史工程一概不动。 */
function archive(assetId) {
  return setArchived(assetId, new Date().toISOString())
}
function restore(assetId) {
  return setArchived(assetId, null)
}
function setArchived(assetId, archivedAt) {
  const id = assetIdOf(assetId)
  const all = pruneEphemeralEntries()
  const found = all.find((entry) => entry.assetId === id)
  if (!found) throw new Error('素材库里没有这个素材')
  const entry = { ...found, archivedAt, updatedAt: new Date().toISOString() }
  persist(all.map((item) => (item.assetId === id ? entry : item)))
  return entry
}

/** 重建缩略图（缓存被清掉后调用）。原件没了会抛错，不会静默留下坏缓存。 */
function rebuildThumbnail(assetId, options) {
  const entry = getEntry(assetId)
  ensureThumbnail(entry, options, true)
  persist(index().map((item) => (item.assetId === entry.assetId ? entry : item)))
  return entry
}

// ─────────────────────────── 清理未引用原件 ───────────────────────────
//
// I-32 清理未引用原件：删除前必须复核仍孤儿，绝不静默删被引用的图。
// 内容寻址池（`design-assets/` 与 `ephemeral-assets/`，见 designs.cjs 的池定义）永不被
// 「删图层 / 删工程 / 归档」触碰（I-31 原则③），长期会膨胀。这里只做**显式、可选**的回收：把「既不在任何工程、也不在素材库」
// 的孤立原件列出来，用户确认后才删；删除时再算一遍引用，期间被用上的就跳过。

const HASH_RE = /^[a-f0-9]{64}$/
/**
 * 收集「当前仍持有这份原件」的一切引用。
 * `options.exceptDesignId`：跳过指定工程（I-33 扩展）。底图制作页删除图层的瞬间，
 * 内存里的工程文档才是权威状态，磁盘上还是上次保存的旧版——若照算就会误判
 * 「仍被引用」而拒绝同步删除。其余工程 / 素材库 / 模板背景照常保护。
 */
function referencedAssetIds(options = {}) {
  const exceptDesignId = options && options.exceptDesignId ? options.exceptDesignId : null
  const excludedLibraryIds = new Set(options && Array.isArray(options.excludeLibraryAssetIds) ? options.excludeLibraryAssetIds : [])
  const refs = new Set()
  for (const id of options.protectedIds || []) if (ASSET_ID.test(id)) refs.add(id)
  // 素材库（含已归档）：在库里就可能被恢复，算引用
  for (const entry of index()) {
    if (entry.assetId && !excludedLibraryIds.has(entry.assetId) && effectiveSource(entry) !== 'ephemeral') refs.add(entry.assetId)
  }
  // Photo bindings are durable consumers even when a library entry is missing or archived.
  // If this index cannot be read, fail closed: treating it as empty could delete a live photo.
  for (const binding of loadJson('photo-bindings', { expect: 'array' }) || []) {
    for (const file of binding.files || []) if (file.assetId) refs.add(file.assetId)
  }
  for (const override of loadJson('photo-overrides', { expect: 'array' }) || []) {
    if (override.assetId) refs.add(override.assetId)
  }
  const staging = resolveInsideDataDir('photo-import-staging')
  if (fs.existsSync(staging)) {
    const stat = fs.lstatSync(staging)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('照片导入暂存目录无效，已停止资源扫描')
    for (const name of fs.readdirSync(staging)) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue
      const journal = resolveInsideDataDir(`photo-import-staging/${name}/journal.json`)
      if (!fs.existsSync(journal)) throw new Error('照片导入任务记录缺失，已停止资源扫描')
      const info = fs.lstatSync(journal)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('照片导入任务记录无效，已停止资源扫描')
      const task = JSON.parse(fs.readFileSync(journal, 'utf8'))
      if (!Array.isArray(task.assets) || !Array.isArray(task.binding?.files)) throw new Error('照片导入任务记录无效，已停止资源扫描')
      for (const item of [...task.assets, ...task.binding.files]) if (item.assetId) refs.add(item.assetId)
    }
  }
  // 所有工程的图层引用的原件
  for (const head of designs.listDesigns()) {
    if (exceptDesignId && head.id === exceptDesignId) continue
    const doc = designs.getDesign(head.id)
    for (const assetId of Object.keys(doc.assets || {})) refs.add(assetId)
  }
  // 模板背景（assetId）也算引用：否则清理未引用会误删正在用的模板底图
  const templates = require('./templates.cjs')
  for (const assetId of templates.listReferencedAssetIds(options)) refs.add(assetId)
  return refs
}

/**
 * 列出两个原件池里既不被任何工程引用、也不在素材库的孤立原件（I-51：两池都扫）。
 * 返回每项：`{ hash, assetId, bytes, files: [相对路径...] }`（同一 hash 的 png/jpg 与 json 归并）。
 */
function findOrphanOriginals(options = {}) {
  const refs = referencedAssetIds(options)
  const byHash = new Map()
  for (const pool of designs.ASSET_POOLS) {
    const dir = assetStorage.poolDir(pool)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      const m = /^([a-f0-9]{64})\.(json|png|jpe?g)$/i.exec(name)
      if (!m) continue
      const hash = m[1]
      if (refs.has(`asset_${hash}`)) continue // 被引用 → 不是孤儿
      if (!byHash.has(hash)) byHash.set(hash, { hash, assetId: `asset_${hash}`, bytes: 0, files: [] })
      const full = path.join(dir, name)
      const row = byHash.get(hash)
      row.files.push(`${pool}/${name}`)
      try { row.bytes += fs.statSync(full).size } catch { /* 已消失不计 */ }
    }
  }
  return [...byHash.values()]
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('资源目录包含链接，已停止空间盘点')
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) stack.push(path.join(current, name))
    else if (stat.isFile()) bytes += stat.size
  }
  return bytes
}

/** Read-only, hash-deduplicated usage by dataset and storage area. */
function resourceUsage() {
  const dataset = require('./dataset.cjs')
  const { matchPhotos } = require('./photo-match.cjs')
  const physical = new Map()
  let originalBytes = 0
  for (const pool of designs.ASSET_POOLS) {
    const dir = assetStorage.poolDir(pool)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const match = /^([a-f0-9]{64})\.(png|jpe?g)$/i.exec(name)
      if (!match) continue
      const stat = fs.lstatSync(path.join(dir, name))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('素材原件类型无效，已停止空间盘点')
      const id = `asset_${match[1]}`
      physical.set(id, Math.max(physical.get(id) || 0, stat.size))
      originalBytes += stat.size
    }
  }
  const designRefs = new Set()
  for (const head of designs.listDesigns()) {
    const doc = designs.getDesign(head.id)
    for (const id of Object.keys(doc.assets || {})) designRefs.add(id)
  }
  for (const id of require('./templates.cjs').listReferencedAssetIds()) designRefs.add(id)
  const bindings = loadJson('photo-bindings', { expect: 'array' }) || []
  const consumers = new Map()
  const datasets = bindings.map(binding => {
    let ds
    try { ds = dataset.getDataset(binding.datasetId) } catch { ds = null }
    const ids = [...new Set((binding.files || []).map(file => file.assetId).filter(id => ASSET_ID.test(id)))]
    for (const id of ids) consumers.set(id, (consumers.get(id) || 0) + 1)
    const result = ds && ds.photoMatchColumn === binding.column
      ? matchPhotos(ds.rows, binding.column, binding.files || []) : null
    return { datasetId: binding.datasetId, name: ds?.name || '（名单已删除或无法读取）', missingDataset: !ds,
      photoCount: ids.length, matchedPeople: result?.counts.matched || 0,
      rowCount: ds?.rows.length || 0, ids }
  })
  for (const item of datasets) {
    item.logicalBytes = item.ids.reduce((sum, id) => sum + (physical.get(id) || 0), 0)
    item.exclusiveBytes = item.ids.reduce((sum, id) => sum + (consumers.get(id) === 1 && !designRefs.has(id) ? physical.get(id) || 0 : 0), 0)
    item.sharedBytes = item.logicalBytes - item.exclusiveBytes
    delete item.ids
  }
  const dataDir = process.env.PRINTPRESS_DATA_DIR
  const orphan = findOrphanOriginals()
  return {
    datasets, uniqueOriginals: physical.size, originalBytes,
    thumbnailBytes: directoryBytes(resolveInsideDataDir(THUMB_DIR)),
    archiveBytes: directoryBytes(path.join(dataDir, 'archive')),
    stagingBytes: directoryBytes(resolveInsideDataDir('photo-import-staging')),
    orphanCount: orphan.length, orphanBytes: orphan.reduce((sum, item) => sum + item.bytes, 0),
  }
}

/**
 * 删除孤儿原件。入参是 64 位十六进制 hash 列表；删除前**重新**算一遍引用，
 * 期间变成被引用的（竞态）一律跳过，绝不删正在用的图。同时清掉对应缩略图。
 * 两个池子都删（I-51：临时池里的孤儿也可能是脏数据）。
 * 返回 `{ removed, kept }`（kept = 因已非孤儿而被跳过的数量）。
 */
function purgeOrphanOriginals(hashes, options = {}) {
  const list = Array.isArray(hashes) ? hashes : []
  const refs = referencedAssetIds(options)
  let removed = 0
  let kept = 0
  let bytes = 0
  const failed = []
  for (const hash of list) {
    if (!HASH_RE.test(hash)) continue
    if (refs.has(`asset_${hash}`)) { kept++; continue } // 复核：已非孤儿，跳过
    let removedAny = false
    let failedThis = false
    for (const pool of designs.ASSET_POOLS) {
      for (const ext of ['png', 'jpg', 'jpeg', 'json']) {
        const fp = assetStorage.resolveAssetPath(`${pool}/${hash}.${ext}`)
        try {
          const size = fs.lstatSync(fp).size
          fs.unlinkSync(fp)
          bytes += size
          removedAny = true
        } catch (err) { if (err.code !== 'ENOENT') failedThis = true }
      }
    }
    const thumb = resolveInsideDataDir(`${THUMB_DIR}/${hash}.png`)
    try { const size = fs.lstatSync(thumb).size; fs.unlinkSync(thumb); bytes += size; removedAny = true }
    catch (err) { if (err.code !== 'ENOENT') failedThis = true }
    if (failedThis) failed.push(hash)
    else if (removedAny) removed++
  }
  return { removed, kept, bytes, failed }
}

/** Remove one failed photo-import asset after callers have rechecked non-library references. */
function removeImportAssetIfUnreferenced(assetId) {
  const id = assetIdOf(assetId)
  if (referencedAssetIds({ excludeLibraryAssetIds: [id] }).has(id)) return { removed: false }
  const all = index()
  persist(all.filter(entry => entry.assetId !== id))
  const result = purgeOrphanOriginals([hashOf(id)])
  return { removed: result.removed > 0 }
}

/**
 * 即时删除分流入口（I-33）。
 *
 * 仅当原件 `normalizeSource === 'ephemeral'`（模板页上传 / 底图制作页粘贴拖入对话框直接加入）
 * **且**已无任何引用时才删原件；其余情况（`managed` / 已归档 / 仍被引用）一律不删，
 * 只由调用方撤引用。原件生死归素材库，模板层与工程文档只持引用。
 *
 * 临时件的原件在 `ephemeral-assets/`（I-51），删的时候两个池子都清一遍——
 * 旧版本写入的临时件可能还在 `design-assets/`，漏清会让它永远占着盘。
 *
 * `options.exceptDesignId`：引用扫描跳过指定工程（正在编辑、尚未保存的那个——
 * 内存态才是权威，磁盘是旧版）。其他工程的引用照常核对，绝不误删。
 *
 * 删除走 dataDir 守卫（`resolveInsideDataDir` 已越界拦截），绝不删到目录外。
 */
function discardIfEphemeral(assetId, options = {}) {
  const id = assetIdOf(assetId)
  let info
  try { info = designs.assetInfo(id) } catch { return { removed: false } }
  const source = normalizeSource(info.source)
  if (source !== 'ephemeral') return { removed: false } // 受管理原件不即时删
  // Old builds could leave ephemeral originals in the library index without a
  // source marker. Remove those stale rows before checking references so they
  // neither appear in the library nor pin a temporary original on disk.
  const all = index()
  const filtered = all.filter(entry => entry.assetId !== id)
  if (filtered.length !== all.length) persist(filtered)
  const refs = referencedAssetIds(options)
  if (refs.has(id)) return { removed: false } // 仍被引用 → 不删
  const hash = hashOf(id)
  let removed = false
  for (const pool of designs.ASSET_POOLS) {
    for (const ext of ['png', 'jpg', 'jpeg', 'json']) {
      const fp = assetStorage.resolveAssetPath(`${pool}/${hash}.${ext}`)
      try { fs.unlinkSync(fp); removed = true } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
  }
  const thumb = resolveInsideDataDir(`${THUMB_DIR}/${hash}.png`)
  try { if (fs.existsSync(thumb)) fs.unlinkSync(thumb) } catch { /* 缩略图可有可无 */ }
  return { removed }
}

module.exports = {
  listLibrary, getEntry, snapshotImportEntry, restoreImportEntry, listTags, upsert, adopt, updateMetadata, archive, restore, rebuildThumbnail,
  referencedAssetIds, findOrphanOriginals, purgeOrphanOriginals, removeImportAssetIfUnreferenced, discardIfEphemeral, originalsDir,
  resourceUsage,
  THUMB_MAX_SIDE, LIMITS,
}

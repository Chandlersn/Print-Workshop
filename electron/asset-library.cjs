/**
 * 本地素材库：在现有**内容寻址**原件之上加一层「给人看的」元数据。
 *
 * ── 它和底图素材的关系（本模块最重要的一条边界）────────────────────
 * 原件**已经**按内容寻址存在 `design-assets/<sha256>.png|jpg`（见 designs.cjs），
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
const designs = require('./designs.cjs')

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
 * 素材列表：搜索 + 标签筛选 + 收藏 + 归档 + 分页。
 *
 * 排序：**收藏的排前面**，再按更新时间倒序——「常用素材」应该一眼看到，
 * 而不是被最近一次批量导入淹掉。
 *
 * 标签筛选是 **AND**（选中的标签要全部命中）：多点是收窄，不是扩大。
 * 分页是硬要求（计划 §3.2「列表分页并限制单页数量」），大素材库不能一次全量返回。
 */
function listLibrary(opts = {}) {
  const query = cleanText(opts.query, 80, '').toLowerCase()
  const tags = Array.isArray(opts.tags) ? opts.tags.map((t) => cleanText(t, LIMITS.tag, '').toLowerCase()).filter(Boolean) : []
  const includeArchived = opts.includeArchived === true
  const favoriteOnly = opts.favoriteOnly === true
  const page = Math.max(1, Number.parseInt(opts.page, 10) || 1)
  const pageSize = Math.min(LIMITS.pageSize, Math.max(1, Number.parseInt(opts.pageSize, 10) || LIMITS.defaultPageSize))

  const matched = index().filter((entry) => {
    if (!includeArchived && entry.archivedAt) return false
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
  const start = (page - 1) * pageSize
  return { items: matched.slice(start, start + pageSize), total: matched.length, page, pageSize }
}

function getEntry(assetId) {
  const id = assetIdOf(assetId)
  const found = index().find((entry) => entry.assetId === id)
  if (!found) throw new Error('素材库里没有这个素材')
  return found
}

/** 全部标签（供筛选器用），按使用次数倒序。 */
function listTags() {
  const counts = new Map()
  for (const entry of index()) {
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
  const all = index()
  const now = new Date().toISOString()
  const existing = all.find((entry) => entry.assetId === id)
  const entry = {
    assetId: id,
    displayName: cleanText(metadata.displayName, LIMITS.displayName, existing ? existing.displayName : cleanText(asset.name, LIMITS.displayName, '图片')),
    tags: metadata.tags === undefined ? (existing ? existing.tags : []) : cleanTags(metadata.tags, []),
    favorite: metadata.favorite === undefined ? Boolean(existing && existing.favorite) : metadata.favorite === true,
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
  return upsert(info, metadata, options)
}

/** 改展示信息：只动 displayName / tags / favorite 三项，其余字段调用方说了不算。 */
function updateMetadata(assetId, patch = {}, options = {}) {
  const id = assetIdOf(assetId)
  const all = index()
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
  const all = index()
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
// 内容寻址池 `design-assets/<sha256>` 永不被「删图层 / 删工程 / 归档」触碰（I-31 原则③），
// 长期会膨胀。这里只做**显式、可选**的回收：把「既不在任何工程、也不在素材库」
// 的孤立原件列出来，用户确认后才删；删除时再算一遍引用，期间被用上的就跳过。

const HASH_RE = /^[a-f0-9]{64}$/
function referencedAssetIds() {
  const refs = new Set()
  // 素材库（含已归档）：在库里就可能被恢复，算引用
  for (const entry of index()) if (entry.assetId) refs.add(entry.assetId)
  // 所有工程的图层引用的原件
  for (const head of designs.listDesigns()) {
    try {
      const doc = designs.getDesign(head.id)
      for (const assetId of Object.keys(doc.assets || {})) refs.add(assetId)
    } catch { /* 工程读不出不影响其余统计 */ }
  }
  return refs
}

/**
 * 列出 `design-assets/` 里既不被任何工程引用、也不在素材库的孤立原件。
 * 返回每项：`{ hash, assetId, bytes, files: [相对路径...] }`（同一 hash 的 png/jpg 与 json 归并）。
 */
function findOrphanOriginals() {
  const dir = resolveInsideDataDir('design-assets')
  if (!fs.existsSync(dir)) return []
  const refs = referencedAssetIds()
  const byHash = new Map()
  for (const name of fs.readdirSync(dir)) {
    const m = /^([a-f0-9]{64})\.(json|png|jpe?g)$/i.exec(name)
    if (!m) continue
    const hash = m[1]
    if (refs.has(`asset_${hash}`)) continue // 被引用 → 不是孤儿
    if (!byHash.has(hash)) byHash.set(hash, { hash, assetId: `asset_${hash}`, bytes: 0, files: [] })
    const full = path.join(dir, name)
    const row = byHash.get(hash)
    row.files.push(`design-assets/${name}`)
    try { row.bytes += fs.statSync(full).size } catch { /* 已消失不计 */ }
  }
  return [...byHash.values()]
}

/**
 * 删除孤儿原件。入参是 64 位十六进制 hash 列表；删除前**重新**算一遍引用，
 * 期间变成被引用的（竞态）一律跳过，绝不删正在用的图。同时清掉对应缩略图。
 * 返回 `{ removed, kept }`（kept = 因已非孤儿而被跳过的数量）。
 */
function purgeOrphanOriginals(hashes) {
  const list = Array.isArray(hashes) ? hashes : []
  const refs = referencedAssetIds()
  let removed = 0
  let kept = 0
  for (const hash of list) {
    if (!HASH_RE.test(hash)) continue
    if (refs.has(`asset_${hash}`)) { kept++; continue } // 复核：已非孤儿，跳过
    for (const ext of ['png', 'jpg', 'jpeg', 'json']) {
      const fp = resolveInsideDataDir(`design-assets/${hash}.${ext}`)
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp) } catch { /* 已不存在 */ }
    }
    const thumb = resolveInsideDataDir(`design-thumbnails/${hash}.png`)
    try { if (fs.existsSync(thumb)) fs.unlinkSync(thumb) } catch { /* 缩略图可有可无 */ }
    removed++
  }
  return { removed, kept }
}

module.exports = {
  listLibrary, getEntry, listTags, upsert, adopt, updateMetadata, archive, restore, rebuildThumbnail,
  findOrphanOriginals, purgeOrphanOriginals,
  THUMB_MAX_SIDE, LIMITS,
}

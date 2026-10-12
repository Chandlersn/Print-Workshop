/** Photo directory import. Original bytes are shared with the existing managed asset pool. */
const fs = require('fs')
const path = require('path')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const designs = require('./designs.cjs')
const library = require('./asset-library.cjs')
const { photoKey, photoIndex, matchPhotos, PHOTO_EXT } = require('./photo-match.cjs')

const LIMITS = Object.freeze({ entries: 10000, photos: 5000, depth: 12, bytes: 2 * 1024 ** 3, singleBytes: 64 * 1024 ** 2 })
let importing = false
const bindings = () => loadJson('photo-bindings', { expect: 'array' }) || []

function requireColumn(datasetId, column) {
  const ds = dataset.getDataset(datasetId)
  if (!ds.columns.some(c => c.key === column)) throw new Error('照片绑定列不存在，请重新选择数据集和列')
  return ds
}

function inside(root, target) {
  const rel = path.relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('照片路径越出所选目录')
}

/** Scan before importing; never follow a link, including Windows junctions. */
function scanFolder(folder) {
  if (typeof folder !== 'string' || !folder || !fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) {
    throw new Error('请选择真实照片文件夹，不能使用符号链接')
  }
  const root = fs.realpathSync(folder)
  const files = []
  const ignored = []
  let visited = 0
  function visit(dir, depth) {
    if (depth > LIMITS.depth) throw new Error(`照片子目录不能超过 ${LIMITS.depth} 层`)
    const children = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (++visited > LIMITS.entries) throw new Error(`目录条目超过 ${LIMITS.entries} 个，请选择更小的照片目录`)
      const absolute = path.join(dir, child.name)
      const name = path.relative(root, absolute).split(path.sep).join('/')
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        if (PHOTO_EXT.test(name)) {
          files.push({ name, error: '符号链接照片不能导入' })
          if (files.length > LIMITS.photos) throw new Error(`照片超过 ${LIMITS.photos} 张，请拆分目录`)
        }
        else ignored.push({ name, reason: '跳过符号链接目录或文件' })
        continue
      }
      inside(root, fs.realpathSync(absolute))
      if (stat.isDirectory()) { visit(absolute, depth + 1); continue }
      if (!stat.isFile() || !PHOTO_EXT.test(name)) { ignored.push({ name, reason: '仅支持 PNG/JPEG 普通文件' }); continue }
      let error
      try { photoKey(name) } catch (err) { error = err.message }
      if (!stat.size || stat.size > LIMITS.singleBytes) error = '照片为空或超过 64 MiB'
      files.push({ name, absolute, size: stat.size, error })
      if (files.length > LIMITS.photos) throw new Error(`照片超过 ${LIMITS.photos} 张，请拆分目录`)
    }
  }
  visit(root, 0)
  return { root, files, ignored }
}

function readScannedFile(root, file) {
  // Verify every component again immediately before opening, including replaced directories.
  const relative = path.relative(root, file.absolute)
  inside(root, file.absolute)
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('照片目录或文件已变为符号链接')
    inside(root, fs.realpathSync(current))
  }
  const before = fs.lstatSync(file.absolute)
  const fd = fs.openSync(file.absolute, 'r')
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size <= 0 || opened.size > LIMITS.singleBytes
        || opened.size !== file.size || before.ino !== opened.ino || before.dev !== opened.dev) {
      throw new Error('照片在扫描后发生变化，请重新导入')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('照片读取不完整，请重新导入')
      offset += count
    }
    const after = fs.fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('照片在读取时发生变化，请重新导入')
    return bytes
  } finally { fs.closeSync(fd) }
}

async function importFolder({ datasetId, column, folder }, { onProgress = () => {}, makeThumbnail } = {}) {
  const ds = requireColumn(datasetId, column)
  if (!ds.photoMatchColumn || ds.photoMatchColumn !== column) throw new Error('配图选择已变化，请重新打开变量照片库后导入')
  if (importing) throw new Error('已有照片正在导入，请等待完成')
  importing = true
  try {
    const scanned = scanFolder(folder)
    // Match names before reading any image bytes or creating assets/thumbnails.
    const wanted = new Set()
    for (const row of ds.rows) {
      try { wanted.add(photoKey(String(row[column] ?? ''))) } catch { /* Invalid/empty values stay in the row report. */ }
    }
    const index = photoIndex(scanned.files)
    const candidates = []
    const ignored = [...scanned.ignored]
    for (const file of scanned.files) {
      let key
      try { key = photoKey(file.name) } catch { /* Unmatchable filename. */ }
      if (!wanted.has(key)) { ignored.push({ name: file.name, reason: '未匹配当前名单，未入库' }); continue }
      candidates.push(index.get(key).length > 1 ? { ...file, error: '同名冲突，未入库，请处理后重新导入' } : file)
    }
    if (candidates.reduce((n, file) => n + (file.error ? 0 : file.size), 0) > LIMITS.bytes) {
      throw new Error('匹配照片总大小超过 2 GiB，请拆分目录')
    }
    const files = []
    let importedBytes = 0
    for (const file of candidates) {
      if (requireColumn(datasetId, column).photoMatchColumn !== column) throw new Error('导入期间配图选择已变化，请重新导入')
      const entry = { name: file.name }
      if (file.error) entry.error = file.error
      else {
        try {
          const bytes = readScannedFile(scanned.root, file)
          importedBytes += bytes.length
          if (importedBytes > LIMITS.bytes) throw new Error('照片总大小超过 2 GiB')
          const asset = designs.importImageBuffer(bytes, path.basename(file.name), 'managed')
          designs.setAssetSource(asset.id, 'managed')
          library.upsert(asset, {}, { makeThumbnail })
          entry.assetId = asset.id
        } catch (err) { entry.error = err.message }
      }
      files.push(entry)
      onProgress({ done: files.length, total: candidates.length, name: file.name })
      await new Promise(resolve => setImmediate(resolve))
    }
    // Only the final index write publishes this selection. Check a deleted dataset/column again.
    if (requireColumn(datasetId, column).photoMatchColumn !== column) throw new Error('导入期间配图选择已变化，请重新导入')
    const binding = { datasetId, column, folderName: path.basename(scanned.root), importedAt: new Date().toISOString(), files, ignored }
    designs.withDesignLock(() => {
      const all = bindings().filter(item => item.datasetId !== datasetId)
      saveJson('photo-bindings', [...all, binding])
    })
    return report({ datasetId, column })
  } finally { importing = false }
}

async function report({ datasetId, column, rows } = {}) {
  const ds = dataset.getDataset(datasetId)
  column = ds.photoMatchColumn || column
  requireColumn(datasetId, column)
  const binding = bindings().slice().reverse().find(item => item.datasetId === datasetId)
  const verified = new Map()
  const files = []
  for (const file of binding?.files || []) {
    if (file.error) { files.push(file); continue }
    if (!verified.has(file.assetId)) {
      try { verified.set(file.assetId, designs.assetInfo(file.assetId)) }
      catch (err) { verified.set(file.assetId, err.message) }
      await new Promise(resolve => setImmediate(resolve))
    }
    const info = verified.get(file.assetId)
    let thumbFile
    try { thumbFile = library.getEntry(file.assetId).thumbFile } catch { /* optional cache */ }
    files.push(typeof info === 'string' ? { ...file, error: info } : { ...file, width: info.width, height: info.height, thumbFile })
  }
  return {
    ...matchPhotos(ds.rows, column, ds.photoMatchColumn ? files : [], rows),
    imported: Boolean(binding), folderName: binding?.folderName || '', importedAt: binding?.importedAt || null,
    files: files.map(({ name, assetId, width, height, thumbFile, error }) => ({ name, assetId, width, height, thumbFile, ...(error ? { error } : {}) })),
    ignored: binding?.ignored || [],
  }
}

/** Resolve only the selected records; unrelated missing photos must not block partial output. */
function prepareRows(datasetId, columns, records, rowIndexes = null) {
  const ds = dataset.getDataset(datasetId)
  const all = bindings()
  const byRecord = new Map(records.map(row => [row, Object.fromEntries(columns.map(key => [key, null]))]))
  const assets = new Set()
  const column = ds.photoMatchColumn
  if (!column || !columns.length) return { byRecord, assets: [] }
  if (!ds.columns.some(c => c.key === column)) throw new Error('配图列已不存在，请到数据页重新选择')
  const binding = all.slice().reverse().find(b => b.datasetId === datasetId)
  const result = matchPhotos(records, column, binding?.files || [])
    for (const item of result.results) {
      if (item.status === 'missing' || item.status === 'empty') continue
      if (item.status !== 'matched') throw new Error(`照片出片检查：第 ${(rowIndexes?.[item.rowIndex] ?? item.rowIndex) + 1} 行「${item.name || '空值'}」未匹配，请到变量照片库处理`)
      if (!assets.has(item.assetId)) designs.assetInfo(item.assetId)
      assets.add(item.assetId)
      for (const key of columns) byRecord.get(records[item.rowIndex])[key] = `pp://media/${item.assetId}`
    }
  return { byRecord, assets: [...assets] }
}

module.exports = { importFolder, report, scanFolder, prepareRows, LIMITS }

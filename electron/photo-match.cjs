/** Pure filename matching. Dataset values never become filesystem paths or URLs. */
const PHOTO_EXT = /\.(png|jpe?g)$/i
const ASSET_ID = /^asset_[a-f0-9]{64}$/

function photoKey(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('照片文件名必须是文本且不能包含控制字符')
  const name = value.trim().normalize('NFC').replace(/\\/g, '/')
  if (!name || name.length > 500 || /[\x00-\x1f\x7f<>:"|?*]/.test(name) || name.startsWith('/')) {
    throw new Error('照片文件名必须是有效相对名称，不能包含盘符、协议或控制字符')
  }
  const parts = name.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('照片文件名不能包含空目录、上级目录或结尾的点与空格')
  }
  if (parts.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('照片文件名不能使用系统保留名称')
  }
  const key = name.replace(PHOTO_EXT, '').toLowerCase()
  if (!key || key.endsWith('/')) throw new Error('照片文件名缺少名称')
  return key
}

function photoIndex(files) {
  if (!Array.isArray(files)) throw new Error('照片清单无效')
  const index = new Map()
  for (const file of files) {
    if (!file || typeof file !== 'object') throw new Error('照片清单条目无效')
    let key
    try { key = photoKey(file.name) } catch { continue }
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(file)
  }
  return index
}

/** rowIndexes uses original zero-based dataset indexes, including partial reprints. */
function matchPhotos(rows, column, files, rowIndexes) {
  if (!Array.isArray(rows) || typeof column !== 'string' || !column) throw new Error('照片匹配的数据或列无效')
  const selected = rowIndexes === undefined ? rows.map((_, i) => i) : rowIndexes
  if (!Array.isArray(selected) || selected.some(i => !Number.isInteger(i) || i < 0 || i >= rows.length)
      || new Set(selected).size !== selected.length) throw new Error('照片匹配行范围无效')
  const index = photoIndex(files)
  const results = []
  const counts = { matched: 0, empty: 0, missing: 0, ambiguous: 0, invalid: 0, broken: 0 }
  const uses = new Map()
  for (const rowIndex of selected) {
    const value = rows[rowIndex][column]
    const raw = value == null ? '' : String(value)
    const name = raw.trim()
    const item = { rowIndex, name, status: 'empty' }
    if (name || /[\x00-\x1f\x7f]/.test(raw)) {
      try {
        const key = photoKey(raw)
        const candidates = index.get(key) || []
        if (!candidates.length) item.status = 'missing'
        else if (candidates.length > 1) {
          item.status = 'ambiguous'
          item.candidates = candidates.map(file => file.name)
        } else {
          const file = candidates[0]
          if (file.error || !ASSET_ID.test(file.assetId || '')) {
            item.status = 'broken'
            item.reason = file.error || '照片素材记录无效'
          } else {
            item.status = 'matched'
            item.assetId = file.assetId
            if (!uses.has(file.assetId)) uses.set(file.assetId, [])
            uses.get(file.assetId).push(rowIndex)
          }
        }
      } catch (err) { item.status = 'invalid'; item.reason = err.message }
    }
    counts[item.status]++
    results.push(item)
  }
  const duplicates = [...uses].filter(([, indexes]) => indexes.length > 1)
    .map(([assetId, rowIndexes]) => ({ assetId, rowIndexes }))
  return {
    column, total: selected.length, counts, results, duplicates,
    blocking: counts.missing + counts.ambiguous + counts.invalid + counts.broken,
  }
}

module.exports = { photoKey, photoIndex, matchPhotos, PHOTO_EXT }

/** Per-record, per-template photo framing. Original image bytes are never rewritten. */
const { loadJson, saveJson } = require('./store.cjs')
const crypto = require('crypto')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const designs = require('./designs.cjs')
const { matchPhotos, photoKey } = require('./photo-match.cjs')

const entries = () => loadJson('photo-overrides', { expect: 'array' }) || []
const same = (entry, query) => entry.datasetId === query.datasetId && entry.rowId === query.rowId
  && entry.templateId === query.templateId && entry.layerId === query.layerId

function context({ datasetId, templateId, rowId, layerId }) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  if (tpl.datasetId && tpl.datasetId !== ds.id) throw new Error('模板已关联其他名单')
  const index = ds.recordIds.indexOf(String(rowId))
  if (index < 0) throw new Error('人员记录已不存在')
  const design = require('./render-engine.cjs').resolveTemplateDesign(tpl)
  const layer = design?.layers.find(item => item.id === layerId && item.type === 'image' && item.variable && item.visible && !item.editorOnly)
  if (!layer) throw new Error('变量图框已不存在')
  const column = ds.photoMatchColumn
  if (!column) throw new Error('当前名单已关闭配图')
  const binding = entriesForDataset(ds.id)
  const match = matchPhotos(ds.rows, column, binding?.files || [], [index]).results[0]
  if (match.status !== 'matched') throw new Error(`第 ${index + 1} 行照片尚未有效匹配`)
  designs.assetInfo(match.assetId)
  return { ds, tpl, layer, index, match, column, photoKey: photoKey(match.name) }
}

function entriesForDataset(datasetId) {
  return (loadJson('photo-bindings', { expect: 'array' }) || []).slice().reverse().find(item => item.datasetId === datasetId)
}

function inspect(query) {
  const ds = dataset.getDataset(String(query.datasetId))
  const tpl = templates.getTemplate(String(query.templateId))
  const design = require('./render-engine.cjs').resolveTemplateDesign(tpl)
  const layer = design?.layers.find(item => item.id === query.layerId && item.type === 'image' && item.variable)
  if (!layer) throw new Error('变量图框已不存在')
  const old = entries().find(entry => same(entry, query)) || null
  let current
  try { current = context(query) } catch { current = null }
  const active = Boolean(old && current && old.matchColumn === current.column
    && old.photoKey === current.photoKey && old.assetId === current.match.assetId)
  return {
    state: old ? (active ? 'active' : 'stale') : 'none',
    fit: active ? old.fit : layer.fit, focal: active ? old.focal : layer.focal,
    defaultFit: layer.fit, defaultFocal: layer.focal,
    assetId: current?.match.assetId || null,
  }
}

function set(query) {
  const current = context(query)
  if (!['cover', 'contain'].includes(query.fit)) throw new Error('照片显示方式无效')
  const focal = query.focal
  if (!focal || !Number.isFinite(focal.x) || !Number.isFinite(focal.y)
    || focal.x < 0 || focal.x > 1 || focal.y < 0 || focal.y > 1) throw new Error('照片焦点必须在图框内')
  const entry = {
    datasetId: current.ds.id, rowId: current.ds.recordIds[current.index], templateId: current.tpl.id,
    layerId: current.layer.id, matchColumn: current.column, photoKey: current.photoKey,
    assetId: current.match.assetId, fit: query.fit,
    focal: { x: focal.x, y: focal.y }, updatedAt: new Date().toISOString(),
  }
  saveJson('photo-overrides', [...entries().filter(item => !same(item, entry)), entry])
  return inspect(entry)
}

function clear(query) {
  const previous = entries()
  const next = previous.filter(item => !same(item, query))
  if (next.length !== previous.length) saveJson('photo-overrides', next)
  return { removed: previous.length !== next.length }
}

function revisionFor(datasetId, templateId, rowIds) {
  const wanted = new Set(rowIds)
  const selected = entries().filter(item => item.datasetId === datasetId && item.templateId === templateId && wanted.has(item.rowId))
  return crypto.createHash('sha256').update(JSON.stringify(selected)).digest('hex')
}

/** Match against the current selected rows; stale entries stay stored for review but never render. */
function forRecords(ds, templateId, records, rowIndexes, matchResult) {
  const result = new Map()
  if (!templateId || !ds.photoMatchColumn) return result
  const byRowId = new Map()
  for (const entry of entries()) {
    if (entry.datasetId !== ds.id || entry.templateId !== templateId) continue
    if (!byRowId.has(entry.rowId)) byRowId.set(entry.rowId, [])
    byRowId.get(entry.rowId).push(entry)
  }
  for (const item of matchResult.results) {
    if (item.status !== 'matched') continue
    const originalIndex = rowIndexes?.[item.rowIndex] ?? item.rowIndex
    const rowId = ds.recordIds[originalIndex]
    const styles = {}
    for (const entry of byRowId.get(rowId) || []) {
      if (entry.matchColumn !== ds.photoMatchColumn || entry.assetId !== item.assetId) continue
      try { if (entry.photoKey !== photoKey(item.name)) continue } catch { continue }
      if (!['cover', 'contain'].includes(entry.fit) || !entry.focal
        || !Number.isFinite(entry.focal.x) || !Number.isFinite(entry.focal.y)
        || entry.focal.x < 0 || entry.focal.x > 1 || entry.focal.y < 0 || entry.focal.y > 1) continue
      styles[entry.layerId] = { fit: entry.fit, focal: entry.focal }
    }
    if (Object.keys(styles).length) result.set(records[item.rowIndex], styles)
  }
  return result
}

module.exports = { inspect, set, clear, forRecords, revisionFor }

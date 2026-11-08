/** Independent, pinned background revisions for one dataset record and template. */
const crypto = require('crypto')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const records = () => loadJson('record-designs', { expect: 'array' }) || []
const photoEntries = (datasetId, templateId, rowId) => (loadJson('photo-overrides', { expect:'array' }) || []).filter(item => item.datasetId === datasetId && item.templateId === templateId && item.rowId === rowId)
const entryHash = entry => crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex')
function rowRevision(ds, index) {
  const binding = (loadJson('photo-bindings', { expect:'array' }) || []).slice().reverse().find(item => item.datasetId === ds.id)
  const match = ds.photoMatchColumn ? require('./photo-match.cjs').matchPhotos(ds.rows, ds.photoMatchColumn, binding?.files || [], [index]).results[0] : null
  return entryHash({ row:ds.rows[index], column:ds.photoMatchColumn, match, processing:require('./photo-processing.cjs').revision(ds.id) })
}
const baseKey = template => crypto.createHash('sha256').update(JSON.stringify({
  background: template.background || null, backgroundDesign: template.backgroundDesign || null,
  pageSize: template.pageSize, layout: template.layout || null,
})).digest('hex')
const same = (entry, query) => entry.datasetId === query.datasetId && entry.templateId === query.templateId && entry.rowId === query.rowId
function context(query) {
  const ds = dataset.getDataset(String(query.datasetId)), tpl = templates.getTemplate(String(query.templateId))
  if (tpl.datasetId && tpl.datasetId !== ds.id) throw new Error('模板属于其他名单')
  const rowIndex = ds.recordIds.indexOf(String(query.rowId))
  if (rowIndex < 0) throw new Error('人员记录已变化，请重新预览')
  const render = require('./render-engine.cjs'), spec = render.pageSpec(tpl.pageSize), layout = render.resolveLayout(tpl.layout, spec)
  if (tpl.layout?.mode === 'grid' && !layout.enabled) throw new Error('多联版式无效，请先调整模板')
  const artboard = { w: layout.enabled ? layout.itemW : spec.w, h: layout.enabled ? layout.itemH : spec.h }
  return { ds, tpl, rowIndex, artboard, base: baseKey(tpl) }
}
function get(query) {
  const { ds, tpl, rowIndex, artboard, base } = context(query)
  const item = records().find(entry => same(entry, { datasetId: ds.id, templateId: tpl.id, rowId: ds.recordIds[rowIndex] })) || null
  if (item) require('./designs.cjs').resolveDesign(item.designRef)
  const rowId = ds.recordIds[rowIndex], entries = photoEntries(ds.id, tpl.id, rowId), photoStyles = {}
  for (const entry of entries) {
    if (item?.absorbedPhotoOverrides?.[entry.layerId] === entryHash(entry)) continue
    try { const current = require('./photo-overrides.cjs').inspect(entry); if (current.state === 'active') photoStyles[entry.layerId] = { fit:current.fit, focal:current.focal, ...(entry.position ? { position:current.position } : {}), ...(entry.size ? { size:current.size } : {}) } } catch { /* stale or removed frame */ }
  }
  return { datasetId:ds.id, templateId:tpl.id, rowId, rowIndex, artboard, baseKey:base, photoStyles, recordRevision:rowRevision(ds,rowIndex), overrideRevision:entryHash(item),
    previewFields:tpl.fields || [], previewRecord:ds.rows[rowIndex],
    photoRevision:require('./photo-overrides.cjs').revisionFor(ds.id, tpl.id, [rowId]),
    name:tpl.name, hasOverride:Boolean(item), stale:Boolean(item && item.baseKey !== base),
    designRef:item?.designRef || tpl.backgroundDesign || null, background:item ? null : tpl.background || null }
}
function set(query) {
  const { ds, tpl, rowIndex, artboard, base } = context(query)
  if (query.baseKey !== base) throw new Error('编辑期间共用模板已变化，请返回打印中心重新打开')
  if (query.recordRevision !== rowRevision(ds,rowIndex)) throw new Error('编辑期间此人的数据或照片已变化，请返回打印中心重新打开')
  const existing = records().find(item => same(item, {datasetId:ds.id,templateId:tpl.id,rowId:ds.recordIds[rowIndex]})) || null
  if (query.overrideRevision !== entryHash(existing)) throw new Error('此人的底图已被其他操作更新，请重新打开')
  if (query.photoRevision !== require('./photo-overrides.cjs').revisionFor(ds.id, tpl.id, [ds.recordIds[rowIndex]])) throw new Error('编辑期间此人的照片取景已变化，请重新打开底图')
  const ref = query.designRef
  const design = require('./render-engine.cjs').resolveTemplateDesign({ ...tpl, background: null, backgroundDesign: ref })
  if (!design || Math.abs(design.artboard.w-artboard.w)>.01 || Math.abs(design.artboard.h-artboard.h)>.01) throw new Error('单人底图尺寸与模板不一致')
  // The shared template revision must never become the per-person editable copy.
  if (tpl.backgroundDesign?.id === ref.id) throw new Error('请保存独立的单人底图副本')
  if (records().some(item => item.designRef?.id === ref.id && !same(item, {datasetId:ds.id,templateId:tpl.id,rowId:ds.recordIds[rowIndex]}))) throw new Error('单人底图不能被其他人员共用')
  require('./designs.cjs').markRecordDesign(ref.id, {datasetId:ds.id,templateId:tpl.id,rowId:ds.recordIds[rowIndex]})
  const entry = { datasetId:ds.id, templateId:tpl.id, rowId:ds.recordIds[rowIndex], baseKey:base,
    designRef:{id:ref.id,revision:ref.revision}, absorbedPhotoOverrides:Object.fromEntries(photoEntries(ds.id,tpl.id,ds.recordIds[rowIndex]).map(item => [item.layerId,entryHash(item)])), updatedAt:new Date().toISOString() }
  saveJson('record-designs', [...records().filter(item => !same(item, entry)), entry])
  return entry
}
function clear(query) {
  const { ds, tpl, rowIndex } = context(query), key = { datasetId:ds.id, templateId:tpl.id, rowId:ds.recordIds[rowIndex] }
  const before = records(), after = before.filter(item => !same(item, key))
  for (const item of before.filter(item => same(item, key))) require('./designs.cjs').markRecordDesign(item.designRef.id, {datasetId:item.datasetId,templateId:item.templateId,rowId:item.rowId})
  if (before.length !== after.length) saveJson('record-designs', after)
  return { removed:before.length !== after.length }
}
function forRows(ds, tpl, indexes) {
  const wanted = new Set(indexes.map(index => ds.recordIds[index])), result = new Map(), base = baseKey(tpl)
  for (const entry of records()) {
    if (entry.datasetId !== ds.id || entry.templateId !== tpl.id || !wanted.has(entry.rowId)) continue
    if (entry.baseKey !== base) throw new Error('共用模板底图已变化，存在单人底图需要重新检查或恢复默认')
    const design = require('./render-engine.cjs').resolveTemplateDesign({ ...tpl, background: null, backgroundDesign: entry.designRef })
    result.set(entry.rowId, { entry, design })
  }
  return result
}
function revisionFor(datasetId, templateId, rowIds) {
  const wanted = new Set(rowIds)
  return crypto.createHash('sha256').update(JSON.stringify(records().filter(entry => entry.datasetId === datasetId && entry.templateId === templateId && wanted.has(entry.rowId)))).digest('hex')
}
function hasForRows(datasetId, templateId, rowIds) {
  const wanted = new Set(rowIds)
  return records().some(entry => entry.datasetId === datasetId && entry.templateId === templateId && wanted.has(entry.rowId))
}
function forget({ datasetIds, templateId, datasetId, rowId } = {}) {
  const ids = Array.isArray(datasetIds) ? new Set(datasetIds.map(String)) : null
  const before = records(), after = before.filter(item => {
    if (ids) return !ids.has(item.datasetId)
    if (templateId) return item.templateId !== templateId
    if (datasetId && rowId) return item.datasetId !== datasetId || item.rowId !== rowId
    return true
  })
  for (const item of before.filter(item => !after.includes(item))) require('./designs.cjs').markRecordDesign(item.designRef.id, {datasetId:item.datasetId,templateId:item.templateId,rowId:item.rowId})
  if (after.length !== before.length) saveJson('record-designs', after)
  return { removed:before.length-after.length }
}
function filteredPhotoStyles(entry, styles, snapshot) {
  const result = { ...(styles || {}) }
  for (const photo of snapshot || photoEntries(entry.datasetId, entry.templateId, entry.rowId)) if (entry.absorbedPhotoOverrides?.[photo.layerId] === entryHash(photo)) delete result[photo.layerId]
  return result
}
module.exports = { get, set, clear, forRows, revisionFor, hasForRows, baseKey, filteredPhotoStyles, forget }

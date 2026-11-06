/** Dataset-wide photo recipes; the editor, preview, print and archives share these results. */
const crypto = require('crypto')
const { loadJson, saveJson } = require('./store.cjs')
const designs = require('./designs.cjs')
const dataset = require('./dataset.cjs')
const { normalizeRecipe, VERSION } = require('./photo-processing-pixels.cjs')
const tasks = new Map(), datasetTasks = new Set()
const states = () => loadJson('photo-processing', { expect: 'array' }) || []
const cache = () => loadJson('photo-processing-cache', { expect: 'array' }) || []
function saveCache(records) {
  const active = new Set(states().filter(state => state.enabled).flatMap(state => Object.values(state.items || {})))
  for (const job of jobs()) for (const id of job.completedAssets || []) active.add(id)
  const keepFrom = Math.max(0, records.length - (datasetTasks.size ? 5000 : 64))
  saveJson('photo-processing-cache', records.filter((item, index) => index >= keepFrom || active.has(item.assetId)))
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function current(datasetId) { return states().find(item => item.datasetId === datasetId) || null }
function binding(datasetId) { return (loadJson('photo-bindings', { expect: 'array' }) || []).slice().reverse().find(item => item.datasetId === datasetId) }
function sourceContext(datasetId) {
  const ds = dataset.getDataset(String(datasetId)), source = binding(ds.id)
  if (!ds.photoMatchColumn) throw new Error('请先在数据页开启配图')
  return { ds, source, fingerprint: hash({ column: ds.photoMatchColumn, source, rows: ds.rows.map(row => row[ds.photoMatchColumn]), ids: ds.recordIds }) }
}
function inspect(query, host) {
  const datasetId = typeof query === 'object' ? query.datasetId : query
  const ds = dataset.getDataset(String(datasetId)), state = current(ds.id)
  const single = typeof query === 'object' && query.rowId ? singleContext(query) : null
  const available = id => { try { return id ? designs.assetInfo(id) : null } catch { return null } }
  return { state: state?.column === ds.photoMatchColumn ? state : null, model: host?.status() || { ready: false, local: true },
    options: optionsFor(ds.id), presets: listPresets(), job: jobs().find(item => item.datasetId === ds.id) || null,
    single: single ? { rowId: single.rowId, assetId: single.match.assetId, override: single.override,
      asset: available(single.override?.assetId), restoreAsset: available(single.override?.restoreAssetId) } : null }
}
async function render({ datasetId, assetId, recipe }, host) {
  if (!host?.processPhoto) throw new Error('照片自动处理需要在桌面应用中运行')
  const context = sourceContext(datasetId)
  if (!context.source?.files?.some(file => file.assetId === assetId && !file.error)) throw new Error('样板照片已变化，请重新选择')
  recipe = normalizeRecipe(recipe)
  const key = hash({ source: assetId, recipe, algorithm: VERSION, model: recipe.cutout ? 'modnet-07c308cf' : null })
  const hit = cache().find(item => item.key === key)
  if (hit) { try { return { asset: designs.assetInfo(hit.assetId), restoreAsset: designs.assetInfo(hit.restoreAssetId || hit.assetId), analysis: hit.analysis || { issues: [] }, key, cached: true } } catch { /* regenerate a missing cached result */ } }
  const { asset, buffer } = designs.assetBytes(assetId)
  const output = await host.processPhoto({ asset, buffer, recipe })
  const result = designs.importImageBuffer(Buffer.from(output.png || output), `${asset.name.slice(0, 160)} 自动处理.png`, 'managed')
  const restoreAsset = output.restorePng ? designs.importImageBuffer(Buffer.from(output.restorePng), `${asset.name.slice(0, 160)} 蒙版原色.png`, 'managed') : result
  const analysis = output.analysis || { issues: [] }
  saveCache([...cache().filter(item => item.key !== key), { key, sourceAssetId: assetId, assetId: result.id, restoreAssetId: restoreAsset.id, analysis, createdAt: new Date().toISOString() }])
  return { asset: result, restoreAsset, analysis, key, cached: false }
}
async function apply(payload, host, emit = () => {}) {
  const context = sourceContext(payload.datasetId), datasetId = context.ds.id
  if (datasetTasks.has(datasetId)) throw new Error('这份名单正在处理照片，请等待完成')
  const taskId = String(payload.taskId || '')
  if (!/^[\w-]{1,100}$/.test(taskId) || tasks.has(taskId)) throw new Error('照片处理任务标识无效')
  const recipe = normalizeRecipe(payload.recipe)
  const task = { datasetId, canceled: false }
  tasks.set(taskId, task); datasetTasks.add(datasetId)
  try {
    const report = await require('./photo-library.cjs').report({ datasetId, column: context.ds.photoMatchColumn })
    const targets = [...new Set(report.results.filter(row => row.status === 'matched').map(row => row.assetId))]
    if (!targets.length) throw new Error('没有可处理的已匹配照片，请先导入照片')
    if (!targets.includes(payload.sampleAssetId)) throw new Error('样板照片已变化，请重新选择')
    const items = {}, failures = [], analysis = {}, previous = current(datasetId)
    for (let index = 0; index < targets.length; index++) {
      if (task.canceled) return { canceled: true, completed: index, total: targets.length }
      const assetId = targets[index]
      emit('photo:processingProgress', { taskId, datasetId, index, total: targets.length, phase: 'processing' })
      try {
        let reusable = false
        if (payload.incremental && previous?.enabled && previous.column === context.ds.photoMatchColumn && hash(normalizeRecipe(previous.recipe)) === hash(recipe) && previous.items?.[assetId]) {
          try { designs.assetInfo(previous.items[assetId]); reusable = true } catch { /* Regenerate missing or corrupt results. */ }
        }
        if (reusable) { items[assetId] = previous.items[assetId]; analysis[assetId] = previous.analysis?.[assetId] || { issues: [] } }
        else { const output = await render({ datasetId, assetId, recipe }, host); items[assetId] = output.asset.id; analysis[assetId] = output.analysis }
      }
      catch (error) { failures.push({ assetId, message: error.message }) }
    }
    if (task.canceled) return { canceled: true, completed: targets.length, total: targets.length }
    if (sourceContext(datasetId).fingerprint !== context.fingerprint) throw new Error('处理期间名单或照片发生变化，请重新应用样板')
    if (failures.length) {
      saveJson('photo-processing-jobs', [...jobs().filter(item => item.datasetId !== datasetId), { datasetId, phase: 'failed', failures, completedAssets: Object.values(items), completed: targets.length - failures.length, total: targets.length, updatedAt: new Date().toISOString() }])
      return { applied: false, total: targets.length, completed: targets.length - failures.length, failures }
    }
    const state = { datasetId, column: context.ds.photoMatchColumn, sampleAssetId: payload.sampleAssetId, recipe, enabled: true, items, analysis, updatedAt: new Date().toISOString() }
    saveJson('photo-processing', [...states().filter(item => item.datasetId !== datasetId), state])
    saveJson('photo-processing-jobs', jobs().filter(item => item.datasetId !== datasetId))
    emit('photo:processingProgress', { taskId, datasetId, index: targets.length, total: targets.length, phase: 'completed' })
    return { applied: true, state, total: targets.length, completed: targets.length, failures: [] }
  } finally { tasks.delete(taskId); datasetTasks.delete(datasetId); try { saveCache(cache()) } catch { /* Retaining extra cache entries is safe; retry housekeeping on the next operation. */ } }
}
function cancel({ datasetId, taskId }) {
  const task = tasks.get(String(taskId))
  if (task?.datasetId === String(datasetId)) task.canceled = true
  return { canceled: Boolean(task?.canceled) }
}
function clear(datasetId) {
  datasetId = dataset.getDataset(String(datasetId)).id
  if (datasetTasks.has(datasetId)) throw new Error('请先取消正在进行的照片处理')
  saveJson('photo-processing', states().filter(item => item.datasetId !== datasetId))
  saveJson('photo-processing-singles', singles().filter(item => item.datasetId !== datasetId))
  return { ok: true }
}
function resolver(ds) {
  const state = current(ds.id), active = Boolean(state?.enabled && state.column === ds.photoMatchColumn)
  const overrides = new Map(singles().filter(item => item.datasetId === ds.id && item.column === ds.photoMatchColumn).map(item => [item.rowId, item]))
  return (assetId, rowId) => {
    const override = overrides.get(rowId)
    if (override?.sourceAssetId === assetId) return override.assetId
    if (!active) return assetId
    const processed = state.items?.[assetId]
    if (!processed) throw new Error('有新增或更换的照片尚未应用样板，请到变量照片页重新应用自动处理')
    return processed
  }
}
function revision(datasetId) { return hash({ state: current(String(datasetId)), singles: singles().filter(item => item.datasetId === String(datasetId)) }) }
const singles = () => loadJson('photo-processing-singles', { expect: 'array' }) || []
const jobs = () => loadJson('photo-processing-jobs', { expect: 'array' }) || []
const options = () => loadJson('photo-processing-options', { expect: 'array' }) || []
const optionsFor = datasetId => options().find(item => item.datasetId === datasetId) || { datasetId, autoProcess: false }
function setOptions({ datasetId, autoProcess }) {
  datasetId = dataset.getDataset(String(datasetId)).id
  if (typeof autoProcess !== 'boolean') throw new Error('自动处理开关无效')
  const next = { datasetId, autoProcess }
  saveJson('photo-processing-options', [...options().filter(item => item.datasetId !== datasetId), next])
  if (!autoProcess) {
    autoQueue.delete(datasetId)
    for (const [id, task] of tasks) if (task.datasetId === datasetId && id.startsWith('automatic-')) task.canceled = true
    saveJson('photo-processing-jobs', jobs().map(item => item.datasetId === datasetId && item.phase === 'processing' ? { ...item, phase: 'canceled' } : item))
  }
  return next
}
function listPresets() {
  const saved = loadJson('photo-processing-presets', { expect: 'array' }) || []
  const templates = (loadJson('templates', { expect: 'array' }) || []).filter(item => item.photoProcessingRecipe).map(item => ({ id: `template:${item.id}`, name: `模板 · ${item.name}`, recipe: item.photoProcessingRecipe, readOnly: true }))
  return [...saved, ...templates]
}
function savePreset({ id, name, recipe }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new Error('请输入不超过 100 字的样板名称')
  const all = (loadJson('photo-processing-presets', { expect: 'array' }) || [])
  if (id && !all.some(item => item.id === id)) throw new Error('样板已不存在，请另存')
  if (!id && all.length >= 100) throw new Error('最多保存 100 份样板，请先删除不用的样板')
  const next = { id: id || crypto.randomUUID(), name: name.trim(), recipe: normalizeRecipe(recipe), updatedAt: new Date().toISOString() }
  saveJson('photo-processing-presets', [...all.filter(item => item.id !== next.id), next])
  return next
}
function deletePreset({ id }) {
  const all = loadJson('photo-processing-presets', { expect: 'array' }) || []
  saveJson('photo-processing-presets', all.filter(item => item.id !== id))
  return { removed: all.some(item => item.id === id) }
}
function singleContext({ datasetId, rowId }) {
  const { ds, source } = sourceContext(datasetId), index = ds.recordIds.indexOf(String(rowId))
  if (index < 0) throw new Error('人员记录已不存在')
  const match = require('./photo-match.cjs').matchPhotos(ds.rows, ds.photoMatchColumn, source?.files || [], [index]).results[0]
  if (match.status !== 'matched') throw new Error('此人的照片尚未有效匹配')
  const old = singles().find(item => item.datasetId === ds.id && item.rowId === rowId)
  const override = old?.column === ds.photoMatchColumn && old.sourceAssetId === match.assetId ? old : null
  return { ds, index, rowId: ds.recordIds[index], match, override }
}
async function setSingle(payload, host) {
  if (datasetTasks.has(String(payload.datasetId))) throw new Error('这份名单正在批量处理，请稍后调整单张照片')
  const context = singleContext(payload), sourceAssetId = context.match.assetId
  if (payload.assetId !== sourceAssetId) throw new Error('照片已更换，请重新打开单张编辑')
  const recipe = normalizeRecipe(payload.recipe)
  const output = await render({ datasetId: context.ds.id, assetId: sourceAssetId, recipe }, host)
  let asset = output.asset, restoreAsset = output.restoreAsset
  if (payload.edit) {
    const edit = payload.edit
    const validBase = edit.baseAssetId === output.asset.id || edit.baseAssetId === context.override?.assetId
    if (!validBase) throw new Error('编辑底图已变化，请重新预览后修补')
    if (edit.baseAssetId === context.override?.assetId && context.override.restoreAssetId) restoreAsset = designs.assetInfo(context.override.restoreAssetId)
    if (edit.base64) asset = designs.importImageBytes({ base64: edit.base64, name: '单张照片修补.png', source: 'managed' })
    else asset = designs.assetInfo(edit.baseAssetId)
    if (asset.width !== restoreAsset.width || asset.height !== restoreAsset.height) throw new Error('修补图片尺寸与样板不一致')
    if (edit.crop) {
      if (!host?.cropPhoto) throw new Error('裁剪需要桌面图片编辑组件')
      const cropped = await host.cropPhoto({ buffer: designs.assetBytes(asset.id).buffer, crop: edit.crop })
      const restored = await host.cropPhoto({ buffer: designs.assetBytes(restoreAsset.id).buffer, crop: edit.crop })
      asset = designs.importImageBuffer(cropped, '单张照片裁剪.png', 'managed'); restoreAsset = designs.importImageBuffer(restored, '单张照片蒙版原色.png', 'managed')
    }
  }
  const latest = singleContext(payload)
  if (latest.match.assetId !== sourceAssetId || latest.ds.photoMatchColumn !== context.ds.photoMatchColumn) throw new Error('处理期间照片或配图列发生变化，请重新编辑')
  const entry = { datasetId: context.ds.id, rowId: context.rowId, column: context.ds.photoMatchColumn, sourceAssetId, assetId: asset.id, restoreAssetId: restoreAsset.id, recipe, analysis: output.analysis, edited: Boolean(payload.edit), updatedAt: new Date().toISOString() }
  saveJson('photo-processing-singles', [...singles().filter(item => !(item.datasetId === entry.datasetId && item.rowId === entry.rowId)), entry])
  return { applied: true, entry, asset, restoreAsset, analysis: output.analysis }
}
function clearSingle({ datasetId, rowId }) {
  datasetId = dataset.getDataset(String(datasetId)).id
  saveJson('photo-processing-singles', singles().filter(item => !(item.datasetId === datasetId && item.rowId === rowId)))
  return { removed: true }
}
const autoQueue = new Map()
let autoRunning = false
function jobState(datasetId, state, emit) {
  const entry = { ...jobs().find(item => item.datasetId === datasetId), datasetId, ...state, updatedAt: new Date().toISOString() }
  saveJson('photo-processing-jobs', [...jobs().filter(item => item.datasetId !== datasetId), entry])
  emit('photo:processingProgress', { ...entry, automatic: true })
}
function scheduleAutomatic(host, emit = () => {}, datasetId) {
  if (!host?.processPhoto) return
  for (const option of options().filter(item => item.autoProcess && (!datasetId || item.datasetId === datasetId))) autoQueue.set(option.datasetId, { host, emit })
  if (autoRunning || !autoQueue.size) return
  autoRunning = true
  setImmediate(async () => {
    try {
      for (const [id, context] of autoQueue) {
        autoQueue.delete(id)
        try {
          const { ds } = sourceContext(id), state = current(id)
          if (!state?.enabled || state.column !== ds.photoMatchColumn || !optionsFor(id).autoProcess) {
            if (jobs().some(item => item.datasetId === id && item.phase === 'processing')) jobState(id, { phase: 'canceled', message: '照片规则或配图列已变化，请重新应用样板' }, context.emit)
            continue
          }
          if (datasetTasks.has(id)) { autoQueue.set(id, context); await new Promise(resolve => setTimeout(resolve, 250)); continue }
          const report = await require('./photo-library.cjs').report({ datasetId: id, column: ds.photoMatchColumn })
          const targets = report.results.filter(item => item.status === 'matched')
          if (!targets.length || !targets.some(item => { try { if (!state.items?.[item.assetId]) return true; designs.assetInfo(state.items[item.assetId]); return false } catch { return true } })) {
            if (jobs().some(item => item.datasetId === id && item.phase === 'processing')) jobState(id, { phase: 'completed', completedAssets: [], completed: targets.length, total: targets.length }, context.emit)
            continue
          }
          const taskId = `automatic-${crypto.randomUUID()}`
          jobState(id, { phase: 'processing', index: 0, total: targets.length }, context.emit)
          const result = await apply({ datasetId: id, recipe: state.recipe, sampleAssetId: targets.some(item => item.assetId === state.sampleAssetId) ? state.sampleAssetId : targets[0].assetId, taskId, incremental: true }, context.host,
            (_channel, progress) => jobState(id, { ...progress, phase: progress.phase }, context.emit))
          jobState(id, { phase: result.applied ? 'completed' : result.canceled ? 'canceled' : 'failed', failures: result.failures || [], completed: result.completed || 0, total: result.total || 0 }, context.emit)
        } catch (error) { jobState(id, { phase: 'failed', message: error.message }, context.emit) }
      }
    } finally { autoRunning = false; if (autoQueue.size) scheduleAutomatic(host, emit, datasetId) }
  })
}
function details(ds) {
  const state = current(ds.id), individual = new Map(singles().filter(item => item.datasetId === ds.id).map(item => [item.rowId, item]))
  return (assetId, rowId) => {
    const old = individual.get(rowId), entry = old?.column === ds.photoMatchColumn && old.sourceAssetId === assetId ? old : null
    const active = state?.enabled && state.column === ds.photoMatchColumn
    return { individual: Boolean(entry), stale: Boolean(old && !entry), analysis: entry?.analysis || (active ? state.analysis?.[assetId] : null) || { issues: [] }, recipe: entry?.recipe || (active ? state.recipe : null) }
  }
}
async function review({ datasetId, templateId, previewRows }) {
  const ds = dataset.getDataset(String(datasetId)), report = await require('./photo-library.cjs').report({ datasetId: ds.id, column: ds.photoMatchColumn })
  let template = null, design = null, layers = []
  if (templateId) {
    template = require('./templates.cjs').getTemplate(String(templateId))
    if (template.datasetId && template.datasetId !== ds.id) throw new Error('模板属于其他名单')
    design = require('./render-engine.cjs').resolveTemplateDesign(template)
    layers = design?.layers.filter(layer => layer.variable && layer.visible && !layer.editorOnly) || []
  }
  const known = new Map(), meta = details(ds), rows = []
  for (const row of report.results) {
    const rowId = ds.recordIds[row.rowIndex], processing = row.status === 'matched' ? meta(row.assetId, rowId) : null
    const issues = []
    if (row.status !== 'matched') issues.push({ code: row.status, message: ({ empty: '未填写照片名', missing: '找不到照片', ambiguous: '同名冲突', invalid: '照片名称无效', broken: '照片不可用' })[row.status], blocking: !['empty','missing'].includes(row.status) })
    if (row.processingError) issues.push({ code: 'pending', message: row.processingError, blocking: true })
    for (const code of processing?.analysis?.issues || []) issues.push({ code, message: ({ 'no-face': '未识别人脸，已使用普通适配，请检查', 'multiple-faces': '检测到多人，已使用普通适配，请检查', 'face-clipped': '人脸可能被裁切', 'subject-clipped': '人物可能超出画面', upscaled: '照片放大较多，建议检查清晰度' })[code] || code, blocking: false })
    if (processing?.stale) issues.push({ code: 'stale', message: '照片已更换，旧的单张修改已停用', blocking: false })
    let geometry = null
    if (row.processedAssetId && !row.processingError) {
      if (!known.has(row.processedAssetId)) { try { known.set(row.processedAssetId, designs.assetInfo(row.processedAssetId)) } catch { known.set(row.processedAssetId, null) } }
      geometry = known.get(row.processedAssetId)
      if (!geometry) issues.push({ code: 'broken', message: '处理结果缺失，请重新应用样板', blocking: true })
      else if (layers.some(layer => Math.min(geometry.width / layer.w, geometry.height / layer.h) * 25.4 < 150)) issues.push({ code: 'low-dpi', message: '实际输出不足 150 dpi，建议更换更清晰的照片', blocking: false })
    }
    rows.push({ ...row, rowId, label: Object.entries(ds.rows[row.rowIndex]).filter(([key]) => key !== ds.photoMatchColumn).map(([,value]) => String(value ?? '')).filter(Boolean).slice(0,3).join(' · ') || row.name,
      individual: Boolean(processing?.individual), width: geometry?.width, height: geometry?.height, issues })
  }
  const previews = []
  if (template && previewRows !== undefined) {
    if (!Array.isArray(previewRows) || previewRows.length > 24 || previewRows.some(index => !Number.isInteger(index) || index < 0 || index >= ds.rows.length) || new Set(previewRows).size !== previewRows.length) throw new Error('批量预览每页最多 24 条有效记录')
    const spec = require('./render-engine.cjs').pageSpec(template.pageSize), scale = 240 / (spec.w * 96 / 25.4)
    for (const rowIndex of previewRows) {
      try {
        const batch = require('./print.cjs').buildBatchHtml(ds.id, template.id, [rowIndex])
        previews.push({ rowIndex, height: 240 * spec.h / spec.w, html: batch.html.replace('</head>', `<style>html,body{margin:0!important;overflow:hidden!important;background:white!important}body{zoom:${scale}}.page{margin:0!important}</style></head>`) })
      } catch (error) { previews.push({ rowIndex, error: error.message }) }
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  return { rows, counts: { total: rows.length, problems: rows.filter(row => row.issues.length).length, blocking: rows.filter(row => row.issues.some(issue => issue.blocking)).length, individual: rows.filter(row => row.individual).length }, previews }
}
module.exports = { inspect, render, apply, cancel, clear, resolver, revision, normalizeRecipe, current, setOptions, listPresets, savePreset, deletePreset, setSingle, clearSingle, scheduleAutomatic, singles, details, review }

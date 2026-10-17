/**
 * 打印领域层：出口校验（空值 / 疑似占位 / 超宽 / 重复行报告，只提示不拦截）、批量 HTML 组装、
 * 打印任务留痕与归档（按月分目录，快照可回看）。
 *
 * 校验分层（承袭源项目原则）：字段目录数据驱动 → 画布半透明提示 →
 * 【本层】打印前空值报告（前端弹窗，可中断可放行）→ 渲染时空值留白兜底。
 *
 * 出片范围（不变量「留痕必全，状态只认全量」）：
 * - 范围可为全量，也可为行级勾选（rows = 0 基索引集合，基于数据集全量行序）；
 * - 无论范围大小，每一次出片都留痕（createJob 记录 scope）；
 * - 但数据集级「已打」状态只由全量出片回写——判定依据 scope.partial，回写动作在 ipc 层。
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { loadJson, saveJson, resolveInsideDataDir } = require('./store.cjs')
const { toUserMessage } = require('./user-error.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const renderEngine = require('./render-engine.cjs')
const { estimatePdfBytes } = require('./output-dpi.cjs')
const { isPlaceholder } = require('./placeholder.cjs')

const DATA_DIR = process.env.PRINTPRESS_DATA_DIR
const ARCHIVE_ROOT = path.join(DATA_DIR, 'archive')
const JOBS_STORE = 'print-jobs'

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

/**
 * 预检辅助：估算单行文字渲染宽度（mm）。
 * CJK 及全角字符记 1em，其余（ASCII/半角）记 0.55em；1pt = 25.4/72 mm。
 * 只求「明显超宽」的粗判（字数 × 字号 vs 可用宽度），不做像素级度量——
 * 渲染层 .pf 是 nowrap，超宽即横向溢出被 overflow:hidden 裁掉，宁多报勿漏报。
 */
function estimateTextWidthMm(text, fontSizePt) {
  let em = 0
  for (const ch of String(text ?? '')) em += ch.charCodeAt(0) > 0xff ? 1 : 0.55
  return em * (Number(fontSizePt) || 12) * 25.4 / 72
}

/**
 * 字段锚点处的可用宽度（mm）：按对齐方式从 x% 推算（居中取两侧较窄一边的两倍）。
 *
 * 两道防线：
 * - Math.max(0, pct) 挡住越界坐标算出的负宽度（负数会让任何非空值都判超宽）
 * - 5mm 下限挡住 pct=0（贴边字段）。下限只作数值兜底，不是给坏布局放行：
 *   真正贴边的模板在 saveTemplate 就已被validateLayout 拦下，不会到打印这一步。
 */
const MIN_USABLE_MM = 5

function usableWidthMm(f, containerWmm) {
  const x = Number(f.x) || 0
  const align = f.align || 'center'
  const pct = align === 'center' ? Math.min(x, 100 - x) * 2 : (align === 'right' ? x : 100 - x)
  const mm = containerWmm * Math.max(0, pct) / 100
  return Math.max(MIN_USABLE_MM, mm)
}

/** 行摘要（重复行提示用）：前 3 个非空列值拼接 */
function rowPreviewOf(ds, row) {
  const vals = (ds.columns || []).map((c) => String(row[c.key] ?? '').trim()).filter(Boolean).slice(0, 3)
  return vals.join(' · ') || '（空行）'
}

/** 规范化行级选择：去重、越界丢弃、按原行序升序——打印顺序跟随名单顺序，而非勾选顺序 */
function normalizeSelection(selection, total) {
  return [...new Set(selection.map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < total)
    .sort((a, b) => a - b)
}

/**
 * 出片范围解析：rows 为行级勾选索引集合（null / 缺省 = 全量）。
 * range 为分批导出的行区间 { from, to }（0 基，[from, to)）——S1.3-b 按整纸
 * 切批后逐批渲染用。返回 { rows, selection, batch, rowIndexes }：
 * - selection 保持整次出片的口径（留痕与「已打」回写判定不能被单批次
 *   歪曲：一批 100 行不能把全量导出误判成部分出片）
 * - rowIndexes 为本次实际出行在数据集里的行号（照片未匹配报错定位用；
 *   非分批路径下它就是 selection，行为与以前逐字一致）
 */
function resolveScope(ds, { rows, range } = {}) {
  const clipRange = (n) => {
    const rawFrom = range && Number.isFinite(range.from) ? Math.floor(range.from) : 0
    const rawTo = range && Number.isFinite(range.to) ? Math.floor(range.to) : n
    const from = Math.max(0, Math.min(rawFrom, n))
    const to = Math.max(from, Math.min(rawTo, n))
    return { from, to }
  }
  if (Array.isArray(rows)) {
    const selection = normalizeSelection(rows, ds.rows.length)
    if (!selection.length) throw new Error('请至少勾选一行再出片')
    if (range) {
      const { from, to } = clipRange(selection.length)
      const indexes = selection.slice(from, to)
      if (!indexes.length) throw new Error('分批区间为空：没有可出片的行')
      return { rows: indexes.map((i) => ds.rows[i]), selection, batch: { from, to, size: to - from }, rowIndexes: indexes }
    }
    return { rows: selection.map((i) => ds.rows[i]), selection, rowIndexes: selection }
  }
  if (range) {
    const { from, to } = clipRange(ds.rows.length)
    const indexes = []
    for (let i = from; i < to; i++) indexes.push(i)
    if (!indexes.length) throw new Error('分批区间为空：没有可出片的行')
    return { rows: indexes.map((i) => ds.rows[i]), selection: null, batch: { from, to, size: to - from }, rowIndexes: indexes }
  }
  return { rows: ds.rows, selection: null, rowIndexes: null }
}

/** Full selected-scope photo check shared by the page and both output paths. */
async function photoPreflight(datasetId, templateId, rows) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  const scope = resolveScope(ds, { rows })
  const design = renderEngine.resolveTemplateDesign(tpl)
  const photoLayers = (design?.layers || []).filter(layer => layer.variable && layer.visible && !layer.editorOnly)
  const spec = renderEngine.pageSpec(tpl.pageSize)
  const layout = renderEngine.resolveLayout(tpl.layout, spec)
  const indexes = scope.rowIndexes || ds.rows.map((_, index) => index)
  const photo = photoLayers.length
    ? await require('./photo-library.cjs').preflightRows(ds, indexes)
    : { column: null, enabled: false, total: indexes.length,
      counts: { matched: 0, empty: 0, missing: 0, ambiguous: 0, invalid: 0, broken: 0 },
      results: [], bindingRevision: null }
  const selectionFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    datasetId: ds.id, indexes, recordIds: indexes.map(index => ds.recordIds?.[index]),
    rows: indexes.map(index => ds.rows[index]), photoMatchColumn: ds.photoMatchColumn,
  })).digest('hex')
  const templateRevision = crypto.createHash('sha256').update(JSON.stringify(tpl)).digest('hex')
  const overrideRevision = require('./photo-overrides.cjs').revisionFor(ds.id, tpl.id, indexes.map(index => ds.recordIds?.[index]))
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    selectionFingerprint, templateRevision, bindingRevision: photo.bindingRevision, overrideRevision,
  })).digest('hex')
  const issues = photo.results.filter(item => !['matched', 'empty'].includes(item.status))
    .map(item => ({ ...item, rowId: ds.recordIds?.[item.rowIndex] || null,
      ...(item.reason ? { reason: toUserMessage(item.reason) } : {}) }))
  return {
    selectionFingerprint, templateRevision, bindingRevision: photo.bindingRevision, overrideRevision, fingerprint,
    recordCount: indexes.length, pageCount: Math.ceil(indexes.length / (layout.enabled ? layout.perPage : 1)),
    photoLayerCount: photoLayers.length, photoFrameCount: photoLayers.length * indexes.length,
    photoEnabled: photo.enabled, photoColumn: photo.column, counts: photo.counts, issues,
    canOutput: !issues.some(item => ['ambiguous', 'invalid', 'broken'].includes(item.status)),
  }
}

async function assertPhotoPreflight(datasetId, templateId, rows, expectedFingerprint) {
  const result = await photoPreflight(datasetId, templateId, rows)
  if (expectedFingerprint && result.fingerprint !== expectedFingerprint) {
    throw new Error('打印预检后名单、模板或照片关联已变化，请重新检查后出片')
  }
  if (!result.canOutput) {
    const issue = result.issues.find(item => ['ambiguous', 'invalid', 'broken'].includes(item.status))
    throw new Error(`第 ${issue.rowIndex + 1} 行照片${{ ambiguous: '同名冲突', invalid: '名称无效', broken: '素材损坏' }[issue.status]}，请处理后再出片`)
  }
  return result
}

/**
 * 按完整物理纸张切批（S1.3-b）。
 *
 * 为什么不能按固定记录数硬切：多联一页 = perPage 条记录，从页中间切开会让
 * 同一条记录裂进两个批次（拼接后花版、漏行）。批边界必须落在页边界上——
 * 批内记录数向上取整到 perPage 的整数倍，尾批取剩余（尾批的零头页是整份
 * 作业的最后一页，不涉及跨批拆分）。
 *
 * @param total 记录数
 * @param layout buildBatchHtml 返回的 layout 摘要（enabled / fold / perPage）
 * @param maxRows 每批目标记录数（默认 100：S1 实测 100 张照片页 ≈ 1.5GB
 *                渲染进程，是 4GB 目标内的安全档；文字作业每批远小于此）
 * @returns [{ start, end, rows, pages, perPage }]，行区间为 [start, end)
 */
function planBatches(total, layout, maxRows = 100) {
  const perPage = layout && layout.enabled ? (layout.fold ? 1 : Math.max(1, Math.floor(layout.perPage) || 1)) : 1
  if (!(total > 0)) return []
  const target = Math.max(1, Math.floor(maxRows) || 100)
  const chunk = Math.max(perPage, Math.ceil(target / perPage) * perPage)
  const batches = []
  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(start + chunk, total)
    batches.push({ start, end, rows: end - start, pages: Math.ceil((end - start) / perPage), perPage })
  }
  return batches
}

/** 范围摘要：selected 为本次出片行数；partial 表示非全量（据此决定是否回写数据集状态） */
function scopeInfo(selection, total) {
  const selected = selection ? selection.length : total
  return { selected, total, partial: Boolean(selection) && selected !== total }
}

/**
 * 是否回写数据集「已打」状态——**单一权威判定**（不变量「留痕必全，状态只认全量」）。
 * 只有全量出片回写；部分出片（行级勾选 / 分组导出）一律不回写，否则
 * 「打了 3 个人」会显示成「整份已打」，侧栏信号失真、用户判断被带偏。
 *
 * selected <= 0 也不回写：空数据集或全被取消勾选时一张都没出，
 * 标成「已打」是凭空多一个成功信号。0 份的留痕照写（历史要能查到这次操作）。
 * selected 缺省（非数字）按全量处理——旧调用方传的是 { partial } 形状。
 */
function shouldMarkPrinted(scope) {
  if (!scope) return true
  if (scope.partial) return false
  const n = Number(scope.selected)
  return Number.isFinite(n) ? n > 0 : true
}

/**
 * 出口校验：出片范围（全量 / 行级勾选）× 模板字段 → 问题清单。
 * 只提示不拦截：空值位置留白打印；疑似占位（值形态规则）单独提示；
 * 超宽文字（估算越界）会被版面裁切；完全重复的行多为误粘贴（同名多份是合法需求，放行权在用户）。
 * 返回 issues 含空值/占位/超宽 > 0 的字段；allEmptyFields 是整列为空的重点提示；
 * duplicates 是内容完全一致的行分组。
 */
function validateBatch(datasetId, templateId, rows) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  // column 为权威属性，key 是旧版 UI 的存法（兼容读取）
  const fields = (tpl.fields || []).filter((f) => f.column || f.key)
  const scope = resolveScope(ds, { rows })
  const list = scope.rows
  // 超宽估算的容器宽度：多联为单格宽，单页为整页宽（与渲染引擎 resolveLayout 口径一致）
  const spec = renderEngine.pageSpec(tpl.pageSize)
  const layout = renderEngine.resolveLayout(tpl.layout, spec)
  const containerW = layout.enabled ? layout.itemW : spec.w

  const issues = []
  const dsKeys = new Set((ds.columns || []).map((c) => c.key))
  // 未激活打印的列：列还在，但用户已在数据页取消过「印」。
  // 必须当缺失处理——否则模板照常出片，字段位置印出来是空白，
  // 用户拿到手才发现，而界面上一个提示都没有（matchDataset 会说不匹配，
  // 但出片这条路上完全静默）。
  const notPrintable = new Set(
    (ds.columns || []).filter((c) => c.printOn !== true).map((c) => c.key))
  for (const f of fields) {
    const colName = f.column || f.key
    // 字段缺失：模板字段在数据集中不存在（换绑/错配兜底），或已取消「印」，单列报告
    if (!dsKeys.has(colName) || notPrintable.has(colName)) {
      issues.push({
        key: colName,
        label: f.label || colName,
        missing: true,
        // 区分两种缺失：文案不同，用户该做的事也不同（换绑数据集 vs 去数据页点「印」）
        reason: !dsKeys.has(colName) ? 'not-found' : 'not-printable',
        empty: list.length,
        placeholder: 0,
        overlong: 0,
        total: list.length,
      })
      continue
    }
    let empty = 0
    let placeholder = 0
    let overlong = 0
    const cells = [] // 出错单元格坐标（0 基行号 + 列键），供「去补录」直达跳转；上限防 payload 膨胀
    const CELL_CAP = 30
    for (let ri = 0; ri < list.length; ri++) {
      // 行级勾选时行号须回填为「数据集全量行号」，否则「去补录直达」会跳到错误行
      const fullIndex = scope.selection ? scope.selection[ri] : ri
      const v = list[ri][colName]
      if (isEmpty(v)) {
        empty++
        if (cells.length < CELL_CAP) cells.push({ rowIndex: fullIndex, kind: 'empty' })
      } else if (isPlaceholder(v)) {
        placeholder++
        if (cells.length < CELL_CAP) cells.push({ rowIndex: fullIndex, kind: 'placeholder' })
      } else if (estimateTextWidthMm(v, f.fontSize) > usableWidthMm(f, containerW)) {
        overlong++
        if (cells.length < CELL_CAP) cells.push({ rowIndex: fullIndex, kind: 'overlong' })
      }
    }
    if (empty > 0 || placeholder > 0 || overlong > 0) {
      issues.push({
        key: colName,
        label: f.label || colName,
        empty,
        placeholder,
        overlong,
        total: list.length,
        cells,
        cellsTotal: empty + placeholder + overlong,
      })
    }
  }

  // 完全相同的行（所有列的值一致）：多为误粘贴 / 重复导入，只提示不拦截。
  // 行号同样回填全量行号；单组展示上限 30 行，超出只报 total。
  const DUP_CAP = 30
  const seen = new Map()
  const duplicates = []
  for (let ri = 0; ri < list.length; ri++) {
    const fullIndex = scope.selection ? scope.selection[ri] : ri
    const sig = JSON.stringify((ds.columns || []).map((c) => list[ri][c.key] ?? ''))
    let g = seen.get(sig)
    if (!g) {
      g = { preview: rowPreviewOf(ds, list[ri]), rowIdx: [], count: 0 }
      seen.set(sig, g)
    }
    g.count++
    if (g.rowIdx.length < DUP_CAP) g.rowIdx.push(fullIndex)
  }
  for (const g of seen.values()) if (g.count > 1) duplicates.push(g)

  return {
    recordCount: list.length,
    totalCount: ds.rows.length,
    filtered: list.length !== ds.rows.length,
    scope: scopeInfo(scope.selection, ds.rows.length),
    fieldCount: fields.length,
    issues,
    allEmptyFields: issues.filter((i) => i.empty === i.total).map((i) => i.label),
    duplicates,
    duplicateTotal: duplicates.reduce((s, g) => s + g.count, 0),
  }
}

/**
 * 出片前预热：把带 `adjust` / `shadow` 的固定图片图层烘成单张 PNG（契约 I-50）。
 *
 * **必须在异步上下文里 await**——它要拉离屏窗口截图，而 `buildBatchHtml` 是同步的。
 * 预跑之后，同步链路里的 `renderEngine.prepareTemplateDesign` 只做缓存命中替换。
 *
 * 这是**设计级**的事（跟有多少行无关），所以整个作业跑一次就够，分批时不必每批都烘。
 * 返回 `{ stats, overrides }`；不烘任何东西时 `stats.baked === 0`。
 */
async function warmBatchBakes(templateId, outputDpi) {
  const tpl = templates.getTemplate(String(templateId))
  const design = renderEngine.resolveTemplateDesign(tpl)
  if (!design) return null
  try {
    return await require('./output-dpi.cjs').prepareFixedBakes({ design, dpi: outputDpi })
  } catch {
    // 烘焙是优化，不是出片的前置条件：失败只能是「不烘」，绝不能拦住出片
    return null
  }
}

/**
 * 组装批量 HTML（不落盘，供预览 / PDF / 直打共用）；范围由 rows（行级勾选）限定；
 *  range 为分批导出的行区间（S1.3-b），只影响本次渲染的行，不改 selection 口径。
 *
 * `outputDpi` 是出片分辨率（契约 I-49）：照片降到图框需要的像素后再出片。
 * **它只作用于出片用的 `html`**；归档快照 `snapshotHtml` 始终用原件——
 * 归档要能脱离本机逐字节核对，留降采样件等于把「原件保真」换成「出片表征」。
 *
 * `encodeDerivatives` 缺省 true（出片）。预览传 false：只规划、不生成派生件，
 * 整批预估为其他页读取尺寸元数据，不读取所有照片字节，也不为预览生成派生件。
 */
function buildBatchHtml(datasetId, templateId, rows, { range, previewPage, outputDpi, encodeDerivatives } = {}) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  const spec = renderEngine.pageSpec(tpl.pageSize)
  let scope = resolveScope(ds, { rows, range })
  const fullScope = scope
  // 多联：一页装多条记录，页数 ≠ 记录数，必须分开报，否则预览会按记录数撑高
  const layout = renderEngine.resolveLayout(tpl.layout, spec)
  const fullCount = scope.rows.length
  const perPage = layout.enabled ? layout.perPage : 1
  const fullPages = Math.ceil(fullCount / perPage)
  let shownPage = null
  if (previewPage !== undefined && previewPage !== null) {
    if (!Number.isInteger(previewPage) || previewPage < 0) throw new Error('预览页码必须为非负整数')
    shownPage = Math.min(previewPage, Math.max(0, fullPages - 1))
    if (fullCount) scope = resolveScope(ds, { rows, range: { from: shownPage * perPage, to: (shownPage + 1) * perPage } })
  }
  const list = scope.rows
  const pageCount = layout.enabled ? Math.ceil(list.length / layout.perPage) : list.length
  const doc = renderEngine.resolveTemplateDesign(tpl)
  const photoColumns = (doc?.layers || []).filter(layer => layer.variable && layer.visible && !layer.editorOnly).map(layer => layer.bindColumn)
  const photos = require('./photo-library.cjs').prepareRows(ds.id, photoColumns, list, scope.rowIndexes, { templateId: tpl.id })
  const preparedDesign = renderEngine.prepareTemplateDesign(tpl, photos, { outputDpi, encodeDerivatives })
  // 预览只渲染一页，但预估覆盖用户选定的全部记录。其余页只读尺寸元数据，
  // 不解码或哈希所有照片；出片时仍逐张验证原件。缺失信息时不显示不完整的体积数字。
  let output = preparedDesign.output
  let outputEstimateIncomplete = false
  if (shownPage !== null && doc) {
    const allPhotos = require('./photo-library.cjs').prepareRows(ds.id, photoColumns, fullScope.rows, fullScope.rowIndexes,
      { estimateOnly: true, knownGeometry: photos.geometry, templateId: tpl.id })
    output = require('./output-dpi.cjs').planDerivatives({ design: doc, photos: allPhotos, dpi: outputDpi }).stats
    outputEstimateIncomplete = allPhotos.unresolved > 0 || output.failed > 0
  }
  // 归档快照显式按「原图 + 不烘焙」再准备一次，不复用出片用的那份。
  // 出片档位本来就是「原图」、且没有烘焙件时两者等价，直接复用，不白做一遍。
  const canReuseForArchive = preparedDesign.output?.dpi == null && !(preparedDesign.bake?.baked > 0)
  const archiveDesign = canReuseForArchive
    ? preparedDesign
    : renderEngine.prepareTemplateDesign(tpl, photos, { outputDpi: null, encodeDerivatives: false, bake: false })
  // 底图输出分辨率：交给界面提示「印出来够不够清」。
  // 成品口径与渲染一致——多联是单格、对折是半页、单页是整张纸。
  const itemW = layout.enabled ? layout.itemW : spec.w
  const itemH = layout.enabled ? layout.itemH : spec.h
  const bgDpi = (!tpl.backgroundDesign && tpl.bgSize && tpl.bgSize.width > 0 && tpl.bgSize.height > 0 && itemW > 0 && itemH > 0)
    ? {
      // 与模板页一致：取宽、高两轴中较低的有效 dpi，避免拉伸时误报清晰。
      dpi: Math.min(tpl.bgSize.width / (itemW / 25.4), tpl.bgSize.height / (itemH / 25.4)),
      width: tpl.bgSize.width,
      height: tpl.bgSize.height,
      stretched: Math.abs(tpl.bgSize.width / tpl.bgSize.height - itemW / itemH) / (itemW / itemH) > 0.02,
    }
    : null
  return {
    html: renderEngine.buildHtml(tpl, list, { withToolbar: false, preparedDesign }),
    // 归档快照用 archiveDesign（原件），与出片用的 preparedDesign 分开——见函数头注释
    snapshotHtml: renderEngine.buildHtml(tpl, list, { withToolbar: true, preparedDesign: archiveDesign }),
    recordCount: shownPage === null ? list.length : fullCount,
    photoAssets: photos.assets,
    pageCount: shownPage === null ? pageCount : fullPages,
    renderedPageCount: pageCount,
    previewPage: shownPage,
    bgDpi,
    designInfo: preparedDesign.info,
    // 出片分辨率与本次实际优化结果：界面据此如实显示「多少张降到了目标 DPI、省了多少」
    outputDpi: output?.dpi ?? null,
    // 体积是**模型**不是预言（见 output-dpi 顶部）：界面必须带「约」字，
    // 导出完成后一律用真实字节数覆盖它。
    // 烘焙件（I-50）只嵌一份，所以按 1 份计入——它恰好把「带效果的固定图片逐页各栅格化一份」
    // 那部分体积从预估里去掉（那部分以前根本没被算进来，等于对 9.8 GB 一声不吭）。
    outputEstimateBytes: outputEstimateIncomplete ? null : estimatePdfBytes((output?.embeddedPixels || 0) + (preparedDesign.bake?.pixels || 0)),
    outputOriginalEstimateBytes: outputEstimateIncomplete ? null : estimatePdfBytes(output?.originalEmbeddedPixels),
    outputEstimateIncomplete,
    output,
    // 固定图片烘焙统计（I-50）：界面据此说明「几个带效果的底图已烘焙成单张图」
    bake: preparedDesign.bake,
    layout: layout.enabled
      ? (layout.fold
        ? { enabled: true, fold: true, perPage: 1 }
        : { enabled: true, cols: layout.cols, rows: layout.rows, perPage: layout.perPage })
      // 回退时必须带上 mode 与 reason：少了它们，前端无法区分「多联放不下已按单页出片」
      // 与「本来就是单页版式」，用户只会看到结果和预期不符却不知发生了什么
      : { enabled: false, mode: tpl.layout?.mode || 'single', reason: layout.reason || '' },
    templateName: tpl.name,
    datasetName: ds.name,
    page: { id: spec.id, name: spec.name, w: spec.w, h: spec.h },
    scope: scopeInfo(scope.selection, ds.rows.length),
    selection: scope.selection,
    selectionIds: scope.selection === null ? null : scope.selection.map(index => ds.recordIds[index]),
  }
}

/**
 * PDF/归档文件名清洗。
 *
 * 模板名是用户自由输入，会被直接拼进保存对话框的 defaultPath，
 * 除了路径非法字符，Windows 还有两类硬限制：
 * - 保留设备名（CON / PRN / AUX / NUL / COM1…）——用这些名字保存会静默失败或写到别处
 * - 结尾的点与空格——被系统悄悄截掉，用户以为存成了 A.pdf 其实是 A
 * 所以这两类也要处理，不然「导出成功」和「文件在哪」对不上。
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function sanitizeFilename(name) {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')   // 路径非法字符与控制字符
    .replace(/[. ]+$/, '')// 结尾的点/空格会被系统截断
    .trim()
  const base = (s || '未命名').slice(0, 80).replace(/[. ]+$/, '')
  return WIN_RESERVED.test(base) ? `_${base}` : base
}

function archiveDirectoryForJob(job) {
  if (!job || !job.snapshot) return null
  const parts = typeof job.snapshot === 'string' ? job.snapshot.split('/') : []
  if (!/^job_[a-zA-Z0-9_-]+$/.test(String(job.id))
      || parts.length !== 4 || parts[0] !== 'archive'
      || !/^\d{4}-(0[1-9]|1[0-2])$/.test(parts[1])
      || parts[2] !== job.id || parts[3] !== 'snapshot.html') {
    throw new Error('归档路径异常，保留归档文件')
  }
  const dir = resolveInsideDataDir(parts.slice(0, 3).join('/'))
  for (let i = 1; i <= 3; i++) {
    const part = resolveInsideDataDir(parts.slice(0, i).join('/'))
    let stat
    try { stat = fs.lstatSync(part) } catch (err) { if (err.code === 'ENOENT') continue; throw err }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('归档目录异常，保留归档文件')
  }
  return dir
}

function removeArchiveDirectory(job) {
  const dir = archiveDirectoryForJob(job)
  if (!dir || !fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  if (fs.existsSync(dir)) throw new Error('归档目录仍存在')
  try { fs.rmdirSync(path.dirname(dir)) } catch { /* keep a non-empty month directory */ }
  return true
}

/**
 * 留痕：快照 HTML 写入 archive/年-月/<jobId>/snapshot.html，
 * 任务元数据原子写入 print-jobs 存储。
 * 范围字段：partial 标记部分出片（供 UI 标注「部分 N/总」并与全量区分），
 * selection 仅在部分出片时落盘（全量为 null，避免冗余）。
 */
function createJob({ templateId, templateName, datasetId, datasetName, mode, recordCount, totalRows, partial, selection, selectionIds, snapshotHtml, photoAssets = [], status, detail }) {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const jobId = `job_${now.getTime().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  // 取消态（点了打印又取消）不落盘快照：无意义且占空间，仅留历史痕迹（状态标「取消」）。
  // 仅 ok / failed 这类「真正出片过」的历史才产出可回看的归档快照。
  const isCanceled = status === 'canceled'
  let snapshotRel = null
  if (!isCanceled) {
    const jobDir = path.join(ARCHIVE_ROOT, month, jobId)
    fs.mkdirSync(jobDir, { recursive: true })
    snapshotRel = `archive/${month}/${jobId}/snapshot.html`
    const snapshot = require('./photo-output.cjs').archivePhotos(jobDir, snapshotHtml || '', photoAssets)
    fs.writeFileSync(path.join(DATA_DIR, snapshotRel), snapshot, 'utf-8')
  }

  const isPartial = Boolean(partial)
  const job = {
    id: jobId,
    createdAt: now.toISOString(),
    templateId: templateId || '', // 供一键重打定位
    templateName: templateName || '',
    datasetId: datasetId || '',
    datasetName: datasetName || '',
    mode: mode || 'pdf', // 'pdf' | 'print'
    recordCount: recordCount || 0,
    totalRows: Number(totalRows) || recordCount || 0,
    partial: isPartial,
    selection: isPartial && Array.isArray(selection) ? selection : null,
    selectionIds: isPartial && Array.isArray(selectionIds) ? selectionIds : null,
    status: status || 'ok', // 'ok' | 'failed' | 'canceled'
    detail: detail || '',
    snapshot: snapshotRel,
  }
  const prev = loadJson(JOBS_STORE, { expect: 'array' }) || []
  // 只保留最近 200 条：历史无上限会让 print-jobs.json 无限膨胀（实测 60 条
  // 带 5000 行 selection 即 3.4MB），而 listJobs 每次都要全量解析，久了会卡主进程。
  // 达到留存上限时，在新索引与恢复备份同步后清理已淘汰任务的归档目录。
  const next = [job, ...prev].slice(0, 200)
  const evicted = [job, ...prev].slice(200)
  saveJson(JOBS_STORE, next)
  const retentionCleanup = { evicted: evicted.length, removedArchives: 0, retainedArchives: 0, backupUpdated: null }
  if (evicted.length) {
    try {
      fs.copyFileSync(path.join(DATA_DIR, `${JOBS_STORE}.json`), path.join(DATA_DIR, `${JOBS_STORE}.json.bak`))
      retentionCleanup.backupUpdated = true
    } catch { retentionCleanup.backupUpdated = false }
    if (retentionCleanup.backupUpdated) {
      for (const oldJob of evicted) {
        if (!oldJob.snapshot) continue
        if (next.some(item => item.id === oldJob.id || item.snapshot === oldJob.snapshot)) {
          retentionCleanup.retainedArchives++
          continue
        }
        try {
          if (removeArchiveDirectory(oldJob)) retentionCleanup.removedArchives++
        } catch {
          retentionCleanup.retainedArchives++
        }
      }
    } else retentionCleanup.retainedArchives = evicted.filter(item => item.snapshot).length
  }
  return { ...job, retentionCleanup }
}

function listJobs() {
  return loadJson(JOBS_STORE, { expect: 'array' }) || []
}

/**
 * 留痕记录里的快照相对路径 → 绝对路径（不存在即抛错）。
 * 路径必须过守卫：snapshot 来自可被手工编辑的 JSON，`../` 会读到数据目录外的文件，
 * 且该路径会直接交给 BrowserWindow 渲染。
 */
function resolveSnapshot(jobId) {
  const job = listJobs().find((j) => j.id === String(jobId))
  if (!job) throw new Error(`打印记录已不存在（可能已被删除）`)
  if (!job.snapshot) throw new Error('该记录没有归档快照（取消的打印不落盘）')
  const abs = resolveInsideDataDir(job.snapshot)
  if (!fs.existsSync(abs)) throw new Error(`归档快照文件已丢失（可能被手动清理），无法查看`)
  return abs
}

/**
 * 删除打印任务：元数据移除 + 归档目录清理。
 * 归档目录（archive/<月>/<jobId>/）含 snapshot.html，变量图快照另含 photos/ 原件，
 * 只允许清理该任务自己拥有的目录；清理失败保留记录，允许用户重试。
 * 不删除外部 PDF、共享素材或名单的累计打印状态。
 */
function deleteJob(jobId) {
  const jobs = listJobs()
  // 遍历全部匹配项而非 find 首条：id 意外重复时（外部改过 JSON），
  // 只清首条目录会让另一条变成无元数据的孤儿快照，永久占盘
  const matched = jobs.filter((j) => j.id === String(jobId))
  if (!matched.length) throw new Error(`打印记录已不存在（可能已被删除）`)
  // 所有路径先验证，再开始删除；被篡改的 snapshot 不得指向其他任务/素材目录。
  const dirs = new Set()
  for (const job of matched) {
    // 取消态没有归档快照（snapshot 为 null），仅删元数据即可
    if (!job.snapshot) continue
    const parts = typeof job.snapshot === 'string' ? job.snapshot.split('/') : []
    if (!/^job_[a-zA-Z0-9_-]+$/.test(String(job.id))
      || parts.length !== 4 || parts[0] !== 'archive'
      || !/^\d{4}-(0[1-9]|1[0-2])$/.test(parts[1])
      || parts[2] !== job.id || parts[3] !== 'snapshot.html') {
      throw new Error('归档路径异常，未删除记录；请检查该任务的快照路径')
    }
    const jobDir = resolveInsideDataDir(parts.slice(0, 3).join('/'))
    // 中间目录的链接/junction 也不能绕过守卫到数据目录外或其他任务。
    for (let i = 1; i <= 3; i++) {
      const dir = resolveInsideDataDir(parts.slice(0, i).join('/'))
      let stat
      try { stat = fs.lstatSync(dir) } catch (err) { if (err.code === 'ENOENT') continue; throw err }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('归档目录异常，未删除记录')
    }
    dirs.add(jobDir)
  }
  for (const jobDir of dirs) {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true })
      if (fs.existsSync(jobDir)) throw new Error('目录仍存在')
    } catch (err) {
      // 这句会显示在打印历史的操作反馈上，所以 err.message（可能含路径/errno）不能直接拼（I-48）
      throw new Error(`归档清理失败，打印记录已保留，可重试：${toUserMessage(err, '文件可能被其他程序占用')}`)
    }
    // 空月份目录没有归档内容，只在确实为空时移除。
    try { fs.rmdirSync(path.dirname(jobDir)) } catch { /* 其他任务或文件仍在，保留 */ }
  }
  saveJson(JOBS_STORE, jobs.filter((j) => j.id !== String(jobId)))
  // saveJson 默认保留上一版；删除后让恢复副本同步，防止损坏恢复时复活已删记录。
  let backupUpdated = true
  try {
    fs.copyFileSync(path.join(DATA_DIR, `${JOBS_STORE}.json`), path.join(DATA_DIR, `${JOBS_STORE}.json.bak`))
  } catch { backupUpdated = false }
  return { ok: true, archiveRemoved: true, backupUpdated }
}

module.exports = {
  validateBatch,
  photoPreflight,
  assertPhotoPreflight,
  buildBatchHtml,
  warmBatchBakes,
  createJob,
  listJobs,
  deleteJob,
  resolveSnapshot,
  sanitizeFilename,
  normalizeSelection,
  resolveScope,
  scopeInfo,
  shouldMarkPrinted,
  planBatches,
  ARCHIVE_ROOT,
}

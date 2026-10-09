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
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const renderEngine = require('./render-engine.cjs')
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
 * 返回 { rows, selection }：selection 为规范化索引集合，全量时为 null。
 */
function resolveScope(ds, { rows } = {}) {
  if (Array.isArray(rows)) {
    const selection = normalizeSelection(rows, ds.rows.length)
    if (!selection.length) throw new Error('请至少勾选一行再出片')
    return { rows: selection.map((i) => ds.rows[i]), selection }
  }
  return { rows: ds.rows, selection: null }
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

/** 组装批量 HTML（不落盘，供预览 / PDF / 直打共用）；范围由 rows（行级勾选）限定 */
function buildBatchHtml(datasetId, templateId, rows) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  const spec = renderEngine.pageSpec(tpl.pageSize)
  const scope = resolveScope(ds, { rows })
  const list = scope.rows
  // 多联：一页装多条记录，页数 ≠ 记录数，必须分开报，否则预览会按记录数撑高
  const layout = renderEngine.resolveLayout(tpl.layout, spec)
  const pageCount = layout.enabled ? Math.ceil(list.length / layout.perPage) : list.length
  const preparedDesign = renderEngine.prepareTemplateDesign(tpl)
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
    snapshotHtml: renderEngine.buildHtml(tpl, list, { withToolbar: true, preparedDesign }),
    recordCount: list.length,
    pageCount,
    bgDpi,
    designInfo: preparedDesign.info,
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

/**
 * 留痕：快照 HTML 写入 archive/年-月/<jobId>/snapshot.html，
 * 任务元数据原子写入 print-jobs 存储。
 * 范围字段：partial 标记部分出片（供 UI 标注「部分 N/总」并与全量区分），
 * selection 仅在部分出片时落盘（全量为 null，避免冗余）。
 */
function createJob({ templateId, templateName, datasetId, datasetName, mode, recordCount, totalRows, partial, selection, snapshotHtml, status, detail }) {
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
    fs.writeFileSync(path.join(DATA_DIR, snapshotRel), snapshotHtml || '', 'utf-8')
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
    status: status || 'ok', // 'ok' | 'failed' | 'canceled'
    detail: detail || '',
    snapshot: snapshotRel,
  }
  const prev = loadJson(JOBS_STORE, { expect: 'array' }) || []
  // 只保留最近 200 条：历史无上限会让 print-jobs.json 无限膨胀（实测 60 条
  // 带 5000 行 selection 即 3.4MB），而 listJobs 每次都要全量解析，久了会卡主进程。
  // 快照目录不在此清理范围内——删记录走 deleteJob，保留期内的归档留在盘上由用户自行处理。
  saveJson(JOBS_STORE, [job, ...prev].slice(0, 200))
  return job
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
 * 归档目录（archive/<月>/<jobId>/）仅含 snapshot.html 单文件，
 * 元数据经 saveJson 原子落盘；两步都成功才算删净，目录已不存在视为已删。
 */
function deleteJob(jobId) {
  const jobs = listJobs()
  // 遍历全部匹配项而非 find 首条：id 意外重复时（外部改过 JSON），
  // 只清首条目录会让另一条变成无元数据的孤儿快照，永久占盘
  const matched = jobs.filter((j) => j.id === String(jobId))
  if (!matched.length) throw new Error(`打印记录已不存在（可能已被删除）`)
  let archiveRemoved = true
  for (const job of matched) {
    // 取消态没有归档快照（snapshot 为 null），仅删元数据即可
    if (!job.snapshot) continue
    let jobDir
    try {
      jobDir = resolveInsideDataDir(path.dirname(job.snapshot))
    } catch (err) {
      // 路径越界说明存储被改过：跳过清理但仍删元数据，不让删除整体失败
      console.warn(`[print] 归档清理跳过（${err.message}）`)
      continue
    }
    if (fs.existsSync(jobDir)) {
      try {
        fs.rmSync(jobDir, { recursive: true, force: true })
        archiveRemoved = archiveRemoved && !fs.existsSync(jobDir)
      } catch (err) {
        archiveRemoved = false
        console.warn(`[print] 归档目录删除失败 ${jobDir}: ${err.message}`)
      }
    }
  }
  saveJson(JOBS_STORE, jobs.filter((j) => j.id !== String(jobId)))
  return { ok: true, archiveRemoved }
}

module.exports = {
  validateBatch,
  buildBatchHtml,
  createJob,
  listJobs,
  deleteJob,
  resolveSnapshot,
  sanitizeFilename,
  normalizeSelection,
  resolveScope,
  scopeInfo,
  shouldMarkPrinted,
  ARCHIVE_ROOT,
}

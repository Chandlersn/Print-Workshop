/**
 * 打印领域层：出口校验（空值报告，只提示不拦截）、批量 HTML 组装、
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
const { loadJson, saveJson } = require('./store.cjs')
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
 */
function shouldMarkPrinted(scope) {
  return !(scope && scope.partial)
}

/**
 * 出口校验：出片范围（全量 / 行级勾选）× 模板字段 → 问题清单。
 * 只提示不拦截：空值位置留白打印；疑似占位（值形态规则）单独提示。
 * 返回 issues 含空值或占位值 > 0 的字段；allEmptyFields 是整列为空的重点提示。
 */
function validateBatch(datasetId, templateId, rows) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  // column 为权威属性，key 是旧版 UI 的存法（兼容读取）
  const fields = (tpl.fields || []).filter((f) => f.column || f.key)
  const scope = resolveScope(ds, { rows })
  const list = scope.rows

  const issues = []
  const dsKeys = new Set((ds.columns || []).map((c) => c.key))
  for (const f of fields) {
    const colName = f.column || f.key
    // 字段缺失：模板字段在数据集中不存在（换绑/错配兜底），单列报告
    if (!dsKeys.has(colName)) {
      issues.push({
        key: colName,
        label: f.label || colName,
        missing: true,
        empty: list.length,
        placeholder: 0,
        total: list.length,
      })
      continue
    }
    let empty = 0
    let placeholder = 0
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
      }
    }
    if (empty > 0 || placeholder > 0) {
      issues.push({
        key: colName,
        label: f.label || colName,
        empty,
        placeholder,
        total: list.length,
        cells,
        cellsTotal: empty + placeholder,
      })
    }
  }
  return {
    recordCount: list.length,
    totalCount: ds.rows.length,
    filtered: list.length !== ds.rows.length,
    scope: scopeInfo(scope.selection, ds.rows.length),
    fieldCount: fields.length,
    issues,
    allEmptyFields: issues.filter((i) => i.empty === i.total).map((i) => i.label),
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
  return {
    html: renderEngine.buildHtml(tpl, list, { withToolbar: false }),
    snapshotHtml: renderEngine.buildHtml(tpl, list, { withToolbar: true }),
    recordCount: list.length,
    pageCount,
    layout: layout.enabled
      ? { enabled: true, cols: layout.cols, rows: layout.rows, perPage: layout.perPage }
      : { enabled: false },
    templateName: tpl.name,
    datasetName: ds.name,
    page: { id: spec.id, name: spec.name, w: spec.w, h: spec.h },
    scope: scopeInfo(scope.selection, ds.rows.length),
    selection: scope.selection,
  }
}

/** PDF/归档文件名清洗：路径非法字符与换行 → 下划线，限长 80 */
function sanitizeFilename(name) {
  const s = String(name ?? '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim()
  return (s || '未命名').slice(0, 80)
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
  const jobDir = path.join(ARCHIVE_ROOT, month, jobId)
  fs.mkdirSync(jobDir, { recursive: true })
  const snapshotRel = `archive/${month}/${jobId}/snapshot.html`
  fs.writeFileSync(path.join(DATA_DIR, snapshotRel), snapshotHtml || '', 'utf-8')

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
  saveJson(JOBS_STORE, [job, ...(loadJson(JOBS_STORE) || [])])
  return job
}

function listJobs() {
  return loadJson(JOBS_STORE) || []
}

/** 留痕记录里的快照相对路径 → 绝对路径（不存在即抛错） */
function resolveSnapshot(jobId) {
  const job = listJobs().find((j) => j.id === String(jobId))
  if (!job) throw new Error(`打印记录已不存在（可能已被删除）`)
  const abs = path.join(DATA_DIR, job.snapshot)
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
  const job = jobs.find((j) => j.id === String(jobId))
  if (!job) throw new Error(`打印记录已不存在（可能已被删除）`)
  const jobDir = path.join(DATA_DIR, path.dirname(job.snapshot))
  let archiveRemoved = false
  if (fs.existsSync(jobDir)) {
    fs.rmSync(jobDir, { recursive: true, force: true })
    archiveRemoved = !fs.existsSync(jobDir)
  } else {
    archiveRemoved = true // 快照本就缺失（曾被手动清理），只删元数据即可
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

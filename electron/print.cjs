/**
 * 打印领域层：出口校验（空值报告，只提示不拦截）、批量 HTML 组装、
 * 打印任务留痕与归档（按月分目录，快照可回看）。
 *
 * 校验分层（承袭源项目原则）：字段目录数据驱动 → 画布半透明提示 →
 * 【本层】打印前空值报告（前端弹窗，可中断可放行）→ 渲染时空值留白兜底。
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const renderEngine = require('./render-engine.cjs')
const { applyFilters, isPlaceholder } = require('./rows.cjs')

const DATA_DIR = process.env.PRINTPRESS_DATA_DIR
const ARCHIVE_ROOT = path.join(DATA_DIR, 'archive')
const JOBS_STORE = 'print-jobs'

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

/**
 * 出口校验：打印范围（行筛选）× 模板字段 → 问题清单。
 * 只提示不拦截：空值位置留白打印；疑似占位（值形态规则）单独提示。
 * 返回 issues 含空值或占位值 > 0 的字段；allEmptyFields 是整列为空的重点提示。
 */
function validateBatch(datasetId, templateId, filters) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  // column 为权威属性，key 是旧版 UI 的存法（兼容读取）
  const fields = (tpl.fields || []).filter((f) => f.column || f.key)
  const rows = applyFilters(ds.rows, filters)

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
        empty: rows.length,
        placeholder: 0,
        total: rows.length,
      })
      continue
    }
    let empty = 0
    let placeholder = 0
    const cells = [] // 出错单元格坐标（0 基行号 + 列键），供「去补录」直达跳转；上限防 payload 膨胀
    const CELL_CAP = 30
    for (let ri = 0; ri < rows.length; ri++) {
      const v = rows[ri][colName]
      if (isEmpty(v)) {
        empty++
        if (cells.length < CELL_CAP) cells.push({ rowIndex: ri, kind: 'empty' })
      } else if (isPlaceholder(v)) {
        placeholder++
        if (cells.length < CELL_CAP) cells.push({ rowIndex: ri, kind: 'placeholder' })
      }
    }
    if (empty > 0 || placeholder > 0) {
      issues.push({
        key: colName,
        label: f.label || colName,
        empty,
        placeholder,
        total: rows.length,
        cells,
        cellsTotal: empty + placeholder,
      })
    }
  }
  return {
    recordCount: rows.length,
    totalCount: ds.rows.length,
    filtered: rows.length !== ds.rows.length,
    fieldCount: fields.length,
    issues,
    allEmptyFields: issues.filter((i) => i.empty === i.total).map((i) => i.label),
  }
}

/** 组装批量 HTML（不落盘，供预览 / PDF / 直打共用）；filters 限定打印范围 */
function buildBatchHtml(datasetId, templateId, filters) {
  const ds = dataset.getDataset(String(datasetId))
  const tpl = templates.getTemplate(String(templateId))
  const spec = renderEngine.pageSpec(tpl.pageSize)
  const rows = applyFilters(ds.rows, filters)
  return {
    html: renderEngine.buildHtml(tpl, rows, { withToolbar: false }),
    snapshotHtml: renderEngine.buildHtml(tpl, rows, { withToolbar: true }),
    recordCount: rows.length,
    templateName: tpl.name,
    datasetName: ds.name,
    page: { id: spec.id, name: spec.name, w: spec.w, h: spec.h },
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
 */
function createJob({ templateId, templateName, datasetId, datasetName, mode, recordCount, snapshotHtml, status, detail }) {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const jobId = `job_${now.getTime().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  const jobDir = path.join(ARCHIVE_ROOT, month, jobId)
  fs.mkdirSync(jobDir, { recursive: true })
  const snapshotRel = `archive/${month}/${jobId}/snapshot.html`
  fs.writeFileSync(path.join(DATA_DIR, snapshotRel), snapshotHtml || '', 'utf-8')

  const job = {
    id: jobId,
    createdAt: now.toISOString(),
    templateId: templateId || '', // 供一键重打定位
    templateName: templateName || '',
    datasetId: datasetId || '',
    datasetName: datasetName || '',
    mode: mode || 'pdf', // 'pdf' | 'print'
    recordCount: recordCount || 0,
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
  ARCHIVE_ROOT,
}

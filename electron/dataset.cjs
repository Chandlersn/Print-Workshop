/**
 * 数据集领域层：导入建档、增删查、列别名、单元格编辑、字段目录派生。
 *
 * 设计原则：
 * - 入口宽松：导入不做校验，能读多少读多少
 * - 过程透明：字段目录带类型推断、填充率、长度提示，只提示不拦截
 * - 工作台可完善：导入后允许直接改数（单元格/行级编辑），编辑即重算列统计，
 *   让「出口把关」（打印前校验）看到的是修完的数据
 * - 用户数据全部是业务数据（与源项目内部台账不同），因此不做硬性
 *   可打印过滤——长文本仅给 suggestSkip 提示，打印与否由用户决定
 */
const path = require('path')
const crypto = require('crypto')
const { loadJson, saveJson } = require('./store.cjs')
const { buildColumns } = require('./keys.cjs')
const { importGrid } = require('./importer/index.cjs')
const { listSheets, readWorkbookGrids, detectHeaderRow, sliceFromHeader } = require('./importer/excel.cjs')

const STORE_NAME = 'datasets'

function loadAll() {
  return loadJson(STORE_NAME, { expect: 'array' }) || []
}

function persistAll(list) {
  saveJson(STORE_NAME, list)
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

/** 类型推断：全非空值均为布尔字面量 → boolean；均可数值化 → number；否则 text */
function inferType(values) {
  const nonEmpty = values.filter((v) => !isEmpty(v))
  if (nonEmpty.length === 0) return { type: 'text', avgLen: 0 }

  const boolSet = new Set(['true', 'false'])
  const isBool = nonEmpty.every((v) => boolSet.has(String(v).trim().toLowerCase()))
  if (isBool) return { type: 'boolean', avgLen: avg(nonEmpty) }

  const isNum = nonEmpty.every((v) => !Number.isNaN(Number(v)))
  if (isNum) return { type: 'number', avgLen: avg(nonEmpty) }

  return { type: 'text', avgLen: avg(nonEmpty) }
}

function avg(values) {
  if (!values.length) return 0
  return Math.round(values.reduce((s, v) => s + String(v).length, 0) / values.length)
}

/** 标准网格 → 数据集建档（类型/填充统计 + 入库），importFromFile 与 importSheets 共用 */
function gridToDataset(grid, name, sourceMeta) {
  const headers = grid[0]
  const bodyRows = grid.slice(1)

  const columns = buildColumns(headers)
  const rows = bodyRows.map((r) => {
    const rec = {}
    columns.forEach((col, i) => { rec[col.key] = r[i] === undefined ? '' : String(r[i]) })
    return rec
  })

  // 类型与填充统计（过程透明，不拦截）
  columns.forEach((col) => {
    const values = rows.map((r) => r[col.key])
    const { type, avgLen } = inferType(values)
    col.type = type
    col.avgLen = avgLen
    col.filled = values.filter((v) => !isEmpty(v)).length
  })

  const ds = {
    id: newId('ds'),
    name,
    source: sourceMeta,
    columns,
    rows,
  }
  const list = loadAll()
  list.push(ds)
  persistAll(list)
  return summary(ds)
}

/**
 * 导入主流程：文件 → 网格 → 数据集建档入库（CSV / 单表 Excel 快捷路径）。
 * 同一次导入调用共享同一个 batchId（导入会话）：数据页按它分组，
 * 支持一键删除整批——「一次导入的所有工作簿」是一个管理单元。
 */
function importFromFile(filePath, nameOverride) {
  const grid = importGrid(filePath)
  return gridToDataset(grid, nameOverride || path.basename(filePath), {
    type: path.extname(filePath).toLowerCase().replace('.', ''),
    fileName: path.basename(filePath),
    importedAt: new Date().toISOString(),
    batchId: newId('imp'),
  })
}

/**
 * 导入前检视：CSV 直接导入返回结果；Excel 返回工作表清单（含表头检测）。
 * 单工作表 Excel 也走清单——表头行可能不在第一行，用户需要确认机会。
 */
function inspectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.csv' || ext === '.txt') {
    const ds = importFromFile(filePath)
    return { kind: 'csv', datasets: [ds] }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    return { kind: 'xlsx', filePath, fileName: path.basename(filePath), sheets: listSheets(filePath) }
  }
  throw new Error(`不支持的文件类型: ${ext}（支持 .xlsx / .xls / .csv）`)
}

/**
 * 按工作表批量导入。
 * selections: [{ name, headerRow? }] headerRow 为 0 基行号（缺省用自动检测）。
 * mode:
 *   - 'split'：每个工作表一个数据集，命名「文件名·表名」
 *   - 'merge'：合并为一个数据集，列取并集，末列自动加「来源工作表」
 * onProgress: (p) => void，进度回调（stage/pct/label），供 UI 进度条消解等待焦虑。
 * 返回新建数据集摘要列表（Promise）。
 */

/** 让主进程事件循环喘一口气：进度消息才能经 IPC 刷给渲染进程并重绘 */
const yieldUi = () => new Promise((r) => setImmediate(r))

async function importSheets(filePath, { selections, mode, onProgress = () => {} }) {
  if (!Array.isArray(selections) || !selections.length) {
    throw new Error('未选择任何工作表')
  }
  const report = (p) => { try { onProgress(p) } catch { /* 进度回调异常不阻断导入 */ } }
  const base = path.basename(filePath, path.extname(filePath))
  const sourceMeta = {
    type: path.extname(filePath).toLowerCase().replace('.', ''),
    fileName: path.basename(filePath),
    importedAt: new Date().toISOString(),
    batchId: newId('imp'), // 本次导入会话标识：split 出的 N 个数据集共享，整批删除按它圈定
  }

  // 1. 整簿只读一次（此前每表经 parseSheetGrid 重读一遍，大文件 N 表 = N 次全量解析）
  report({ stage: 'read', pct: 2, label: '读取工作簿…' })
  await yieldUi()
  const { grids } = readWorkbookGrids(filePath)

  // 2. 逐表切片（保留原错误语义：任一表切片失败即整体中止，未落库任何数据集）
  const parsed = []
  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i]
    report({
      stage: 'parse',
      current: i + 1,
      total: selections.length,
      name: String(sel.name),
      pct: 5 + Math.round(50 * (i / selections.length)),
      label: `解析「${sel.name}」${i + 1}/${selections.length}`,
    })
    await yieldUi()
    const grid = grids[String(sel.name)]
    if (!grid) throw new Error(`工作表不存在: ${sel.name}`)
    const hr = Number.isInteger(sel.headerRow) && sel.headerRow >= 0
      ? sel.headerRow
      : detectHeaderRow(grid)
    if (hr < 0) throw new Error(`工作表「${sel.name}」未检测到有效表头行，可手动指定`)
    const sliced = sliceFromHeader(grid, hr)
    if (!sliced || sliced.length < 1) throw new Error(`工作表「${sel.name}」表头行之后没有数据`)
    parsed.push({ name: String(sel.name), headerRow: hr, sliced })
  }

  if (mode === 'merge') {
    if (parsed.length === 1) mode = 'split' // 单表无合并意义，退化为 split
  }

  const results = []
  if (mode === 'merge') {
    // 列并集（按各表表头文本去重，保持首现顺序），行按选择顺序拼接
    report({ stage: 'build', pct: 70, label: `合并 ${parsed.length} 个工作表…` })
    await yieldUi()
    const unionHeads = []
    const seen = new Set()
    for (const p of parsed) {
      for (const h of p.sliced[0]) {
        const key = String(h).trim()
        if (key && !seen.has(key)) { seen.add(key); unionHeads.push(key) }
      }
    }
    unionHeads.push('来源工作表')
    const rows2d = [unionHeads]
    for (const p of parsed) {
      const headIndex = new Map()
      p.sliced[0].forEach((h, i) => headIndex.set(String(h).trim(), i))
      for (const r of p.sliced.slice(1)) {
        const out = unionHeads.map((h) => {
          if (h === '来源工作表') return p.name
          const i = headIndex.get(h)
          return i === undefined || i >= r.length ? '' : r[i]
        })
        rows2d.push(out)
      }
    }
    report({ stage: 'save', pct: 92, label: '保存合并数据集…' })
    await yieldUi()
    results.push(gridToDataset(rows2d, `${base}（合并 ${parsed.length} 表）`, sourceMeta))
  } else {
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i]
      report({
        stage: 'build',
        current: i + 1,
        total: parsed.length,
        pct: 60 + Math.round(30 * (i / parsed.length)),
        label: `生成「${base}·${p.name}」${i + 1}/${parsed.length}`,
      })
      await yieldUi()
      results.push(gridToDataset(p.sliced, `${base}·${p.name}`, sourceMeta))
    }
  }
  report({ stage: 'done', pct: 100, label: '导入完成' })
  return results
}

function summary(ds) {
  return {
    id: ds.id,
    name: ds.name,
    source: ds.source,
    rowCount: ds.rows.length,
    columnCount: ds.columns.length,
    // 已激活打印的字段数（列头「印」开关）——模板页数据集下拉据此置顶排序
    printCols: ds.columns.filter((c) => c.printOn === true).length,
    // 打印/导出过的状态回写——数据页侧栏据此变色，用户一眼看出哪些工作簿还没打
    printCount: ds.printCount || 0,
    lastPrintedAt: ds.lastPrintedAt || '',
    lastPrintMode: ds.lastPrintMode || '',
  }
}

function listDatasets() {
  return loadAll().map(summary)
}

function findDs(id) {
  const ds = loadAll().find((d) => d.id === id)
  // 文案面向用户：不暴露内部 id，直接给现象与出路
  if (!ds) throw new Error('所选数据集已不存在（可能已被删除），请刷新后重新选择')
  return ds
}

function getDataset(id) {
  const ds = findDs(id)
  return { ...summary(ds), columns: ds.columns, rows: ds.rows }
}

function deleteDataset(id) {
  findDs(id)
  persistAll(loadAll().filter((d) => d.id !== id))
  return { ok: true }
}

/**
 * 按导入会话整批删除：ids 为同批数据集 id 清单（UI 从 source.batchId 分组派生）。
 * 一次 persistAll 落盘（逐个 deleteDataset 会写 N 次）；实际删除数如实返回，
 * 已不存在的 id 不报错也不计入——部分已被删时剩余的照删，与「会话清空」语义一致。
 */
function deleteBatch(ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String))
  if (!want.size) throw new Error('未指定要删除的数据集')
  const list = loadAll()
  const remaining = list.filter((d) => !want.has(d.id))
  const deleted = list.length - remaining.length
  if (deleted === 0) throw new Error('所选数据集均已不存在（可能已被删除），请刷新后重试')
  persistAll(remaining)
  return { ok: true, deleted }
}

function renameColumn(id, key, alias) {
  const aliasClean = String(alias || '').trim()
  if (!aliasClean) throw new Error('列别名不能为空')
  const list = loadAll()
  const ds = list.find((d) => d.id === id)
  if (!ds) throw new Error(`所选数据集已不存在（可能已被删除），请刷新后重新选择`)
  const col = ds.columns.find((c) => c.key === key)
  if (!col) throw new Error(`列不存在: ${key}`)
  col.alias = aliasClean
  persistAll(list)
  return { ok: true, alias: aliasClean }
}

// ---- 行级/单元格编辑（导入后用户自行修正局部问题） ----

/** 重算某列（或全部列）的类型/填充/均长统计——编辑后即时刷新，字段目录与打印校验共用同一份真相 */
function recomputeColumnStats(ds, key) {
  const targets = key ? ds.columns.filter((c) => c.key === key) : ds.columns
  for (const col of targets) {
    const values = ds.rows.map((r) => r[col.key])
    const { type, avgLen } = inferType(values)
    col.type = type
    col.avgLen = avgLen
    col.filled = values.filter((v) => !isEmpty(v)).length
  }
}

function assertRowIndex(ds, rowIndex) {
  const i = Number(rowIndex)
  if (!Number.isInteger(i) || i < 0 || i >= ds.rows.length) {
    throw new Error(`行号越界: ${rowIndex}（共 ${ds.rows.length} 行，0 基）`)
  }
  return i
}

/** 修改单元格：值一律存为字符串（与导入路径一致），编辑后重算该列统计并落盘 */
function updateCell(id, rowIndex, key, value) {
  const list = loadAll()
  const ds = list.find((d) => d.id === id)
  if (!ds) throw new Error(`所选数据集已不存在（可能已被删除），请刷新后重新选择`)
  const i = assertRowIndex(ds, rowIndex)
  const col = ds.columns.find((c) => c.key === String(key))
  if (!col) throw new Error(`列不存在: ${key}`)
  ds.rows[i][col.key] = String(value ?? '')
  recomputeColumnStats(ds, col.key)
  persistAll(list)
  return {
    ok: true,
    rowIndex: i,
    key: col.key,
    value: ds.rows[i][col.key],
    column: { key: col.key, alias: col.alias, type: col.type, filled: col.filled, avgLen: col.avgLen },
  }
}

/** 追加空行（全部列为空串），返回新行号 */
function addRow(id) {
  const list = loadAll()
  const ds = list.find((d) => d.id === id)
  if (!ds) throw new Error(`所选数据集已不存在（可能已被删除），请刷新后重新选择`)
  const rec = {}
  ds.columns.forEach((c) => { rec[c.key] = '' })
  ds.rows.push(rec)
  recomputeColumnStats(ds)
  persistAll(list)
  return { ok: true, rowIndex: ds.rows.length - 1, rowCount: ds.rows.length }
}

/** 删除行（0 基行号），删后重算全部列统计 */
function deleteRow(id, rowIndex) {
  const list = loadAll()
  const ds = list.find((d) => d.id === id)
  if (!ds) throw new Error(`所选数据集已不存在（可能已被删除），请刷新后重新选择`)
  const i = assertRowIndex(ds, rowIndex)
  ds.rows.splice(i, 1)
  recomputeColumnStats(ds)
  persistAll(list)
  return { ok: true, rowCount: ds.rows.length }
}

/** 列级打印开关：停用的字段不出现在模板设计页字段清单（决策权在用户，渲染不受影响——已放置字段照常出图） */
function setColumnPrint(id, key, on) {
  const list = loadAll()
  const ds = list.find((d) => d.id === id)
  if (!ds) throw new Error(`所选数据集已不存在（可能已被删除），请刷新后重新选择`)
  const col = ds.columns.find((c) => c.key === String(key))
  if (!col) throw new Error(`列不存在: ${key}`)
  col.printOn = Boolean(on)
  persistAll(list)
  return { ok: true, key: col.key, printOn: col.printOn }
}

/**
 * 字段目录：打印模板字段勾选清单的数据来源。
 * 建议跳过（suggestSkip）只作 UI 提示，绝不硬过滤——出口把关在打印前校验。
 * printOn 缺省视为 false：字段默认不参与打印，须用户在数据页列头显式激活。
 */
function fieldCatalog(id) {
  const ds = findDs(id)
  return ds.columns.map((col) => ({
    key: col.key,
    alias: col.alias,
    type: col.type,
    fill: `${col.filled}/${ds.rows.length}`,
    fillRate: ds.rows.length ? col.filled / ds.rows.length : 0,
    avgLen: col.avgLen,
    suggestSkip: col.type === 'boolean' || col.avgLen > 200 || col.filled === 0,
    printOn: col.printOn === true,
  }))
}

/**
 * 打印/导出成功的状态回写（工作簿级）：数据页侧栏变色显示，用户对照
 * 哪些工作簿已经打过、哪些还没打。只在导出/打印成功后调用（失败不标）。
 */
function markPrinted(id, mode) {
  const list = loadAll()
  const ds = list.find((d) => d.id === String(id))
  if (!ds) throw new Error('所选数据集已不存在（可能已被删除），请刷新后重新选择')
  ds.printCount = (ds.printCount || 0) + 1
  ds.lastPrintedAt = new Date().toISOString()
  ds.lastPrintMode = mode === 'print' ? 'print' : 'pdf'
  persistAll(list)
  return { printCount: ds.printCount, lastPrintedAt: ds.lastPrintedAt }
}

module.exports = {
  importFromFile,
  inspectFile,
  importSheets,
  listDatasets,
  getDataset,
  deleteDataset,
  deleteBatch,
  renameColumn,
  updateCell,
  addRow,
  deleteRow,
  setColumnPrint,
  markPrinted,
  fieldCatalog,
}

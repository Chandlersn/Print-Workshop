/**
 * Excel 导入：多工作表支持 + 表头行智能检测。
 *
 * 真实世界的工作簿往往不是「第一行即表头」：
 * 证书打包分表 = 标题行 + 统计段 + 空行 + 明细段（第 N 行才是真表头）。
 * 因此导入流程拆为两步：
 *   1. listSheets(filePath)  → 每个表的概要（含检测出的表头行与预览）
 *   2. parseSheetGrid + sliceFromHeader → 按选定表头行切片成标准网格
 * detectHeaderRow / sliceFromHeader 是纯函数，可独立测试。
 */
const fs = require('fs')
const XLSX = require('xlsx')

/**
 * 导入上限与原型污染守卫（I-53）。
 *
 * 为什么要有：这个函数面对的是**用户随手拖进来的文件**，而 `xlsx@0.18.5` 有两条
 * 官方已无修复版本的安全公告（原型污染 + ReDoS）。换解析器是产品决策，在那之前
 * 至少把「可判定的坏输入」挡在门外——上限全部取「正常名单不可能达到」的量级：
 *  - 单文件 64 MB：证书名单不该有这个体量，超过基本是误选（拖了整个数据库导出）；
 *  - 工作表 64 张 / 单表 20 万行 / 1024 列 / 合计 200 万格：再大就不是名单了；
 *  - 单格 3 万字符：ReDoS 与内存膨胀都靠超长字符串放大。
 * 另外每次解析前后对 `Object.prototype` 做一次快照，见 assertNoPrototypePollution。
 *
 * 上限可注入（`limits` 参数）是为了**能测**：测试不必真造一个 64 MB 的文件。
 */
const LIMITS = {
  bytes: 64 * 1024 * 1024,
  sheets: 64,
  rows: 200000,
  cols: 1024,
  cells: 2000000,
  cellChars: 30000,
}

/** 体积闸门：stat 读不到就交给 XLSX.readFile 报它自己的错（不在这里假装文件不存在） */
function assertFileSize(filePath, limits = LIMITS) {
  let size = 0
  try { size = fs.statSync(filePath).size } catch { return }
  if (size > limits.bytes) {
    const mb = limits.bytes / 1024 / 1024
    const shown = mb >= 1 ? `${Math.round(mb)} MB` : `${limits.bytes} 字节`
    throw new Error(`Excel 文件超过大小上限（${shown}），请先在表格软件里拆成多个文件再导入。`)
  }
}

/** 网格闸门：行 / 列 / 单元格总数 / 单格长度，返回本表单元格数供跨表累加 */
function assertGridLimits(name, grid, limits = LIMITS) {
  if (grid.length > limits.rows) {
    throw new Error(`工作表「${name}」超过 ${limits.rows} 行上限，请先在表格软件里拆分。`)
  }
  let cells = 0
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i]
    if (row.length > limits.cols) {
      throw new Error(`工作表「${name}」超过 ${limits.cols} 列上限，请先在表格软件里裁剪。`)
    }
    cells += row.length
    for (let j = 0; j < row.length; j++) {
      if (String(row[j]).length > limits.cellChars) {
        throw new Error(`工作表「${name}」第 ${i + 1} 行有超长单元格（超过 ${limits.cellChars} 字符），请确认这个文件是不是选错了。`)
      }
    }
  }
  return cells
}

const prototypeSnapshot = () => new Set(Object.getOwnPropertyNames(Object.prototype))

/**
 * 原型污染守卫：解析前后比对 `Object.prototype` 的自有属性名，多出来的就是被注入的。
 * 只检出还不够——注入的属性会一直留在进程里影响后面所有代码，所以**先清掉再报错**：
 * 快照之外的键按定义就是这次解析新加上去的，删它不会碰到语言/框架自带的属性。
 */
function assertNoPrototypePollution(before) {
  const injected = Object.getOwnPropertyNames(Object.prototype).filter((k) => !before.has(k))
  if (!injected.length) return
  for (const k of injected) {
    try { delete Object.prototype[k] } catch { /* 删不掉也要把它报出来 */ }
  }
  throw new Error('这个 Excel 文件携带了原型污染载荷，已拒绝导入并清理现场。请换用 CSV，或用表格软件另存为新文件后再试。')
}

/** 读整个工作簿，返回 { wb, sheets: { 表名: 字符串网格 } }（空单元格补空串） */
function readWorkbookGrids(filePath) {
  assertFileSize(filePath)
  const before = prototypeSnapshot()
  // sheetRows 让解析器在超行时提前收手，不把整张巨表读进内存
  const wb = XLSX.readFile(filePath, { dense: false, sheetRows: LIMITS.rows + 1 })
  assertNoPrototypePollution(before)
  if (!wb.SheetNames.length) {
    throw new Error('Excel 文件不含任何工作表')
  }
  if (wb.SheetNames.length > LIMITS.sheets) {
    throw new Error(`工作簿含 ${wb.SheetNames.length} 张工作表，超过 ${LIMITS.sheets} 张上限，请先拆分。`)
  }
  const grids = {}
  let cells = 0
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      raw: false, // 取显示值（日期等格式化文本，适合打印场景）
      defval: '',
    })
    const normalized = grid.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))))
    cells += assertGridLimits(name, normalized)
    if (cells > LIMITS.cells) {
      throw new Error(`工作簿合计超过 ${LIMITS.cells} 个单元格上限，请先在表格软件里拆分。`)
    }
    grids[name] = normalized
  }
  return { wb, grids }
}

/**
 * 表头行检测（纯函数）。
 * 启发式评分：非空列数 ×2 + 表头不重复 +3 + 短文本占比 ×4
 *            + 下一行数据量 + 纯数字占比惩罚 ×6（表头一般不含纯数字列）。
 * 只扫描前 30 行；无候选返回 -1。
 */
function detectHeaderRow(grid) {
  let best = -1
  let bestScore = -Infinity
  const limit = Math.min(grid.length, 30)
  for (let i = 0; i < limit; i++) {
    const cells = grid[i].map((c) => String(c).trim()).filter((c) => c !== '')
    if (cells.length < 2) continue
    const unique = new Set(cells).size === cells.length ? 3 : 0
    const shortRatio = cells.filter((c) => c.length <= 15).length / cells.length
    const numRatio = cells.filter((c) => !Number.isNaN(Number(c))).length / cells.length
    const nextFilled = i + 1 < grid.length
      ? grid[i + 1].filter((c) => String(c).trim() !== '').length
      : 0
    const score = cells.length * 2 + unique + shortRatio * 4 + Math.min(nextFilled, cells.length) - numRatio * 6
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/**
 * 从表头行切片成标准网格（纯函数）：
 * - 丢弃表头行之前的所有行（标题、统计段）
 * - 丢弃完全空白的行
 * - 裁掉右侧整列为空的列（合并标题造成的幽灵列）
 * 返回 null 表示该表头行之后没有数据。
 */
function sliceFromHeader(grid, headerRow) {
  if (headerRow < 0 || headerRow >= grid.length) return null
  const kept = grid.slice(headerRow).filter((r) => r.some((c) => String(c).trim() !== ''))
  if (kept.length === 0) return null
  let maxCol = 0
  for (const r of kept) {
    for (let i = r.length - 1; i >= 0; i--) {
      if (String(r[i]).trim() !== '') { maxCol = Math.max(maxCol, i); break }
    }
  }
  return kept.map((r) => {
    const out = []
    for (let i = 0; i <= maxCol; i++) out.push(r[i] === undefined ? '' : String(r[i]))
    return out
  })
}

/** 工作表清单：供导入前选择（含表头行检测结果与预览） */
function listSheets(filePath) {
  const { wb, grids } = readWorkbookGrids(filePath)
  return wb.SheetNames.map((name) => {
    const grid = grids[name]
    const nonEmptyRows = grid.filter((r) => r.some((c) => String(c).trim() !== '')).length
    const headerRow = detectHeaderRow(grid)
    const sliced = headerRow >= 0 ? sliceFromHeader(grid, headerRow) : null
    return {
      name,
      nonEmptyRows,
      headerRow, // 0 基；-1 = 未检测到
      dataRows: sliced ? sliced.length - 1 : 0,
      colCount: sliced ? sliced[0].length : 0,
      headerPreview: sliced ? sliced[0].slice(0, 4) : [],
    }
  })
}

/** 按表名取原始网格（供 dataset 层按用户指定表头行切片） */
function parseSheetGrid(filePath, sheetName) {
  const { grids } = readWorkbookGrids(filePath)
  const grid = grids[sheetName]
  if (!grid) throw new Error(`工作表不存在: ${sheetName}`)
  return grid
}

/** 兼容旧接口：第一个工作表按检测表头切片（seed-demo 等内部调用） */
function importExcel(filePath) {
  const { wb, grids } = readWorkbookGrids(filePath)
  const grid = grids[wb.SheetNames[0]]
  const hr = detectHeaderRow(grid)
  const sliced = sliceFromHeader(grid, hr >= 0 ? hr : 0)
  if (!sliced) throw new Error('第一个工作表为空')
  return sliced
}

module.exports = {
  readWorkbookGrids,
  listSheets,
  parseSheetGrid,
  detectHeaderRow,
  sliceFromHeader,
  importExcel,
  // 供验收测试直接驱动守卫（I-53）：上限可注入，测试不必真造 64 MB 文件
  LIMITS,
  assertFileSize,
  assertGridLimits,
  assertNoPrototypePollution,
}

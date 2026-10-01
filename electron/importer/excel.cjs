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
const XLSX = require('xlsx')

/** 读整个工作簿，返回 { wb, sheets: { 表名: 字符串网格 } }（空单元格补空串） */
function readWorkbookGrids(filePath) {
  const wb = XLSX.readFile(filePath, { dense: false })
  if (!wb.SheetNames.length) {
    throw new Error('Excel 文件不含任何工作表')
  }
  const grids = {}
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      raw: false, // 取显示值（日期等格式化文本，适合打印场景）
      defval: '',
    })
    grids[name] = grid.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))))
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

module.exports = { readWorkbookGrids, listSheets, parseSheetGrid, detectHeaderRow, sliceFromHeader, importExcel }

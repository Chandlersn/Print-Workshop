/* 名册解析：Excel 名单 → 单位 / 行 / 字段，纯函数优先。
 *
 * 三个口径必须钉死，否则后面全错：
 *  1. dataRow —— 过滤掉全空行之后的 0 基序号，**与批印坊数据集的行索引一一对应**
 *     （导入时同样过滤空行）。出片的 rows:[i] 传的就是它。
 *  2. excelRow —— 1 基，Excel 里肉眼看到的行号 = dataRow + 2（第 1 行是表头）。
 *  3. 编号列 —— 固定取第 1 列（列 key = '1'）。编号为空的行不出片：
 *     这些人在补充编号名单里已按 5xxx 编号出过，重导只会生成 `_姓名.png` 垃圾。
 */
const path = require('path')
const XLSX = require('xlsx')
const { matchHeader, batchLabel } = require('./config.cjs')

function readGrid(file, sheetName) {
  const wb = XLSX.readFile(file, { dense: false })
  const sheet = sheetName ? wb.Sheets[sheetName] : wb.Sheets[wb.SheetNames[0]]
  if (!sheet) throw new Error(`工作表不存在: ${sheetName}（${path.basename(file)}）`)
  return { wb, grid: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) }
}

function isBlankRow(r) {
  return !r || !r.some(c => String(c ?? '').trim() !== '')
}

/**
 * 解析一个工作表。
 * @returns {{sheet:string, no:number, header:string[], requiredIdx:object, missingColumns:string[],
 *            rows:Array<{dataRow,excelRow,code,name,values,blanks}>}}
 */
function parseSheet(grid, sheetName, cfg) {
  if (!grid.length) {
    return { sheet: sheetName, no: Number(String(sheetName).split('_')[0]) || 0, header: [], requiredIdx: {}, missingColumns: cfg.requiredFields.map(f => f.key), rows: [] }
  }
  const header = grid[0].map(h => String(h ?? '').trim())

  const requiredIdx = {}
  const missingColumns = []
  for (const f of cfg.requiredFields) {
    const i = matchHeader(header, f.match)
    if (i < 0) missingColumns.push(f.key)
    else requiredIdx[f.key] = i
  }

  const iName = matchHeader(header, 'prefix:姓名')
  if (iName < 0) throw new Error(`${sheetName} 缺姓名列，无法出片`)

  const rows = []
  let dataRow = 0
  for (let k = 1; k < grid.length; k++) {
    const r = grid[k]
    if (isBlankRow(r)) continue
    const values = {}
    const blanks = []
    for (const f of cfg.requiredFields) {
      const i = requiredIdx[f.key]
      const v = i === undefined ? '' : String(r[i] ?? '').trim()
      values[f.key] = v
      if (!v) blanks.push(f.key)
    }
    rows.push({
      dataRow,
      excelRow: k + 1,
      code: String(r[0] ?? '').trim(),
      name: String(r[iName] ?? '').trim(),
      values,
      blanks,
    })
    dataRow++
  }
  return {
    sheet: sheetName,
    no: Number(String(sheetName).split('_')[0]) || 0,
    header,
    requiredIdx,
    missingColumns,
    rows,
  }
}

/** 读整份名册：每个 sheet = 一个单位。 */
function readRoster(file, cfg) {
  const wb = XLSX.readFile(file, { dense: false })
  const units = wb.SheetNames.map(name => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' })
    return parseSheet(grid, name, cfg)
  })
  return { file, batch: batchLabel(file), sheetNames: wb.SheetNames, units }
}

/**
 * 批量读多份名册并按单位序号过滤。
 * @param {{unit?:Set<number>|null, from?:number, to?:number}} range
 */
function readRosters(cfg, files, range = {}) {
  const out = []
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(cfg.rosterDir, file)
    const roster = readRoster(abs, cfg)
    roster.units = roster.units.filter(u => inRange(u.no, range))
    out.push(roster)
  }
  return out
}

function inRange(no, range = {}) {
  if (range.unit && !range.unit.has(no)) return false
  if (range.from !== undefined && range.from !== null && !(no >= range.from)) return false
  if (range.to !== undefined && range.to !== null && !(no <= range.to)) return false
  return true
}

/** 应出文件名的主体（不含 .png）。编号空 → 空串，调用方据此跳过。 */
function fileStem(row) {
  if (!row.code) return ''
  return `${row.code}_${row.name}`
}

/** 已知口径差异判定：如 Excel「二等奖」↔ 数据集「个人复赛二等奖」。 */
function isKnownDialect(cfg, field, excelValue, dsValue) {
  for (const d of cfg.knownDialects || []) {
    if (d.field !== field) continue
    if (String(d.datasetIs).replace('{excel}', String(excelValue)) === String(dsValue)) return true
  }
  return false
}

/**
 * 单行 Excel × 数据集字段比对，纯函数。
 * @returns {{field:string, excel:string, dataset:string, verdict:string, action:string}[]}
 *   verdict: dataset-filled | dataset-empty | value-differs
 *   方向决定动作：Excel 有值→同步进数据集再重出；Excel 空→只回填 Excel，证书不用重出
 */
function diffRow(cfg, row, dsRow, fieldKeys) {
  if (!dsRow) {
    return [{ field: '(整行)', excel: '存在', dataset: '缺该行', verdict: 'row-missing', action: '重新导入该单位后重出' }]
  }
  const out = []
  for (const key of fieldKeys) {
    const ev = String(row.values[key] ?? '').trim()
    const dv = String(dsRow[key] ?? '').trim()
    if (ev === dv) continue
    if (isKnownDialect(cfg, key, ev, dv)) continue
    const verdict = !ev ? 'dataset-filled' : !dv ? 'dataset-empty' : 'value-differs'
    const action = verdict === 'dataset-filled'
      ? '只回填 Excel（证书已按数据集出好，不用重出）'
      : verdict === 'dataset-empty'
        ? '同步进数据集后重出这张'
        : '确认哪边对，再同步并重出'
    out.push({ field: key, excel: ev, dataset: dv, verdict, action })
  }
  return out
}

module.exports = {
  readGrid, parseSheet, readRoster, readRosters, inRange, fileStem, isKnownDialect, diffRow,
}

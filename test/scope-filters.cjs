/**
 * 打印范围（行筛选）+ 占位值检测 + 列值清单 验收测试。
 * 抽象层验收：不针对任何业务场景，全部用通用列名。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-scope')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const path = require('path')
const { applyFilters, isPlaceholder } = require('../electron/rows.cjs')
const dataset = require('../electron/dataset.cjs')
const templates = require('../electron/templates.cjs')
const printDomain = require('../electron/print.cjs')

const TMP = path.join(__dirname, '.tmp-data-scope')
let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  console.log('== 1. applyFilters（纯函数语义） ==')
  const rows = [
    { 区域: '东区', 奖级: '金奖', 姓名: '甲' },
    { 区域: '东区', 奖级: '银奖', 姓名: '乙' },
    { 区域: '西区', 奖级: '金奖', 姓名: '丙' },
    { 区域: '西区', 奖级: '铜奖', 姓名: '丁' },
  ]
  ok(applyFilters(rows, []) === rows, '空筛选原样返回')
  ok(applyFilters(rows, null) === rows, 'null 筛选原样返回')
  ok(applyFilters(rows, [{ key: '区域', values: [] }]).length === 4, '空值集合条件视为无效')
  ok(applyFilters(rows, [{ key: '区域', values: ['东区'] }]).length === 2, '单条件单值')
  ok(applyFilters(rows, [{ key: '区域', values: ['东区', '西区'] }]).length === 4, '条件内多值 OR')
  ok(applyFilters(rows, [{ key: '区域', values: ['东区'] }, { key: '奖级', values: ['金奖'] }]).length === 1, '条件间 AND')
  ok(applyFilters(rows, [{ key: '不存在', values: ['x'] }]).length === 0, '未知列 → 空集（不抛错）')
  ok(applyFilters(rows, [{ key: '区域', values: [1] }]).length === 0, '值按字符串比较（数字不误命中）')
  ok(applyFilters(rows, [null, undefined]).length === 4, '非法条件项被忽略')

  console.log('== 2. isPlaceholder（值形态规则，非业务字面量） ==')
  ok(isPlaceholder('（待补）') === true, '全角括号包裹')
  ok(isPlaceholder('(TBD)') === true, '半角括号包裹')
  ok(isPlaceholder('【占位】') === true, '方头括号包裹')
  ok(isPlaceholder('——') === true, '纯破折号')
  ok(isPlaceholder('/') === true, '纯斜杠')
  ok(isPlaceholder('???') === true, '纯问号')
  ok(isPlaceholder('（良好的作品）') === true, '形态规则对一切整值括号包裹生效（只提示不拦截，不猜内容好坏）')
  ok(isPlaceholder('张三') === false, '正常文本')
  ok(isPlaceholder('') === false && isPlaceholder('  ') === false, '空串不是占位（是空值，另行统计）')
  ok(isPlaceholder(null) === false && isPlaceholder(undefined) === false, 'null/undefined 安全')

  console.log('== 3. 领域层贯通（CSV 数据集 + 模板） ==')
  const csvFp = path.join(TMP, 'demo.csv')
  fs.writeFileSync(csvFp, [
    '区域,奖级,姓名,作品',
    '东区,金奖,甲,《作品一》',
    '东区,（待补）,乙,——',
    '西区,金奖,丙,《作品三》',
    '西区,,丁,/',
  ].join('\n'), 'utf-8')
  const ds = dataset.getDataset(dataset.importFromFile(csvFp).id)
  ok(ds.rows.length === 4 && ds.columns.length === 4, '数据集 4 行 4 列', { r: ds.rows.length, c: ds.columns.length })

  // 保存强校验：模板字段必须全部在数据集激活列中，先激活三个列头「印」
  for (const k of ['姓名', '奖级', '作品']) dataset.setColumnPrint(ds.id, k, true)

  const tpl = templates.saveTemplate({
    name: '测试模板',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    background: '',
    datasetId: ds.id,
    fields: [
      { column: '姓名', label: '姓名', x: 30, y: 30, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
      { column: '奖级', label: '奖级', x: 50, y: 30, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
      { column: '作品', label: '作品', x: 50, y: 60, fontSize: 18, color: '#000', align: 'center', bold: false, fontFamily: '' },
    ],
  })

  const vAll = printDomain.validateBatch(ds.id, tpl.id)
  ok(vAll.recordCount === 4 && !vAll.filtered, '全量校验 4 行', vAll.recordCount)
  ok(vAll.allEmptyFields.includes('奖级') === false, '奖级非整列空（有 1 空行）')
  const jiang = vAll.issues.find((i) => i.key === '奖级')
  const zuo = vAll.issues.find((i) => i.key === '作品')
  ok(jiang && jiang.empty === 1, '奖级空值 1', jiang)
  ok(zuo && zuo.placeholder === 2 && zuo.empty === 0, '作品列疑似占位 2（括号包裹+纯符号）', zuo)
  // 去补录直达：issues 携带出错单元格坐标（0 基行号 + 空值/占位形态）
  ok(jiang.cellsTotal === 2 && jiang.cells.length === 2, '奖级出错坐标共 2 处', jiang.cells)
  ok(jiang.cells[0].rowIndex === 1 && jiang.cells[0].kind === 'placeholder', '奖级第 2 行为疑似占位坐标', jiang.cells[0])
  ok(jiang.cells[1].rowIndex === 3 && jiang.cells[1].kind === 'empty', '奖级第 4 行为空值坐标', jiang.cells[1])
  ok(zuo.cells.length === 2 && zuo.cells.every((c) => c.rowIndex === 1 || c.rowIndex === 3), '作品占位坐标限定在 1/3 行', zuo.cells)

  const vFiltered = printDomain.validateBatch(ds.id, tpl.id, [{ key: '区域', values: ['东区'] }])
  ok(vFiltered.recordCount === 2 && vFiltered.filtered, '筛选后校验范围 2 行', vFiltered.recordCount)
  ok(vFiltered.totalCount === 4, 'totalCount 保留全量行数', vFiltered.totalCount)

  const built = printDomain.buildBatchHtml(ds.id, tpl.id, [{ key: '奖级', values: ['金奖'] }])
  ok(built.recordCount === 2, '批量 HTML 按筛选范围组装（2 金奖）', built.recordCount)
  ok(built.html.includes('甲') && !built.html.includes('丁'), 'HTML 只含筛选命中记录')

  console.log('== 4. columnValues（真实数据派生） ==')
  const cv = dataset.columnValues(ds.id, '区域')
  ok(cv.distinct === 2 && cv.values[0].value === '东区' && cv.values[0].count === 2, 'distinct + 计数 + 按次数排序', cv.values)
  const cvFiltered = dataset.columnValues(ds.id, '奖级', [{ key: '区域', values: ['西区'] }])
  ok(cvFiltered.distinct === 1 && cvFiltered.values[0].value === '金奖', '值清单支持在筛选范围内统计', cvFiltered.values)
  let threw = false
  try { dataset.columnValues(ds.id, '不存在') } catch { threw = true }
  ok(threw, '未知列被拒')

  console.log('== 5. 分组导出支撑（文件名清洗 + 分组完整性） ==')
  ok(printDomain.sanitizeFilename('A机构/东区:金奖*') === 'A机构_东区_金奖_', '路径非法字符清洗')
  ok(printDomain.sanitizeFilename('') === '未命名', '空名回退')
  ok(printDomain.sanitizeFilename('x'.repeat(100)).length === 80, '限长 80')
  const groups = dataset.columnValues(ds.id, '区域').values
  const groupRows = groups.map((g) =>
    printDomain.buildBatchHtml(ds.id, tpl.id, [{ key: '区域', values: [g.value] }]).recordCount)
  ok(groupRows.reduce((s, n) => s + n, 0) === 4, '分组行数之和 = 全量（不重不漏）', groupRows)

  rmDeep(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

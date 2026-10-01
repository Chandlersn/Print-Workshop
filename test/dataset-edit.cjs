/**
 * 数据编辑（导入后修数）验收测试。
 * 抽象层验收：单元格编辑 / 加行 / 删行 / 列统计即时重算，全部用通用列名。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-edit')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const path = require('path')
const dataset = require('../electron/dataset.cjs')

const TMP = path.join(__dirname, '.tmp-data-edit')
let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}
function throws(fn, label) {
  try { fn(); failCount++; console.error(`  FAIL - ${label}（未抛错）`) }
  catch { passCount++; console.log(`  ok - ${label}`) }
}

function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  const csv = [
    '姓名,奖级,分数',
    '甲,金奖,95',
    '乙,,88',
    '丙,银奖,',
    '丁,金奖,90',
  ].join('\n')
  const csvPath = path.join(TMP, 'seed.csv')
  fs.writeFileSync(csvPath, csv, 'utf8')

  console.log('== 1. 建档基线 ==')
  const ds = dataset.importFromFile(csvPath)
  const d0 = dataset.getDataset(ds.id)
  ok(d0.rowCount === 4 && d0.columnCount === 3, '基线 4 行 3 列', d0)
  const scoreCol = d0.columns.find((c) => c.key === '分数')
  ok(scoreCol.type === 'number' && scoreCol.filled === 3, '分数列基线：number，填充 3/4', scoreCol)

  console.log('== 2. updateCell（值写入 + 持久化） ==')
  const r1 = dataset.updateCell(ds.id, 1, '奖级', '金奖')
  ok(r1.ok && r1.value === '金奖', '修改返回新值')
  const d1 = dataset.getDataset(ds.id)
  ok(d1.rows[1]['奖级'] === '金奖', '修改已持久化')
  ok(d1.rows[1]['分数'] === '88', '同行其他单元格不受影响')
  const gradeCol = d1.columns.find((c) => c.key === '奖级')
  ok(gradeCol.filled === 4, '奖级列填充 3 → 4（空补值后重算）', gradeCol)

  const r2 = dataset.updateCell(ds.id, 2, '奖级', '')
  const d2 = dataset.getDataset(ds.id)
  ok(d2.rows[2]['奖级'] === '' && d2.columns.find((c) => c.key === '奖级').filled === 3, '改回空值填充回落')

  console.log('== 3. updateCell（类型即时重算） ==')
  const r3 = dataset.updateCell(ds.id, 2, '分数', 'not-a-number')
  ok(r3.column.type === 'text', '混入非数值 → 列类型重算为 text', r3.column)
  const r4 = dataset.updateCell(ds.id, 2, '分数', '77')
  ok(r4.column.type === 'number', '恢复数值 → 列类型重算回 number', r4.column)

  console.log('== 4. updateCell（边界防护） ==')
  throws(() => dataset.updateCell(ds.id, 99, '奖级', 'x'), '行号越界抛错')
  throws(() => dataset.updateCell(ds.id, -1, '奖级', 'x'), '负行号抛错')
  throws(() => dataset.updateCell(ds.id, 0, '不存在', 'x'), '未知列抛错')
  throws(() => dataset.updateCell('ds_none', 0, '奖级', 'x'), '数据集不存在抛错')

  console.log('== 5. addRow（追加空行） ==')
  const a1 = dataset.addRow(ds.id)
  ok(a1.rowIndex === 4 && a1.rowCount === 5, '追加后行数 4 → 5，新行号 4', a1)
  const d3 = dataset.getDataset(ds.id)
  ok(d3.rows[4]['姓名'] === '' && d3.rows[4]['分数'] === '', '新行全部为空串')
  ok(d3.columns.find((c) => c.key === '姓名').filled === 4, '姓名列填充随空行回落 4/5')

  console.log('== 6. deleteRow（删行 + 重算） ==')
  const del1 = dataset.deleteRow(ds.id, 0) // 删掉首行「甲」
  ok(del1.rowCount === 4, '删行后 5 → 4', del1)
  const d4 = dataset.getDataset(ds.id)
  ok(d4.rows[0]['姓名'] === '乙', '删除首行后行序前移')
  ok(!d4.rows.some((r) => r['姓名'] === '甲'), '被删行不存在')
  throws(() => dataset.deleteRow(ds.id, 4), '删除后旧行号越界抛错')

  console.log('== 7. 编辑与出口联动（columnValues 跟随编辑） ==')
  dataset.updateCell(ds.id, 2, '奖级', '铜奖') // 丁（删首行后在索引 2）：金奖 → 铜奖
  const vals = dataset.columnValues(ds.id, '奖级', [])
  const gold = vals.values.find((v) => v.value === '金奖')
  const bronze = vals.values.find((v) => v.value === '铜奖')
  ok(gold && gold.count === 1, '金奖只剩乙（甲被删、丁改走）', vals.values)
  ok(bronze && bronze.count === 1, '铜奖清单出现新值', vals.values)

  const summary = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(summary.rowCount === 4, '列表摘要行数同步')

  console.log('== 8. 列级打印开关（默认停用，用户激活才进模板页） ==')
  const cat0 = dataset.fieldCatalog(ds.id)
  ok(cat0.every((c) => c.printOn === false), '新数据集所有列缺省停用（须用户显式激活）')
  throws(() => dataset.fieldCatalog('ds_none').length, '数据集不存在抛错')
  const on = dataset.setColumnPrint(ds.id, '分数', true)
  ok(on.ok && on.printOn === true, '激活返回新状态')
  const cat1 = dataset.fieldCatalog(ds.id)
  ok(cat1.find((c) => c.key === '分数').printOn === true, '字段目录反映激活')
  ok(cat1.filter((c) => c.printOn === true).length === 1, '其余列仍为停用')
  const d5 = dataset.getDataset(ds.id)
  ok(d5.columns.find((c) => c.key === '分数').printOn === true, '激活标记持久化到数据集')
  throws(() => dataset.setColumnPrint(ds.id, '不存在', true), '未知列激活抛错')
  const reOff = dataset.setColumnPrint(ds.id, '分数', false)
  ok(reOff.printOn === false, '可再次停用')

  // 摘要携带 printCols（模板页数据集下拉置顶排序的数据源）
  dataset.setColumnPrint(ds.id, '分数', true)
  dataset.setColumnPrint(ds.id, '姓名', true)
  const sum1 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sum1.printCols === 2, '摘要统计已激活打印字段数（=2）')
  dataset.setColumnPrint(ds.id, '姓名', false)
  const sum2 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sum2.printCols === 1, '停用后摘要同步（=1）')
  const csv2Path = path.join(TMP, 'fresh.csv')
  fs.writeFileSync(csv2Path, '甲,乙\n1,2\n', 'utf8')
  const fresh = dataset.importFromFile(csv2Path)
  const sumFresh = dataset.listDatasets().find((s) => s.id === fresh.id)
  ok(sumFresh.printCols === 0, '新导入数据集 printCols=0（默认全停）')

  console.log('== 9. 打印状态回写（工作簿级，侧栏变色数据源） ==')
  ok(sum2.printCount === 0 && !sum2.lastPrintedAt, '未打印数据集 printCount=0 且无时间')
  const m1 = dataset.markPrinted(ds.id, 'pdf')
  ok(m1.printCount === 1 && m1.lastPrintedAt, '首次回写 printCount=1')
  dataset.markPrinted(ds.id, 'print')
  const sum3 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sum3.printCount === 2 && sum3.lastPrintedAt && sum3.lastPrintMode === 'print', '重复回写累加且记录最近方式')
  ok(sum3.lastPrintedAt.length >= 19 && sum3.lastPrintedAt.includes('T'), 'lastPrintedAt 为 ISO 时间戳')
  throws(() => dataset.markPrinted('ds_none', 'pdf'), '不存在的数据集回写抛错')

  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  if (failCount) process.exit(1)
}

main()

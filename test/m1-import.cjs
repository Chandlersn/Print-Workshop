/**
 * M1 数据导入层验收测试。
 * 运行：node test/m1-import.cjs（在项目根目录）
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data')
const fs = require('fs')
const path = require('path')
const XLSX = require('xlsx')
const { rmDeep } = require('./helpers/rm.cjs')

// 自足清理：每次运行从干净数据目录开始（测试可独立/重复执行）
rmDeep(path.join(__dirname, '.tmp-data'))

const { decodeBuffer, parseCsvGrid } = require('../electron/importer/csv.cjs')
const { buildColumns } = require('../electron/keys.cjs')
const dataset = require('../electron/dataset.cjs')

const FIXTURES = path.join(__dirname, 'fixtures')
let pass = 0
let fail = 0

function assert(cond, label, extra) {
  if (cond) { pass += 1; console.log(`  PASS ${label}`) }
  else { fail += 1; console.error(`  FAIL ${label}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 生成乱 xlsx：重复表头 + 合并单元格 + 空列 + 长文本 ----------
function makeMessyXlsx() {
  const rows = [
    ['姓名', '姓名', '证书编号', '分数', '是否出席', '长文备注', '整列为空'],
    ['张三', '张三副', 'C-001', '98.5', '是', 'x'.repeat(250), ''],
    ['李四', '李四副', 'C-002', '', '否', '', ''],
    ['王五', '王五副', 'C-003', '77', '是', '', ''],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 1, c: 1 } }] // 张三 行 A5:B5 合并
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const fp = path.join(FIXTURES, 'messy.xlsx')
  XLSX.writeFile(wb, fp)
  return fp
}

async function main() {
  console.log('== 1. CSV 编码检测 ==')
  const gbkBuf = fs.readFileSync(path.join(FIXTURES, 'gbk-names.csv'))
  const gbkText = decodeBuffer(gbkBuf)
  assert(gbkText.startsWith('姓名,证书编号'), 'GBK 文件正确解码出中文表头', gbkText.slice(0, 20))

  const bomBuf = fs.readFileSync(path.join(FIXTURES, 'quotes-bom.csv'))
  const bomText = decodeBuffer(bomBuf)
  assert(bomText.startsWith('姓名,备注'), 'UTF-8 BOM 识别且剥离 BOM', bomText.slice(0, 20))

  console.log('== 2. RFC 4180 引号规则 ==')
  const grid = parseCsvGrid(bomText)
  assert(grid.length === 5, '表头 + 4 行数据（引号内换行算一行）', `实际 ${grid.length}`)
  assert(grid[1][0] === '张三, 小三', '引号内逗号不切列', JSON.stringify(grid[1][0]))
  assert(grid[2][0] === '李四\n（两行名）', '引号内换行保留', JSON.stringify(grid[2][0]))
  assert(grid[2][1] === '他说："这个奖很好"', '双引号转义还原', JSON.stringify(grid[2][1]))

  console.log('== 3. 键名规范化与去重 ==')
  const cols = buildColumns(['姓名', '姓名', '证书 编号', '', '@#$'])
  assert(cols[0].key === '姓名' && cols[1].key === '姓名_2', '重复表头自动加后缀', JSON.stringify(cols.map((c) => c.key)))
  assert(cols[2].key === '证书_编号', '空格折叠为下划线', cols[2].key)
  assert(cols[3].alias === '列4' && cols[3].key === 'col', '空表头回退 col + 别名列N', JSON.stringify(cols[3]))
  assert(cols[4].key === 'col_2', '非法字符表头回退并去重', cols[4].key)

  console.log('== 4. GBK CSV 全链路导入 ==')
  const ds1 = dataset.importFromFile(path.join(FIXTURES, 'gbk-names.csv'))
  const full1 = dataset.getDataset(ds1.id)
  assert(full1.rowCount === 6, '6 行数据入库', `实际 ${full1.rowCount}`)
  assert(full1.columns.length === 5, '5 列', `实际 ${full1.columns.length}`)
  assert(full1.rows[0].姓名 === '张三', 'GBK 中文数据完整', JSON.stringify(full1.rows[0]))
  const cat1 = dataset.fieldCatalog(ds1.id)
  const remarkCol = cat1.find((c) => c.key === '备注')
  assert(remarkCol && remarkCol.fill === '4/6', '备注列填充率 4/6', remarkCol && remarkCol.fill)
  const advCol = cat1.find((c) => c.key === '晋级情况')
  assert(advCol && advCol.fill === '5/6', '晋级情况填充率 5/6（首行有值+末行单列行）', advCol && advCol.fill)

  console.log('== 5. 类型推断 ==')
  const ds2 = dataset.importFromFile(path.join(FIXTURES, 'quotes-bom.csv'))
  const cat2 = dataset.fieldCatalog(ds2.id)
  const amountCol = cat2.find((c) => c.alias === '金额')
  assert(amountCol && amountCol.type === 'number', '金额列识别为数值', amountCol && amountCol.type)
  const vipCol = cat2.find((c) => c.alias === '是否 VIP')
  assert(vipCol && vipCol.type === 'boolean', 'true/false 文本识别为布尔', vipCol && vipCol.type)
  const longCol = cat2.find((c) => c.alias === '长文本')
  assert(longCol && longCol.avgLen === 1 && longCol.suggestSkip === false, '单字符列不误判为长文本', JSON.stringify(longCol))

  console.log('== 6. 乱 xlsx 导入（重复表头/合并单元格/空列） ==')
  const messyPath = makeMessyXlsx()
  const ds3 = dataset.importFromFile(messyPath)
  const full3 = dataset.getDataset(ds3.id)
  assert(full3.columns.length === 7, '7 列', `实际 ${full3.columns.length}`)
  assert(full3.columns[0].key === '姓名' && full3.columns[1].key === '姓名_2', '重复表头去重', JSON.stringify(full3.columns.map((c) => c.key)))
  assert(full3.rows[0].姓名 === '张三', '合并单元格取左上值', full3.rows[0].姓名)
  const cat3 = dataset.fieldCatalog(ds3.id)
  const emptyCol = cat3.find((c) => c.alias === '整列为空')
  assert(emptyCol && emptyCol.fillRate === 0 && emptyCol.suggestSkip, '空列 fill 0 且建议跳过', JSON.stringify(emptyCol))
  const longCol3 = cat3.find((c) => c.alias === '长文备注')
  assert(longCol3 && longCol3.avgLen > 200 && longCol3.suggestSkip, '长文本列 avgLen>200 且建议跳过', longCol3 && `${longCol3.avgLen}/${longCol3.suggestSkip}`)
  const scoreCol = cat3.find((c) => c.alias === '分数')
  assert(scoreCol && scoreCol.type === 'number' && scoreCol.fill === '2/3', '分数列数值类型+填充 2/3', scoreCol && `${scoreCol.type}/${scoreCol.fill}`)

  console.log('== 7. 数据集管理 ==')
  const list = dataset.listDatasets()
  assert(list.length === 3, '清单返回 3 个数据集', `实际 ${list.length}`)
  dataset.renameColumn(ds1.id, '备注', '老师备注')
  const renamed = dataset.fieldCatalog(ds1.id).find((c) => c.key === '备注')
  assert(renamed.alias === '老师备注', '列别名改名生效', renamed.alias)
  dataset.deleteDataset(ds2.id)
  assert(dataset.listDatasets().length === 2, '删除生效', dataset.listDatasets().length)

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('测试执行异常:', err)
  process.exit(1)
})

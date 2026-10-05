/**
 * 导入会话（批次）整批删除 验收测试。
 * 覆盖：同批数据集共享 batchId / deleteBatch 整批删除 / 既有数据不受波及 / 边界守卫。
 * 背景：一次导入（split 出 N 个工作簿）是一个管理单元——删除按钮删的是整个会话，
 * 而不是当前选中的单个工作簿。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-batch')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const path = require('path')
const XLSX = require('xlsx')
const dataset = require('../electron/dataset.cjs')

const TMP = path.join(__dirname, '.tmp-data-batch')
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

async function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  // 构造三表工作簿：一次导入 → 3 个数据集（同会话）
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of [
    ['表一', [['姓名', '奖级'], ['甲', '金奖'], ['乙', '银奖']]],
    ['表二', [['姓名', '奖级'], ['丙', '铜奖']]],
    ['表三', [['姓名', '奖级'], ['丁', '金奖']]],
  ]) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  }
  const xlsxPath = path.join(TMP, '三表.xlsx')
  XLSX.writeFile(wb, xlsxPath)
  const csvPath = path.join(TMP, '另册.csv')
  fs.writeFileSync(csvPath, '姓名,奖级\n戊,银奖\n', 'utf8')

  console.log('== 1. 同批共享 batchId ==')
  const res = await dataset.importSheets(xlsxPath, {
    mode: 'split',
    selections: [{ name: '表一' }, { name: '表二' }, { name: '表三' }],
  })
  ok(res.length === 3, '3 表 → 3 数据集', res.length)
  const batchIds = new Set(res.map((r) => r.source.batchId))
  ok(batchIds.size === 1 && res[0].source.batchId, '同次导入共享同一 batchId', [...batchIds])
  ok(String(res[0].source.batchId).startsWith('imp_'), 'batchId 形如 imp_*', res[0].source.batchId)
  ok(res.every((r) => r.source.fileName === '三表.xlsx'), '批次可读名取自源文件名')

  const csvDs = dataset.importFromFile(csvPath)
  ok(csvDs.source.batchId && csvDs.source.batchId !== res[0].source.batchId, '另一次导入有独立 batchId')

  const sum = dataset.listDatasets().find((s) => s.id === res[0].id)
  ok(sum.source && sum.source.batchId === res[0].source.batchId, '列表摘要透出 batchId（UI 分组数据源）')

  console.log('== 2. deleteBatch 整批删除 ==')
  const r1 = await dataset.deleteBatch(res.map((r) => r.id))
  ok(r1.ok && r1.deleted === 3, '整批删除 3 个，如实返回删除数', r1)
  const after = dataset.listDatasets()
  ok(after.length === 1 && after[0].id === csvDs.id, '会话内全灭，其他导入不受波及')

  console.log('== 3. 边界守卫 ==')
  throws(() => dataset.deleteBatch(res.map((r) => r.id)), '全部 id 已不存在时抛错')
  throws(() => dataset.deleteBatch([]), '空 id 清单被拒')
  const r2 = await dataset.deleteBatch([res[0].id, csvDs.id])
  ok(r2.ok && r2.deleted === 1, '混合清单：已删的不计，存在的照删（部分清理语义）', r2)
  ok(dataset.listDatasets().length === 0, '最终清空')

  rmDeep(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

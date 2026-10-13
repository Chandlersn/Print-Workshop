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
  const stableIds = [...d0.recordIds]
  ok(stableIds.length === d0.rows.length && new Set(stableIds).size === stableIds.length,
    '每条记录有唯一内部 ID，不增加用户列')
  const scoreCol = d0.columns.find((c) => c.key === '分数')
  ok(scoreCol.type === 'number' && scoreCol.filled === 3, '分数列基线：number，填充 3/4', scoreCol)

  console.log('== 2. updateCell（值写入 + 持久化） ==')
  const r1 = dataset.updateCell(ds.id, 1, '奖级', '金奖')
  ok(r1.ok && r1.value === '金奖', '修改返回新值')
  const d1 = dataset.getDataset(ds.id)
  ok(d1.rows[1]['奖级'] === '金奖', '修改已持久化')
  ok(d1.recordIds[1] === stableIds[1], '编辑字段不改变记录 ID')
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
  ok(d3.recordIds[4] && !stableIds.includes(d3.recordIds[4]), '新增行获得新记录 ID')
  ok(d3.columns.find((c) => c.key === '姓名').filled === 4, '姓名列填充随空行回落 4/5')

  console.log('== 6. deleteRow（删行 + 重算） ==')
  const del1 = dataset.deleteRow(ds.id, 0) // 删掉首行「甲」
  ok(del1.rowCount === 4, '删行后 5 → 4', del1)
  const d4 = dataset.getDataset(ds.id)
  ok(d4.rows[0]['姓名'] === '乙', '删除首行后行序前移')
  ok(d4.recordIds[0] === stableIds[1] && !d4.recordIds.includes(stableIds[0]), '删行只移除该行 ID，其余身份随记录移动')
  ok(!d4.rows.some((r) => r['姓名'] === '甲'), '被删行不存在')
  throws(() => dataset.deleteRow(ds.id, 4), '删除后旧行号越界抛错')

  console.log('== 7. 编辑即时生效（读回的数据已变） ==')
  dataset.updateCell(ds.id, 2, '奖级', '铜奖') // 丁（删首行后在索引 2）：金奖 → 铜奖
  const d7 = dataset.getDataset(ds.id)
  const golds = d7.rows.filter((r) => r['奖级'] === '金奖').map((r) => r['姓名'])
  ok(golds.length === 1 && golds[0] === '乙', '金奖只剩乙（甲被删、丁改走）', golds)
  ok(d7.rows[2]['奖级'] === '铜奖', '改格写回后读回即新值', d7.rows[2])

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

  // 摘要携带 photoMatchColumn（数据页/模板页「已配图置顶」排序的数据源，与 printCols 并列）
  const sumPhoto0 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sumPhoto0.photoMatchColumn === null, '默认未配图：photoMatchColumn=null')
  dataset.setPhotoMatchColumn(ds.id, '姓名')
  const sumPhoto1 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sumPhoto1.photoMatchColumn === '姓名', '摘要暴露当前配图列（置顶排序数据源）')
  dataset.setPhotoMatchColumn(ds.id, null)
  const sumPhoto2 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sumPhoto2.photoMatchColumn === null, '关闭配图后摘要同步为 null')

  console.log('== 9. 打印状态回写（工作簿级，侧栏变色数据源） ==')
  ok(sum2.printCount === 0 && !sum2.lastPrintedAt, '未打印数据集 printCount=0 且无时间')
  const m1 = dataset.markPrinted(ds.id, 'pdf')
  ok(m1.printCount === 1 && m1.lastPrintedAt, '首次回写 printCount=1')
  dataset.markPrinted(ds.id, 'print')
  const sum3 = dataset.listDatasets().find((s) => s.id === ds.id)
  ok(sum3.printCount === 2 && sum3.lastPrintedAt && sum3.lastPrintMode === 'print', '重复回写累加且记录最近方式')
  ok(sum3.lastPrintedAt.length >= 19 && sum3.lastPrintedAt.includes('T'), 'lastPrintedAt 为 ISO 时间戳')
  throws(() => dataset.markPrinted('ds_none', 'pdf'), '不存在的数据集回写抛错')

  console.log('== 10. 配图置顶排序（I-39，前端静态核查） ==')
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    const dsView = read('src/views/DatasetView.vue')
    const tplView = read('src/views/TemplateView.vue')
    // 排序档位必须是「已配图 → 已印 → 其余」：只把配图名单并进旧档位会漏掉「立即置顶」
    ok(/const photo = list\.filter\(\(d\) => !!d\.photoMatchColumn\)/.test(dsView)
      && /\.\.\.photo, \.\.\.ready, \.\.\.rest/.test(dsView),
      '数据页侧栏：已配图名单独立置顶档，先于已印档位（I-39）')
    ok(/const photo = datasets\.value\.filter\(\(d\) => !!d\.photoMatchColumn\)/.test(tplView)
      && /\.\.\.photo, \.\.\.ready, \.\.\.rest/.test(tplView),
      '模板页数据集下拉：与数据页同一套「已配图最优先」置顶规则（I-39）')
    ok(/ds\.photoMatchColumn" class="ds-photo-mark" title="已开启配图，自动置顶">图<\/span>/.test(dsView),
      '已配图名单有一个「图」字标记，置顶不是因为 bug（I-39）')
    // 点配图后本地同步摘要是即时置顶的前提：不同步就要重进页面才动
    ok(/summary\.photoMatchColumn = result\.photoMatchColumn/.test(dsView),
      '列头点配图后即时同步侧栏摘要，置顶当场生效（I-39）')
  }

  console.log('== 11. 详情头部必须容忍整块缺失的 source（I-42，旧记录真实存在） ==')
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    const dsView = read('src/views/DatasetView.vue')
    // 先剥掉注释行：守卫要钉的是**代码**里的解引用，注释里提到这个反例是正常的。
    const dsCode = dsView.split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
    /*
     * 旧版本导入的记录可能**整块没有 `source`**；侧栏批次分组早就 `ds.source || {}` 兜底了，
     * 详情头部却直接解引用过——选中这类记录时整个右侧渲染抛错、页面变空白，
     * 而且**只在老数据上复现**（`test:design-e2e` 就是这么红起来的：它手工写了一条无 source 的记录）。
     * 「少显示一行字」和「整页打不开」是两回事，这条守卫钉住后者。
     */
    ok(!/detail\.source\./.test(dsCode), '详情头部不得直接解引用 detail.source')
    ok(!/detail\.lastPrintedAt\.slice/.test(dsCode), '详情头部不得直接对 lastPrintedAt 取切片（可能是空串）')
    ok(/const detailSource = computed\(\(\) => detail\.value\?\.source \|\| \{\}\)/.test(dsCode),
      '来源信息统一走 detailSource 兜底')
    ok(/来源未知（旧版本导入）/.test(dsCode), '缺 source 时给出可读文案，而不是留空或抛错')
    // 这条记录不是假设：真写一条没有 source 的进去，数据层照样要能读出来
    const { loadJson, saveJson } = require('../electron/store.cjs')
    saveJson('datasets', [
      ...loadJson('datasets', []),
      { id: 'legacy-no-source', name: '旧记录', columns: [{ key: 'name', alias: '姓名', type: 'text' }], rows: [{ name: '甲' }] },
    ])
    const legacy = dataset.getDataset('legacy-no-source')
    ok(legacy.source === undefined && legacy.rowCount === 1 && legacy.lastPrintedAt === '',
      '没有 source 的记录仍可读取，且 lastPrintedAt 为空串——前端必须容忍这种形状')
    ok(legacy.recordIds.length === 1 && typeof legacy.recordIds[0] === 'string', '旧数据首次读取时迁移并持久化记录 ID')
    ok(!legacy.columns.some(c => c.key === 'recordIds') && Object.keys(legacy.rows[0]).join() === 'name',
      '迁移 ID 不进入用户字段或名单行')
  }

  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  if (failCount) process.exit(1)
}

main()

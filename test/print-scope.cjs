/**
 * 行级出片范围验收测试。
 *
 * 把守的核心不变量：**留痕必全，状态只认全量**——
 * - 出片范围可为全量，也可为行级勾选（索引集合）；
 * - 无论范围大小都留痕（createJob 记录 scope）；
 * - 但数据集「已打」状态只由全量出片回写（shouldMarkPrinted）。
 *
 * 另守住一个易漏的正确性点：行级勾选时，校验弹窗「去补录直达」的
 * 行号必须是**数据集全量行号**，否则会跳到错误的行。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-pscope')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const dataset = require('../electron/dataset.cjs')
const templates = require('../electron/templates.cjs')
const printDomain = require('../electron/print.cjs')

const TMP = path.join(__dirname, '.tmp-data-pscope')
let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  console.log('== 1. normalizeSelection（纯函数语义） ==')
  const { normalizeSelection, resolveScope, scopeInfo, shouldMarkPrinted } = printDomain
  ok(JSON.stringify(normalizeSelection([4, 0, 2], 6)) === '[0,2,4]', '按原行序升序（打印顺序跟随名单，不跟随勾选顺序）')
  ok(JSON.stringify(normalizeSelection([2, 2, 2], 6)) === '[2]', '重复索引去重')
  ok(JSON.stringify(normalizeSelection([99, -1, 2], 6)) === '[2]', '越界索引丢弃')
  ok(JSON.stringify(normalizeSelection(['3', 1.5, 1], 6)) === '[1,3]', '非整数丢弃、字符串数字归一')
  ok(JSON.stringify(normalizeSelection([], 6)) === '[]', '空集合 → 空数组')

  console.log('== 2. resolveScope（rows 优先 / 空选择拦截 / 缺省全量） ==')
  const fakeDs = { rows: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] }
  ok(resolveScope(fakeDs, { rows: [2, 0] }).rows.map((r) => r.n).join('') === 'ac', 'rows 选出并按行序排列')
  ok(resolveScope(fakeDs, {}).selection === null, '缺省 rows → selection 为 null（全量）')
  ok(resolveScope(fakeDs, {}).rows.length === 3, '缺省 → 全量 3 行')
  ok(resolveScope(fakeDs, { rows: [0] }).selection.length === 1, '行级选择 selection 非 null')
  let threw = false
  try { resolveScope(fakeDs, { rows: [] }) } catch { threw = true }
  ok(threw, '空勾选抛错（至少勾一行）')
  threw = false
  try { resolveScope(fakeDs, { rows: [99] }) } catch { threw = true }
  ok(threw, '全部越界的勾选视同空，同样抛错')
  // 行筛选（filters）已随分组导出下线：多传该键也不再影响范围，避免旧调用静默改变语义
  ok(resolveScope(fakeDs, { rows: [1], filters: [{ key: 'n', values: ['a'] }] }).rows[0].n === 'b',
    'filters 已下线：多传也不影响范围（只有 rows 说了算）')

  console.log('== 3. scopeInfo / shouldMarkPrinted（不变量核心） ==')
  ok(scopeInfo(null, 6).partial === false, '全量 → partial=false')
  ok(scopeInfo([0, 1, 2], 6).partial === true, '部分 → partial=true')
  ok(scopeInfo([0, 1, 2, 3, 4, 5], 6).partial === false, '显式全选（行数覆盖=全量）→ partial=false')
  ok(scopeInfo([0, 1, 2], 6).selected === 3 && scopeInfo([0, 1, 2], 6).total === 6, 'selected/total 正确')
  ok(shouldMarkPrinted({ partial: false }) === true, '全量出片 → 回写数据集状态')
  ok(shouldMarkPrinted({ partial: true }) === false, '部分出片 → 不回写（信号不被污染）')
  ok(shouldMarkPrinted(null) === true, '缺省 scope → 视为全量，回写')

  console.log('== 4. 领域层贯通（行级范围的校验与组装） ==')
  const csvFp = path.join(TMP, 'demo.csv')
  fs.writeFileSync(csvFp, [
    '区域,奖级,姓名',
    '东区,金奖,甲',
    '东区,银奖,乙',
    '西区,金奖,丙',
    '西区,铜奖,丁',
    '东区,,戊',
    '西区,银奖,己',
  ].join('\n'), 'utf-8')
  const ds = dataset.getDataset(dataset.importFromFile(csvFp).id)
  ok(ds.rows.length === 6, '数据集 6 行', ds.rows.length)
  for (const k of ['姓名', '奖级']) dataset.setColumnPrint(ds.id, k, true)
  const tpl = templates.saveTemplate({
    name: '行级范围模板',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    background: '',
    datasetId: ds.id,
    fields: [
      { column: '姓名', label: '姓名', x: 30, y: 30, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
      { column: '奖级', label: '奖级', x: 50, y: 30, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
    ],
  })

  // 全量（不传 rows）：行为与改造前一致
  const vAll = printDomain.validateBatch(ds.id, tpl.id)
  ok(vAll.recordCount === 6 && vAll.totalCount === 6, '缺省 → 全量 6 行', vAll.recordCount)
  ok(vAll.scope.partial === false, '缺省 → scope.partial=false')
  ok(shouldMarkPrinted(vAll.scope) === true, '缺省全量 → 应回写')

  // 行级：勾选第 1、3、5 行（0 基 0/2/4），其中第 5 行（索引 4）奖级为空
  const vPart = printDomain.validateBatch(ds.id, tpl.id, [4, 0, 2])
  ok(vPart.recordCount === 3 && vPart.totalCount === 6, '行级校验范围 3 行（totalCount 仍为 6）', vPart.recordCount)
  ok(vPart.scope.partial === true && vPart.scope.selected === 3, 'scope 标记部分出片', vPart.scope)
  ok(shouldMarkPrinted(vPart.scope) === false, '部分出片 → 不应回写数据集状态')
  const jiang = vPart.issues.find((i) => i.key === '奖级')
  ok(jiang && jiang.empty === 1, '范围内奖级空值 1（戊）', jiang)
  // 关键：行级勾选下，出错行号必须是全量行号 4（戊），而不是范围内第 0 位
  ok(jiang.cells[0].rowIndex === 4, '「去补录直达」行号回填为全量行号（不是范围内序号）', jiang.cells[0])

  const builtPart = printDomain.buildBatchHtml(ds.id, tpl.id, [4, 0, 2])
  ok(builtPart.recordCount === 3, '批量 HTML 按行级范围组装 3 页', builtPart.recordCount)
  ok(JSON.stringify(builtPart.selection) === '[0,2,4]', 'selection 规范化落盘', builtPart.selection)
  ok(builtPart.html.includes('甲') && builtPart.html.includes('丙') && builtPart.html.includes('戊')
    && !builtPart.html.includes('乙') && !builtPart.html.includes('丁') && !builtPart.html.includes('己'),
  'HTML 只含勾选行')
  ok(builtPart.scope.partial === true, '组装结果同样带 partial 标记')

  // 显式全选：范围=全量，应回写
  const builtAll = printDomain.buildBatchHtml(ds.id, tpl.id, [0, 1, 2, 3, 4, 5])
  ok(builtAll.scope.partial === false && shouldMarkPrinted(builtAll.scope) === true,
    '显式勾满全部行 → 视为全量 → 应回写')

  console.log('== 5. 任务留痕的范围字段（部分留痕、全量不冗余） ==')
  const jobPart = printDomain.createJob({
    templateId: tpl.id,
    templateName: tpl.name,
    datasetId: ds.id,
    datasetName: ds.name,
    mode: 'pdf',
    recordCount: 3,
    totalRows: 6,
    partial: true,
    selection: [0, 2, 4],
    snapshotHtml: '<html>x</html>',
    status: 'ok',
  })
  ok(jobPart.partial === true && jobPart.totalRows === 6, '部分任务记录 partial + totalRows', jobPart)
  ok(JSON.stringify(jobPart.selection) === '[0,2,4]', '部分任务落盘 selection（打了哪几行可回溯）')
  ok(fs.existsSync(path.join(TMP, jobPart.snapshot)), '部分出片同样写入归档快照（留痕必全）')

  const jobFull = printDomain.createJob({
    templateName: tpl.name, mode: 'pdf', recordCount: 6, totalRows: 6, partial: false, selection: null,
    snapshotHtml: '<html>y</html>', status: 'ok',
  })
  ok(jobFull.partial === false && jobFull.selection === null, '全量任务不落 selection（避免冗余）')
  ok(jobFull.totalRows === 6, '全量任务 totalRows 正确')

  // 旧记录（无 partial 字段）读取不炸，且语义上不等同部分
  const jobs = printDomain.listJobs()
  ok(jobs.length === 2 && jobs.every((j) => typeof j.partial === 'boolean'), '任务清单可读回且 partial 为布尔')

  console.log('== 6. 出口校验增量：超宽估算与重复行（只提示不拦截） ==')
  // 基线：原模板短值不误报
  ok(!vAll.duplicates.length, '无重复行 → duplicates 为空', vAll.duplicates)
  ok(!vAll.issues.some((i) => i.overlong > 0), '短值不触发超宽', vAll.issues)

  // 超宽：锚点 x=95% 居中 → 可用宽度仅 10%（60mm 纸即 6mm），24pt 单个汉字 ≈ 8.5mm 必超
  const tplNarrow = templates.saveTemplate({
    name: '窄锚点模板',
    pageSize: { id: 'custom', name: '自定义', w: 60, h: 40 },
    background: '',
    datasetId: ds.id,
    fields: [
      { column: '姓名', label: '姓名', x: 95, y: 30, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
    ],
  })
  const vNarrow = printDomain.validateBatch(ds.id, tplNarrow.id)
  const narrow = vNarrow.issues.find((i) => i.key === '姓名')
  ok(narrow && narrow.overlong === 6, '可用宽度不足时整列计超宽（6 行）', narrow)
  ok(narrow && narrow.cells.every((c) => c.kind === 'overlong'), '超宽单元格 kind=overlong（直达 chips 可复用）', narrow && narrow.cells)

  // 多联容器口径：单格宽（90mm）而非整页宽（210mm）
  const tplGrid = templates.saveTemplate({
    name: '多联超宽模板',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    background: '',
    datasetId: ds.id,
    layout: { mode: 'grid', itemW: 90, itemH: 60, showCutMarks: false },
    fields: [
      { column: '奖级', label: '奖级', x: 50, y: 50, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
    ],
  })
  const vGrid = printDomain.validateBatch(ds.id, tplGrid.id)
  ok(!vGrid.issues.some((i) => i.overlong > 0), '多联按单格宽估算：2 字 24pt 在 90mm 格内不超宽', vGrid.issues)

  // 重复行：整行所有列一致才算；行号回填全量行号
  const dupCsv = path.join(TMP, 'dup.csv')
  fs.writeFileSync(dupCsv, [
    '姓名,奖级',
    '张三,金奖',
    '李四,银奖',
    '张三,金奖',
    '王五,铜奖',
  ].join('\n'), 'utf-8')
  const dsDup = dataset.getDataset(dataset.importFromFile(dupCsv).id)
  for (const k of ['姓名', '奖级']) dataset.setColumnPrint(dsDup.id, k, true)
  const tplDup = templates.saveTemplate({
    name: '重复行模板',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    background: '',
    datasetId: dsDup.id,
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 30, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
    ],
  })
  const vDup = printDomain.validateBatch(dsDup.id, tplDup.id)
  ok(vDup.duplicates.length === 1 && vDup.duplicateTotal === 2, '识别 1 组 2 行重复', vDup.duplicates)
  ok(JSON.stringify(vDup.duplicates[0].rowIdx) === '[0,2]', '重复行号为全量行号 [0,2]', vDup.duplicates[0] && vDup.duplicates[0].rowIdx)
  ok(Boolean(vDup.duplicates[0].preview), '重复组带行摘要 preview', vDup.duplicates[0])
  // 行级勾选只圈中重复行：同样回填全量行号；圈不齐则不报
  const vDupPart = printDomain.validateBatch(dsDup.id, tplDup.id, [2, 0])
  ok(vDupPart.duplicates.length === 1 && JSON.stringify(vDupPart.duplicates[0].rowIdx) === '[0,2]',
    '行级勾选含重复两行 → 行号仍为全量行号', vDupPart.duplicates)
  const vDupMiss = printDomain.validateBatch(dsDup.id, tplDup.id, [0, 1])
  ok(!vDupMiss.duplicates.length, '行级勾选只圈中单行 → 不算重复', vDupMiss.duplicates)

  rmDeep(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

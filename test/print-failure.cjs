/**
 * 打印出口三条「静默出错」路径的验收：
 *   1. 一键重打必须还原当时的出片范围（补打 3 人不能打成 100 人）
 *   2. 多联放不下时回退原因必须传到界面（不能静默按单页出片）
 *   3. 直打失败必须留痕（否则历史里查不到当时出了什么）
 * 这三条在原有 12 个套件里覆盖率为 0——出错时不抛错、不变红，只是纸打多了。
 *
 * 运行：node test/print-failure.cjs
 */
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

const TMP = path.join(__dirname, '.tmp-data-fail')
rmDeep(TMP)
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const printDomain = require('../electron/print.cjs')
const templates = require('../electron/templates.cjs')
const dataset = require('../electron/dataset.cjs')
const { reprintScope, layoutFallbackText } = require('../src/lib/print-scope.cjs')

/** 造一个 10 行「姓名」数据集 */
function makeDataset() {
  const fp = path.join(TMP, '重打名单.csv')
  fs.writeFileSync(fp, '姓名\n' + Array.from({ length: 10 }, (_, i) => `第${i + 1}号`).join('\n') + '\n', 'utf-8')
  const ds = dataset.importFromFile(fp)
  dataset.setColumnPrint(ds.id, '姓名', true)
  return ds
}

console.log('== 1. 重打必须还原出片范围 ==')
{
  const ds = makeDataset()
  const tpl = templates.saveTemplate({
    name: '重打用', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    fields: [{ key: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })

  // 只勾 3 行出片 → 留痕里必须有 selection，且重打时能原样取回
  const picked = [1, 4, 7]
  const built = printDomain.buildBatchHtml(ds.id, tpl.id, picked)
  ok(built.recordCount === 3, '部分出片只出 3 条', built.recordCount)
  const job = printDomain.createJob({
    templateId: tpl.id, templateName: tpl.name, datasetId: ds.id, datasetName: ds.name,
    mode: 'print', recordCount: built.recordCount, totalRows: built.scope.total,
    partial: built.scope.partial, selection: built.selection,
    snapshotHtml: built.snapshotHtml, status: 'ok', detail: '打印对话框确认',
  })
  ok(Array.isArray(job.selection) && job.selection.length === 3, '留痕保存了当时的行号', job.selection)
  ok(JSON.stringify(reprintScope(job)) === JSON.stringify(picked),
    '重打还原为当初那 3 行（不是全部 10 行）', reprintScope(job))
  // 反向验证：还原后的范围重新出片，结果仍是 3 条
  const again = printDomain.buildBatchHtml(ds.id, tpl.id, reprintScope(job))
  ok(again.recordCount === 3, '按还原范围重新出片仍是 3 条', again.recordCount)

  // 全量留痕没有 selection → 重打必须是全量
  const fullJob = printDomain.createJob({
    templateId: tpl.id, templateName: tpl.name, datasetId: ds.id, datasetName: ds.name,
    mode: 'pdf', recordCount: 10, totalRows: 10, partial: false, selection: null,
    snapshotHtml: built.snapshotHtml, status: 'ok', detail: 'x.pdf',
  })
  ok(fullJob.selection === null, '全量留痕不冗余存 selection', fullJob.selection)
  ok(reprintScope(fullJob) === null, '全量留痕重打走全量（null）', reprintScope(fullJob))

  // 异常输入不得打出空集或错人
  ok(reprintScope({ selection: [] }) === null, '空 selection 视为全量')
  ok(reprintScope({ selection: 'abc' }) === null, '非数组 selection 视为全量')
  ok(reprintScope({}) === null, '缺字段不炸')
  ok(reprintScope(null) === null, 'null 记录不炸')
  ok(JSON.stringify(reprintScope({ selection: [3, 1, 1, -1, 2.5, '4'] })) === JSON.stringify([1, 3, 4]),
    '行号去重排序并剔除非整数/负数', reprintScope({ selection: [3, 1, 1, -1, 2.5, '4'] }))
}

console.log('== 2. 多联回退原因必须传到界面 ==')
{
  const ds = makeDataset()
  const gridTpl = templates.saveTemplate({
    name: '放不下的多联', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 200, itemH: 200 },
    fields: [{ key: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  const built = printDomain.buildBatchHtml(ds.id, gridTpl.id, null)
  ok(built.layout.enabled === false, '放不下时回退单页')
  ok(built.layout.mode === 'grid', '回退时带原mode（界面据此判断该不该提示）', built.layout)
  ok(typeof built.layout.reason === 'string' && built.layout.reason.includes('放不下'),
    '回退时带可读 reason', built.layout.reason)

  // 界面文案：只有 grid/fold 回退才提示
  ok(layoutFallbackText(built.layout).includes('放不下'), '界面拿到可展示的回退原因', layoutFallbackText(built.layout))
  ok(layoutFallbackText({ enabled: true, cols: 2, rows: 3 }) === '', '正常多联不提示')
  ok(layoutFallbackText({ enabled: false, mode: 'single' }) === '', '单页版式不提示（不是问题）')
  ok(layoutFallbackText({ enabled: false, mode: 'grid' }).length > 0, '缺 reason 时有兜底文案')
  ok(layoutFallbackText(null) === '', '无 layout 不提示')

  // 每页格数超上限也必须给reason（否则同样静默）
  const tinyTpl = templates.saveTemplate({
    name: '极小成品', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 1, itemH: 1 },
    fields: [{ key: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  const tiny = printDomain.buildBatchHtml(ds.id, tinyTpl.id, null)
  ok(tiny.layout.enabled === false && /上限/.test(tiny.layout.reason || ''),
    '每页格数超上限时回退并说明', tiny.layout)

  // 对折桌牌是一页一条，不该被当成回退
  const foldTpl = templates.saveTemplate({
    name: '对折台签', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    layout: { mode: 'fold' },
    fields: [{ key: '姓名', label: '姓名', x: 50, y: 25, fontSize: 12, align: 'center' }],
  })
  const fold = printDomain.buildBatchHtml(ds.id, foldTpl.id, null)
  ok(fold.layout.enabled === true && fold.layout.fold === true, '对折桌牌正常启用', fold.layout)
  ok(layoutFallbackText(fold.layout) === '', '对折桌牌不触发回退提示')
}

console.log('== 3. 直打失败必须留痕 ==')
{
  // 复刻 ipc.cjs print:send 的失败分支：sendToPrinter 抛错时写一条 failed 记录。
  // 这里不真连打印机（会弹系统对话框），而是验证「失败路径确实产出了可查的留痕」：
  // 用真实 printDomain.createJob 落failed，再用 listJobs 读回、resolveSnapshot 回看。
  const ds = makeDataset()
  const tpl = templates.saveTemplate({
    name: '会失败的直打', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    fields: [{ key: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  const built = printDomain.buildBatchHtml(ds.id, tpl.id, [0, 2])
  const failed = printDomain.createJob({
    templateId: tpl.id, templateName: tpl.name, datasetId: ds.id, datasetName: ds.name,
    mode: 'print', recordCount: built.recordCount, totalRows: built.scope.total,
    partial: built.scope.partial, selection: built.selection,
    snapshotHtml: built.snapshotHtml, status: 'failed', detail: '打印机未连接',
  })
  ok(failed.status === 'failed', '失败态被记录', failed.status)
  ok(failed.detail === '打印机未连接', '失败原因入库（能查当时出了什么）', failed.detail)
  ok(failed.snapshot && fs.existsSync(printDomain.resolveSnapshot(failed.id)),
    '失败也留快照（能回看当时排的是什么版）')

  const listed = printDomain.listJobs()
  const back = listed.find((j) => j.id === failed.id)
  ok(Boolean(back), '失败记录出现在历史列表里')
  ok(back.selection && back.selection.length === 2, '失败记录同样保留范围（可原样重打）', back.selection)

  // 取消态不落快照（无意义的归档），但仍要有历史痕迹
  const canceled = printDomain.createJob({
    templateId: tpl.id, templateName: tpl.name, datasetId: ds.id, datasetName: ds.name,
    mode: 'print', recordCount: built.recordCount, totalRows: built.scope.total,
    partial: false, snapshotHtml: built.snapshotHtml, status: 'canceled', detail: '',
  })
  ok(canceled.snapshot === null, '取消态不落快照（省空间）', canceled.snapshot)
  ok(printDomain.listJobs().some((j) => j.id === canceled.id), '取消态仍留历史痕迹')
}

console.log('== 4. 静态核查：print:send 必须有失败留痕分支 ==')
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc.cjs'), 'utf-8')
  const start = src.indexOf("ipcMain.handle('print:send'")
  ok(start > 0, '定位到 print:send 处理函数')
  const body = src.slice(start, src.indexOf("ipcMain.handle('job:list'", start))
  ok(/catch\s*\(/.test(body), 'print:send 包了 try/catch（异常不再静默）')
  ok(/status:\s*'failed'/.test(body), 'print:send 失败时写 failed 留痕')
  ok(body.indexOf("status: 'failed'") < body.indexOf('return {'), '失败留痕发生在 return 之前')
  // 对称性：PDF 出口也必须有，两个出口不能一个留痕一个不留
  const pdfStart = src.indexOf("ipcMain.handle('print:exportPdf'")
  const pdfBody = src.slice(pdfStart, start)
  ok(/status:\s*'failed'/.test(pdfBody), 'print:exportPdf 同样有 failed 留痕（两出口对称）')
}

rmDeep(TMP)
console.log(`\n打印出口容错：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

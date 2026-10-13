/** Batch orchestration: complete paper boundaries, cancellation, real PDF merge and API history. */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-print-batch-'))
process.env.PRINTPRESS_DATA_DIR = path.join(tmp, 'data')
const store = require('../electron/store.cjs')
const domain = require('../electron/print.cjs')
const batch = require('../electron/print-batch.cjs')
const api = require('../electron/api.cjs')
const { buildPdf, readPdfLike, payloadsOf } = require('./helpers/pdf-fixture.cjs')
const { countPdfPagesFromFile } = require('../electron/pdf-merge.cjs')
let checks = 0
const check = (value, label) => { assert.ok(value, label); checks++; console.log('  ok -', label) }
const pageCount = html => (html.match(/class="page"/g) || []).length
store.saveJson('datasets', [{ id: 'ds_batch', name: '分批名单', columns: [{ key: 'name', alias: '姓名', printOn: true }], rows: Array.from({ length: 250 }, (_, i) => ({ name: `人员${i}` })) }])
const template = require('../electron/templates.cjs').saveTemplate({ name: '分批模板', datasetId: 'ds_batch', pageSize: 'a4-portrait', fields: [{ key: 'name', x: 30, y: 20, w: 50, fontSize: 12 }] })
const base = { domain, datasetId: 'ds_batch', templateId: template.id, batches: domain.planBatches(250, null), savePath: path.join(tmp, 'result.pdf') }
function printer(fault = {}) {
  const partitions = [], sends = []
  let calls = 0
  return {
    partitions, sends,
    async printToPdfBuffer(html, opts) {
      calls++; partitions.push(opts.partition)
      if (fault.failOn === calls) throw Error('injected failure')
      if (fault.before) await fault.before(calls)
      return fault.badOn === calls ? Buffer.from('bad PDF') : buildPdf({ tag: `batch${calls}`, pages: pageCount(html) + (fault.extraOn === calls ? 1 : 0) })
    },
    async exportPdf(html, target) { fs.writeFileSync(target, buildPdf({ tag: 'single', pages: pageCount(html) })); return { ok: true, path: target, bytes: fs.statSync(target).size } },
    async sendToPrinter(html, opts) { sends.push(opts); return { ok: fault.failSendOn !== sends.length, error: 'injected print failure' } },
  }
}
async function run() {
  check(domain.planBatches(250, null).map(b => b.rows).join() === '100,100,50', '单页按100/100/50切批')
  const grid = { enabled: true, perPage: 8 }
  check(domain.planBatches(250, grid).map(b => b.pages).join() === '13,13,6', '多联整纸边界与尾批页数')
  check(domain.planBatches(5, grid, 2).length === 1 && domain.planBatches(0, null).length === 0, '小批与空作业边界')
  const ds = require('../electron/dataset.cjs').getDataset('ds_batch')
  const scope = domain.resolveScope(ds, { rows: [9, 2, 20], range: { from: 1, to: 2 } })
  check(scope.selection.join() === '2,9,20' && scope.rowIndexes.join() === '9', '切片保留整次选择和绝对行号')
  check(domain.resolveScope(ds, { range: { from: 100, to: 200 } }).selection === null, '全量切片不误判为部分出片')
  assert.throws(() => domain.resolveScope(ds, { range: { from: 250, to: 250 } }), /为空/)
  const preview = domain.buildBatchHtml('ds_batch', template.id, null, { previewPage: 12 })
  check(pageCount(preview.html) === 1 && preview.pageCount === 250 && preview.recordCount === 250 && preview.html.includes('人员12'), '分页预览只渲染指定纸张且保留总统计')
  check(pageCount(domain.buildBatchHtml('ds_batch', template.id).html) === 250, '完整导出不受预览分页影响')
  const gridTpl = require('../electron/templates.cjs').saveTemplate({ name: '多联模板', datasetId: 'ds_batch', pageSize: 'a4-portrait', layout: { mode: 'grid', itemW: 90, itemH: 60 }, fields: [{ key: 'name', x: 30, y: 20, w: 50, fontSize: 12 }] })
  const gridBuilt = domain.buildBatchHtml('ds_batch', gridTpl.id)
  check(gridBuilt.layout.perPage === 8 && domain.planBatches(250, gridBuilt.layout).map(b=>b.pages).join()==='13,13,6', '实际多联模板元数据用于整纸切批')
  const gridPreview = domain.buildBatchHtml('ds_batch', gridTpl.id, null, { previewPage: 31 })
  check(gridPreview.pageCount===32 && pageCount(gridPreview.html)===1 && gridPreview.html.includes('人员248') && !gridPreview.html.includes('人员247'), '多联末页预览保持余数和正确记录范围')
  const p = printer(), events = []
  const r = await batch.exportPdfBatched({ ...base, printer: p, onProgress: e => events.push(e.phase) })
  check(r.pages === 250 && countPdfPagesFromFile(base.savePath) === 250, '真实合并产物250页完整')
  check(new Set(p.partitions).size === 3 && events.at(-1) === 'publish', '每批独立会话且最后发布')
  const payloads = payloadsOf(readPdfLike(fs.readFileSync(base.savePath)))
  check(payloads[99].includes('batch1-page-100') && payloads[100].includes('batch2-page-1') && payloads[249].includes('batch3-page-50'), '独立解析器核对跨批页序')
  check(!fs.readdirSync(tmp).some(f => f.startsWith('.printpress-tmp-')), '成功后临时件清零')
  for (const fault of [{ failOn: 1 }, { failOn: 2 }, { extraOn: 2 }, { badOn: 2 }]) {
    const target = path.join(tmp, 'existing.pdf')
    fs.writeFileSync(target, 'existing output')
    await assert.rejects(batch.exportPdfBatched({ ...base, savePath: target, printer: printer(fault) }))
    check(fs.readFileSync(target, 'utf8') === 'existing output' && !fs.readdirSync(tmp).some(f => f.startsWith('.printpress-tmp-')), '失败不覆盖已有文件并清理临时件 '+JSON.stringify(fault))
  }
  for (const cancelPhase of ['batch-done', 'merge']) {
    let canceled = false
    const target = path.join(tmp, `canceled-${cancelPhase}.pdf`)
    await assert.rejects(batch.exportPdfBatched({ ...base, savePath: target, printer: printer(), shouldCancel: () => canceled, onProgress: e => { if (e.phase === cancelPhase) canceled = true } }), e => e.canceled)
    check(!fs.existsSync(target) && !fs.readdirSync(tmp).some(f => f.startsWith('.printpress-tmp-')), '取消于'+cancelPhase+'不发布半成品')
  }
  const send = printer()
  await batch.sendToPrinterBatched({ ...base, printer: send, silent: false })
  check(send.sends.map(o => o.silent).join() === 'false,false,false', '非静默打印每批确认设备，不切换到默认打印机')
  let cancelSend = false
  await assert.rejects(batch.sendToPrinterBatched({ ...base, printer: printer(), shouldCancel: () => cancelSend, onProgress: e => { if (e.phase === 'submit-done') cancelSend = true } }), e => e.canceled && e.submitted === 1)
  check(true, '直打取消保留已提交批数')
  await assert.rejects(batch.sendToPrinterBatched({ ...base, printer: printer({ failSendOn: 2 }) }), /前 1 批已提交/)
  const params = { datasetId: 'ds_batch', templateId: template.id, savePath: path.join(tmp, 'api.pdf'), jobKey: 'test-job' }
  const apiEvents = []
  await api.call('print:exportPdf', params, { allowWrite: true, printer: printer(), emit: (channel, e) => apiEvents.push(e) })
  check(domain.listJobs()[0].status === 'ok' && apiEvents.every(e => e.jobKey === params.jobKey), 'API分批成功留痕和进度关联')
  check(api.call('print:cancel', { jobKey: params.jobKey }, { allowWrite: true }).ok === false, '结束任务不可取消')
  await assert.rejects(api.call('print:exportPdf', { ...params, savePath: path.join(tmp, 'api-cancel.pdf') }, { allowWrite: true, printer: printer(), emit: (ch, e) => { if (e.phase === 'batch-done') api.call('print:cancel', { jobKey: params.jobKey }, { allowWrite: true }) } }), e => e.canceled)
  check(domain.listJobs()[0].status === 'canceled', 'API取消留痕为canceled')
  await assert.rejects(api.call('print:exportPdf', params, { allowWrite: true, printer: printer({ failOn: 2 }) }))
  check(domain.listJobs()[0].status === 'failed', 'API失败留痕为failed')
  const savedDatasets = store.loadJson('datasets')
  await assert.rejects(api.call('print:exportPdf', params, { allowWrite: true, printer: printer(), emit: (ch,e)=>{if(e.phase==='batch-done'){const changed=store.loadJson('datasets');changed[0].rows[0].name='changed';store.saveJson('datasets',changed)}} }), /发生变化/)
  store.saveJson('datasets', savedDatasets)
  check(true, '分批期间输入变化时停止，不混用前后名单内容')
  await api.call('print:exportPdf', { ...params, rows: [0, 1], savePath: path.join(tmp, 'single.pdf') }, { allowWrite: true, printer: printer() })
  check(countPdfPagesFromFile(path.join(tmp, 'single.pdf')) === 2, '单批兼容出口')
  console.log(`分批出片：${checks} 项通过`)
}
run().catch(err => { console.error(err); process.exitCode = 1 }).finally(() => rmDeep(tmp))

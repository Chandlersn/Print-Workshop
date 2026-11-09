/** Fault-injection regressions; all data and output are isolated under test/.tmp-*. */
const assert = require('assert/strict'), fs = require('fs'), path = require('path')
const { spawn } = require('child_process')
const ROOT = path.resolve(__dirname, '..')

if (process.argv[2] === 'holder') {
  process.env.PRINTPRESS_DATA_DIR = process.argv[3]
  const api = require('../electron/api.cjs')
  const promise = api.call('app:changeDataDir', {}, { allowWrite: true, app: { userDataDir: process.argv[4] }, dialog: {
    openDirectory: () => new Promise(resolve => { process.send('held'); process.once('message', () => resolve({ canceled: true })) }),
  } })
  Promise.resolve(promise).then(() => { process.send('released'); process.disconnect() }).catch(error => { console.error(error); process.exit(1) })
  return
}

const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-system-audit-regression-'))
const data = path.join(tmp, 'data'), target = path.join(tmp, 'target'), userData = path.join(tmp, 'userData')
for (const dir of [data, target, userData]) fs.mkdirSync(dir, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = data
const api = require('../electron/api.cjs'), store = require('../electron/store.cjs'), lock = require('../electron/data-lock.cjs')
const dataset = require('../electron/dataset.cjs'), templates = require('../electron/templates.cjs'), print = require('../electron/print.cjs')
const dataDir = require('../electron/data-dir.cjs'), XLSX = require('xlsx')
const waitMessage = child => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`子进程退出: ${code}`)) }) })
let checks = 0
function pass(label) { checks++; console.log('  ok -', label) }

async function main() {
  const migrationCtx = { allowWrite: true, app: { userDataDir: userData }, dialog: { openDirectory: async () => ({ canceled: false, filePaths: [target] }) } }
  dataDir.writeCustomDataDir(userData, data)
  const bootstrapBefore = fs.readFileSync(path.join(userData, dataDir.BOOTSTRAP_FILE), 'utf8')
  const bootstrapRename = fs.renameSync
  try {
    fs.renameSync = function(from, to) { if (String(to) === path.join(userData, dataDir.BOOTSTRAP_FILE)) throw new Error('injected configuration failure'); return bootstrapRename.apply(this, arguments) }
    assert.throws(() => dataDir.scheduleMigration(userData, data, target), /configuration failure/)
  } finally { fs.renameSync = bootstrapRename }
  assert.equal(fs.readFileSync(path.join(userData, dataDir.BOOTSTRAP_FILE), 'utf8'), bootstrapBefore)
  pass('迁移配置写入失败时保留旧的数据目录设置')
  fs.writeFileSync(path.join(data, 'marker.txt'), 'source')
  fs.writeFileSync(path.join(target, 'marker.txt'), 'target original')
  await assert.rejects(() => api.call('app:changeDataDir', {}, migrationCtx), /同名/)
  assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'target original')
  pass('迁移冲突被阻止，目标原文件未被覆盖')
  fs.unlinkSync(path.join(target, 'marker.txt'))
  const scheduled = await api.call('app:changeDataDir', {}, migrationCtx)
  assert.equal(scheduled.pendingMigration, true)
  assert.equal(fs.existsSync(path.join(target, 'marker.txt')), false)
  fs.writeFileSync(path.join(data, 'marker.txt'), 'after scheduling')
  dataDir.assertNoMigrationConflicts(data, target)
  dataDir.copyDirSync(data, target)
  assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'after scheduling')
  pass('延后启动时复制包含选择目录之后的修改')

  fs.writeFileSync(path.join(data, 'damaged.json'), '[broken')
  assert.throws(() => store.loadJson('damaged', { expect: 'array' }), /损坏/)
  assert.throws(() => store.loadJson('damaged', { expect: 'array' }), /尚未恢复/)
  assert.throws(() => store.saveJson('damaged', []), /尚未恢复/)
  pass('数据损坏后反复读取和直接写入都不会当成空库')

  assert.equal(lock.isStale({ pid: process.pid, beatAt: Date.now() - 60000, startedAt: Date.now() - 70000 }), false)
  const child = spawn(process.execPath, [__filename, 'holder', data, userData], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  assert.equal(await waitMessage(child), 'held')
  const csv = path.join(tmp, 'people.csv')
  fs.writeFileSync(csv, 'Name,Code\nAlice,A\n')
  assert.throws(() => api.call('dataset:importFile', { filePath: csv }, { allowWrite: true }), { code: 'DATA_DIR_BUSY' })
  child.send('finish'); assert.equal(await waitMessage(child), 'released')
  const imported = await api.call('dataset:importFile', { filePath: csv }, { allowWrite: true })
  assert.ok(imported.id)
  pass('活进程旧心跳不被回收；并发客户端写入被阻止，释放后可写')

  const wb = XLSX.utils.book_new(), xlsx = path.join(tmp, 'multiple.xlsx')
  for (const name of ['One', 'Two']) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name'], [name]]), name)
  XLSX.writeFile(wb, xlsx)
  const before = dataset.listDatasets().length, originalRename = fs.renameSync
  try {
    fs.renameSync = function(from, to) { if (String(to) === path.join(data, 'datasets.json')) throw new Error('injected write failure'); return originalRename.apply(this, arguments) }
    await assert.rejects(() => dataset.importSheets(xlsx, { selections: [{ name: 'One', headerRow: 0 }, { name: 'Two', headerRow: 0 }], mode: 'split' }), /写入失败/)
  } finally { fs.renameSync = originalRename }
  assert.equal(dataset.listDatasets().length, before)
  assert.equal((await dataset.importSheets(xlsx, { selections: [{ name: 'One', headerRow: 0 }, { name: 'Two', headerRow: 0 }], mode: 'split' })).length, 2)
  pass('多表落盘失败不留下部分名单，重试一次得到完整结果')

  dataset.setColumnPrint(imported.id, 'Name', true)
  const tpl = templates.saveTemplate({ name: 'Audit', datasetId: imported.id, pageSize: { w: 210, h: 297 }, fields: [{ column: 'Name', label: 'Name', x: 50, y: 50, fontSize: 12 }] })
  const originalMark = dataset.markPrinted, originalCreate = print.createJob
  try {
    let sent = false
    dataset.markPrinted = () => { throw new Error('injected status failure') }
    const result = await api.call('print:send', { datasetId: imported.id, templateId: tpl.id }, { allowWrite: true, printer: { sendToPrinter: async () => { sent = true; return { ok: true } } } })
    assert.ok(sent && result.ok && result.recordWarning.includes('已发送'))
    assert.ok(print.listJobs().some(job => job.datasetId === imported.id && job.status === 'ok'))
    pass('已送打印机但状态写入失败时明确提示，并保留成功记录')
  } finally { dataset.markPrinted = originalMark }
  try {
    print.createJob = () => { throw new Error('injected history failure') }
    const pdf = path.join(tmp, 'result.pdf')
    const result = await api.call('print:exportPdf', { datasetId: imported.id, templateId: tpl.id, savePath: pdf }, { allowWrite: true, printer: { exportPdf: async (_html, output) => { fs.writeFileSync(output, 'pdf'); return { path: output, bytes: 3 } } } })
    assert.ok(fs.existsSync(pdf) && !result.canceled && result.recordWarning.includes('已导出'))
    const imageDir = path.join(tmp, 'images')
    const images = await api.call('print:exportImages', { datasetId: imported.id, templateId: tpl.id, outputDir: imageDir, field1: 'Name', field2: 'Code' }, { allowWrite: true, printer: { exportPng: async (_html, output) => { fs.copyFileSync(path.join(ROOT, 'test/fixtures/tiny.png'), output); return { path: output } } } })
    assert.ok(images.count === 1 && images.recordWarning.includes('已导出'))
    pass('PDF 和图片已经写出但历史失败时返回成功及持续提示')
  } finally { print.createJob = originalCreate }
  console.log(`AUDIT_DATA_OK ${checks} ${tmp}`)
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })

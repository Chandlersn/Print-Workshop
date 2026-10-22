/** Real Electron raster and UI regression checks for per-record PNG exports. */
const { app, BrowserWindow, nativeImage, ipcMain, protocol } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { pathToFileURL } = require('url')
const ROOT = path.resolve(__dirname, '..')
const CODE = path.resolve(process.env.PRINTPRESS_REVIEW_CODE || ROOT)
const displayScale = Number(process.env.PRINTPRESS_REVIEW_SCALE || 1.25)
const runName = process.env.PRINTPRESS_REVIEW_RUN || `source-${displayScale}`
const output = path.join(ROOT, '.workbuddy-ai/tmp/print-images-review', runName)
const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-print-images-e2e-'))
const data = path.join(temp, 'data')
fs.mkdirSync(output, { recursive: true })
if (process.env.PRINTPRESS_REVIEW_SOURCE_DATA) fs.cpSync(process.env.PRINTPRESS_REVIEW_SOURCE_DATA, data, { recursive: true })
else fs.mkdirSync(data, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = data
app.setPath('userData', path.join(temp, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('force-device-scale-factor', String(displayScale))
protocol.registerSchemesAsPrivileged([{ scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.on('window-all-closed', () => {})
const evidence = { displayScale, code: CODE, checks: [], images: [] }
evidence.captures = []
app.on('browser-window-created', (_event, win) => {
  const debug = win.webContents.debugger
  const send = debug.sendCommand.bind(debug)
  debug.sendCommand = async (method, params, ...rest) => {
    const result = await send(method, params, ...rest)
    if (method === 'Page.captureScreenshot' && params.format === 'png') {
      const buffer = Buffer.from(result.data, 'base64')
      const capture = { clip: params.clip, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
      evidence.captures.push(capture)
      console.log('RAW_CAPTURE', JSON.stringify(capture))
    }
    return result
  }
})
function check(value, label) { assert.ok(value, label); evidence.checks.push(label); console.log('PASS', label) }
const watchdog = setTimeout(() => { console.error('PRINT_IMAGES_TIMEOUT'); app.exit(1) }, 180000)
const mod = name => require(path.join(CODE, 'electron', name + '.cjs'))
function pixel(image, x, y) {
  const { width } = image.getSize()
  const i = (y * width + x) * 4
  return [...image.toBitmap().subarray(i, i + 4)]
}
function inspect(file, w, h, corners = true) {
  const bytes = fs.readFileSync(file)
  const image = nativeImage.createFromBuffer(bytes)
  const size = mod('images').imageSizeFromBuffer(bytes)
  check(size.width === w && size.height === h, `${path.basename(file)} actual PNG ${w}x${h}`)
  if (corners) {
    const colors = [[0, 0, 255], [0, 128, 0], [255, 0, 0], [0, 255, 255]]
    for (const [index, [x, y]] of [[.05, .05], [.95, .05], [.05, .95], [.95, .95]].entries()) {
      const p = pixel(image, Math.floor(size.width * x), Math.floor(size.height * y))
      check(colors[index].every((v, c) => Math.abs(p[c] - v) < 8) && p[3] === 255,
        `${path.basename(file)} corner ${index + 1} has artwork, no external canvas (${p})`)
    }
  }
  evidence.images.push({ file, ...size, bytes: bytes.length })
  return image
}
async function main() {
  await app.whenReady()
  mod('media-protocol').registerMediaProtocol(require('electron').session.defaultSession)
  const printer = mod('printer')
  const render = mod('render-engine')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><path fill="red" d="M0 0h200v200H0z"/><path fill="green" d="M200 0h200v200H200z"/><path fill="blue" d="M0 200h200v200H0z"/><path fill="yellow" d="M200 200h200v200H200z"/></svg>'
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  const template = { name: 'Raster acceptance', pageSize: { id: 'a4-portrait', w: 210, h: 297 }, fields: [] }
  function html(tpl, selector = '.page') {
    return render.buildHtml(tpl, [{}], { withToolbar: false,
      preparedDesign: { css: `${selector}{background-image:url('${url}');background-size:100% 100%}`, html: '', fontFamilies: [] } })
  }
  for (const dpi of [150, 300, 600]) {
    const file = path.join(output, `a4-${dpi}.png`)
    await printer.exportPng(html(template), file, { widthMm: 210, heightMm: 297, dpi })
    inspect(file, Math.ceil(210 / 25.4 * dpi), Math.ceil(297 / 25.4 * dpi))
  }
  const grid = { ...template, layout: { mode: 'grid', itemW: 85, itemH: 54, showCutMarks: true } }
  const file = path.join(output, 'grid-cell-300.png')
  await printer.exportPng(html(grid, '.cell'), file, { widthMm: 210, heightMm: 297, dpi: 300, cropToCell: true })
  inspect(file, Math.ceil(85 / 25.4 * 300), Math.ceil(54 / 25.4 * 300))

  const dataset = mod('dataset'), templates = mod('templates'), api = mod('api'), print = mod('print')
  const csv = path.join(temp, 'review.csv')
  fs.writeFileSync(csv, '编号,姓名\n' + Array.from({ length: 20 }, (_, i) => `${i + 1},Review${i + 1}`).join('\n'), 'utf8')
  const ds = dataset.getDataset(dataset.importFromFile(csv).id)
  dataset.setColumnPrint(ds.id, '姓名', true)
  const bg = nativeImage.createFromBuffer(Buffer.from(await (async () => {
    const win = await printer.loadHtml(`<html><body style="margin:0"><img width="400" height="400" src="${url}"></body></html>`, { capture: true })
    try { return (await win.webContents.capturePage({ x: 0, y: 0, width: 400, height: 400 })).toPNG() } finally { win.destroy() }
  })()))
  fs.mkdirSync(path.join(data, 'print-bg'), { recursive: true })
  fs.writeFileSync(path.join(data, 'print-bg/review.png'), bg.toPNG())
  const tpl = templates.saveTemplate({ name: 'PNG 20 rows review', datasetId: ds.id, pageSize: template.pageSize,
    background: 'print-bg/review.png', fields: [{ column: '姓名', label: '姓名', x: 30, y: 45, fontSize: 14 }] })
  async function apiExport(t, d, name, rows, dpi = 150, fields) {
    const directory = path.join(output, name)
    const progress = []
    const result = await api.call('print:exportImages', {
      datasetId: d.id, templateId: t.id, rows, outputDpi: dpi,
      field1: fields?.[0] || '编号', field2: fields?.[1] || '姓名',
    }, { allowWrite: true, printer, dialog: { openDirectory: async () => ({ canceled: false, filePaths: [directory] }) },
      emit: (channel, event) => { if (channel === 'print:progress') progress.push(event.index) } })
    check(result.count === (rows?.length || d.rows.length), `${name} full API record count correct`)
    check(fs.readdirSync(directory).length === result.count && progress.length === result.count, `${name} file count equals progress and success count`)
    return result
  }
  const all = await apiExport(tpl, ds, 'all-20', null)
  check(all.files.some(f => path.basename(f) === '20_Review20.png'), 'filename combines selected values and all-row indexing reaches row 20')
  const allJob = print.listJobs().find(job => job.id === all.jobId)
  check(allJob?.mode === 'images' && allJob.status === 'ok' && allJob.recordCount === 20 && allJob.completedCount === 20, 'full PNG export creates successful history with 20 completed records')
  check(allJob.imageNameFields.join(',') === '编号,姓名' && allJob.outputDpi === 150 && fs.existsSync(print.resolveSnapshot(all.jobId)), 'PNG history preserves naming fields, DPI and archived snapshot')
  check(fs.readFileSync(print.resolveSnapshot(all.jobId), 'utf8').includes('Review20'), 'PNG history snapshot includes the entire exported scope')
  const marked = dataset.listDatasets().find(d => d.id === ds.id)
  check(marked.printCount === 1 && marked.lastPrintMode === 'images' && marked.lastPrintedAt, 'successful full PNG export automatically marks the dataset printed')
  const selected = await apiExport(tpl, ds, 'selected', [1, 3])
  check(selected.files.map(f => path.basename(f)).join(',') === '2_Review2.png,4_Review4.png', 'selected records keep original dataset indexes')
  const partialJob = print.listJobs().find(job => job.id === selected.jobId)
  check(partialJob.partial && partialJob.selection.join(',') === '1,3' && partialJob.selectionIds.length === 2, 'partial PNG export archives stable selected record identities')
  check(dataset.listDatasets().find(d => d.id === ds.id).printCount === 1, 'partial PNG export does not mark the entire dataset printed')
  inspect(all.files[0], Math.ceil(210 / 25.4 * 150), Math.ceil(297 / 25.4 * 150), false)
  const firstBytes = fs.readFileSync(all.files[0])
  const collision = await api.call('print:exportImages', { datasetId: ds.id, templateId: tpl.id, rows: [0], field1: '编号', field2: '姓名', outputDpi: 150 },
    { allowWrite: true, printer, dialog: { openDirectory: async () => ({ filePaths: [path.dirname(all.files[0])] }) } })
  check(path.basename(collision.files[0]) === '1_Review1 (2).png' && fs.readFileSync(all.files[0]).equals(firstBytes), 'existing files get duplicate suffix and original bytes stay unchanged')
  let falseSuccess = false, falseProgress = 0
  try {
    await api.call('print:exportImages', { datasetId: ds.id, templateId: tpl.id, rows: [0], field1: '编号', field2: '姓名', outputDpi: 150 }, {
      allowWrite: true, printer: { exportPng: async (_html, target) => ({ path: target }) },
      dialog: { openDirectory: async () => ({ filePaths: [path.join(output, 'unwritten')] }) }, emit: () => falseProgress++,
    })
    falseSuccess = true
  } catch (error) { check(error.message.includes('未成功写入磁盘'), 'missing written file causes an explicit export failure') }
  check(!falseSuccess && falseProgress === 0, 'no success result or progress emitted before file exists')
  check(print.listJobs()[0].mode === 'images' && print.listJobs()[0].status === 'failed' && print.listJobs()[0].completedCount === 0,
    'PNG export failure is recorded in history with zero completed files')
  check(dataset.listDatasets().find(d => d.id === ds.id).printCount === 1, 'failed PNG export does not change dataset print status')
  let attempts = 0
  try {
    await api.call('print:exportImages', { datasetId: ds.id, templateId: tpl.id, rows: null, field1: '编号', field2: '姓名', outputDpi: 150 }, {
      allowWrite: true, printer: { ...printer, exportPng: async (...args) => {
        if (++attempts === 2) throw new Error('验收：第二张渲染失败')
        return printer.exportPng(...args)
      } }, dialog: { openDirectory: async () => ({ filePaths: [path.join(output, 'mid-failure')] }) },
    })
    assert.fail('a mid-export error must propagate')
  } catch (error) { check(error.message.includes('第二张渲染失败'), 'mid-export rendering failure propagates') }
  const interrupted = print.listJobs()[0]
  check(interrupted.status === 'failed' && interrupted.completedCount === 1 && interrupted.recordCount === 20,
    'failed full export records one saved image out of twenty')
  check(dataset.listDatasets().find(d => d.id === ds.id).printCount === 1, 'partially saved full export does not mark dataset printed')
  const beforeCancel = print.listJobs().length
  const canceled = await api.call('print:exportImages', { datasetId: ds.id, templateId: tpl.id, field1: '编号', field2: '姓名' },
    { allowWrite: true, printer, dialog: { openDirectory: async () => ({ canceled: true }) } })
  check(canceled.canceled && print.listJobs().length === beforeCancel && dataset.listDatasets().find(d => d.id === ds.id).printCount === 1,
    'canceling the folder chooser adds no print record or dataset mark')

  const real = JSON.parse(fs.readFileSync(path.join(data, 'templates.json'), 'utf8')).find(t => t.backgroundDesign && t.id !== tpl.id)
  if (process.env.PRINTPRESS_REVIEW_SOURCE_DATA && real) {
    const realDs = dataset.getDataset(real.datasetId)
    const fields = realDs.columns.slice(0, 2).map(c => c.key)
    const previousCount = dataset.listDatasets().find(d => d.id === realDs.id).printCount || 0
    const result = await apiExport(real, realDs, 'real-certificate', null, 300, fields)
    const spec = render.pageSpec(real.pageSize)
    for (const image of result.files) inspect(image, Math.ceil(spec.w / 25.4 * 300), Math.ceil(spec.h / 25.4 * 300), false)
    check(dataset.listDatasets().find(d => d.id === realDs.id).printCount === previousCount + 1 && print.listJobs()[0].id === result.jobId,
      'real certificate export records the full job and marks the isolated dataset')
    evidence.realTemplate = { name: real.name, count: result.count }
  }

  mod('store').saveJson('settings', { onboarded: true })
  print.createJob({ datasetId: ds.id, datasetName: ds.name, templateId: tpl.id, templateName: tpl.name,
    mode: 'pdf', status: 'ok', recordCount: 20, snapshotHtml: '<html>review</html>' })
  mod('ipc').registerIpc()
  ipcMain.handle('app:meta', () => ({ version: 'review', links: {} }))
  const ui = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: path.join(CODE, 'electron/preload.cjs'), sandbox: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  const evaluate = code => ui.webContents.executeJavaScript(code)
  async function waitFor(code, label) {
    for (let i = 0; i < 200; i++) { if (await evaluate(code)) return; await new Promise(r => setTimeout(r, 50)) }
    throw new Error('UI timeout: ' + label)
  }
  await ui.loadURL(pathToFileURL(path.join(CODE, 'dist/index.html')).href)
  await waitFor(`document.querySelectorAll('.nav-label').length===5`, 'app tabs')
  await evaluate(`document.querySelectorAll('.nav-label')[4].click()`)
  await waitFor(`!!document.querySelector('.history-trigger')`, 'history button')
  check(await evaluate(`!document.querySelector('.history-modal') && !document.querySelector('.job-table')`), 'history list absent from print center document flow by default')
  await evaluate(`document.querySelector('.history-trigger').click()`)
  await waitFor(`!!document.querySelector('.history-modal .job-table')`, 'history dialog')
  check(await evaluate(`getComputedStyle(document.querySelector('.history-mask')).position==='fixed'`), 'history opens in fixed overlay, not preview layout')
  fs.writeFileSync(path.join(output, 'history-ui.png'), (await ui.webContents.capturePage()).toPNG())
  check(await evaluate(`document.querySelector('.history-modal').getBoundingClientRect().width > 900`), 'desktop history dialog is wide enough for the table')
  await evaluate(`document.querySelector('.history-head button').click()`)
  await waitFor(`!document.querySelector('.history-modal')`, 'history closed')
  check(await evaluate(`!document.querySelector('.history-modal')`), 'close button hides history dialog')
  dataset.updateCell(ds.id, 0, '姓名', '')
  await evaluate(`document.querySelector('.history-trigger').click()`)
  await waitFor(`!!document.querySelector('.history-modal .row-actions')`, 'history reopened')
  await evaluate(`Array.from(document.querySelectorAll('.history-modal .row-actions button')).find(el => el.textContent==='重打').click()`)
  await waitFor(`Array.from(document.querySelectorAll('.modal-title')).some(el=>el.textContent.includes('打印前校验'))`, 'reprint validation')
  check(await evaluate(`!document.querySelector('.history-modal')`), 'reprint closes history before opening validation')
  await evaluate(`Array.from(document.querySelectorAll('.modal-actions button')).find(el=>el.textContent==='返回补全').click()`)
  await waitFor(`!!document.querySelector('.preview-frame') && !!document.querySelector('.range-count')`, 'print preview')
  const previewBefore = await evaluate(`document.querySelector('.preview-wrap').getBoundingClientRect().top`)
  await evaluate(`document.querySelector('.history-trigger').click()`)
  await waitFor(`!!document.querySelector('.history-modal')`, 'history over preview')
  await evaluate(`document.querySelector('.history-head button').click()`)
  await waitFor(`!document.querySelector('.history-modal')`, 'history over preview closed')
  check(await evaluate(`document.querySelector('.preview-wrap').getBoundingClientRect().top === ${previewBefore}`), 'opening and closing history does not move the print preview')
  check(await evaluate(`(() => { const bar=document.querySelector('.range-bar'); const items=[...bar.children].filter(el=>el.offsetWidth && !el.classList.contains('tb-spacer')); return items.every(el=>Math.abs(el.getBoundingClientRect().top-items[0].getBoundingClientRect().top)<8) })()`), 'scope and record/page summary stay on one desktop row')
  fs.writeFileSync(path.join(output, 'print-preview-ui.png'), (await ui.webContents.capturePage()).toPNG())
  const dialog = require('electron').dialog
  const originalDialog = dialog.showOpenDialog
  const zoomFiles = []
  try {
    for (const zoom of [50, 125]) {
      await evaluate(`document.querySelector('.preview-bar .cs-trigger').click()`)
      await waitFor(`!!document.querySelector('.preview-bar .cs-option')`, 'preview zoom menu')
      await evaluate(`Array.from(document.querySelectorAll('.preview-bar .cs-option')).find(el=>el.textContent.trim()==='${zoom}%').click()`)
      await waitFor(`document.querySelector('.preview-frame').style.transform==='scale(${zoom / 100})'`, 'preview zoom applied')
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(output, 'zoom-' + zoom)] })
      const result = await evaluate(`window.printpress.printExportImages(${JSON.stringify({ datasetId: ds.id, templateId: tpl.id, rows: [1], field1: '编号', field2: '姓名', outputDpi: 150 })})`)
      zoomFiles.push(result.files[0])
    }
  } finally { dialog.showOpenDialog = originalDialog }
  check(fs.readFileSync(zoomFiles[0]).equals(fs.readFileSync(zoomFiles[1])), '50% and 125% preview zoom produce byte-identical PNG through actual IPC')
  const countBeforeUi = dataset.listDatasets().find(d => d.id === ds.id).printCount
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(output, 'ui-full')] })
    await evaluate(`document.querySelector('.toolbar-row-output .toolbar-control .cs-trigger').click()`)
    await waitFor(`!!document.querySelector('.toolbar-row-output .cs-option')`, 'output DPI menu')
    await evaluate(`Array.from(document.querySelectorAll('.toolbar-row-output .cs-option')).find(el=>el.textContent.includes('150')).click()`)
    await evaluate(`document.querySelector('.toolbar-actions button').click()`)
    await waitFor(`document.querySelector('.toast')?.textContent.includes('已导出 20 张 PNG')`, 'PNG button exports all rows')
    await waitFor(`document.querySelector('.stats-bar')?.textContent.includes('已打印/导出')`, 'live dataset statistics refreshed')
    check(dataset.listDatasets().find(d => d.id === ds.id).printCount === countBeforeUi + 1, 'actual PNG button marks full dataset after success')
    await evaluate(`document.querySelector('.history-trigger').click()`)
    await waitFor(`document.querySelector('.history-modal tbody tr')?.textContent.includes('导出 PNG')`, 'live PNG history refreshed')
    check(print.listJobs()[0].mode === 'images' && print.listJobs()[0].recordCount === 20, 'PNG success immediately refreshes the history dialog')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(output, 'ui-png-reprint')] })
    await evaluate(`(() => { const row=[...document.querySelectorAll('.history-modal tbody tr')].find(el=>el.querySelector('.partial-tag')?.textContent.includes('部分 1/20')); [...row.querySelectorAll('button')].find(el=>el.textContent==='重打').click() })()`)
    await waitFor(`!document.querySelector('.history-modal') && document.querySelector('.toast')?.textContent.includes('已导出 1 张 PNG')`, 'PNG history reprint')
    const repeated = print.listJobs()[0]
    check(repeated.mode === 'images' && repeated.recordCount === 1 && repeated.outputDpi === 150 && repeated.imageNameFields.join(',') === '编号,姓名',
      'PNG history reprint preserves PNG format, naming fields, DPI and partial scope')
  } finally { dialog.showOpenDialog = originalDialog }
  await evaluate(`document.querySelectorAll('.nav-label')[3].click()`)
  await waitFor(`!!document.querySelector('.tpl-tabs')`, 'template page')
  await evaluate(`document.querySelectorAll('.tpl-tabs button')[1].click()`)
  await waitFor(`Array.from(document.querySelectorAll('.tpl-name')).some(el=>el.textContent==='PNG 20 rows review')`, 'user template')
  await evaluate(`Array.from(document.querySelectorAll('.tpl-item')).find(el=>el.querySelector('.tpl-name')?.textContent==='PNG 20 rows review').click()`)
  await waitFor(`!!document.querySelector('.palette-toggle') && document.querySelectorAll('.palette-chip').length>0`, 'field panel')
  await evaluate(`document.querySelector('.palette-toggle').click()`)
  await waitFor(`document.querySelector('.palette-toggle').getAttribute('aria-expanded')==='false'`, 'fields collapsed')
  check(await evaluate(`document.querySelectorAll('.palette-chip').length===0 && document.querySelector('.palette-toggle').textContent==='展开字段'`), 'one-click collapse hides the field list')
  await evaluate(`document.querySelector('.palette-toggle').click()`)
  await waitFor(`document.querySelector('.palette-toggle').getAttribute('aria-expanded')==='true'`, 'fields expanded')
  check(await evaluate(`document.querySelectorAll('.palette-chip').length>0`), 'one-click expand restores the field list')
  ui.destroy()
  console.log('PRINT_IMAGES_REVIEW_PASS', evidence.checks.length)
}
main().then(() => { evidence.ok = true; clearTimeout(watchdog); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2)); app.exit(0) })
  .catch(err => { evidence.ok = false; evidence.error = err.stack; console.error(err.stack); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2)); clearTimeout(watchdog); app.exit(1) })

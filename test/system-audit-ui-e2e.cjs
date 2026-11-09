/** Isolated renderer reproductions for scope drift, unsaved photo edits, and rapid cell edits. */
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
const assert = require('assert/strict')
const fs = require('fs'), path = require('path')
const { pathToFileURL } = require('url')
const ROOT = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-audit-ui-'))
process.env.PRINTPRESS_DATA_DIR = path.join(tmp, 'data')
app.setPath('userData', path.join(tmp, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.on('window-all-closed', () => {})
protocol.registerSchemesAsPrivileged([{ scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
const watchdog = setTimeout(() => { console.error('AUDIT_UI_TIMEOUT'); app.exit(1) }, 60000)
let ui
const results = {}
const evalUi = async code => { try { return await ui.webContents.executeJavaScript(code) } catch (error) { console.error('UI script:', code); throw error } }
async function wait(code, description) {
  for (let i = 0; i < 200; i++) {
    if (await evalUi(code)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败: ${description}; ${await evalUi(`document.body.innerText.slice(0, 2500)`)}`)
}
async function main() {
  await app.whenReady()
  require('../electron/media-protocol.cjs').registerMediaProtocol(session.defaultSession)
  require('../electron/data-lock.cjs').acquireForHost()
  const store = require('../electron/store.cjs'), dataset = require('../electron/dataset.cjs')
  const designs = require('../electron/designs.cjs'), templates = require('../electron/templates.cjs')
  store.saveJson('settings', { onboarded: true, demoSeeded: true })
  const columns = [{ key: 'name', alias: '姓名', printOn: true }, { key: 'photo', alias: '照片', printOn: false }]
  store.saveJson('datasets', [
    { id: 'ds_audit_a', name: 'Audit A', source: { batchId: 'audit', fileName: 'audit' }, photoMatchColumn: 'photo', columns, rows: [{ name: 'Alice', photo: 'a' }, { name: 'Bob', photo: 'a' }, { name: 'Carol', photo: 'a' }] },
    { id: 'ds_audit_b', name: 'Audit B', source: { batchId: 'audit', fileName: 'audit' }, photoMatchColumn: 'photo', columns, rows: [{ name: 'Other', photo: 'a' }] },
  ])
  const asset = designs.importImageBuffer(fs.readFileSync(path.join(ROOT, 'test/fixtures/tiny.png')), 'a.png', 'photo')
  store.saveJson('photo-bindings', [{ datasetId: 'ds_audit_a', column: 'photo', files: [{ name: 'a.png', assetId: asset.id }] }])
  const design = designs.saveDesign({ name: 'Audit design', artboard: { w: 90, h: 60 }, layers: [{ id: 'portrait', type: 'image', variable: true, bindColumn: 'photo', x: 10, y: 10, w: 30, h: 40, fit: 'contain' }] })
  templates.saveTemplate({ name: 'Audit template', datasetId: 'ds_audit_a', pageSize: { id: 'custom', w: 90, h: 60 }, fields: [{ column: 'name', x: 55, y: 30, fontSize: 16 }], backgroundDesign: { id: design.id, revision: design.revision } })
  require('../electron/ipc.cjs').registerIpc()
  ipcMain.handle('app:meta', () => ({ version: 'audit', links: {} }))
  ipcMain.handle('app:checkUpdate', () => ({ status: 'current' }))
  ui = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), sandbox: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  ui.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('RENDERER:', message) })
  await ui.loadFile(path.join(ROOT, 'dist/index.html'))
  await wait(`document.querySelectorAll('.nav-label').length===5 && !!document.querySelector('.cell')`, '数据页')
  const originalUpdate = dataset.updateCell
  let failNextUpdate = false
  dataset.updateCell = async (...args) => { await new Promise(resolve => setTimeout(resolve, 400)); if (failNextUpdate) { failNextUpdate = false; throw new Error('injected save failure') }; return originalUpdate(...args) }
  try {
    await evalUi(`document.querySelectorAll('td.cell')[0].click()`)
    await wait(`!!document.querySelector('.cell-input')`, '第一个单元格编辑')
    await evalUi(`(() => {const first=document.querySelector('.cell-input'); first.value='Alice changed'; first.dispatchEvent(new Event('input',{bubbles:true})); first.dispatchEvent(new FocusEvent('blur')); document.querySelectorAll('td.cell')[1].click()})()`)
    await wait(`!!document.querySelectorAll('td.cell')[1]?.querySelector('input')`, '第二个单元格编辑')
    await evalUi(`(() => {const second=document.querySelectorAll('td.cell')[1].querySelector('input');second.value='unsaved draft';second.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await new Promise(resolve => setTimeout(resolve, 900))
    results.rapidCellDraftLost = await evalUi(`!document.querySelector('.cell-input') && !document.body.textContent.includes('unsaved draft')`)
    results.cellState = { input: await evalUi(`document.querySelector('.cell-input')?.value || ''`), rows: dataset.getDataset('ds_audit_a').rows }
    failNextUpdate = true
    await evalUi(`[...document.querySelectorAll('.ds-item')].find(el=>el.textContent.includes('Audit B')).click()`)
    await new Promise(resolve => setTimeout(resolve, 600))
    results.failedSaveBlocksSwitch = await evalUi(`document.querySelector('.detail-title')?.textContent==='Audit A' && document.querySelector('.cell-input')?.value==='unsaved draft'`)
    assert.equal(results.failedSaveBlocksSwitch, true, '保存失败保留草稿并阻止切换名单')
    await evalUi(`[...document.querySelectorAll('.ds-item')].find(el=>el.textContent.includes('Audit B')).click()`)
    await wait(`document.querySelector('.detail-title')?.textContent==='Audit B'`, '切换名单')
    results.draftAppearsInOtherDataset = await evalUi(`document.querySelector('.cell-input')?.value === 'unsaved draft'`)
    assert.equal(results.rapidCellDraftLost, false, '连续编辑时保留草稿')
    assert.equal(results.draftAppearsInOtherDataset, false, '草稿不能带到另一份名单')
    assert.equal(dataset.getDataset('ds_audit_a').rows[0].photo, 'unsaved draft', '切换前将草稿写回原名单')
    await evalUi(`[...document.querySelectorAll('.ds-item')].find(el=>el.textContent.includes('Audit A')).click()`)
    await wait(`document.querySelector('.detail-title')?.textContent==='Audit A'`, '返回原名单')
  } finally { dataset.updateCell = originalUpdate }

  await evalUi(`document.querySelectorAll('.nav-label')[4].click()`)
  await wait(`!!document.querySelector('.toolbar-row-template .cs-trigger')`, '打印中心')
  await evalUi(`document.querySelector('.toolbar-row-template .cs-trigger').click()`)
  await wait(`!!document.querySelector('.toolbar-row-template .cs-option')`, '模板菜单')
  await evalUi(`[...document.querySelectorAll('.toolbar-row-template .cs-option')].find(el=>el.textContent.includes('Audit template')).click()`)
  await wait(`!!document.querySelector('.preview-frame') && [...document.querySelectorAll('button')].some(el=>el.textContent==='选择打印行'&&!el.disabled)`, '预览')
  await evalUi(`[...document.querySelectorAll('button')].find(el=>el.textContent==='选择打印行').click()`)
  await wait(`!!document.querySelector('.scope-list')`, '打印范围')
  await evalUi(`[...document.querySelectorAll('.scope-toolbar button')].find(el=>el.textContent==='取消全选').click(); document.querySelectorAll('.scope-row input')[1].click(); document.querySelector('.modal-actions .btn-primary').click()`)
  await wait(`document.querySelector('.range-bar')?.textContent.includes('已选 1 / 3 行')`, '部分范围')
  await evalUi(`document.querySelectorAll('.nav-label')[0].click()`)
  dataset.deleteRow('ds_audit_a', 0)
  dataset.addRow('ds_audit_a')
  await evalUi(`document.querySelectorAll('.nav-label')[4].click()`)
  await wait(`document.querySelector('.range-bar')?.textContent.includes('已选 1 / 3 行') && document.querySelector('.preview-frame')?.srcdoc.includes('Bob')`, '返回后的范围')
  results.scopeNowPointsAtWrongPerson = await evalUi(`document.querySelector('.preview-frame').srcdoc.includes('Carol') && !document.querySelector('.preview-frame').srcdoc.includes('Bob')`)
  assert.equal(results.scopeNowPointsAtWrongPerson, false, '行数相同但记录顺序变化时仍选择原人员')

  await evalUi(`document.querySelectorAll('.nav-label')[0].click()`)
  dataset.deleteRow('ds_audit_a', 0)
  dataset.addRow('ds_audit_a')
  await evalUi(`document.querySelectorAll('.nav-label')[4].click()`)
  await wait(`document.querySelector('.range-bar .photo-preflight-error')?.textContent.includes('重新选择')`, '所选人员删除后的范围提醒')
  results.removedPersonBlocksOutput = await evalUi(`document.querySelector('.toolbar-actions .btn-primary').disabled`)
  assert.equal(results.removedPersonBlocksOutput, true, '所选人员删除后阻止出片直至确认范围')
  await evalUi(`[...document.querySelectorAll('button')].find(el=>el.textContent==='选择打印行').click()`)
  await wait(`!!document.querySelector('.scope-list')`, '重新确认范围')
  await evalUi(`document.querySelector('.modal-actions .btn-primary').click()`)
  await wait(`!document.querySelector('.range-bar .photo-preflight-error')`, '新范围已确认')

  await wait(`document.querySelector('.preview-frame')?.srcdoc.includes('Carol') && !!document.querySelector('.preview-frame')?.contentDocument?.querySelector('img[data-photo-layer-id][title]')`, '照片预览')
  await new Promise(resolve => setTimeout(resolve, 300))
  await evalUi(`document.querySelector('.preview-frame').contentDocument.querySelector('img[data-photo-layer-id]').click()`)
  await wait(`!!document.querySelector('[data-testid="print-photo-edit"]')`, '照片调整')
  const overrides = require('../electron/photo-overrides.cjs')
  const activeTemplate = templates.listTemplates().find(item => item.name === 'Audit template')
  const photoKey = { datasetId: 'ds_audit_a', templateId: activeTemplate.id, rowId: dataset.getDataset('ds_audit_a').recordIds[0], layerId: 'portrait' }
  const originalPhotoPosition = overrides.inspect(photoKey).position.x
  await evalUi(`document.querySelector('.preview-frame').contentDocument.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`)
  await wait(`document.querySelector('[data-testid="print-photo-edit"]')?.textContent.includes('未保存')`, '未保存调整')
  assert.equal(overrides.inspect(photoKey).position.x, originalPhotoPosition, '照片调整不会自动保存')
  results.rebindDisabledWhileDirty = await evalUi(`[...document.querySelectorAll('button')].find(el=>el.textContent==='更换数据集').disabled`)
  assert.equal(results.rebindDisabledWhileDirty, true, '未保存的照片调整阻止换绑')
  await wait(`[...document.querySelectorAll('[data-testid="print-photo-edit"] button')].some(el=>el.textContent==='保存调整' && !el.disabled)`, '照片保存按钮')
  await evalUi(`[...document.querySelectorAll('[data-testid="print-photo-edit"] button')].find(el=>el.textContent==='保存调整').click()`)
  await wait(`document.querySelector('[data-testid="print-photo-edit"]')?.textContent.includes('已保存')`, '照片手动保存')
  assert.notEqual(overrides.inspect(photoKey).position.x, originalPhotoPosition, '点击保存后调整才持久化')
  results.photoSavedOnlyOnClick = true
  console.log(JSON.stringify({ tmp, results }, null, 2))
  clearTimeout(watchdog); ui.destroy(); app.exit(0)
}
main().catch(error => { console.error(error.stack); clearTimeout(watchdog); if (ui && !ui.isDestroyed()) ui.destroy(); app.exit(1) })

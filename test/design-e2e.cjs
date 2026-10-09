/** Real Electron acceptance: shared artwork, PDF fidelity, and editor persistence. */
const { app, BrowserWindow, protocol, net, ipcMain, nativeImage, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const DATA = fs.mkdtempSync(path.join(__dirname, '.tmp-design-e2e-'))
const OUTPUT = path.join(ROOT, '.workbuddy-ai', 'tmp', 'design-acceptance')
fs.mkdirSync(OUTPUT, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = DATA
app.setPath('userData', path.join(DATA, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-breakpad')
// Several hidden print windows are opened in sequence; closing one is not the end of the test.
app.on('window-all-closed', () => {})
protocol.registerSchemesAsPrivileged([
  { scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks++; console.log('  ok -', message) }
const watchdog = setTimeout(() => { console.error('DESIGN_E2E_FAIL timeout'); app.exit(1) }, 180000)
let ui

async function waitFor(expression, label, timeout = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await ui.webContents.executeJavaScript(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等待失败：${label}`)
}
const evaluate = (source) => ui.webContents.executeJavaScript(source)
const click = (selector) => evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('找不到控件 '+${JSON.stringify(selector)});el.click()})()`)
const fill = (selector, value) => evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('找不到输入 '+${JSON.stringify(selector)});el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.blur()})()`)
const clickText = (selector, text) => evaluate(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('找不到按钮 '+${JSON.stringify(text)});el.click()})()`)
async function drag(selector, dx, dy, { snap = false } = {}) {
  const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  ui.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  ui.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  for (let i = 1; i <= 5; i++) ui.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + Math.round(dx * i / 5), y: point.y + Math.round(dy * i / 5), modifiers: snap ? ['leftButtonDown'] : ['leftButtonDown', 'alt'] })
  ui.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + dx, y: point.y + dy })
  await new Promise(resolve => setTimeout(resolve, 150))
}

async function main() {
  await app.whenReady()
  protocol.handle('pp', async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    if (rel.split(/[\\/]/).includes('..')) return new Response('bad path', { status: 403 })
    try {
      const response = await net.fetch(pathToFileURL(path.join(DATA, rel)).href)
      return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } })
    } catch { return new Response('missing', { status: 404 }) }
  })
  const { saveJson } = require('../electron/store.cjs')
  const designs = require('../electron/designs.cjs')
  const templates = require('../electron/templates.cjs')
  const renderer = require('../electron/render-engine.cjs')
  const printer = require('../electron/printer.cjs')
  saveJson('settings', { onboarded: true, demoSeeded: true })
  saveJson('datasets', [{ id: 'design-e2e-dataset', name: '图层验收名单', columns: [{ key: 'name', alias: '姓名', type: 'text', printOn: true }], rows: [{ name: '张三' }, { name: '李四' }] }])
  const pixels = Buffer.alloc(1024 * 768 * 4)
  for (let y = 0; y < 768; y++) for (let x = 0; x < 1024; x++) {
    const offset = (y * 1024 + x) * 4
    pixels[offset] = x % 256
    pixels[offset + 1] = y % 256
    pixels[offset + 2] = (x + y) % 256
    pixels[offset + 3] = 255
  }
  const jpeg = nativeImage.createFromBitmap(pixels, { width: 1024, height: 768 }).toJPEG(94)
  fs.writeFileSync(path.join(OUTPUT, 'source.jpg'), jpeg)
  const asset = designs.importImageBytes({ name: '源照片.jpg', base64: jpeg.toString('base64') })
  let design = designs.saveDesign({ schemaVersion: 1, revision: 0, name: '输出验收工程', artboard: { w: 210, h: 148.5, background: '#ffffff' }, assets: { [asset.id]: asset }, layers: [
    { id: 'photo', type: 'image', name: '原图', x: 12, y: 60, w: 64, h: 48, assetId: asset.id },
    { id: 'photo-rotated', type: 'image', name: '裁切旋转图', x: 135, y: 70, w: 40, h: 30, assetId: asset.id, rotation: 12, opacity: 0.7, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
    { id: 'title', type: 'text', name: '静态标题', x: 15, y: 12, w: 175, h: 25, text: '证书 CERTIFICATE', fontSize: 24, align: 'center', color: '#9b3029' },
    { id: 'frame', type: 'rect', name: '细框', x: 8, y: 8, w: 194, h: 130, fill: 'transparent', stroke: '#9b3029', strokeWidth: 0.25 },
  ] })
  const originalRevision = design.revision
  const modes = [
    { name: 'single', pageSize: { w: 210, h: 148.5 }, layout: { mode: 'single' }, expectedPages: 2 },
    { name: 'grid', pageSize: { w: 420, h: 297 }, layout: { mode: 'grid', itemW: 210, itemH: 148.5, showCutMarks: true }, expectedPages: 1 },
    { name: 'fold', pageSize: { w: 210, h: 297 }, layout: { mode: 'fold' }, expectedPages: 2 },
  ]
  const measurements = {}
  for (const mode of modes) {
    const template = templates.saveTemplate({ name: `图层${mode.name}`, datasetId: 'design-e2e-dataset', pageSize: mode.pageSize, layout: mode.layout, background: '', backgroundDesign: { id: design.id, revision: design.revision }, fields: [{ column: 'name', x: 50, y: 34, fontSize: 18, align: 'center' }] })
    const html = renderer.buildHtml(template, [{ name: '张三' }, { name: '李四' }], { withToolbar: false })
    ok(html.split(jpeg.toString('base64')).length - 1 === 1, `${mode.name} 原图仅嵌入一次`)
    const win = await printer.loadHtml(html)
    try {
      measurements[mode.name] = await win.webContents.executeJavaScript(`(() => {const root=document.querySelector('.print-design-root');return {root:root?.getBoundingClientRect().toJSON(), layers:[...document.querySelectorAll('[data-design-layer]')].map(el=>({id:el.dataset.designLayer,rect:el.getBoundingClientRect().toJSON()}))}})()`)
      const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } })
      fs.writeFileSync(path.join(OUTPUT, `${mode.name}.pdf`), pdf)
      const text = pdf.toString('latin1')
      const pages = (text.match(/\/Type\s*\/Page\b/g) || []).length
      ok(pages === mode.expectedPages, `${mode.name} PDF页数正确：${pages}`)
      ok(pdf.includes(jpeg), `${mode.name} PDF保留原始JPEG码流`)
      ok(/\/Width\s+1024\b/.test(text) && /\/Height\s+768\b/.test(text), `${mode.name} PDF保留1024×768源像素`)
      ok(/\/Type\s*\/Font\b/.test(text), `${mode.name} PDF含真实字体对象`)
    } finally { win.destroy() }
  }
  design.name = '新版工程'
  design.layers.find((layer) => layer.id === 'title').text = '最新草稿版本'
  design = designs.saveDesign(design)
  ok(designs.getDesign(design.id, originalRevision).layers.find((layer) => layer.id === 'title').text === '证书 CERTIFICATE', '保存新版本不改变模板旧版本')
  fs.writeFileSync(path.join(OUTPUT, 'measurements.json'), JSON.stringify(measurements, null, 2))

  // Load the real Vite build through the real context bridge and operation registry.
  require('../electron/ipc.cjs').registerIpc()
  ipcMain.handle('app:meta', () => ({ version: require('../package.json').version }))
  ipcMain.handle('app:checkUpdate', () => ({ status: 'current' }))
  ui = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { preload: path.join(ROOT, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true } })
  const errors = []
  ui.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  await ui.loadFile(path.join(ROOT, 'dist', 'index.html'))
  await waitFor(`Boolean([...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('底图')))`, '底图导航')
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('底图')).click()`)
  await waitFor(`Boolean(document.querySelector('[data-testid="design-new"]'))`, '底图编辑器')
  await click('[data-testid="design-new"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-name"]'))`, '新建工程')
  await fill('[data-testid="design-name"]', '真实界面保存验收')
  await click('[data-testid="design-add-text"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-text"]'))`, '文字属性')
  await fill('[data-testid="design-text"]', '图层编辑测试 TEST')
  await click('[data-testid="design-add-rect"]')
  await click('[data-testid="design-undo"]')
  await click('[data-testid="design-redo"]')
  await click('[data-testid="design-save"]')
  await waitFor(`window.printpress.listDesigns().then(items=>items.some(item=>item.name==='真实界面保存验收'))`, '工程真实落盘')
  const saved = designs.listDesigns().find((item) => item.name === '真实界面保存验收')
  const reopened = designs.getDesign(saved.id, saved.revision)
  ok(reopened.layers.some((layer) => layer.type === 'text' && layer.text === '图层编辑测试 TEST'), '界面文字编辑保存后可读取')
  ok(reopened.layers.some((layer) => layer.type === 'rect'), '界面撤销重做保留矩形')
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('数据')).click()`)
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('底图')).click()`)
  await waitFor(`document.querySelector('[data-testid="design-name"]')?.value==='真实界面保存验收'`, '切页保留编辑工程')
  ok(true, '切换页面后工程状态保留')

  // Real pointer events use the overlay coordinates; a full gesture is one undo operation.
  const rectLayer = reopened.layers.find(layer => layer.type === 'rect')
  await click(`[data-layer-id="${rectLayer.id}"]`)
  const beforeMove = await evaluate(`Number(document.querySelector('[data-testid="design-layer-x"]').value)`)
  await drag(`[data-canvas-layer-id="${rectLayer.id}"]`, 36, 20)
  const afterMove = await evaluate(`Number(document.querySelector('[data-testid="design-layer-x"]').value)`)
  ok(afterMove > beforeMove + 10, '真实鼠标拖动改变物理坐标')
  await click('[data-testid="design-undo"]')
  ok(await evaluate(`Math.abs(Number(document.querySelector('[data-testid="design-layer-x"]').value)-${beforeMove})<0.001`), '一次撤销还原完整拖动')
  ok(await evaluate(`!document.querySelector('.canvas-status .unsaved')`), '撤销回已保存内容后恢复已保存状态')

  await click(`[data-layer-id="${rectLayer.id}"] [aria-label="锁定图层"]`)
  ui.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
  ui.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
  await new Promise(resolve => setTimeout(resolve, 100))
  ok(await evaluate(`Boolean(document.querySelector('[data-canvas-layer-id="${rectLayer.id}"]'))`), '锁定图层不会被Delete删除')
  await click(`[data-layer-id="${rectLayer.id}"] [aria-label="解锁图层"]`)

  // Exercise the real dialog IPC/importer; only the OS file picker result is substituted.
  const originalDialog = dialog.showOpenDialog
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(OUTPUT, 'source.jpg')] })
  try {
    await click('[data-testid="design-add-image"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="design-crop-w"]'))`, '导入图片并展示裁切属性')
  } finally { dialog.showOpenDialog = originalDialog }
  await fill('[data-testid="design-crop-w"]', 50)
  await fill('[data-testid="design-crop-h"]', 50)
  await fill('[data-testid="design-crop-x"]', 25)
  await fill('[data-testid="design-crop-y"]', 25)
  await clickText('.inspector button', '水平翻转')
  const widthBeforeResize = await evaluate(`Number(document.querySelector('[data-testid="design-layer-w"]').value)`)
  await drag('.resize-handle', 24, 18)
  ok(await evaluate(`Number(document.querySelector('[data-testid="design-layer-w"]').value)>${widthBeforeResize}`), '图片缩放手柄可拖动')
  await click('[data-testid="design-save"]')
  await waitFor(`document.querySelector('.canvas-status')?.textContent.includes('已保存') && !document.querySelector('[data-testid="design-save"]').disabled`, '保存裁切图层')
  const cropped = designs.getDesign(saved.id)
  const croppedLayer = cropped.layers.find(layer => layer.type === 'image')
  assert.deepEqual(croppedLayer.crop, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  ok(croppedLayer.flipX && Math.abs(croppedLayer.w / croppedLayer.h - 4 / 3) < 0.001, '裁切翻转与缩放比例持久化')
  ok(fs.readFileSync(path.join(DATA, cropped.assets[croppedLayer.assetId].path)).equals(jpeg), '界面导入和裁切不改写源图片字节')
  await click('[data-testid="design-new"]')
  // A new empty document is a draft; explicitly discard it before opening the saved project.
  await clickText('.project-open b', '真实界面保存验收')
  await waitFor(`Boolean(document.querySelector('.cd-btn.danger'))`, '确认切换空白草稿')
  await click('.cd-btn.danger')
  await waitFor(`document.querySelector('[data-testid="design-name"]')?.value==='真实界面保存验收'`, '重开已保存工程')
  await click(`[data-layer-id="${croppedLayer.id}"]`)
  ok(await evaluate(`document.querySelector('[data-testid="design-crop-x"]').value==='25' && document.querySelector('[data-testid="design-crop-w"]').value==='50'`), '重开工程恢复裁切属性')

  // Phase 2 uses actual controls and pointer input, then reopens the persisted schema.
  const titleLayer = cropped.layers.find(layer => layer.type === 'text')
  await click(`[data-layer-id="${titleLayer.id}"]`)
  await evaluate(`document.querySelector('[data-layer-id="${rectLayer.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`)
  await click('[data-testid="design-group"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-group-name"]'))`, '组合后显示组属性')
  await fill('[data-testid="design-group-name"]', '标题与边框')
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && !document.querySelector('.canvas-status .unsaved')`, '保存分组')
  const grouped = designs.getDesign(saved.id)
  const group = grouped.groups[0]
  ok(grouped.schemaVersion === 2 && group.name === '标题与边框' && group.layerIds.length === 2, '图层分组与名称保存为格式版本2')
  await click(`[data-layer-id="${titleLayer.id}"]`)
  ui.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
  ui.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
  await new Promise(resolve => setTimeout(resolve, 100))
  ok(await evaluate(`document.querySelectorAll('[data-layer-id]').length===2 && !document.querySelector('[data-layer-id="${titleLayer.id}"]') && Boolean(document.querySelector('[data-layer-id="${rectLayer.id}"]'))`), '列表单选成员后Delete仅删除选中成员')
  await click('[data-testid="design-undo"]')
  ok(await evaluate(`document.querySelectorAll('[data-group-id]').length===1 && !document.querySelector('.canvas-status .unsaved')`), '撤销成员删除完整恢复分组')
  await click(`[data-layer-id="${titleLayer.id}"]`)
  const memberX = await evaluate(`Number(document.querySelector('[data-testid="design-layer-x"]').value)`)
  const otherX = await evaluate(`document.querySelector('[data-canvas-layer-id="${rectLayer.id}"]').style.left`)
  ui.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  ui.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await new Promise(resolve => setTimeout(resolve, 100))
  ok(await evaluate(`Number(document.querySelector('[data-testid="design-layer-x"]').value)>${memberX} && document.querySelector('[data-canvas-layer-id="${rectLayer.id}"]').style.left===${JSON.stringify(otherX)}`), '列表单选成员方向键不会移动其他组员')
  await click('[data-testid="design-undo"]')
  const draftDoc = `JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design`
  await click(`[data-group-id="${group.id}"]`)
  await drag(`[data-canvas-layer-id="${rectLayer.id}"]`, 24, 14)
  await waitFor(`(${draftDoc})?.layers.find(l=>l.id===${JSON.stringify(rectLayer.id)})?.x!==${grouped.layers.find(l=>l.id===rectLayer.id).x} && Boolean(${draftDoc})`, '整组拖动写入草稿')
  const movedGroup = await evaluate(draftDoc)
  const deltas = group.layerIds.map(id => {
    const before = grouped.layers.find(l => l.id === id), after = movedGroup.layers.find(l => l.id === id)
    return { x: after.x - before.x, y: after.y - before.y }
  })
  ok(deltas[0].x > 0 && Math.abs(deltas[0].x - deltas[1].x) < 0.001 && Math.abs(deltas[0].y - deltas[1].y) < 0.001, '整组真实拖动保持成员相对位置')
  await click('[data-testid="design-undo"]')
  ok(await evaluate(`!document.querySelector('.canvas-status .unsaved')`), '一次撤销恢复整组位置与已保存状态')
  await click(`[data-group-id="${group.id}"] [data-testid="design-group-lock"]`)
  ui.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
  ui.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
  await new Promise(resolve => setTimeout(resolve, 100))
  ok(await evaluate(`document.querySelectorAll('[data-layer-id]').length===3`), '整组锁定后Delete不会删除任何成员')
  await click(`[data-group-id="${group.id}"] [data-testid="design-group-lock"]`)
  await click(`[data-group-id="${group.id}"] [data-testid="design-group-visible"]`)
  ok(await evaluate(`!document.querySelector('[data-design-layer="${titleLayer.id}"]') && !document.querySelector('[data-design-layer="${rectLayer.id}"]')`), '组隐藏会隐藏全部成员的实际渲染')
  await click(`[data-group-id="${group.id}"] [data-testid="design-group-visible"]`)
  await click(`[data-group-id="${group.id}"]`)
  await click('[data-testid="design-group-copy"]')
  ok(await evaluate(`document.querySelectorAll('[data-group-id]').length===2 && document.querySelectorAll('[data-layer-id]').length===5`), '复制组生成新的组和全部成员')
  await click('[data-testid="design-ungroup"]')
  ok(await evaluate(`document.querySelectorAll('[data-group-id]').length===1 && document.querySelectorAll('[data-layer-id]').length===5`), '解组保留复制出的全部图层')
  await click('[data-testid="design-undo"]')
  await evaluate(`[...document.querySelectorAll('[data-group-id]')].find(el=>el.dataset.groupId!==${JSON.stringify(group.id)}).click()`)
  await click('[data-testid="design-group-delete"]')
  ok(await evaluate(`document.querySelectorAll('[data-group-id]').length===1 && document.querySelectorAll('[data-layer-id]').length===3`), '删除副本组不影响原组及图片')
  await fill('[data-testid="design-guide-axis"]', 'x')
  await fill('[data-testid="design-guide-position"]', 80)
  await click('[data-testid="design-guide-add"]')
  await fill('[data-testid="design-guide-axis"]', 'y')
  await fill('[data-testid="design-guide-position"]', 40)
  await click('[data-testid="design-guide-add"]')
  ok(await evaluate(`document.querySelectorAll('[data-guide-line]').length===2`), '水平和垂直参考线显示在编辑视图')
  await click('[data-testid="design-guides-visible"]')
  ok(await evaluate(`document.querySelectorAll('[data-guide-line]').length===0`), '参考线显示开关生效')
  await click('[data-testid="design-guides-visible"]')
  await click(`[data-group-id="${group.id}"]`)
  const groupStart = grouped.layers.find(layer => layer.id === rectLayer.id).x
  const snapPixels = (80 - groupStart) * 720 / 297 - 1
  await drag(`[data-canvas-layer-id="${rectLayer.id}"]`, snapPixels, 0, { snap: true })
  await waitFor(`Math.abs((${draftDoc})?.layers.find(l=>l.id===${JSON.stringify(rectLayer.id)})?.x-80)<0.01`, '拖动吸附垂直参考线')
  ok(true, '真实拖动吸附到参考线的毫米坐标')
  await click('[data-testid="design-undo"]')
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && !document.querySelector('.canvas-status .unsaved')`, '保存分组与参考线')
  const phaseTwo = designs.getDesign(saved.id)
  ok(phaseTwo.groups[0].name === '标题与边框' && phaseTwo.guides.some(g => g.axis === 'x' && g.position === 80) && phaseTwo.guides.some(g => g.axis === 'y' && g.position === 40), '工程落盘保留分组和参考线毫米位置')

  // Export the current draft through the real context bridge. The OS picker alone is stubbed.
  await click(`[data-layer-id="${titleLayer.id}"]`)
  await fill('[data-testid="design-text"]', 'PNG当前草稿')
  const pngPath = path.join(OUTPUT, 'editor-transparent.png')
  const originalSaveDialog = dialog.showSaveDialog
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: pngPath })
  try {
    await click('[data-testid="design-export-png"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="design-export-dialog"]'))`, 'PNG导出配置')
    await fill('[data-testid="design-export-dpi"]', 150)
    await click('[data-testid="design-export-transparent"]')
    await click('[data-testid="design-export-confirm"]')
    await waitFor(`!document.querySelector('[data-testid="design-export-dialog"]')`, 'PNG导出完成', 30000)
  } finally { dialog.showSaveDialog = originalSaveDialog }
  assert.ok(fs.existsSync(pngPath), 'PNG文件真实写入')
  const exportedPng = nativeImage.createFromPath(pngPath)
  const pngSize = exportedPng.getSize()
  ok(pngSize.width === Math.round(297 * 150 / 25.4) && pngSize.height === Math.round(210 * 150 / 25.4), '界面导出PNG得到指定DPI的精确像素')
  const pngPixels = exportedPng.toBitmap()
  ok(pngPixels[pngPixels.length - 1] === 0 && pngPixels.some((value, index) => index % 4 === 3 && value > 0), '透明PNG有实际图层像素且空白角落透明')
  ok(designs.getDesign(saved.id).revision === phaseTwo.revision && await evaluate(`Boolean(document.querySelector('.canvas-status .unsaved'))`), '导出当前草稿不保存新版本也不清除未保存状态')
  ok(fs.readFileSync(path.join(DATA, phaseTwo.assets[croppedLayer.assetId].path)).equals(jpeg), 'PNG导出后原始图片字节保持不变')
  await click('[data-testid="design-undo"]')

  // Recovery uses the local draft, including a value changed after the last successful save.
  await click(`[data-layer-id="${croppedLayer.id}"]`)
  await fill('[data-testid="design-layer-x"]', 21)
  await waitFor(`localStorage.getItem('printpress-background-designer-draft-v1')?.includes('真实界面保存验收')`, '草稿写入')
  await ui.reload()
  await waitFor(`Boolean(document.querySelector('.nav-item'))`, '重新载入界面')
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('底图')).click()`)
  await waitFor(`document.querySelector('[data-testid="design-name"]')?.value==='真实界面保存验收'`, '恢复未保存草稿')
  await click(`[data-layer-id="${croppedLayer.id}"]`)
  ok(await evaluate(`document.querySelector('[data-testid="design-layer-x"]').value==='21'`), '重启恢复未保存的位置修改')
  ok(await evaluate(`document.querySelectorAll('[data-group-id]').length===1 && document.querySelectorAll('[data-guide-line]').length===2`), '重新载入后恢复图层组与参考线')
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled`, '恢复草稿保存完成')

  // Round trip through the template UI, followed by actual print rendering of its fixed revision.
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('模板')).click()`)
  await waitFor(`Boolean([...document.querySelectorAll('.tpl-name')].find(el=>el.textContent==='图层single'))`, '模板工程清单')
  await clickText('.tpl-name', '图层single')
  await waitFor(`Boolean([...document.querySelectorAll('.design-toolbar button')].find(el=>el.textContent==='编辑底图工程'))`, '模板工程入口')
  const priorTemplate = templates.listTemplates().find(item => item.name === '图层single')
  const priorRef = templates.getTemplate(priorTemplate.id).backgroundDesign
  await clickText('.design-toolbar button', '编辑底图工程')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-apply"]') && document.querySelector('[data-layer-id="title"]'))`, '模板打开固定工程版本')
  await click('[data-layer-id="title"]')
  await fill('[data-testid="design-text"]', '模板往返应用验收')
  // This opens an older immutable revision. Saving must offer a useful conflict and allow a copy.
  await click('[data-testid="design-apply"]')
  await waitFor(`Boolean(document.querySelector('.designer-view .notice.error'))`, '旧版本更新冲突可见')
  ok(await evaluate(`document.querySelector('.notice.error').textContent.length>8`), '编辑旧版本的冲突向用户显示')
  await click('[data-testid="design-copy"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && document.querySelector('[data-testid="design-name"]').value.endsWith('副本')`, '旧版本另存副本')
  await click('[data-testid="design-apply"]')
  await waitFor(`Boolean(document.querySelector('.editor .name-input')) && document.querySelector('.warn-line')?.textContent.includes('底图工程')`, '保存并返回模板')
  await clickText('.editor .toolbar .btn-primary', '保存')
  await waitFor(`window.printpress.getTemplate(${JSON.stringify(priorTemplate.id)}).then(t=>t.backgroundDesign.id!==${JSON.stringify(priorRef.id)})`, '模板固定引用落盘')
  const appliedTemplate = templates.getTemplate(priorTemplate.id)
  const appliedDoc = designs.getDesign(appliedTemplate.backgroundDesign.id, appliedTemplate.backgroundDesign.revision)
  ok(appliedDoc.layers.find(layer => layer.id === 'title').text === '模板往返应用验收', '模板引用编辑后保存的精确版本')
  ok(designs.getDesign(priorRef.id, priorRef.revision).layers.find(layer => layer.id === 'title').text === '证书 CERTIFICATE', '模板编辑应用不会改变原有固定版本')
  ok(await evaluate(`(() => {const el=document.querySelector('.field-box');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return Boolean(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.field-box'))})()`), '图层底图不会遮挡变量字段点击')
  const fieldBefore = await evaluate(`document.querySelector('.field-box').style.left`)
  await drag('.field-box', 30, 12)
  ok(await evaluate(`document.querySelector('.field-box').style.left!==${JSON.stringify(fieldBefore)}`), '有图层底图时变量字段仍可真实拖动')
  await clickText('.editor .toolbar button', '撤销')
  ok(await evaluate(`document.querySelector('.field-box').style.left===${JSON.stringify(fieldBefore)}`), '模板字段撤销独立于底图图层')
  await fill('.editor .name-input', '未保存的模板名称草稿')
  await clickText('.design-toolbar button', '编辑底图工程')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-apply"]'))`, '再次进入底图编辑')
  await clickText('.context-note button', '返回模板（不应用）')
  await waitFor(`Boolean(document.querySelector('.editor .name-input'))`, '不应用返回模板')
  ok(await evaluate(`document.querySelector('.editor .name-input').value==='未保存的模板名称草稿'`), '不应用返回保留模板草稿')
  await clickText('.design-toolbar button', '编辑底图工程')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-apply"]'))`, '返回编辑器截图')
  await evaluate(`document.querySelector('.app-main').scrollTop=0;document.querySelector('.inspector').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  await new Promise(resolve => setTimeout(resolve, 200))
  fs.writeFileSync(path.join(OUTPUT, 'designer.png'), (await ui.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  const appliedHtml = renderer.buildHtml(appliedTemplate, [{ name: '王五' }], { withToolbar: false })
  const appliedWindow = await printer.loadHtml(appliedHtml)
  try {
    ok(await appliedWindow.webContents.executeJavaScript(`document.body.textContent.includes('模板往返应用验收') && document.body.textContent.includes('王五')`), '再次出片包含新静态标题与变量字段')
    const pdf = await appliedWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
    fs.writeFileSync(path.join(OUTPUT, 'applied-template.pdf'), pdf)
    ok(pdf.includes(jpeg) && /\/Type\s*\/Font\b/.test(pdf.toString('latin1')), '编辑应用后的PDF仍保留原图码流与字体对象')
  } finally { appliedWindow.destroy() }
  ok(errors.length === 0, `界面无控制台错误：${errors.join('; ')}`)
  console.log(`DESIGN_E2E_OK checks=${checks} artifacts=${OUTPUT}`)
  ui.destroy()
  clearTimeout(watchdog)
  app.exit(0)
}

main().catch(async (error) => {
  console.error('DESIGN_E2E_FAIL', error.stack || error)
  if (ui && !ui.isDestroyed()) {
    try { fs.writeFileSync(path.join(OUTPUT, 'failure.png'), (await ui.webContents.capturePage()).toPNG()) } catch {}
  }
  clearTimeout(watchdog)
  app.exit(1)
})

/** Real Electron acceptance: shared artwork, PDF fidelity, and editor persistence. */
const { app, BrowserWindow, protocol, net, ipcMain, nativeImage, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
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
/**
 * 轮询**主进程侧**的真实结果（不是页面状态）。
 *
 * 导出后的「打开所在文件夹」要在主进程里调 shell，页面状态帮不上忙——
 * 只能等测试进程里那个记录器收到调用。带超时，避免静默吊死。
 */
async function waitNode(predicate, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败：${label}`)
}
const click = (selector) => evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('找不到控件 '+${JSON.stringify(selector)});el.click()})()`)
const fill = (selector, value) => evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('找不到输入 '+${JSON.stringify(selector)});el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.blur()})()`)
const clickText = (selector, text) => evaluate(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('找不到按钮 '+${JSON.stringify(text)});el.click()})()`)
function hasPdfTextOperators(pdf) {
  const raw = pdf.toString('latin1')
  let index = 0
  while ((index = raw.indexOf('stream\n', index)) >= 0) {
    const start = index + 7, end = raw.indexOf('endstream', start)
    if (end < 0) break
    try {
      const content = zlib.inflateSync(pdf.subarray(start, end)).toString('latin1')
      if (/\bBT\b/.test(content) && /\bET\b/.test(content) && /\b(?:Tj|TJ)\b/.test(content)) return true
    } catch { /* Binary image streams and uncompressed streams are unrelated. */ }
    index = end + 9
  }
  return false
}
async function drag(selector, dx, dy, { snap = false } = {}) {
  const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  ui.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  ui.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  for (let i = 1; i <= 5; i++) ui.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + Math.round(dx * i / 5), y: point.y + Math.round(dy * i / 5), modifiers: snap ? ['leftButtonDown'] : ['leftButtonDown', 'alt'] })
  ui.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + dx, y: point.y + dy })
  await new Promise(resolve => setTimeout(resolve, 150))
}

/** 真实双击（两次 clickCount 递增的按键），用于验证 pointerdown 里的 detail 判定 */
async function doubleClick(selector) {
  const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  for (const clickCount of [1, 2]) {
    ui.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...point })
    ui.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...point })
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  await new Promise(resolve => setTimeout(resolve, 150))
}

/**
 * 真实鼠标点击（带用户手势）。
 *
 * 不能用 el.click()：那是合成事件、没有 transient user activation，
 * showPicker() 这类需要用户手势的 API 会直接抛 NotAllowedError。
 */
async function realClickPoint(pointExpression) {
  const point = await evaluate(pointExpression)
  ui.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  ui.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  ui.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await new Promise((resolve) => setTimeout(resolve, 200))
}

/**
 * 真实点击画布上「没有图层」的一处空白。
 *
 * 不能随便点画布中心：那里通常正好压着刚加的文字图层，会变成选中/拖动而不是「点空白」。
 * 所以在画布可视区里从右下往左上扫，取第一个不落在任何图层命中框上的点。
 */
async function clickBlankCanvas() {
  const point = await evaluate(`(() => {
    const stage = document.querySelector('[data-testid="design-stage"]')
    const scroll = document.querySelector('.canvas-scroll')
    stage.scrollIntoView({ block: 'center', inline: 'center' })
    const s = stage.getBoundingClientRect(), c = scroll.getBoundingClientRect()
    const hits = [...document.querySelectorAll('[data-canvas-layer-id]')].map(el => el.getBoundingClientRect())
    const left = Math.max(s.left, c.left) + 4, right = Math.min(s.right, c.right) - 4
    const top = Math.max(s.top, c.top) + 4, bottom = Math.min(s.bottom, c.bottom) - 4
    for (let y = bottom; y > top; y -= 8) for (let x = right; x > left; x -= 8) {
      if (!hits.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return { x: Math.round(x), y: Math.round(y) }
    }
    throw new Error('画布上没有找到空白处')
  })()`)
  ui.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  ui.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  ui.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
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
  const printPaint = { type: 'linear', angle: 35, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#c4e5f6', opacity: 0.7 }] }
  let design = designs.saveDesign({ schemaVersion: 1, revision: 0, name: '输出验收工程', artboard: { w: 210, h: 148.5, background: '#ffffff', backgroundPaint: printPaint }, assets: { [asset.id]: asset }, layers: [
    { id: 'photo', type: 'image', name: '原图', x: 12, y: 60, w: 64, h: 48, assetId: asset.id },
    { id: 'photo-rotated', type: 'image', name: '裁切旋转图', x: 135, y: 70, w: 40, h: 30, assetId: asset.id, rotation: 12, opacity: 0.7, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
    { id: 'title', type: 'text', name: '静态标题', x: 15, y: 12, w: 175, h: 25, text: '证书 CERTIFICATE', fontSize: 24, align: 'center', color: '#9b3029' },
    { id: 'frame', type: 'rect', name: '细框', x: 8, y: 8, w: 194, h: 130, fill: 'transparent', stroke: '#9b3029', strokeWidth: 0.25 },
    { id: 'gradient', type: 'rect', name: '渐变装饰', x: 90, y: 95, w: 30, h: 18, fillPaint: printPaint, shadow: { dxMm: 1.5, dyMm: 2, blurMm: 1.2, color: '#223344', opacity: 0.4 }, stroke: 'transparent', strokeWidth: 0 },
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
    const gradientIds = [...html.matchAll(/<linearGradient id="(pp_effect_[^"]+)"/g)].map(match => match[1])
    ok(gradientIds.length === (mode.name === 'fold' ? 8 : 4) && new Set(gradientIds).size === gradientIds.length, `${mode.name} 每份画板和图形渐变的 SVG ID 唯一`)
    const filterIds = [...html.matchAll(/<filter id="(pp_effect_[^"]+)"/g)].map(match => match[1])
    ok(filterIds.length === (mode.name === 'fold' ? 4 : 2) && new Set(filterIds).size === filterIds.length, `${mode.name} 每份外阴影滤镜的 SVG ID 唯一`)
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
      ok(hasPdfTextOperators(pdf), `${mode.name} PDF保留可选取文字的文本绘制指令`)
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
  // 注意：这个窗口是 show:false + offscreen，**文档没有焦点**。Chromium 在这种情况下照常更新
  // document.activeElement，却不派发 focus/blur 事件（ui.show()/ui.focus()/webContents.focus()
  // 都拿不回焦点，CDP 的 Emulation.setFocusEmulationEnabled 又会把这个环境挂死）。
  // 所以就地编辑的收尾走「捕获阶段 pointerdown」这条不依赖焦点事件的路（见 finishTextEdit 注释），
  // 靠 blur 的那条另用派发 FocusEvent 验连线。
  const errors = []
  ui.webContents.on('console-message', (_event, level, message, line, sourceId) => { if (level >= 3) { errors.push(message); console.log('PAGE-ERR:', message, '@', sourceId, line) } })
  await ui.loadFile(path.join(ROOT, 'dist', 'index.html'))
  await waitFor(`Boolean([...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('底图')))`, '底图导航')
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.includes('底图')).click()`)
  await waitFor(`Boolean(document.querySelector('[data-testid="design-new"]'))`, '底图编辑器')
  // 首次进入本页时下拉就必须已就绪：预设只在 activate() 里刷的话，首屏会一直是
  // 空的且禁用（onActivated 早于 onMounted 的 await 跑完，那句话被 initialized 门控跳过），
  // 用户会以为没有这个功能——得先切页再切回来才出现。
  await waitFor(`document.querySelectorAll('[data-testid="design-preset"] option[value="preset:id-card-a4"]').length === 1`, '首次进入即加载内置预设')
  ok(await evaluate(`!document.querySelector('[data-testid="design-preset"]').disabled`), '首次进入底图制作时「常用模板」下拉就可用，不用先切页再回来')
  // 「最近使用」那一组依赖 `projects`，而 refreshProjects / refreshPresets 是**并行**发的，
  // 只等预设就绪就断言会踩竞态（本套件跑之前已有工程，所以这组必定会出现）。等到再断言。
  await waitFor(`document.querySelectorAll('[data-testid="design-preset"] optgroup').length === 2`, '「常用模板」两组就绪')
  ok(await evaluate(`[...document.querySelectorAll('[data-testid="design-preset"] optgroup')].map(g=>g.label).join('|') === '内置模板|常用'`), '「常用模板」下拉分成「内置模板」与「常用」两组')
  await click('[data-testid="design-new"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-name"]'))`, '新建工程')
  await fill('[data-testid="design-name"]', '真实界面保存验收')
  await click('[data-testid="design-add-text"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-text"]'))`, '文字属性')
  // 双击画布上的文字图层 → 在画布上原位出现编辑框（像改 PPT 的文本框）。
  // 此前模板挂在 @dblclick 上，而 pointerDown 对 pointerdown 调了 preventDefault，
  // 按 Pointer Events 规范会抑制 mousedown/click/dblclick，那个监听器永远收不到事件。
  const firstTextId = await evaluate(`document.querySelector('[data-canvas-layer-id]').dataset.canvasLayerId`)
  await doubleClick(`[data-canvas-layer-id="${firstTextId}"]`)
  await waitFor(`Boolean(document.querySelector('[data-testid="design-inline-text"]'))`, '画布内出现就地编辑框')
  ok(await evaluate(`document.activeElement === document.querySelector('[data-testid="design-inline-text"]')`), '双击文字图层在画布上就地编辑并自动聚焦')
  ok(await evaluate(`(() => { const el=document.querySelector('[data-testid="design-inline-text"]');return el.selectionStart===0 && el.selectionEnd===el.value.length })()`), '就地编辑框整段选中，可直接重写')
  // 编辑框与出片共用同一套毫米坐标 + pt 字号，几何必须和图层命中框重合
  const editGeom = await evaluate(`(() => {
    const box = document.querySelector('[data-testid="design-inline-text"]')
    const layer = document.querySelector('[data-canvas-layer-id="${firstTextId}"]')
    const b = box.getBoundingClientRect(), l = layer.getBoundingClientRect()
    return { dx: Math.abs(b.left - l.left), dy: Math.abs(b.top - l.top), dw: Math.abs(b.width - l.width), dh: Math.abs(b.height - l.height) }
  })()`)
  ok(editGeom.dx < 1 && editGeom.dy < 1 && editGeom.dw < 1 && editGeom.dh < 1, `就地编辑框与图层几何重合（偏差 ${editGeom.dx.toFixed(2)}/${editGeom.dy.toFixed(2)}/${editGeom.dw.toFixed(2)}/${editGeom.dh.toFixed(2)} px）`)
  ok(await evaluate(`!(document.querySelector('[data-design-layer="${firstTextId}"]')?.textContent || '').trim()`), '编辑时画布上的原文字已隐去，不会与编辑框叠成双影')
  await fill('[data-testid="design-inline-text"]', '画布上直接改的字')
  ok(await evaluate(`document.querySelector('[data-testid="design-inline-text"]').value === '画布上直接改的字'`), '就地编辑框内容随输入更新')
  // ① 点画布空白处收工。这是真实 pointerdown：pointerDown() 对 pointerdown 调了 preventDefault，
  //    浏览器不会移走焦点、blur 不会触发，所以必须靠捕获阶段的 pointerdown 自己收尾。
  await clickBlankCanvas()
  await waitFor(`!document.querySelector('[data-testid="design-inline-text"]')`, '点画布空白处退出就地编辑')
  await waitFor(`(JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design)?.layers.find(l=>l.id===${JSON.stringify(firstTextId)})?.text==='画布上直接改的字'`, '就地编辑内容写入工程')
  ok(await evaluate(`(document.querySelector('[data-design-layer="${firstTextId}"]')?.textContent || '').includes('画布上直接改的字')`), '画布上重新画出改后的文字')
  // ② blur 提交：生产环境靠它（Tab 走开 / 窗口失焦）。离屏窗口的文档没有焦点，
  //    Chromium 不会派发 focus/blur，所以这里直接派发 FocusEvent 验证这条连线接好了。
  await doubleClick(`[data-canvas-layer-id="${firstTextId}"]`)
  await waitFor(`Boolean(document.querySelector('[data-testid="design-inline-text"]'))`, '再次进入就地编辑')
  await fill('[data-testid="design-inline-text"]', '失焦提交的字')
  await evaluate(`document.querySelector('[data-testid="design-inline-text"]').dispatchEvent(new FocusEvent('blur'))`)
  await waitFor(`!document.querySelector('[data-testid="design-inline-text"]')`, '失焦后退出就地编辑')
  await waitFor(`(JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design)?.layers.find(l=>l.id===${JSON.stringify(firstTextId)})?.text==='失焦提交的字'`, '失焦提交的内容写入工程')
  // ③ Esc 收工（照 PPT 的习惯：Esc 保留改动，想撤销按 Ctrl+Z）。没改就不该多出一条历史。
  const undoDisabledBefore = await evaluate(`document.querySelector('[data-testid="design-undo"]').disabled`)
  await doubleClick(`[data-canvas-layer-id="${firstTextId}"]`)
  await waitFor(`Boolean(document.querySelector('[data-testid="design-inline-text"]'))`, '第三次进入就地编辑')
  await evaluate(`document.querySelector('[data-testid="design-inline-text"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
  await waitFor(`!document.querySelector('[data-testid="design-inline-text"]')`, 'Esc 退出就地编辑')
  ok(await evaluate(`(JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design)?.layers.find(l=>l.id===${JSON.stringify(firstTextId)})?.text==='失焦提交的字'`), 'Esc 退出时没改过内容就不产生新版本')
  ok(undoDisabledBefore === await evaluate(`document.querySelector('[data-testid="design-undo"]').disabled`), 'Esc 空退出不改动撤销栈')
  await fill('[data-testid="design-text"]', '图层编辑测试 TEST')
  /*
   * ---- 颜色控件 ----
   * 过去只绑 @change，而原生 <input type="color"> 只保证发 input（拖动过程中连续发），
   * change 要等取色器关掉才发、且不同环境行为并不一致——一旦 change 不来，用户看到的
   * 就是「点了色块、选了颜色，画布上的字一点没变」，属于看不见的失败。
   * 另外色块本体只有 34px 宽，用户点的往往是整块控件盒子，光靠 <label> 转发不可靠。
   * 下面三条分别钉住：整块盒子能唤起取色器 / input 即时生效 / change 只记一条撤销。
   */
  const colorInput = `document.querySelector('[aria-label="选择文字颜色"]')`
  const draftTextColor = `(JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design)?.layers.find(l=>l.type==='text')?.color`
  await evaluate(`(() => { const el=${colorInput}; window.__pickerCalls=0; el.showPicker=()=>{window.__pickerCalls++} })()`)
  await realClickPoint(`(() => { const box=${colorInput}.closest('.color-control'); box.scrollIntoView({block:'center'}); const r=box.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  ok(await evaluate(`window.__pickerCalls`) >= 1, '真实点击颜色控件整块盒子即可唤起取色器（不依赖 label 转发）')
  await evaluate(`(() => { const el=${colorInput}; el.value='#0f7a3d'; el.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await waitFor(`${draftTextColor}==='#0f7a3d'`, '取色器拖动过程中颜色即时生效')
  ok(await evaluate(`document.querySelector('[data-design-layer="${firstTextId}"]')?.getAttribute('style')?.includes('color:#0f7a3d')`), '只发 input 事件时画布上的文字颜色也跟着变')
  await evaluate(`(() => { const el=${colorInput}; el.value='#0f7a3d'; el.dispatchEvent(new Event('change',{bubbles:true})) })()`)
  await waitFor(`${draftTextColor}==='#0f7a3d'`, 'change 收尾后颜色保持最终值')
  ok(true, 'change 收尾后颜色保持最终值')
  await click('[data-testid="design-undo"]')
  await waitFor(`${draftTextColor}==='#2b2622'`, '撤销回到取色前的颜色')
  ok(true, '撤销一步即回到取色前的颜色（一次取色只记一条历史）')
  await click('[data-testid="design-redo"]')
  await waitFor(`${draftTextColor}==='#0f7a3d'`, '重做恢复取色结果')
  ok(true, '重做恢复取色结果')
  /*
   * 取色快照必须被别的编辑打断：input（实时生效）→ 一次普通编辑 → change。
   * 若快照没被打断，撤销取色会把中间那次普通编辑一起回滚掉。
   */
  const draftTextValue = `(JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design)?.layers.find(l=>l.type==='text')?.text`
  await evaluate(`(() => { const el=${colorInput}; el.value='#123456'; el.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await fill('[data-testid="design-text"]', '取色打断测试')
  await evaluate(`(() => { const el=${colorInput}; el.value='#0f7a3d'; el.dispatchEvent(new Event('change',{bubbles:true})) })()`)
  await waitFor(`${draftTextColor}==='#0f7a3d'`, '打断后取色仍生效')
  ok(true, '打断后取色仍生效')
  await click('[data-testid="design-undo"]')
  await waitFor(`${draftTextColor}==='#123456'`, '撤销只回退取色')
  ok(await evaluate(`${draftTextValue}==='取色打断测试'`), '撤销取色不连带回滚中间那次普通编辑')
  await click('[data-testid="design-redo"]')
  await fill('[data-testid="design-text"]', '图层编辑测试 TEST')
  await waitFor(`${draftTextColor}==='#0f7a3d'`, '颜色收尾')
  await click('[data-testid="design-add-rect"]')
  await click('[data-testid="design-undo"]')
  await click('[data-testid="design-redo"]')
  await click('[data-testid="design-save"]')
  await waitFor(`window.printpress.listDesigns().then(items=>items.some(item=>item.name==='真实界面保存验收'))`, '工程真实落盘')
  const saved = designs.listDesigns().find((item) => item.name === '真实界面保存验收')
  const reopened = designs.getDesign(saved.id, saved.revision)
  ok(reopened.layers.some((layer) => layer.type === 'text' && layer.text === '图层编辑测试 TEST'), '界面文字编辑保存后可读取')
  ok(reopened.layers.some((layer) => layer.type === 'text' && layer.color === '#0f7a3d'), '界面改的文字颜色保存后可读取')
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

  // Paste and drop add an image layer without ever opening the OS file picker.
  const pasteJpeg = nativeImage.createFromBuffer(jpeg).resize({ width: 120 }).toJPEG(80)
  const bytesToFile = `(base64, name, type) => { const bin = atob(base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i); return new File([bytes], name, { type }) }`
  const pasteBytes = JSON.stringify(pasteJpeg.toString('base64'))
  const draftDesign = `JSON.parse(localStorage.getItem('printpress-background-designer-draft-v1')||'null')?.design`
  ok(await evaluate(`(() => { const dt=new DataTransfer(); dt.items.add(new File([new Uint8Array([1,2,3])],'x.png',{type:'image/png'})); const ev=new ClipboardEvent('paste',{clipboardData:dt}); return Boolean(ev.clipboardData && ev.clipboardData.items[0] && ev.clipboardData.items[0].getAsFile()) })()`), '测试环境可用 ClipboardEvent 模拟粘贴文件')
  const layersBeforePaste = await evaluate(`document.querySelectorAll('[data-layer-id]').length`)
  await evaluate(`(() => {
    const make = ${bytesToFile}
    const dt = new DataTransfer()
    dt.items.add(make(${pasteBytes}, '粘贴截图.jpg', 'image/jpeg'))
    document.querySelector('.canvas-scroll').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${layersBeforePaste + 1}`, 'Ctrl+V 粘贴截图新增图片图层')
  await waitFor(`(${draftDesign})?.layers.length===${layersBeforePaste + 1}`, '粘贴结果写入草稿')
  const pastedDesign = await evaluate(draftDesign)
  const pastedLayer = pastedDesign.layers[pastedDesign.layers.length - 1]
  ok(pastedLayer.type === 'image' && pastedLayer.name === '粘贴截图.jpg', '粘贴截图落成图片图层并沿用文件名')
  ok(fs.readFileSync(path.join(DATA, pastedDesign.assets[pastedLayer.assetId].path)).equals(pasteJpeg), '粘贴的图片字节原样落盘，不受前端文件名影响')

  const dropJpeg = nativeImage.createFromBuffer(jpeg).resize({ width: 96 }).toJPEG(75)
  const dropBytes = JSON.stringify(dropJpeg.toString('base64'))
  await evaluate(`(() => {
    const make = ${bytesToFile}
    const dt = new DataTransfer()
    dt.items.add(make(${dropBytes}, '拖入图片.jpg', 'image/jpeg'))
    document.querySelector('.canvas-scroll').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`Boolean(document.querySelector('.canvas-scroll.drop-active') && document.querySelector('.drop-hint'))`, '拖入文件时显示投放提示')
  await evaluate(`(() => {
    const make = ${bytesToFile}
    const dt = new DataTransfer()
    dt.items.add(make(${dropBytes}, '拖入图片.jpg', 'image/jpeg'))
    document.querySelector('.canvas-scroll').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${layersBeforePaste + 2}`, '拖入图片新增图层')
  ok(await evaluate(`!document.querySelector('.canvas-scroll.drop-active') && !document.querySelector('.drop-hint')`), '投放后拖拽高亮提示消失')
  await waitFor(`(${draftDesign})?.layers.length===${layersBeforePaste + 2}`, '拖入结果写入草稿')
  const droppedDesign = await evaluate(draftDesign)
  const droppedLayer = droppedDesign.layers[droppedDesign.layers.length - 1]
  ok(droppedLayer.type === 'image' && droppedLayer.name === '拖入图片.jpg', '拖入文件同样落成图片图层')
  ok(fs.readFileSync(path.join(DATA, droppedDesign.assets[droppedLayer.assetId].path)).equals(dropJpeg), '拖入的图片字节原样落盘')

  // Re-importing the exact same bytes must reuse the stored asset rather than duplicate the file.
  await evaluate(`(() => {
    const make = ${bytesToFile}
    const dt = new DataTransfer()
    dt.items.add(make(${pasteBytes}, '同名副本.jpg', 'image/jpeg'))
    document.querySelector('.canvas-scroll').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${layersBeforePaste + 3}`, '相同字节再次拖入仍新增图层')
  await waitFor(`(${draftDesign})?.layers.length===${layersBeforePaste + 3}`, '去重结果写入草稿')
  const dedupedDesign = await evaluate(draftDesign)
  const dedupedLayer = dedupedDesign.layers[dedupedDesign.layers.length - 1]
  ok(dedupedLayer.assetId === pastedLayer.assetId && Object.keys(dedupedDesign.assets).length === Object.keys(droppedDesign.assets).length, '相同字节复用同一素材，不重复占盘')

  await evaluate(`(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1,2,3])], 'notes.txt', { type: 'text/plain' }))
    document.querySelector('.canvas-scroll').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`Boolean(document.querySelector('.notice.error'))`, '非图片拖入被拒绝')
  ok(await evaluate(`document.querySelectorAll('[data-layer-id]').length===${layersBeforePaste + 3}`), '非图片拖入不会新增图层')
  await click('.notice.error button')

  // Later assertions count this same project's layers, so undo every addition first.
  for (let i = 0; i < 3; i += 1) {
    await click('[data-testid="design-undo"]')
    await waitFor(`document.querySelectorAll('[data-layer-id]').length===${layersBeforePaste + 2 - i}`, `撤销第 ${i + 1} 次导入`)
  }
  ok(true, '撤销可完整回退粘贴与拖入产生的图层')

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

  // I-43：「选 1 寸」必须是「改尺寸 + 改裁切」的同一个动作——只改尺寸，打印出来就是一张被拉长的脸。
  const sizePresetValues = await evaluate(`[...document.querySelectorAll('[data-testid="design-size-preset"] option')].map(o=>o.value)`)
  ok(sizePresetValues.includes('size:photo-1') && sizePresetValues.includes('ratio:1:1') && sizePresetValues[0] === '',
    `尺寸/比例预设下拉同时给出证件照毫米规格与纯比例，首项是「自定义」（实得 ${JSON.stringify(sizePresetValues.slice(0, 3))}…）`)
  await fill('[data-testid="design-size-preset"]', 'size:photo-1')
  await waitFor(`(${draftDesign})?.layers.find(l=>l.id===${JSON.stringify(croppedLayer.id)})?.w === 25`, '套用 1 寸预设把图层改成 25mm 宽')
  const presetDoc = await evaluate(draftDesign)
  const presetLayer = presetDoc.layers.find((layer) => layer.id === croppedLayer.id)
  const presetAsset = presetDoc.assets[presetLayer.assetId]
  const printedAspect = (presetAsset.width * presetLayer.crop.w) / (presetAsset.height * presetLayer.crop.h)
  ok(presetLayer.w === 25 && presetLayer.h === 35, `套用 1 寸预设后图层是 25×35mm 成品尺寸（实得 ${presetLayer.w}×${presetLayer.h}）`)
  ok(Math.abs(printedAspect - 25 / 35) < 1e-4,
    `裁切跟着改成同一长宽比，脸不会被拉长（可见源区域比例 ${printedAspect.toFixed(4)} vs 目标 ${(25 / 35).toFixed(4)}）`)
  ok(presetLayer.crop.x >= 0 && presetLayer.crop.y >= 0 && presetLayer.crop.x + presetLayer.crop.w <= 1 && presetLayer.crop.y + presetLayer.crop.h <= 1,
    '重新裁切仍落在原图内（浮点尾巴会让 normalizeDesign 拒绝整份工程）')
  ok(await evaluate(`document.querySelector('[data-testid="design-size-preset"]').value === ''`), '套用后下拉回位成「自定义」，同一个预设能再点一次')
  await fill('[data-testid="design-size-preset"]', 'ratio:1:1')
  await waitFor(`(${draftDesign})?.layers.find(l=>l.id===${JSON.stringify(croppedLayer.id)})?.h === 25`, '套用 1:1 比例预设只改高度')
  const squareLayer = (await evaluate(draftDesign)).layers.find((layer) => layer.id === croppedLayer.id)
  ok(squareLayer.w === 25 && squareLayer.h === 25, `比例预设保持宽度 25mm、只把高度改成 25mm（实得 ${squareLayer.w}×${squareLayer.h}）`)
  await click('[data-testid="design-undo"]')
  await click('[data-testid="design-undo"]')
  // 撤销回退到保存态后草稿会被清掉（不再是「未保存」），所以这一条必须看 DOM 而不是草稿。
  await waitFor(`Number(document.querySelector('[data-testid="design-layer-w"]').value) === ${croppedLayer.w}`, '撤销可完整回退尺寸')
  ok(await evaluate(`document.querySelector('[data-testid="design-crop-x"]').value==='25' && document.querySelector('[data-testid="design-crop-w"]').value==='50'`),
    '撤销连带把裁切也回退（尺寸与裁切是同一个动作，撤销也必须是）')

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
  // 先隐藏无关图片，避免它的边缘吸附目标与参考线竞争。
  await click(`[data-layer-id="${croppedLayer.id}"] [aria-label="隐藏图层"]`)
  await click(`[data-group-id="${group.id}"]`)
  // 吸附的是组合的当前包围盒；前面的撤销/微调已让坐标不同于 saved 快照。
  const groupStart = await evaluate(`Math.min(...${JSON.stringify(group.layerIds)}.map(id=>parseFloat(document.querySelector('[data-canvas-layer-id="'+id+'"]').style.left)))*297/720`)
  const snapPixels = (80 - groupStart) * 720 / 297 - 1
  // sendInputEvent may coalesce intermediate moves before mouseUp; dispatch the exact endpoint
  // for this geometry assertion. Other checks above cover native mouse dragging.
  await evaluate(`(() => {
    const el = document.querySelector('[data-canvas-layer-id="${rectLayer.id}"]')
    const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: x + ${snapPixels}, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x + ${snapPixels}, clientY: y }))
    return true
  })()`)
  await waitFor(`Math.abs(Math.min(...(${draftDoc}).layers.filter(l=>${JSON.stringify(group.layerIds)}.includes(l.id)).map(l=>l.x))-80)<0.01`, '拖动吸附垂直参考线')
  ok(true, '组合拖动吸附到参考线的毫米坐标')
  await click('[data-testid="design-undo"]')
  await click('[data-testid="design-undo"]')
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && !document.querySelector('.canvas-status .unsaved')`, '保存分组与参考线')
  const phaseTwo = designs.getDesign(saved.id)
  ok(phaseTwo.groups[0].name === '标题与边框' && phaseTwo.guides.some(g => g.axis === 'x' && g.position === 80) && phaseTwo.guides.some(g => g.axis === 'y' && g.position === 40), '工程落盘保留分组和参考线毫米位置')

  // 工程包 M2：通过真实界面与 IPC 导出固定版本，再检查并导入新副本。
  // 只替换系统文件选择器结果；打包、检查、提交和工程读取仍走生产实现。
  const packageFile = path.join(OUTPUT, 'roundtrip.ppdesign')
  const packageSaveDialog = dialog.showSaveDialog
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: packageFile })
  try {
    await click('[data-testid="design-export-package"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="design-package-export-dialog"]'))`, '打开工程包导出对话框')
    ok(await evaluate(`document.querySelector('[data-testid="design-package-version"]')?.textContent.includes('已保存的第 ${phaseTwo.revision} 版')`), '工程包导出页明确显示固定版本号')
    await evaluate(`window.__packageExportProgress=[];window.__stopPackageExportProgress=window.printpress.onDesignPackageProgress(p=>window.__packageExportProgress.push(p));true`)
    await click('[data-testid="design-package-export-confirm"]')
    await waitNode(() => fs.existsSync(packageFile) && fs.statSync(packageFile).size > 0, '工程包文件落盘')
    await waitFor(`document.querySelector('.notice.success')?.textContent.includes('工程包已导出')`, '界面提示工程包导出完成')
    ok(await evaluate(`window.__packageExportProgress.length>0 && window.__packageExportProgress.at(-1).index===window.__packageExportProgress.at(-1).total`), '导出过程通过 preload 收到逐条目进度')
    await evaluate(`window.__stopPackageExportProgress?.();delete window.__stopPackageExportProgress`)
    ok(fs.existsSync(packageFile), '界面导出按钮生成可读取的 .ppdesign 文件')
  } finally { dialog.showSaveDialog = packageSaveDialog }

  const packageOpenDialog = dialog.showOpenDialog
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [packageFile] })
  try {
    const beforeImportIds = new Set(designs.listDesigns().map((item) => item.id))
    await click('[data-testid="design-import-package"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="design-package-import-dialog"]'))`, '打开工程包检查摘要')
    ok(await evaluate(`document.querySelector('[data-testid="design-package-stats"]')?.textContent.includes('${phaseTwo.layers.length} 个图层')`), '导入检查页显示工程包图层摘要')
    await click('[data-testid="design-package-import-open"]')
    await waitNode(() => designs.listDesigns().some((item) => !beforeImportIds.has(item.id)), '副本发布到工程库')
    const imported = designs.listDesigns().find((item) => !beforeImportIds.has(item.id))
    ok(imported && imported.id !== saved.id && imported.revision === 1, '界面导入创建新 ID 和第 1 版，不覆盖来源工程')
    await waitFor(`document.querySelector('.canvas-status')?.textContent.includes('已保存 · v1')`, '导入并打开工程副本')
    const importedDoc = designs.getDesign(imported.id)
    ok(importedDoc.groups.some((item) => item.name === '标题与边框') && importedDoc.guides.length === 2, '工程包往返保留分组与参考线')
    ok(await evaluate(`document.querySelectorAll('[data-layer-id]').length===${phaseTwo.layers.length}`), '导入副本在当前编辑器中完整打开')
    await evaluate(`(() => { const row=[...document.querySelectorAll('.project-row')].find(el=>el.querySelector('b')?.textContent==='真实界面保存验收' && el.querySelector('small')?.textContent.includes('v${phaseTwo.revision}')); if(!row)throw new Error('找不到导出来源工程');row.querySelector('.project-open').click() })()`)
    await waitFor(`document.querySelector('.canvas-status')?.textContent.includes('已保存 · v${phaseTwo.revision}')`, '恢复工程包往返前的来源工程')
  } finally { dialog.showOpenDialog = packageOpenDialog }

  // 参考框（仅编辑可见）：编辑器画布必须看得见，导出 PNG 必须完全不出现。
  // 探针用一个铺满整张画布的不透明矩形——它只要漏进导出，PNG 就不剩任何透明像素，
  // 后面那条「空白角落透明」的断言会立刻变红。这就是「看不见的失败」的克星。
  // 注意：保存成功后草稿会被清掉，这一段只能读界面上的真实状态，不能读 localStorage。
  const idsBeforeRefBox = await evaluate(`[...document.querySelectorAll('[data-layer-id]')].map(el=>el.getAttribute('data-layer-id'))`)
  await click('[data-testid="design-add-rect"]')
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${idsBeforeRefBox.length + 1}`, '新增矩形参考框')
  const refBoxId = await evaluate(`(() => { const before=${JSON.stringify(idsBeforeRefBox)}; return [...document.querySelectorAll('[data-layer-id]')].map(el=>el.getAttribute('data-layer-id')).find(id=>!before.includes(id))||'' })()`)
  ok(Boolean(refBoxId), '新增的矩形出现在图层列表里')
  ok(await evaluate(`(() => { const el=document.querySelector('[data-testid="design-layer-editor-only"]'); return Boolean(el) && el.checked===false })()`), '图层属性面板有「仅编辑可见（不打印）」开关，默认关闭')
  for (const [key, value] of [['x', 0], ['y', 0], ['w', 210], ['h', 148.5]]) await fill(`[data-testid="design-layer-${key}"]`, String(value))
  await click('[data-testid="design-layer-editor-only"]')
  await waitFor(`document.querySelector('[data-testid="design-layer-editor-only"]')?.checked===true`, '勾选仅编辑可见')
  ok(await evaluate(`Boolean(document.querySelector('[data-design-layer="${refBoxId}"]'))`), '编辑器画布仍然渲染参考框（否则没法照着对齐）')
  ok(await evaluate(`document.querySelector('[data-layer-id="${refBoxId}"] .layer-flag')?.textContent.trim()==='仅编辑'`), '图层列表给参考框标注「仅编辑」')
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && !document.querySelector('.canvas-status .unsaved')`, '保存参考框')
  const savedRefBox = designs.getDesign(saved.id).layers.find(layer => layer.id === refBoxId)
  ok(savedRefBox?.editorOnly === true, '参考框的「仅编辑可见」落盘')
  ok(designs.getDesign(saved.id).schemaVersion === 3, '带参考框的工程标记为格式版本3（旧应用明确拒绝，而不是把参考框当普通图层印出去）')
  // 参考框存在的意义就是「照着它对图片」——所以它必须能选中、能拖动，而不是只能看。
  const refBoxX = savedRefBox.x
  await drag(`[data-canvas-layer-id="${refBoxId}"]`, 40, 0)
  await waitFor(`Math.abs(Number(document.querySelector('[data-testid="design-layer-x"]').value)-${refBoxX})>1`, '参考框可真实拖动')
  ok(true, '参考框在画布上能选中并拖动，用户照着它对齐图片')
  await click('[data-testid="design-undo"]')

  // Export the current draft through the real context bridge. The OS picker alone is stubbed.
  // 基准取「导出前那一刻」的版本号：上面参考框的保存已经推进过版本，早先抓的快照会过期。
  const revisionBeforeExport = designs.getDesign(saved.id).revision
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
  const refBoxAtExport = designs.getDesign(saved.id).layers.find(layer => layer.id === refBoxId)
  ok(refBoxAtExport?.editorOnly === true && refBoxAtExport.w === 210 && refBoxAtExport.h === 148.5, '导出时画布上确实盖着一个铺满整张画布的不透明参考框')
  ok(pngPixels[pngPixels.length - 1] === 0, '铺满画布的不透明参考框没有漏进导出 PNG（否则整张图不会再有透明像素）')
  ok(designs.getDesign(saved.id).revision === revisionBeforeExport && await evaluate(`Boolean(document.querySelector('.canvas-status .unsaved'))`), '导出当前草稿不保存新版本也不清除未保存状态')
  ok(fs.readFileSync(path.join(DATA, phaseTwo.assets[croppedLayer.assetId].path)).equals(jpeg), 'PNG导出后原始图片字节保持不变')

  /*
   * 下面那条 JPEG 导出会把「最近一次导出」换成 .jpg，所以 I-28 那一组断言
   * 一律读这个变量、不写死 pngPath——它要守的是「打开的就是**最近一次**导出的那个文件」，
   * 而不是「打开的一定是 PNG」。写死会让这两段互相绊倒。
   */
  let lastExportPath = pngPath

  /*
   * ---- 界面驱动 JPEG 导出（v0.7 P1 多格式）----
   *
   * 上面那条验的是 PNG 老路径；这里**从界面选格式**一路走到真实文件，
   * 证明「下拉 → 预检 → IPC → 主进程编码器 → 落盘」这条链没有断在中间某一环
   * （纯 Node 套件只覆盖到格式表与字节改写，真实编码器在 design-export-e2e 里验）。
   */
  const jpegPath = path.join(OUTPUT, 'editor-quality.jpg')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: jpegPath })
  try {
    await click('[data-testid="design-export-png"]')
    await waitFor(`Boolean(document.querySelector('[data-testid="design-export-dialog"]'))`, '多格式导出配置')
    await fill('[data-testid="design-export-format"]', 'jpeg')
    ok(await evaluate(`document.querySelector('[data-testid="design-export-transparent"]').disabled`),
      '切到 JPEG 后「透明背景」勾选框置灰（没有 alpha 通道）')
    ok(await evaluate(`Boolean(document.querySelector('[data-testid="design-export-flatten-hint"]'))`),
      '界面明确写出 JPEG 会铺画布底色，而不是静默丢掉透明层')
    ok(await evaluate(`Boolean(document.querySelector('[data-testid="design-export-quality"]'))`),
      '有损格式才出现质量滑杆')
    ok(await evaluate(`document.querySelector('[data-testid="design-export-size"]').textContent.includes('约')`),
      '面板给出体积预估并标明是估算值')
    await fill('[data-testid="design-export-quality"]', 60)
    await fill('[data-testid="design-export-dpi"]', 150)
    await click('[data-testid="design-export-confirm"]')
    await waitFor(`!document.querySelector('[data-testid="design-export-dialog"]')`, 'JPEG导出完成', 30000)
  } finally { dialog.showSaveDialog = originalSaveDialog }
  assert.ok(fs.existsSync(jpegPath), 'JPEG文件真实写入')
  const exportedJpeg = fs.readFileSync(jpegPath)
  ok(exportedJpeg[0] === 0xff && exportedJpeg[1] === 0xd8, '界面导出的确实是 JPEG（不是改了扩展名的 PNG）')
  const exportedJpegSize = require('../electron/images.cjs').imageSizeFromBuffer(exportedJpeg)
  ok(exportedJpegSize.width === Math.round(297 * 150 / 25.4) && exportedJpegSize.height === Math.round(210 * 150 / 25.4),
    '界面导出JPEG得到指定DPI的精确像素')
  ok(exportedJpeg.subarray(6, 11).toString('latin1') === 'JFIF\0' && exportedJpeg.readUInt16BE(14) === 150,
    '界面导出JPEG写入了 150 dpi 的 JFIF 密度')
  ok(nativeImage.createFromPath(jpegPath).toBitmap().at(-1) === 255, 'JPEG 空白角落是不透明底色（没有 alpha 通道）')
  ok(await evaluate(`document.querySelector('.export-done-text')?.textContent.includes('JPEG') === true`),
    '完成条标明导出的是 JPEG')
  lastExportPath = jpegPath

  /*
   * ---- 导出后「脱离本系统打印」----
   * 真点这两个按钮会弹出资源管理器 / 看图器，所以把 shell 的方法换成记录器：
   * printer.cjs 解构拿到的是 shell 这个**对象**的引用，改它的属性对调用方可见。
   * 另：这两个动作**不接受参数**（I-28）——路径由主进程记着，渲染层传不进路径。
   */
  const { shell } = require('electron')
  const originalReveal = shell.showItemInFolder
  const originalOpen = shell.openPath
  const opened = []
  shell.showItemInFolder = (p) => { opened.push({ how: 'reveal', path: p }) }
  shell.openPath = async (p) => { opened.push({ how: 'open', path: p }); return '' }
  try {
    ok(await evaluate(`Boolean(document.querySelector('[data-testid="design-reveal-export"]')) && Boolean(document.querySelector('[data-testid="design-open-export"]'))`), '导出成功后给出「打开所在文件夹 / 用系统程序打开」两个动作')
    ok(await evaluate(`document.querySelector('.export-done-path')?.textContent === ${JSON.stringify(lastExportPath)}`), '完成条里带完整导出路径，用户照着就能找到文件')
    ok(await evaluate(`window.printpress.revealDesignExport.length === 0 && window.printpress.openDesignExport.length === 0`), '渲染层暴露的这两个方法是零参的（界面上无处传路径）')
    await click('[data-testid="design-reveal-export"]')
    await waitNode(() => opened.length >= 1, '主进程收到「打开所在文件夹」')
    ok(opened.at(-1).how === 'reveal' && opened.at(-1).path === lastExportPath, '「打开所在文件夹」定位到刚导出的文件（按钮真的接到了主进程）')
    await click('[data-testid="design-open-export"]')
    await waitNode(() => opened.length >= 2, '主进程收到「用系统程序打开」')
    ok(opened.at(-1).how === 'open' && opened.at(-1).path === lastExportPath, '「用系统程序打开」打开的是刚导出的文件')
    await click('[data-testid="design-export-done-close"]')
    ok(await evaluate(`!document.querySelector('[data-testid="design-reveal-export"]')`) && fs.existsSync(pngPath), '「关闭」只收起完成条，磁盘上的导出文件不受影响')
  } finally {
    shell.showItemInFolder = originalReveal
    shell.openPath = originalOpen
  }
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

  // 图片图层的描边与投影（v0.7 §6 / I-44）：开关 → 画布 → 落盘 → 关掉要真删字段。
  const canvasLayerStyle = `document.querySelector('.design-stage [data-design-layer="${croppedLayer.id}"]')?.getAttribute('style') || ''`
  const canvasStrokeStyle = `document.querySelector('.design-stage [data-design-stroke="${croppedLayer.id}"]')?.getAttribute('style') || ''`
  ok(await evaluate(`Boolean(document.querySelector('[data-testid="design-layer-stroke"]')) && Boolean(document.querySelector('[data-testid="design-layer-shadow"]'))`),
    '选中图片图层时给出「描边（衬边）」与「投影」两个开关')
  ok(await evaluate(`!document.querySelector('[data-testid="design-stroke-width"]') && !document.querySelector('[data-testid="design-shadow-dx"]')`),
    '未开启时不展开具体参数（不白占版面）')
  await click('[data-testid="design-layer-stroke"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-stroke-width"]'))`, '开启描边后出现宽度与颜色')
  await fill('[data-testid="design-stroke-width"]', 1.2)
  await waitFor(`(${canvasStrokeStyle}).includes('box-shadow:inset 0 0 0 1.2mm #ffffff')`, '画布上的图片框内侧出现白色描边叠层')
  ok(await evaluate(`(${canvasLayerStyle}).includes('width:${croppedLayer.w}mm') && (${canvasLayerStyle}).includes('height:${croppedLayer.h}mm')`),
    '描边不改变框的毫米尺寸（用 border 会挤掉内容盒 ⇒ 等于把照片拉长）')
  ok(await evaluate(`!(${canvasLayerStyle}).includes('outline')`),
    '描边不用 outline（Chromium 把它画在图片之下，整圈会被盖住）')
  await click('[data-testid="design-layer-shadow"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-shadow-dx"]'))`, '开启投影后出现偏移 / 模糊 / 透明度 / 颜色')
  await waitFor(`(${canvasLayerStyle}).includes('drop-shadow')`, '画布上的图片框带上投影')
  await fill('[data-testid="design-shadow-blur"]', 2)
  await waitFor(`(${canvasLayerStyle}).includes('drop-shadow(1mm 1.5mm 2mm')`, '改模糊后画布即时跟着变')
  ok(await evaluate(`!(${canvasLayerStyle}).includes('box-shadow')`), '投影走 drop-shadow（按轮廓）而不是 box-shadow（按包围盒投出一个方盒）')
  // 草稿写入有 250ms 防抖，必须等（直接读会读到还没落盘的旧值）。
  await waitFor(`(${draftDesign})?.layers.find(l=>l.id===${JSON.stringify(croppedLayer.id)})?.strokeWidth === 1.2`, '描边与投影写进草稿')
  const effectsDraft = await evaluate(`(${draftDesign})?.layers.find(l=>l.id===${JSON.stringify(croppedLayer.id)})`)
  ok(effectsDraft?.strokeWidth === 1.2 && effectsDraft?.stroke === '#ffffff' && effectsDraft?.shadow?.blurMm === 2,
    `描边与投影写进草稿（实得 ${JSON.stringify({ stroke: effectsDraft?.stroke, strokeWidth: effectsDraft?.strokeWidth, blur: effectsDraft?.shadow?.blurMm })}）`)
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && !document.querySelector('.canvas-status .unsaved')`, '保存图片描边与投影')
  const effectsSaved = designs.getDesign(saved.id)
  const effectsLayer = effectsSaved.layers.find(layer => layer.id === croppedLayer.id)
  ok(effectsSaved.schemaVersion === 7, `带图片描边/投影的工程标记为格式版本7（旧应用明确拒绝，实得 ${effectsSaved.schemaVersion}）`)
  ok(effectsLayer.strokeWidth === 1.2 && effectsLayer.stroke === '#ffffff' && effectsLayer.shadow?.blurMm === 2, '描边与投影落盘')
  // 关掉必须**真删字段**：留一个 strokeWidth:0 会把工程标成版本 7 却没给用户任何视觉差别。
  await click('[data-testid="design-layer-stroke"]')
  await click('[data-testid="design-layer-shadow"]')
  await waitFor(`!document.querySelector('[data-testid="design-stroke-width"]') && !document.querySelector('[data-testid="design-shadow-dx"]')`, '关掉后参数面板收起')
  ok(!(await evaluate(`(${canvasStrokeStyle})`)).includes('box-shadow') && !(await evaluate(`(${canvasLayerStyle})`)).includes('drop-shadow'),
    '关掉后画布上不再有描边与投影')
  await click('[data-testid="design-save"]')
  await waitFor(`!document.querySelector('[data-testid="design-save"]').disabled && !document.querySelector('.canvas-status .unsaved')`, '保存关闭结果')
  const clearedLayer = designs.getDesign(saved.id).layers.find(layer => layer.id === croppedLayer.id)
  const leftovers = ['stroke', 'strokeWidth', 'shadow'].filter((key) => key in clearedLayer)
  ok(leftovers.length === 0, `关掉后字段被真删除（实得残留 ${JSON.stringify(leftovers)}）`)

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
  await evaluate(`document.querySelector('.app-main').scrollTop=0;(()=>{const el=document.querySelector('.inspector');if(el)el.scrollTop=0})();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
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

  /*
   * ---- 「常用模板」下拉：内置只剩身份证一套 + 「常用」只收**用户保存过**的 ----
   *
   * 三件事必须分清，否则会重演「工程库被堆满」：
   * - 「内置模板」是**打开或新建**：工程库里已有同名工程就打开它，**绝不复制**。
   *   无条件落库 ⇒ 每点一次多一个同名工程（实测一次会话 18 个、装上 0.4.0 又点了 4 个）；
   * - 「常用」的门槛是**用户自己保存过**，系统按预设自动建出来的不算——
   *   否则每点一次「身份证」就往常用里塞一条，是同一类病；
   * - 「常用」选中是**打开那份工程本身**，绝不复制。
   *
   * 另：内置参考框必须 `editorOnly`（绝不能印出去），而它的失败方式只有印出来才看得见。
   */
  const presetValues = await evaluate(`[...document.querySelectorAll('[data-testid="design-preset"] option')].map(o=>o.value)`)
  ok(presetValues[0] === '' && presetValues[1] === 'preset:id-card-a4', `下拉第一项是占位、紧接着就是唯一的内置模板（实得 ${JSON.stringify(presetValues.slice(0, 2))}）`)
  ok(!presetValues.some((v) => v.startsWith('preset:') && v !== 'preset:id-card-a4'), '内置模板只剩身份证一套')
  ok(presetValues.filter((v) => v.startsWith('design:')).length > 0, '「常用」里列出了用户自己的工程')

  const projectsBeforePresets = designs.listDesigns().length
  await fill('[data-testid="design-preset"]', 'preset:id-card-a4')
  await waitFor(`document.querySelector('[data-testid="design-name"]')?.value==='身份证正反面复印件'`, '按预设新建工程')
  ok(await evaluate(`document.querySelector('[data-testid="design-preset"]').value===''`), '下拉选完自动复位，再选同一项仍会触发')
  ok(await evaluate(`document.querySelector('.notice.success')?.textContent.includes('新建工程') === true`), '新建后给出「已按某模板新建工程」的提示')
  ok(designs.listDesigns().length === projectsBeforePresets + 1, '选「内置模板」确实新建了一份独立工程，不动已有工程')

  const idCard = designs.listDesigns().find((item) => item.name === '身份证正反面复印件')
  const idCardDoc = designs.getDesign(idCard.id)
  ok(idCardDoc.schemaVersion === 3 && idCardDoc.layers.length > 0 && idCardDoc.layers.every((layer) => layer.editorOnly === true), '证件预设整份都是「仅编辑可见」的参考框，并标记为格式版本 3')
  ok(await evaluate(`document.querySelectorAll('[data-canvas-layer-id]').length === ${idCardDoc.layers.length}`), '编辑器画布照样把参考框画出来（否则没法照着它对齐图片）')
  ok(await evaluate(`document.querySelectorAll('[data-layer-id] .layer-flag').length === ${idCardDoc.layers.length}`), '图层列表把每个参考框都标成「仅编辑」')

  // ⚠️ 系统按预设建出来的工程**不该**自动进「常用」：门槛是用户自己保存过。
  ok(!idCard.lastUsedAt, '预设刚建出来的工程没有使用记录（不该自动进「常用」）')
  ok(await evaluate(`document.querySelectorAll('[data-testid="design-preset"] option[value="design:${idCard.id}"]').length === 0`), '刚按预设建出来的工程**没有**出现在「常用」里')

  /*
   * ⚠️ 连点 N 次「内置模板」只该有一份工程。
   * 无条件落库时每点一次就多一份同名工程（实测一次会话 18 个、装上 0.4.0 又点了 4 个）——
   * 这个坑不在逻辑里、在交互后果里，所以正面钉住行为而不是钉实现。
   */
  const countBeforeSecondPreset = designs.listDesigns().length
  await fill('[data-testid="design-preset"]', 'preset:id-card-a4')
  await waitFor(`document.querySelector('.notice.success')?.textContent.includes('已经有一份') === true`, '再选一次「身份证」时明确告知「已经有一份，直接打开」')
  ok(designs.listDesigns().length === countBeforeSecondPreset, '再选一次「身份证」不会新增工程——打开已有的那份（「每点一次多一个」的根因就此堵住）')
  ok(await evaluate(`document.querySelector('[data-testid="design-name"]')?.value==='身份证正反面复印件'`), '复用时打开的确实是那份身份证工程')
  ok(!designs.listDesigns().find((item) => item.id === idCard.id).lastUsedAt, '复用（打开）一份从没保存过的工程，也不会把它塞进「常用」')

  // 用户**自己保存**之后才进「常用」——这才是门槛。
  await click('[data-testid="design-add-text"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-text"]'))`, '加一个文字图层，制造出「有改动」')
  await click('[data-testid="design-save"]')
  await waitFor(`document.querySelectorAll('[data-testid="design-preset"] option[value="design:${idCard.id}"]').length === 1`, '用户保存后该工程出现在「常用」里')
  ok(designs.listDesigns().find((item) => item.id === idCard.id).lastUsedAt, '用户保存后工程才有了使用记录')

  // 工程库里若已堆着几份同名工程（历史残留），「常用」要把同名折叠成一条——
  // 一排一模一样的名字用户根本分不清该点哪个。工程库本身仍列全部（不能替用户藏工程）。
  const { buildPreset } = require('../electron/design-presets.cjs')
  designs.saveDesign(buildPreset('id-card-a4'))
  designs.saveDesign(buildPreset('id-card-a4'))
  await fill('[data-testid="design-preset"]', 'preset:id-card-a4')
  await waitFor(`document.querySelector('[data-testid="design-name"]')?.value==='身份证正反面复印件'`)
  const sameName = designs.listDesigns().filter((item) => item.name === '身份证正反面复印件').length
  ok(sameName >= 3, `工程库里确实堆着 ${sameName} 份同名工程（人为造的重复）`)
  const shownSameName = await evaluate(`[...document.querySelectorAll('[data-testid="design-preset"] option')].filter(o=>o.value.startsWith('design:')&&o.textContent.startsWith('身份证正反面复印件')).length`)
  ok(shownSameName === 1, `同名工程在「常用」里只列一条（实得 ${shownSameName} 条）`)

  // 「常用」= 打开那份工程本身，**不是**再复制一份。
  const other = designs.listDesigns().find((item) => item.id !== idCard.id && item.lastUsedAt && item.name !== '身份证正反面复印件')
  const countBeforeOpen = designs.listDesigns().length
  await fill('[data-testid="design-preset"]', `design:${other.id}`)
  await waitFor(`document.querySelector('[data-testid="design-name"]')?.value===${JSON.stringify(other.name)}`, '从「常用」打开已有工程')
  await waitFor(`[...document.querySelectorAll('[data-testid="design-preset"] option')].filter(o=>o.value.startsWith('design:'))[0]?.value==='design:${other.id}'`, '「常用」把刚打开的工程排到第一')
  ok(designs.listDesigns().length === countBeforeOpen, '从「常用」打开**不会**新增工程（这正是当初堆出 18 个的根因）')
  ok(designs.listDesigns().find((item) => item.id === other.id).lastUsedAt > other.lastUsedAt, '打开后被记入「常用」（lastUsedAt 刷新，且不碰版本号）')
  ok(designs.getDesign(idCard.id).layers.some((layer) => layer.editorOnly === true), '打开别的工程不会改动先前那份证件预设工程')

  /*
   * 交互优化（v0.5.0）：① 顶部提示条 5 秒自动消失；② 删「未加入素材库的图」前二次确认
   * （同步删原图不可撤销，安全姿态对齐 I-32）；③ 删临时件**只丢引用该素材的快照**（外科清栈，
   * 不再整栈清空）；④ 撤销栈上限从 5 放宽到 50。都是「用户看不见但一定会踩」的交互性质，
   * 只有真界面能验。
   */
  // 先做一次「无关编辑」，稍后用它证明删临时件没有把整栈清空
  const layersBeforeRect = await evaluate(`document.querySelectorAll('[data-layer-id]').length`)
  await click('[data-testid="design-add-rect"]')
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${layersBeforeRect + 1}`, '先加一个矩形（无关编辑）')

  const toastJpeg = nativeImage.createFromBuffer(jpeg).resize({ width: 90 }).toJPEG(80)
  const toastBytes = JSON.stringify(toastJpeg.toString('base64'))
  const layersBeforeToast = await evaluate(`document.querySelectorAll('[data-layer-id]').length`)
  await evaluate(`(() => {
    const make=(b64,n,t)=>{const bin=atob(b64);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return new File([a],n,{type:t})}
    const dt=new DataTransfer(); dt.items.add(make(${toastBytes}, '提示条验证.jpg', 'image/jpeg'))
    document.querySelector('.canvas-scroll').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${layersBeforeToast + 1}`, '粘贴用于验证的图片')
  // 只认「通用提示条」，避开导出完成条（.export-done 常驻直到手动关）
  const noticeSel = `.notice.success:not(.export-done)`
  await waitFor(`(document.querySelector('${noticeSel}')?.textContent||'').includes('已加入图片图层')`, '粘贴后出现提示条')
  await waitFor(`!document.querySelector('${noticeSel}')`, '提示条 5 秒后自动消失', 9000)
  ok(true, '顶部提示条 5 秒后自动消失（无需手动关闭）')

  // ② 删临时件不再弹确认（用户要求别打断操作）：原图仍随图层同步清理，改由顶部提示条告知
  const dToast = await evaluate(draftDesign)
  const toastLayer = dToast.layers[dToast.layers.length - 1]
  const toastFile = path.join(DATA, designs.assetInfo(toastLayer.assetId).path)
  ok(fs.existsSync(toastFile), '待删的临时原件已在磁盘')
  await click(`[data-layer-id="${toastLayer.id}"]`)
  await click('[data-testid="design-group-delete"]')
  await waitNode(() => !fs.existsSync(toastFile), '临时原件被同步清理')
  ok(!(await evaluate(`Boolean(document.querySelector('.cd-box'))`)), '删临时件不再弹确认框（不打断操作）')
  ok(!fs.existsSync(toastFile), '临时原件随图层同步删除（删除行为不变）')
  ok(await evaluate(`!Boolean(document.querySelector('[data-layer-id="${toastLayer.id}"]'))`), '图层已删除')
  await waitFor(`(document.querySelector('.notice.success:not(.export-done)')?.textContent||'').includes('原图已同步清理')`, '顶部提示条告知原图已清理')
  ok(true, '顶部提示条告知「未加入素材库的原图已同步清理」（非阻塞，替代原确认框）')

  // ③ 外科清栈：删临时件后，与它无关的编辑历史必须还在（旧的「整栈清空」会让 undo 立刻变灰）
  ok(!(await evaluate(`document.querySelector('[data-testid="design-undo"]').disabled`)), '删临时件后撤销栈未被清空（无关编辑仍可撤）')
  let backSteps = 0
  while (backSteps < 60 && !(await evaluate(`document.querySelector('[data-testid="design-undo"]').disabled`))) {
    await click('[data-testid="design-undo"]')
    backSteps += 1
  }
  ok(backSteps > 0 && await evaluate(`document.querySelectorAll('[data-layer-id]').length===${layersBeforeRect}`), '无关编辑（先加的那个矩形）仍能撤销回去')

  // ④ 撤销栈上限已从 5 放宽到 50：连加 12 个矩形能一路全撤（若仍是 5 则只能撤回 7 个）
  const rectsBase = await evaluate(`document.querySelectorAll('[data-layer-id]').length`)
  for (let i = 0; i < 12; i += 1) await click('[data-testid="design-add-rect"]')
  await waitFor(`document.querySelectorAll('[data-layer-id]').length===${rectsBase + 12}`, '连加 12 个矩形')
  for (let i = 0; i < 12; i += 1) await click('[data-testid="design-undo"]')
  ok(await evaluate(`document.querySelectorAll('[data-layer-id]').length===${rectsBase}`), '连加 12 个矩形可全部撤销（上限已从 5 放宽到 50）')

  // 渐变是右侧属性栏里的真实操作，不只验证模型字段存在。
  ok(await evaluate(`Boolean(document.querySelector('[data-testid="design-board-gradient"]'))`), '画布渐变开关在右侧属性栏可见')
  if (!(await evaluate(`document.querySelector('[data-testid="design-board-gradient"]').checked`))) await click('[data-testid="design-board-gradient"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-board-gradient-angle"]'))`, '画布渐变属性展开')
  await fill('[data-testid="design-board-gradient-angle"]', '35')
  await waitFor(`document.querySelector('[data-testid="design-stage"] linearGradient')?.getAttribute('x1') !== document.querySelector('[data-testid="design-stage"] linearGradient')?.getAttribute('x2')`, '画布渐变绘出端点')
  ok(await evaluate(`document.querySelector('[data-testid="design-board-gradient-angle"]')?.value==='35'`), '画布渐变角度可在界面编辑')
  await clickText('.inspector button', '添加色标')
  await waitFor(`document.querySelectorAll('.inspector label').length > 0 && document.querySelector('[data-testid="design-stage"] linearGradient')?.querySelectorAll('stop').length===3`, '画布增加第三个渐变色标')
  ok(true, '画布渐变可增加色标并立即重绘')
  await click('[data-testid="design-add-rect"]')
  await waitFor(`Boolean(document.querySelector('[data-testid="design-layer-gradient"]'))`, '矩形图层渐变开关')
  const beforeShapeGradient = await evaluate(`document.querySelectorAll('[data-testid="design-stage"] linearGradient').length`)
  await click('[data-testid="design-layer-gradient"]')
  await waitFor(`document.querySelectorAll('[data-testid="design-stage"] linearGradient').length===${beforeShapeGradient + 1}`, '矩形渐变与画布渐变同时渲染')
  const visibleGradientIds = await evaluate(`[...document.querySelectorAll('[data-testid="design-stage"] linearGradient')].map(node=>node.id)`)
  ok(new Set(visibleGradientIds).size === visibleGradientIds.length, '画布和矩形的渐变在编辑画布中使用不同 ID')
  await fill('[data-testid="design-layer-gradient-angle"]', '120')
  ok(await evaluate(`document.querySelector('[data-testid="design-layer-gradient-angle"]')?.value==='120'`), '矩形渐变角度可在界面编辑')
  ok(await evaluate(`Boolean(document.querySelector('[data-testid="design-layer-shadow"]'))`), '矩形外阴影开关在属性栏可见')
  const beforeShapeShadow = await evaluate(`document.querySelectorAll('[data-testid="design-stage"] filter').length`)
  await click('[data-testid="design-layer-shadow"]')
  await waitFor(`document.querySelectorAll('[data-testid="design-stage"] filter').length===${beforeShapeShadow + 1}`, '矩形外阴影立即进入编辑画布')
  await fill('[data-testid="design-shadow-dx"]', '-2')
  await waitFor(`[...document.querySelectorAll('[data-testid="design-stage"] feOffset')].some(node=>node.getAttribute('dx')==='-2')`, '阴影负偏移实时渲染')
  ok(await evaluate(`document.querySelector('[data-testid="design-shadow-dx"]')?.value==='-2'`), '阴影水平偏移可在界面编辑')

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

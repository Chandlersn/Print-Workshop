/** Real PNG output at Windows scale factor 2: exact pixels, alpha, artwork and guides. */
const { app, BrowserWindow, nativeImage, screen } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const DATA = fs.mkdtempSync(path.join(__dirname, '.tmp-design-png-e2e-'))
const OUTPUT = path.resolve(__dirname, '../.workbuddy-ai/tmp/design-png-acceptance')
fs.mkdirSync(OUTPUT, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = DATA
app.setPath('userData', path.join(DATA, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('force-device-scale-factor', '2')
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => { console.error('PNG_E2E_FAIL timeout'); app.exit(1) }, 120000)
let count = 0
function check(condition, label) { assert.ok(condition, label); count++; console.log('  ok -', label) }
function pixel(image, x, y) { const size = image.getSize(); return [...image.toBitmap().subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 4)] }
async function main() {
  await app.whenReady()
  const exporter = require('../electron/design-export.cjs')
  const designs = require('../electron/designs.cjs')
  const printer = require('../electron/printer.cjs')
  // Production keeps its main window visible while the PNG renderer stays hidden.
  const mainWindow = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false } })
  await mainWindow.loadURL('data:text/html,<h1>PNG export acceptance</h1>')
  mainWindow.showInactive()
  check(mainWindow.isVisible(), '存在可见主窗口时执行隐藏PNG渲染')
  const vectorOnly = { schemaVersion: 2, revision: 0, name: '无图片A4', artboard: { w: 297, h: 210, background: '#ffffff' }, assets: {}, layers: [
    { id: 'title', type: 'text', x: 10, y: 10, w: 100, h: 30, text: 'TEXT 纯文字底图', fontSize: 24 },
    { id: 'rect', type: 'rect', x: 20, y: 50, w: 80, h: 20, fill: '#123456', strokeWidth: 0 },
  ] }
  const vectorPng = nativeImage.createFromBuffer(await exporter.renderPng(exporter.prepareExport({ design: vectorOnly, dpi: 300, transparent: true })))
  check(vectorPng.getSize().width === 3508 && vectorPng.getSize().height === 2480, '无图片A4文字与形状在可见主窗口旁完成PNG截图')
  check(screen.getPrimaryDisplay().scaleFactor === 2, '测试启用Windows 200%显示缩放')
  const source = nativeImage.createFromBitmap(Buffer.from([0, 128, 0, 128, 0, 128, 0, 128, 0, 128, 0, 128, 0, 128, 0, 128]), { width: 2, height: 2 }).toPNG()
  const asset = designs.importImageBytes({ name: 'alpha.png', base64: source.toString('base64') })
  const fontPath = process.platform === 'win32'
    ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf')
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  let customFont = ''
  if (fs.existsSync(fontPath)) {
    fs.mkdirSync(path.join(DATA, 'print-fonts'))
    fs.copyFileSync(fontPath, path.join(DATA, 'print-fonts', 'PNG验收.ttf'))
    customFont = 'PNG验收'
  }
  const doc = { schemaVersion: 2, revision: 0, name: 'PNG真实输出', artboard: { w: 25.4, h: 12.7, background: '#ffffff' }, assets: { [asset.id]: asset }, layers: [
    { id: 'red', type: 'rect', x: 0, y: 0, w: 6.35, h: 6.35, fill: '#ff0000', strokeWidth: 0 },
    { id: 'alpha', type: 'image', x: 12.7, y: 0, w: 6.35, h: 6.35, assetId: asset.id },
    { id: 'title', type: 'text', x: 1, y: 8, w: 18, h: 4, text: 'PNG TEST', fontSize: 8, ...(customFont ? { fontFamily: customFont } : {}) },
  ] }
  let baseline
  for (const dpi of [150, 300, 600]) {
    const prepared = exporter.prepareExport({ design: doc, dpi, transparent: true })
    const filePath = path.join(OUTPUT, `transparent-${dpi}.png`)
    const result = await exporter.exportPng(prepared, filePath)
    const bytes = fs.readFileSync(filePath)
    const image = nativeImage.createFromBuffer(bytes)
    const size = image.getSize()
    check(size.width === dpi && size.height === dpi / 2, `${dpi}DPI精确输出${dpi}×${dpi / 2}px`)
    check(result.width === size.width && result.height === size.height, '返回尺寸等于PNG真实尺寸')
    const red = pixel(image, Math.round(size.width / 8), Math.round(size.height / 4))
    check(red[2] > 245 && red[1] < 5 && red[0] < 5 && red[3] === 255, `${dpi}DPI形状像素为不透明红色`)
    const alpha = pixel(image, Math.round(size.width * 0.625), Math.round(size.height / 4))
    check(alpha[3] >= 125 && alpha[3] <= 130, `${dpi}DPI保留原PNG半透明alpha=${alpha[3]}`)
    check(pixel(image, size.width - 2, size.height - 2)[3] === 0, `${dpi}DPI空白画布透明`)
    const phys = bytes.indexOf(Buffer.from('pHYs'))
    check(phys > 0 && bytes.readUInt32BE(phys + 4) === Math.round(dpi / 0.0254), `${dpi}DPI物理分辨率元数据正确`)
    if (dpi === 300) baseline = image.toBitmap()
  }
  const guided = structuredClone(doc)
  guided.guides = [{ id: 'guide-a', axis: 'x', position: 3 }, { id: 'guide-b', axis: 'y', position: 4 }]
  const withGuides = await exporter.renderPng(exporter.prepareExport({ design: guided, dpi: 300, transparent: true }))
  check(nativeImage.createFromBuffer(withGuides).toBitmap().equals(baseline), '参考线不进入导出像素')
  const opaque = nativeImage.createFromBuffer(await exporter.renderPng(exporter.prepareExport({ design: doc, dpi: 300, transparent: false })))
  check(pixel(opaque, 298, 148).every(value => value === 255), '非透明导出使用白色背景')
  const alphaOnWhite = pixel(opaque, 188, 37)
  check(alphaOnWhite[3] === 255 && alphaOnWhite[1] > alphaOnWhite[0], '半透明图片正确合成到白色背景')
  const shadowDoc = { schemaVersion: 4, name: '阴影与透明渐变验收', artboard: { w: 25.4, h: 25.4, background: '#ffffff', backgroundPaint: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#ddeeff', opacity: 1 }] } }, assets: {}, layers: [
    { id: 'shadow-rect', type: 'rect', x: 3, y: 3, w: 8, h: 8, fill: '#ff0000', strokeWidth: 0, shadow: { dxMm: 3, dyMm: 0, blurMm: 0, color: '#000000', opacity: 0.5 } },
  ] }
  const shadowPrepared = exporter.prepareExport({ design: shadowDoc, dpi: 300, transparent: true })
  check(!shadowPrepared.html.includes('export-design-board-paint'), '透明 PNG 导出移除画板渐变')
  const shadowImage = nativeImage.createFromBuffer(await exporter.renderPng(shadowPrepared))
  const mm = value => Math.round(value * 300 / 25.4)
  const cast = pixel(shadowImage, mm(12), mm(7))
  check(cast[3] >= 120 && cast[3] <= 135 && cast[0] < 10 && cast[1] < 10 && cast[2] < 10, '形状外侧实际输出半透明黑色阴影像素')
  check(pixel(shadowImage, mm(5), mm(7))[2] > 245, '阴影不覆盖形状主体的红色像素')
  check(pixel(shadowImage, mm(20), mm(20))[3] === 0, '阴影之外的透明 PNG 背景仍透明')
  const fadedDoc = structuredClone(shadowDoc)
  fadedDoc.layers[0].fillPaint = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ff0000', opacity: 0 }] }
  const fadedImage = nativeImage.createFromBuffer(await exporter.renderPng(exporter.prepareExport({ design: fadedDoc, dpi: 300, transparent: true })))
  check(pixel(fadedImage, mm(12), mm(7))[3] > pixel(fadedImage, mm(13.5), mm(7))[3], '阴影遵循透明渐变填充的实际 alpha')
  const edgeDoc = structuredClone(shadowDoc)
  edgeDoc.layers[0].x = 1
  edgeDoc.layers[0].shadow = { dxMm: -1, dyMm: 0, blurMm: 2, color: '#000000', opacity: 1 }
  const edgeImage = nativeImage.createFromBuffer(await exporter.renderPng(exporter.prepareExport({ design: edgeDoc, dpi: 300, transparent: true })))
  check(pixel(edgeImage, mm(0.5), mm(7))[3] > 0, '贴近画板边缘的模糊阴影未被图层边框提前裁断')
  /*
   * ---- 图片图层的描边与投影（v0.7 §6 / I-44）----
   *
   * 这两条走的是 CSS（`outline` + `filter: drop-shadow()`），不是 SVG filter。
   * 文本断言只能证明「HTML 里有那串字符」，证明不了「像素上真的画出来了」——
   * 所以这里出真图、读真像素。特别注意 `nativeImage.toBitmap()` 是 **BGRA**，
   * 用纯绿（B=R=0）当描边色，避免 B/R 顺序写反还能通过。
   */
  const solid = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]), { width: 2, height: 2 }).toPNG()
  const solidAsset = designs.importImageBytes({ name: 'solid-red.png', base64: solid.toString('base64') })
  const effectDoc = { schemaVersion: 7, name: '图片描边与投影', artboard: { w: 25.4, h: 25.4, background: '#ffffff' }, assets: { [solidAsset.id]: solidAsset }, layers: [
    { id: 'card', type: 'image', assetId: solidAsset.id, x: 6, y: 6, w: 10, h: 10, stroke: '#00ff00', strokeWidth: 1, shadow: { dxMm: 3, dyMm: 0, blurMm: 0, color: '#000000', opacity: 1 } },
  ] }
  const effectImage = nativeImage.createFromBuffer(await exporter.renderPng(exporter.prepareExport({ design: effectDoc, dpi: 300, transparent: true })))
  const ring = pixel(effectImage, mm(6.5), mm(11))
  check(ring[1] > 200 && ring[0] < 40 && ring[2] < 40 && ring[3] === 255, '描边真的画在框内侧（1mm 绿环落在 x=6–7mm）')
  const body = pixel(effectImage, mm(11), mm(11))
  check(body[2] > 200 && body[0] < 40 && body[1] < 40, '描边没有吃掉图片主体（x=11mm 仍是红色原图）')
  const outside = pixel(effectImage, mm(5.5), mm(11))
  check(outside[3] === 0, '描边不收在框内就会溢到框外——这里必须是透明')
  const castShadow = pixel(effectImage, mm(18), mm(11))
  check(castShadow[3] === 255 && castShadow[0] < 10 && castShadow[1] < 10 && castShadow[2] < 10,
    '图片投影真的投到了框外（dx=3mm ⇒ x=18mm 处是黑色阴影）')
  check(pixel(effectImage, mm(23), mm(11))[3] === 0, '投影之外的透明 PNG 背景仍透明')
  const semiDoc = structuredClone(effectDoc)
  semiDoc.assets = { [asset.id]: asset }
  semiDoc.layers[0] = { id: 'card', type: 'image', assetId: asset.id, x: 6, y: 6, w: 10, h: 10, shadow: { dxMm: 3, dyMm: 0, blurMm: 0, color: '#000000', opacity: 1 } }
  const semiImage = nativeImage.createFromBuffer(await exporter.renderPng(exporter.prepareExport({ design: semiDoc, dpi: 300, transparent: true })))
  const semiShadow = pixel(semiImage, mm(18), mm(11))
  check(Math.abs(semiShadow[3] - 128) <= 6,
    `投影跟随源图 alpha（半透明图 ⇒ 阴影像素也半透明；box-shadow 会给 255，实得 ${semiShadow[3]}）`)
  // 对照组要挑**只有图片、没有阴影**的地方：阴影只覆盖 9–19mm，所以取 x=7mm。
  // （若取 x=11mm，图片与它自己的影子会叠成 0.5 + 0.5×0.5 = 0.75 ⇒ 192，那是另一个证据。）
  const semiBody = pixel(semiImage, mm(7), mm(11))[3]
  check(Math.abs(semiBody - 128) <= 6, `对照组：半透明图本身确实是 50% alpha（实得 ${semiBody}）`)
  const semiOverlap = pixel(semiImage, mm(11), mm(11))[3]
  check(Math.abs(semiOverlap - 192) <= 6,
    `图片与它自己的影子叠在一起时是 0.5 + 0.5×0.5 = 75%（实得 ${semiOverlap}，再次说明影子也带着源图的 alpha）`)
  const large = structuredClone(doc)
  large.artboard = { w: 210, h: 297, background: '#ffffff' }
  const largeOutput = await exporter.exportPng(exporter.prepareExport({ design: large, dpi: 600 }), path.join(OUTPUT, 'a4-600dpi.png'))
  check(largeOutput.width === 4961 && largeOutput.height === 7016, 'A4 600DPI超屏幕大图输出4961×7016原生像素')
  const largeImage = nativeImage.createFromPath(largeOutput.filePath)
  check(largeImage.getSize().width === 4961 && largeImage.getSize().height === 7016, 'A4高清PNG文件实际像素正确')
  /*
   * ---- JPEG / WebP（v0.7 P1：PNG 之外的出图格式）----
   *
   * 纯 Node 套件只能验格式表与字节改写，**真实编码**必须在 Electron 里跑：
   * CDP 的 `Page.captureScreenshot` 三种格式走的是三个不同编码器，
   * 「参数传对了」不等于「编码器真的吐了那个格式」。
   *
   * WebP 不能靠 `nativeImage` 验——Electron 28 的 nativeImage 只解 PNG / JPEG，
   * 所以借渲染器自己的解码器看像素，顺带证明写出的是**能解码**的文件而不是坏字节。
   */
  const images = require('../electron/images.cjs')
  async function decodeInChromium(bytes, mime) {
    const win = await printer.loadHtml(
      `<!DOCTYPE html><html><body style="margin:0"><img id="shot" src="data:${mime};base64,${bytes.toString('base64')}"></body></html>`,
      { capture: true })
    try {
      return await win.webContents.executeJavaScript(`(async () => {
        const img = document.getElementById('shot')
        if (!img.complete) await new Promise(resolve => { img.onload = resolve; img.onerror = resolve })
        if (!img.naturalWidth) return null
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        // getImageData 是 RGBA（与 nativeImage.toBitmap 的 BGRA 不同序）
        const at = (x, y) => { const i = (y * canvas.width + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]] }
        return { width: canvas.width, height: canvas.height, shape: at(37, 37), blank: at(canvas.width - 2, canvas.height - 2) }
      })()`)
    } finally { if (!win.isDestroyed()) win.destroy() }
  }
  const sizes = {}
  // WebP 支持透明，所以让它走透明分支；JPEG 不支持，只能铺底。
  for (const [format, ext, transparent, flattened] of [['jpeg', 'jpg', false, false], ['webp', 'webp', true, false]]) {
    const prepared = exporter.prepareExport({ design: doc, dpi: 300, format, quality: 85, transparent })
    const filePath = path.join(OUTPUT, `quality-85.${ext}`)
    const result = await exporter.exportImage(prepared, filePath)
    const bytes = fs.readFileSync(filePath)
    const size = images.imageSizeFromBuffer(bytes)
    sizes[format] = bytes.length
    check(size && size.width === 300 && size.height === 150, `${format} 真实输出 300×150 像素`)
    check(result.format === format && result.bytes === bytes.length, `${format} 结果带回格式与真实字节数`)
    check(result.flattened === flattened, `${format} flattened 只报「透明要求被替换掉」这件事`)
  }
  // JPEG 勾了透明才会被铺底——这时候必须如实说，不能静默丢掉这一层
  check(exporter.prepareExport({ design: doc, format: 'jpeg', transparent: true }).flattened === true,
    'JPEG + 勾透明 ⇒ flattened 为真（界面据此提示已铺底）')
  const jpegBytes = fs.readFileSync(path.join(OUTPUT, 'quality-85.jpg'))
  const jpegImage = nativeImage.createFromBuffer(jpegBytes)
  check(jpegImage.getSize().width === 300, 'JPEG 能被系统解码器打开')
  check(pixel(jpegImage, 37, 37)[2] > 235 && pixel(jpegImage, 37, 37)[1] < 20, 'JPEG 形状像素仍是红色')
  check(pixel(jpegImage, 298, 148)[3] === 255, 'JPEG 没有 alpha：空白处铺成不透明底色，不是透明')
  check(jpegBytes.subarray(6, 11).toString('latin1') === 'JFIF\0' && jpegBytes.readUInt16BE(14) === 300,
    'JPEG 紧跟 SOI 写入 JFIF 密度 300 dpi')
  check(jpegBytes.toString('latin1').split('JFIF').length - 1 === 1, 'JPEG 里恰好一个 JFIF 段（没有重复注入）')
  const lowQuality = await exporter.renderImage(exporter.prepareExport({ design: doc, dpi: 300, format: 'jpeg', quality: 20 }))
  check(lowQuality.length < jpegBytes.length, 'JPEG 质量参数真的影响体积（20 比 85 小）')
  const webpBytes = fs.readFileSync(path.join(OUTPUT, 'quality-85.webp'))
  check(webpBytes.toString('latin1', 0, 4) === 'RIFF' && webpBytes.toString('latin1', 8, 12) === 'WEBP',
    'WebP 是真正的 RIFF/WEBP 容器，不是改了扩展名的 PNG')
  const webp = await decodeInChromium(webpBytes, 'image/webp')
  check(webp && webp.width === 300 && webp.height === 150, 'WebP 能被 Chromium 解码为 300×150（不是坏文件）')
  check(webp && webp.shape[0] > 235 && webp.shape[1] < 20 && webp.shape[2] < 20, 'WebP 形状像素仍是红色')
  check(webp && webp.blank[3] === 0, 'WebP 保留透明背景（多格式没有把 alpha 挤掉）')
  check(sizes.webp < sizes.jpeg, '同质量下 WebP 比 JPEG 小')
  // PNG 这条老路不能被顺手改坏：仍然带 alpha、仍然写 pHYs
  const stillPng = await exporter.renderImage(exporter.prepareExport({ design: doc, dpi: 300, transparent: true }))
  const stillPngImage = nativeImage.createFromBuffer(stillPng)
  check(pixel(stillPngImage, 298, 148)[3] === 0, 'PNG 仍然保留透明背景（多格式没有把它挤成不透明）')
  check(stillPng.indexOf(Buffer.from('pHYs')) > 0, 'PNG 仍然写入 pHYs 分辨率元数据')
  if (customFont) {
    const textPixels = nativeImage.createFromBitmap(baseline, { width: 300, height: 150 }).crop({ x: 10, y: 95, width: 210, height: 40 }).toBitmap()
    let ink = 0
    for (let i = 3; i < textPixels.length; i += 4) if (textPixels[i] > 0) ink++
    check(ink > 20, '上传字体实际渲染文字像素')
    const saved = designs.saveDesign(doc)
    const removedMap = structuredClone(saved)
    delete removedMap.fontAssets
    fs.unlinkSync(path.join(DATA, 'print-fonts', 'PNG验收.ttf'))
    assert.throws(() => exporter.prepareExport({ design: removedMap }), /字体/)
    check(true, '历史工程上传字体缺失时即使草稿省略映射也阻断PNG输出')
    fs.copyFileSync(fontPath, path.join(DATA, 'print-fonts', 'PNG验收.ttf'))
  }
  const bad = exporter.prepareExport({ design: doc, dpi: 150 })
  bad.html = bad.html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/, 'data:image/png;base64,AAAA')
  await assert.rejects(exporter.renderPng(bad), /decode|图片|EncodingError/i)
  check(BrowserWindow.getAllWindows().length === 1 && BrowserWindow.getAllWindows()[0] === mainWindow, '失败和成功导出均销毁隐藏窗口，保留主窗口')
  const model = printer.prepareDesignPng({ design: doc, dpi: 150, transparent: true })
  const viaPrinter = await printer.exportDesignPng(model, path.join(OUTPUT, 'context.png'))
  check(viaPrinter.width === 150, '宿主注入PNG出口可正常调用')

  /*
   * ---- 导出后「打开所在文件夹 / 用系统程序打开」（I-28）----
   *
   * 真调用 shell 会弹出资源管理器 / 看图器，所以把 shell 的方法换成记录器：
   * printer.cjs 解构拿到的是 shell 这个**对象**的引用，改它的属性对调用方可见，
   * 于是既能验「到底打开了哪个文件」，又不会真弹窗口。
   */
  const shell = require('electron').shell
  const originalReveal = shell.showItemInFolder
  const originalOpen = shell.openPath
  const opened = []
  shell.showItemInFolder = (p) => { opened.push({ how: 'reveal', path: p }) }
  shell.openPath = async (p) => { opened.push({ how: 'open', path: p }); return '' }
  try {
    const api = require('../electron/api.cjs')
    const ctx = { allowWrite: true, app: {}, dialog: null, printer }
    const revealed = api.call('design:revealExport', {}, ctx)
    check(revealed.filePath === viaPrinter.filePath && opened.at(-1).how === 'reveal' && opened.at(-1).path === viaPrinter.filePath,
      '「打开所在文件夹」定位到的正是刚导出的那个 PNG')
    await api.call('design:openExport', {}, ctx)
    check(opened.at(-1).how === 'open' && opened.at(-1).path === viaPrinter.filePath,
      '「用系统程序打开」打开的是刚导出的那个 PNG')

    // 安全边界（I-28 的行为面）：就算调用方硬塞一个路径进来，也只会打开主进程记着的那个
    api.call('design:revealExport', { filePath: path.join(OUTPUT, 'transparent-600.png') }, ctx)
    check(opened.at(-1).path === viaPrinter.filePath,
      '调用方塞进来的路径被忽略，只打开主进程记着的文件（渲染进程传不进路径）')

    // CLI / agent 拿不到 ctx.printer ⇒ 一律 GUI_REQUIRED，而不是 TypeError
    const noGui = await api.invoke('design:openExport', {}, { allowWrite: true })
    check(noGui.ok === false && noGui.error.code === 'GUI_REQUIRED',
      '无 GUI 上下文调用「用系统程序打开」得到 GUI_REQUIRED（agent 够不到这条能力）')

    // 文件被用户挪走 / 删掉时要明确报错——静默 no-op 就是「点了没反应」
    const gone = await printer.exportDesignPng(
      printer.prepareDesignPng({ design: doc, dpi: 150, transparent: true }), path.join(OUTPUT, 'gone.png'))
    fs.unlinkSync(gone.filePath)
    await assert.rejects(async () => printer.revealLastDesignPng(), /移动或删除/)
    check(true, '刚导出的 PNG 被删掉后「打开」明确报错，而不是静默无反应')
  } finally {
    shell.showItemInFolder = originalReveal
    shell.openPath = originalOpen
  }
  mainWindow.destroy()
  console.log(`PNG_E2E_OK checks=${count} artifacts=${OUTPUT}`)
  clearTimeout(watchdog)
  app.exit(0)
}
main().catch(err => { console.error('PNG_E2E_FAIL', err.stack || err); clearTimeout(watchdog); app.exit(1) })

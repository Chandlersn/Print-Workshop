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
  const large = structuredClone(doc)
  large.artboard = { w: 210, h: 297, background: '#ffffff' }
  const largeOutput = await exporter.exportPng(exporter.prepareExport({ design: large, dpi: 600 }), path.join(OUTPUT, 'a4-600dpi.png'))
  check(largeOutput.width === 4961 && largeOutput.height === 7016, 'A4 600DPI超屏幕大图输出4961×7016原生像素')
  const largeImage = nativeImage.createFromPath(largeOutput.filePath)
  check(largeImage.getSize().width === 4961 && largeImage.getSize().height === 7016, 'A4高清PNG文件实际像素正确')
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
  mainWindow.destroy()
  console.log(`PNG_E2E_OK checks=${count} artifacts=${OUTPUT}`)
  clearTimeout(watchdog)
  app.exit(0)
}
main().catch(err => { console.error('PNG_E2E_FAIL', err.stack || err); clearTimeout(watchdog); app.exit(1) })

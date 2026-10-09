/** PNG output is rendered at its requested pixel size, independent of the editor viewport. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { normalizeDesign, renderDesign } = require('./design-layout.cjs')
const designs = require('./designs.cjs')
const { fontFaceCss } = require('./render-engine.cjs')
const { normalizeFamily } = require('./fonts.cjs')
const { resolveInsideDataDir } = require('./store.cjs')
const { imageSizeFromBuffer } = require('./images.cjs')

const LIMITS = Object.freeze({ edge: 16384, pixels: 40000000, workingBytes: 768 * 1024 * 1024 })
const DPI_VALUES = [150, 300, 600]
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function outputSize(artboard, dpi) {
  if (!DPI_VALUES.includes(dpi)) throw new Error('PNG 分辨率仅支持 150、300 或 600 DPI')
  if (!artboard || !Number.isFinite(artboard.w) || !Number.isFinite(artboard.h) || artboard.w <= 0 || artboard.h <= 0) throw new Error('PNG 画布尺寸无效')
  const width = Math.round(artboard.w * dpi / 25.4)
  const height = Math.round(artboard.h * dpi / 25.4)
  if (width < 1 || height < 1 || width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels) {
    throw new Error(`PNG 输出 ${width}×${height}px 超出限制：单边最多 ${LIMITS.edge}px、总像素最多 4000 万。请降低 DPI 或画布尺寸`)
  }
  return { width, height, dpi }
}

/** Pure Node preparation: freeze the current source/font bytes before the save dialog. */
function prepareExport({ design, dpi = 300, transparent = false } = {}) {
  if (typeof transparent !== 'boolean') throw new Error('PNG 透明背景选项必须为布尔值')
  const raw = normalizeDesign(design)
  const size = outputSize(raw.artboard, dpi)
  const doc = designs.resolveDraft(raw)
  const usedAssets = new Set(doc.layers.filter(layer => layer.visible && layer.type === 'image').map(layer => layer.assetId))
  let estimated = size.width * size.height * 12
  for (const id of usedAssets) {
    const asset = doc.assets[id]
    estimated += asset.width * asset.height * 4 + fs.statSync(resolveInsideDataDir(asset.path)).size * 3
  }
  for (const file of Object.values(doc.fontAssets)) estimated += fs.statSync(resolveInsideDataDir(`print-fonts/${file}`)).size * 3
  if (estimated > LIMITS.workingBytes) throw new Error('PNG 导出预计工作内存超过 768 MB，请降低 DPI 或减少图片素材')
  if (transparent) doc.artboard.background = 'transparent'
  const output = renderDesign(doc, {
    classPrefix: 'export-design', fontFamily: normalizeFamily,
    assetUrl: asset => `data:${asset.mime};base64,${fs.readFileSync(resolveInsideDataDir(asset.path)).toString('base64')}`,
  })
  const background = transparent ? 'transparent' : '#ffffff'
  const scale = dpi / 96
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    fontFaceCss(output.fontFamilies) + '\n' + output.css + '\n' +
    `html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;overflow:hidden;background:${background};}` +
    `#export-stage{position:absolute;left:0;top:0;transform-origin:0 0;transform:scale(${scale});}` +
    '</style></head><body><div id="export-stage">' + output.html + '</div></body></html>'
  return { ...size, name: doc.name, transparent, html }
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Add physical resolution metadata without decoding/re-encoding any pixels. */
function pngWithDpi(png, dpi) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG 渲染结果无效')
  const payload = Buffer.alloc(13)
  payload.write('pHYs')
  payload.writeUInt32BE(Math.round(dpi / 0.0254), 4)
  payload.writeUInt32BE(Math.round(dpi / 0.0254), 8)
  payload[12] = 1
  const length = Buffer.alloc(4); length.writeUInt32BE(9)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(payload))
  const parts = [PNG_SIGNATURE]
  let inserted = false
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) throw new Error('PNG 数据不完整')
    const end = offset + png.readUInt32BE(offset) + 12
    if (end > png.length) throw new Error('PNG 数据不完整')
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type !== 'pHYs') parts.push(png.subarray(offset, end))
    if (type === 'IHDR') { parts.push(length, payload, checksum); inserted = true }
    offset = end
  }
  if (!inserted) throw new Error('PNG 缺少图片头')
  return Buffer.concat(parts)
}

function outputPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.png$/i.test(filePath)) throw new Error('请指定以 .png 结尾的绝对保存路径')
  const target = path.resolve(filePath)
  const realParent = fs.realpathSync(path.dirname(target))
  const targets = [target, path.join(realParent, path.basename(target))]
  if (fs.existsSync(target)) targets.push(fs.realpathSync(target))
  const root = process.env.PRINTPRESS_DATA_DIR
  if (root) {
    const roots = [path.resolve(root)]
    if (fs.existsSync(root)) roots.push(fs.realpathSync(root))
    const managed = roots.flatMap(dir => ['design-assets', 'designs', 'print-fonts', 'print-bg'].map(name => path.join(dir, name)))
    for (const directory of [...managed]) if (fs.existsSync(directory)) managed.push(fs.realpathSync(directory))
    if (managed.some(directory => targets.some(file => {
      const relative = path.relative(directory, file)
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    }))) throw new Error('不能将导出文件写入应用管理的素材目录，请选择其他位置')
  }
  return target
}

function atomicWrite(filePath, bytes) {
  const target = outputPath(filePath)
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' })
    fs.renameSync(temp, target)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
  return target
}

async function renderPng(prepared) {
  const { width, height, dpi } = prepared
  let win
  let debug
  let timer
  try {
    win = await require('./printer.cjs').loadHtml(prepared.html, { capture: true })
    debug = win.webContents.debugger
    win.webContents.setZoomFactor(1)
    debug.attach('1.3')
    // Explicit emulation overrides Windows display scaling and browser zoom.
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await debug.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: prepared.transparent ? 0 : 1 } })
    const screenshot = await Promise.race([
      debug.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('PNG 渲染超时，请降低 DPI 或减少图片素材')), 30000) }),
    ])
    const bytes = Buffer.from(screenshot.data, 'base64')
    const actual = imageSizeFromBuffer(bytes)
    if (!actual || actual.width !== width || actual.height !== height) throw new Error(`PNG 输出像素不符：预期 ${width}×${height}，请重试导出`)
    return pngWithDpi(bytes, dpi)
  } catch (err) {
    // Chromium DOMException may cross executeJavaScript as an object without a message.
    throw new Error(`PNG 渲染失败：${err && err.message ? err.message : '图片或字体加载失败，请检查素材后重试'}`)
  } finally {
    clearTimeout(timer)
    if (win && !win.isDestroyed()) {
      try { if (debug && debug.isAttached()) debug.detach() } finally { win.destroy() }
    }
  }
}

async function exportPng(prepared, filePath, renderer = renderPng) {
  const target = outputPath(filePath)
  const bytes = await renderer(prepared)
  atomicWrite(target, bytes)
  return { canceled: false, filePath: target, width: prepared.width, height: prepared.height, dpi: prepared.dpi }
}

module.exports = { LIMITS, outputSize, prepareExport, pngWithDpi, outputPath, atomicWrite, renderPng, exportPng }

/** 出图按请求的像素尺寸渲染，与编辑器视口无关；PNG / JPEG / WebP 共用同一条渲染管线。 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { normalizeDesign, renderDesign, shadowRegion } = require('./design-layout.cjs')
const designs = require('./designs.cjs')
const { fontFaceCss } = require('./render-engine.cjs')
const { normalizeFamily } = require('./fonts.cjs')
const { resolveInsideDataDir } = require('./store.cjs')
const { imageSizeFromBuffer } = require('./images.cjs')
// 格式表与体积估算在纯模块里，渲染进程的导出面板读的是同一份（见 export-formats.cjs）。
const {
  FORMATS, KNOWN_EXTS, normalizeFormat, normalizeQuality, extensionOf, formatOfPath, estimateOutputBytes,
} = require('./export-formats.cjs')

const LIMITS = Object.freeze({ edge: 16384, pixels: 40000000, workingBytes: 768 * 1024 * 1024 })
const DPI_VALUES = [150, 300, 600]
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function outputSize(artboard, dpi) {
  if (!DPI_VALUES.includes(dpi)) throw new Error('输出分辨率仅支持 150、300 或 600 DPI')
  if (!artboard || !Number.isFinite(artboard.w) || !Number.isFinite(artboard.h) || artboard.w <= 0 || artboard.h <= 0) throw new Error('画布尺寸无效')
  const width = Math.round(artboard.w * dpi / 25.4)
  const height = Math.round(artboard.h * dpi / 25.4)
  if (width < 1 || height < 1 || width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels) {
    throw new Error(`输出 ${width}×${height}px 超出限制：单边最多 ${LIMITS.edge}px、总像素最多 4000 万。请降低 DPI 或画布尺寸`)
  }
  return { width, height, dpi }
}

/** Pure Node preparation: freeze the current source/font bytes before the save dialog. */
function prepareExport({ design, dpi = 300, transparent = false, format, quality } = {}) {
  if (typeof transparent !== 'boolean') throw new Error('透明背景选项必须为布尔值')
  const kind = normalizeFormat(format)
  const level = normalizeQuality(quality, kind)
  const raw = normalizeDesign(design)
  if (raw.layers.some(layer => layer.variable && layer.visible && !layer.editorOnly)) throw new Error('含变量图的工程请应用到模板，在打印中心选择名单导出 PDF；底图不包含名单照片')
  const size = outputSize(raw.artboard, dpi)
  const doc = designs.resolveDraft(raw)
  const usedAssets = new Set(doc.layers.filter(layer => layer.visible && layer.type === 'image' && !layer.variable).map(layer => layer.assetId))
  let estimated = size.width * size.height * 12
  for (const id of usedAssets) {
    const asset = doc.assets[id]
    estimated += asset.width * asset.height * 4 + fs.statSync(resolveInsideDataDir(asset.path)).size * 3
  }
  for (const layer of doc.layers) {
    if (!layer.visible || layer.editorOnly || layer.opacity === 0 || !layer.shadow) continue
    const region = shadowRegion(layer.w, layer.h, layer.shadow)
    const radians = layer.rotation * Math.PI / 180
    const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians))
    const widthPx = Math.ceil((region.width * cosine + region.height * sine) * dpi / 25.4)
    const heightPx = Math.ceil((region.width * sine + region.height * cosine) * dpi / 25.4)
    // Filter output, source alpha and intermediate buffers coexist during a high-DPI capture.
    estimated += widthPx * heightPx * 4 * 5
  }
  for (const file of Object.values(doc.fontAssets)) estimated += fs.statSync(resolveInsideDataDir(`print-fonts/${file}`)).size * 3
  if (estimated > LIMITS.workingBytes) throw new Error('导出预计工作内存超过 768 MB，请降低 DPI 或减少图片素材、阴影效果')
  /*
   * 透明与格式的取舍：JPEG 没有 alpha 通道，用户勾了透明也印不出透明——
   * 与其静默丢掉这一层，不如**铺上画布自己的底色**（用户眼前就是它），
   * 再用 `flattened` 把「这一层被替换掉了」如实报给界面。
   * 画布本身就是 transparent 时没有底色可铺，退回白色。
   */
  const wantsTransparent = transparent && FORMATS[kind].transparent
  const flattened = !FORMATS[kind].transparent && (transparent || raw.artboard.background === 'transparent')
  if (wantsTransparent) { doc.artboard.background = 'transparent'; delete doc.artboard.backgroundPaint }
  else if (flattened && doc.artboard.background === 'transparent') doc.artboard.background = '#ffffff'
  const output = renderDesign(doc, {
    classPrefix: 'export-design', fontFamily: normalizeFamily,
    assetUrl: asset => `data:${asset.mime};base64,${fs.readFileSync(resolveInsideDataDir(asset.path)).toString('base64')}`,
  })
  const background = wantsTransparent ? 'transparent' : '#ffffff'
  const scale = dpi / 96
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    fontFaceCss(output.fontFamilies) + '\n' + output.css + '\n' +
    `html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;overflow:hidden;background:${background};}` +
    `#export-stage{position:absolute;left:0;top:0;transform-origin:0 0;transform:scale(${scale});}` +
    '</style></head><body><div id="export-stage">' + output.html + '</div></body></html>'
  return { ...size, name: doc.name, format: kind, quality: level, transparent: wantsTransparent, flattened, html }
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

/**
 * 给 JPEG 写物理分辨率——**不重新编码任何像素**。
 *
 * JPEG 没有 PNG 那种 `pHYs`，DPI 只能落在 JFIF APP0 段的 density 字段
 * （`units=1` 表示「每英寸点数」）。编码器有没有吐 APP0 不能假设：
 * 这里统一「丢掉原有的 JFIF APP0、在 SOI 之后补一个自己的」，
 * 于是无论上游是 Chromium 还是别的编码器，结果都恰好一个 JFIF 段、密度正确。
 */
function jpegWithDpi(jpeg, dpi) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('JPEG 渲染结果无效')
  const density = Math.round(dpi)
  const app0 = Buffer.alloc(18)
  app0[0] = 0xff; app0[1] = 0xe0
  app0.writeUInt16BE(16, 2)          // 段长含长度字段自身
  app0.write('JFIF\0', 4, 'latin1')  // 标识
  app0[9] = 1; app0[10] = 1          // 版本 1.01
  app0[11] = 1                       // units = 1 ⇒ 密度单位为 dpi
  app0.writeUInt16BE(density, 12)
  app0.writeUInt16BE(density, 14)
  app0[16] = 0; app0[17] = 0         // 无缩略图
  const parts = [jpeg.subarray(0, 2), app0]
  let offset = 2
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) break
    const marker = jpeg[offset + 1]
    // SOS 之后是熵编码数据、EOI 就是文件尾，都没有长度字段
    if (marker === 0xda || marker === 0xd9) break
    // 无载荷的标记（TEM / RST / SOI）没有长度字段，跳过
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue }
    const length = jpeg.readUInt16BE(offset + 2)
    const end = offset + 2 + length
    if (length < 2 || end > jpeg.length) throw new Error('JPEG 数据不完整')
    const isJfif = marker === 0xe0 && jpeg.toString('latin1', offset + 4, offset + 9) === 'JFIF\0'
    if (!isJfif) parts.push(jpeg.subarray(offset, end))
    offset = end
  }
  parts.push(jpeg.subarray(offset))
  return Buffer.concat(parts)
}

/**
 * 导出体积估算——实现见 export-formats.cjs（渲染进程的导出面板要用同一份）。
 * 这里只做转发，好让出图相关的调用方只认一个模块。
 */

function outputPath(filePath, format) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('请指定绝对保存路径')
  const kind = format === undefined ? formatOfPath(filePath) : normalizeFormat(format)
  if (!kind) throw new Error(`无法从扩展名判断出图格式，请用 .${KNOWN_EXTS.join(' / .')} 结尾`)
  if (!FORMATS[kind].exts.includes(extensionOf(filePath))) {
    throw new Error(`保存路径的扩展名与 ${FORMATS[kind].label} 不符，请用 .${FORMATS[kind].exts.join(' / .')} 结尾`)
  }
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

function atomicWrite(filePath, bytes, format) {
  const target = outputPath(filePath, format)
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' })
    fs.renameSync(temp, target)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
  return target
}

async function renderImage(prepared) {
  const { width, height, dpi } = prepared
  const kind = normalizeFormat(prepared.format)
  const label = FORMATS[kind].label
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
    const request = { format: kind, fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }
    // CDP 只在有损格式上认 quality；PNG 传了会被拒，所以按格式决定要不要带。
    if (FORMATS[kind].quality !== null) request.quality = normalizeQuality(prepared.quality, kind)
    const screenshot = await Promise.race([
      debug.sendCommand('Page.captureScreenshot', request),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}渲染超时，请降低 DPI 或减少图片素材`)), 30000) }),
    ])
    const bytes = Buffer.from(screenshot.data, 'base64')
    // 先验像素、再写 DPI 元数据：注入的段不该参与尺寸校验。
    const actual = imageSizeFromBuffer(bytes)
    if (!actual || actual.width !== width || actual.height !== height) throw new Error(`${label}输出像素不符：预期 ${width}×${height}，请重试导出`)
    if (FORMATS[kind].dpi === 'phys') return pngWithDpi(bytes, dpi)
    if (FORMATS[kind].dpi === 'jfif') return jpegWithDpi(bytes, dpi)
    return bytes
  } catch (err) {
    // Chromium DOMException may cross executeJavaScript as an object without a message.
    throw new Error(`${label}渲染失败：${err && err.message ? err.message : '图片或字体加载失败，请检查素材后重试'}`)
  } finally {
    clearTimeout(timer)
    if (win && !win.isDestroyed()) {
      try { if (debug && debug.isAttached()) debug.detach() } finally { win.destroy() }
    }
  }
}

async function exportImage(prepared, filePath, renderer = renderImage) {
  const kind = normalizeFormat(prepared.format)
  const target = outputPath(filePath, kind)
  const bytes = await renderer(prepared)
  atomicWrite(target, bytes, kind)
  return {
    canceled: false, filePath: target, width: prepared.width, height: prepared.height,
    dpi: prepared.dpi, format: kind, bytes: bytes.length, flattened: prepared.flattened === true,
  }
}

module.exports = {
  LIMITS, DPI_VALUES, FORMATS, KNOWN_EXTS, outputSize, prepareExport,
  normalizeFormat, normalizeQuality, estimateOutputBytes,
  pngWithDpi, jpegWithDpi, outputPath, atomicWrite, formatOfPath,
  renderImage, exportImage,
  // 旧名保留：PNG 是默认格式，这两条等价于新名，外部调用方无需跟着改。
  renderPng: renderImage, exportPng: exportImage,
}
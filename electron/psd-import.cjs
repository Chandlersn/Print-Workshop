/** Photoshop import: inspect a bounded snapshot, then create a new project on confirmation. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')
const { BLEND_MODES, normalizeDesign } = require('./design-layout.cjs')
const { toUserMessage } = require('./user-error.cjs')

const MAX_FILE_MB = 512
const MAX_FILE = MAX_FILE_MB * 1024 * 1024
const MAX_MEMORY = 1024 * 1024 * 1024
const PARSE_TIMEOUT_MS = 120000
const TTL = 15 * 60 * 1000
const sessions = new Map()
const id = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const cleanName = (v, fallback) => String(v || fallback).replace(/[\x00-\x1f]/g, '').slice(0, 120) || fallback
const round = v => Math.round(v * 10000) / 10000

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0) }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const header = Buffer.alloc(8), tail = Buffer.alloc(4)
  header.writeUInt32BE(data.length); header.write(type, 4, 'ascii')
  tail.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])))
  return Buffer.concat([header, data, tail])
}
function pngFromPixels(image) {
  const { width, height, data } = image || {}
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 24000 || height > 24000 || width * height > 20000000 || !data || data.length !== width * height * 4 || data.BYTES_PER_ELEMENT !== 1) throw new Error('PSD 图层像素尺寸无效或超过限制')
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rows.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
  if (png.length > 64 * 1024 * 1024) throw new Error('PSD 中单个图层超过 64 MB，无法导入')
  return png
}
function color(c, fallback = '#000000') {
  if (!c || !['r','g','b'].every(k => Number.isFinite(c[k]))) return fallback
  return '#' + ['r','g','b'].map(k => Math.round(clamp(c[k], 0, 255)).toString(16).padStart(2, '0')).join('')
}
function rectangle(layer) {
  if (layer.vectorFill?.type !== 'color' || layer.vectorStroke?.strokeEnabled || layer.vectorStroke?.fillEnabled === false || (layer.mask && !layer.mask.fromVectorData && !layer.mask.disabled) || layer.vectorMask?.disable || layer.vectorMask?.invert || layer.vectorMask?.fillStartsWithAllPixels) return null
  const origins = layer.vectorOrigination?.keyDescriptorList
  const origin = origins?.length === 1 ? origins[0] : null
  const bounds = origin?.keyOriginShapeBoundingBox
  if (origin && !origin.keyShapeInvalidated && [1,2,5].includes(origin.keyOriginType) && bounds) {
    const x = bounds.left?.value, y = bounds.top?.value, right = bounds.right?.value, bottom = bounds.bottom?.value
    const radii = origin.keyOriginRRectRadii && Object.values(origin.keyOriginRRectRadii).map(v => v.value)
    const corners = origin.keyOriginBoxCorners
    const axisAligned = !corners || (corners.length === 4 && corners.every(p => Math.min(Math.abs(p.x-x),Math.abs(p.x-right)) < .05 && Math.min(Math.abs(p.y-y),Math.abs(p.y-bottom)) < .05))
    if ([x,y,right,bottom].every(Number.isFinite) && right-x >= 1 && bottom-y >= 1 && axisAligned && (!radii || (radii.length === 4 && radii.every(Number.isFinite) && Math.max(...radii)-Math.min(...radii) < .05))) return { type:origin.keyOriginType === 5 ? 'ellipse' : 'rect', x,y,w:right-x,h:bottom-y, radius:radii ? Math.max(...radii) : 0,fill:color(layer.vectorFill.color) }
  }
  const paths = layer.vectorMask?.paths
  if (!paths || paths.length !== 1 || paths[0].open || (paths[0].operation && paths[0].operation !== 'combine') || paths[0].knots?.length !== 4) return null
  const pts = paths[0].knots.map(k => k.points)
  if (pts.some(p => !p || p.length !== 6 || p.some(v => !Number.isFinite(v)) || Math.abs(p[0]-p[2]) > .05 || Math.abs(p[1]-p[3]) > .05 || Math.abs(p[4]-p[2]) > .05 || Math.abs(p[5]-p[3]) > .05)) return null
  const xs = pts.map(p => p[2]), ys = pts.map(p => p[3]), x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs)-x, h = Math.max(...ys)-y
  if (w < 1 || h < 1 || pts.some(p => Math.min(Math.abs(p[2]-x),Math.abs(p[2]-x-w)) > .05 || Math.min(Math.abs(p[3]-y),Math.abs(p[3]-y-h)) > .05) || new Set(pts.map(p => `${p[2] > x+w/2 ? 1 : 0},${p[3] > y+h/2 ? 1 : 0}`)).size !== 4) return null
  return { type:'rect', x, y, w, h, radius:0, fill: color(layer.vectorFill.color) }
}
function parse(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size < 26) throw new Error('PSD/PSB 文件无效或不完整')
  if (stat.size > MAX_FILE) throw new Error(`PSD/PSB 文件超过 ${MAX_FILE_MB} MB`)
  const bytes = fs.readFileSync(filePath)
  if (bytes.length > MAX_FILE) throw new Error(`PSD/PSB 文件超过 ${MAX_FILE_MB} MB`)
  if (bytes.toString('ascii',0,4) !== '8BPS' || ![1,2].includes(bytes.readUInt16BE(4))) throw new Error('这不是有效的 PSD/PSB 文件')
  if (bytes.readUInt16BE(22) !== 8 || bytes.readUInt16BE(24) !== 3) throw new Error('目前仅支持 8 位 RGB 的 PSD/PSB；请在 Photoshop 中转换后保存副本')
  const width = bytes.readUInt32BE(18), height = bytes.readUInt32BE(14)
  if (!width || !height || width > 24000 || height > 24000 || width * height > 20000000) throw new Error('PSD 画布超过导入限制（单边 24000 像素、总计 2000 万像素）')
  const { readPsd, initializeCanvas } = require('ag-psd')
  initializeCanvas(() => { throw new Error('PSD 不支持该画布格式') }, (w, h) => ({ width:w, height:h, data:new Uint8ClampedArray(w * h * 4) }))
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true, totalMemoryLimit: MAX_MEMORY })
  const ri = psd.imageResources?.resolutionInfo
  let dpi = ri?.horizontalResolution
  if (ri?.horizontalResolutionUnit === 'PPCM') dpi *= 2.54
  const warnings = []
  const note = (layer, message, details = {}) => warnings.push({ layer: cleanName(layer, '文档'), message, ...details })
  if (!Number.isFinite(dpi) || dpi < 1 || dpi > 2400) { dpi = 72; note('文档', '未找到有效分辨率，按 72 DPI 换算画布尺寸。') }
  const mm = n => round(n * 25.4 / dpi)
  if (mm(width) < 1 || mm(height) < 1 || mm(width) > 2000 || mm(height) > 2000) throw new Error('按 PSD 分辨率换算后的画布尺寸超出 1–2000 mm，请先调整分辨率')
  if (ri && ri.verticalResolution && Math.abs(ri.verticalResolution - ri.horizontalResolution) > 0.01) note('文档', '水平与垂直分辨率不同，按水平分辨率换算，尺寸可能有差异。')
  if (psd.imageResources?.iccProfile) note('文档', '嵌入色彩配置文件未转换，颜色可能与 Photoshop 不同。')
  const layers = [], groups = [], images = []
  function visit(children, parent = null, inheritedVisible = true, inheritedOpacity = 1, depth = 0) {
    if (depth > 20) throw new Error('PSD 分组嵌套过深')
    // ag-psd 的实际解码顺序与工程数组一致：从底到顶；分组成员也应保持原序。
    // 反转会让底图盖住上方内容。用重叠像素与原 PSD 合并画面验证，不能只核对图层列表。
    for (const layer of children) {
      const name = cleanName(layer.name, '图层')
      if (Array.isArray(layer.children)) {
        if (parent) note(name, '嵌套分组已展开到外层分组。')
        if (layer.blendMode && !['normal','pass through'].includes(layer.blendMode)) note(name, '分组混合模式未保留。')
        if (layer.mask || layer.vectorMask || layer.clipping || layer.effects) note(name, '分组的蒙版、剪贴或效果未保留。')
        const start = layers.length
        visit(layer.children, parent || name, inheritedVisible && !layer.hidden, inheritedOpacity * (layer.opacity ?? 1), depth + 1)
        if (!parent && layers.length - start >= 2) groups.push({ id: id('group'), name, layerIds: layers.slice(start).map(l => l.id) })
        if ((layer.opacity ?? 1) !== 1) note(name, '分组透明度已乘入各成员，重叠区域可能与 Photoshop 不同。')
        continue
      }
      if (layers.length >= 300) throw new Error('PSD 超过 300 个图层，无法导入')
      if (layer.adjustment) { note(name, '调整图层暂不支持，已跳过；画面可能不同。'); continue }
      const blend = String(layer.blendMode || 'normal').replaceAll(' ', '-')
      const base = { id: id('layer'), name, opacity: clamp((layer.opacity ?? 1) * inheritedOpacity,0,1), visible: inheritedVisible && !layer.hidden, locked: !!layer.protected?.all, blend: BLEND_MODES.includes(blend) ? blend : 'normal' }
      if (!BLEND_MODES.includes(blend)) note(name, `混合模式 ${layer.blendMode} 不支持，改为正常。`)
      if (layer.clipping) note(name, '剪贴蒙版未保留。')
      if (layer.fillOpacity !== undefined && layer.fillOpacity !== 1) note(name, '填充不透明度未保留。')
      if ((layer.mask && !layer.mask.fromVectorData && !layer.mask.disabled) || (layer.vectorMask && !layer.vectorFill)) note(name, '图层蒙版未保留，显示范围可能不同。')
      if (layer.effects) note(name, '图层效果未保留，外观可能不同。')
      if (layer.placedLayer) note(name, '智能对象转为图片，内部内容不可编辑。')
      const box = rectangle(layer)
      if (box) {
        layers.push({ ...base, type:box.type, x:mm(box.x), y:mm(box.y), w:mm(box.w), h:mm(box.h), radius:mm(box.radius), fill:box.fill, stroke:'transparent', strokeWidth:0 })
        continue
      }
      if (layer.text) {
        const t = layer.text, matrix = t.transform || [1,0,0,1,0,0], sx = Math.hypot(matrix[0],matrix[1]), sy = Math.hypot(matrix[2],matrix[3])
        const supported = t.orientation !== 'vertical' && sx > 0 && Math.abs(sx-sy) < .02*Math.max(sx,sy) && Math.abs(matrix[0]*matrix[2]+matrix[1]*matrix[3]) < .02*sx*sy && (layer.right-layer.left)>0 && (layer.bottom-layer.top)>0
        const str = String(t.text || '').replace(/\r\n?/g,'\n').replace(/\0/g,'')
        if (supported && str && str.length <= 20000) {
          const style = { ...(t.style || {}), ...(t.styleRuns?.[0]?.style || {}) }, fontSize = (style.fontSize || 12)*sx*72/dpi
          if (fontSize >= 1 && fontSize <= 1000) {
            const font = cleanName(style.font?.name, '')
            const lineHeightMm = fontSize * 25.4 / 72 * 1.2
            // 保存 PSD 自带的栅格预览供用户选择；原文件稍后可能变化，不能在确认时重新读取。
            let textPreview = null
            const img = layer.imageData
            if (img && img.width && img.height && img.data) {
              let visiblePixel = false
              for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) { visiblePixel = true; break }
              if (visiblePixel) {
                try { textPreview = { imageIndex:images.push(pngFromPixels(img))-1, x:mm(layer.left), y:mm(layer.top), w:mm(img.width), h:mm(img.height) } }
                catch { /* 无有效预览或像素过大时仍保留可编辑文字，不阻止导入。 */ }
              }
            }
            layers.push({ ...base, type:'text', x:mm(layer.left), y:mm(layer.top), w:Math.max(.01,mm(layer.right-layer.left)), h:Math.max(.01,mm(layer.bottom-layer.top),lineHeightMm), rotation:Math.atan2(matrix[1],matrix[0])*180/Math.PI, text:str, fontFamily:font, fontSize, color:color(style.fillColor), bold:!!style.fauxBold, align:['center','right'].includes(t.paragraphStyle?.justification) ? t.paragraphStyle.justification : 'left', textPreview })
            const detail = { category:'editable-text', layerId:base.id }
            note(name, '作为可编辑文字导入时，字形、定位和换行可能与 Photoshop 不完全一致。', detail)
            if ((t.styleRuns?.length || 0) > 1) note(name, '多段文字样式仅保留第一段。', detail)
            if (t.warp?.style && t.warp.style !== 'none') note(name, '文字变形未保留。', detail)
            continue
          }
        }
        note(name, '文字转换为图片，不能直接编辑文字。')
      } else if (layer.vectorFill || layer.vectorMask) note(name, '复杂矢量形状转换为图片。')
      const img = layer.imageData
      if (!img || !img.width || !img.height) { note(name, '图层没有可用像素，已跳过。'); continue }
      const png = pngFromPixels(img), imageIndex = images.push(png)-1
      layers.push({ ...base, type:'image', imageIndex, x:mm(layer.left || 0), y:mm(layer.top || 0), w:mm(img.width), h:mm(img.height) })
    }
  }
  visit(psd.children || [])
  if (!layers.length && psd.imageData) {
    const imageIndex = images.push(pngFromPixels(psd.imageData))-1
    layers.push({ id:id('layer'), name:'合并画面', type:'image', imageIndex, x:0, y:0, w:mm(width), h:mm(height) })
    note('文档', '没有可导入的图层，已使用合并画面。')
  }
  if (!layers.length) throw new Error('PSD 没有可导入的图层或合并画面')
  const name = cleanName(path.basename(filePath, path.extname(filePath)), '导入的 Photoshop 工程')
  // Validate converted geometry and group limits before showing a confirmable report.
  const temporaryAssets = {}, temporaryLayers = layers.map(layer => {
    if (layer.type !== 'image') return layer
    const png = images[layer.imageIndex], hash = layer.imageIndex.toString(16).padStart(64, '0'), assetId = `asset_${hash}`
    temporaryAssets[assetId] = { id:assetId,path:`design-assets/${hash}.png`,width:png.readUInt32BE(16),height:png.readUInt32BE(20),mime:'image/png',name:layer.name }
    return { ...layer, assetId }
  })
  try { normalizeDesign({ name,artboard:{w:mm(width),h:mm(height),background:'transparent'},layers:temporaryLayers,groups,assets:temporaryAssets }) }
  catch (err) { throw new Error(`PSD 转换后的工程超出编辑器限制：${toUserMessage(err)}`) }
  return { name, artboard:{w:mm(width),h:mm(height),background:'transparent'}, layers, groups, images, warnings, width, height, dpi:round(dpi), totalBytes:bytes.length }
}
function expire() { for (const [token, session] of sessions) if (session.expires < Date.now()) sessions.delete(token) }
async function inspect(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('PSD 路径无效')
  expire()
  if (sessions.size >= 3) throw new Error('待导入文件过多，请先完成或取消之前的导入')
  const result = await new Promise((resolve,reject) => {
    const worker = new Worker(__filename, { workerData:{filePath} })
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('PSD 解析超时，请缩小文件后重试')) }, PARSE_TIMEOUT_MS)
    worker.once('message', message => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message.result) })
    worker.once('error', err => { clearTimeout(timer); reject(err) })
    worker.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error('PSD 解析进程异常退出')) } })
  })
  const token = 'psd_' + crypto.randomBytes(12).toString('hex')
  const timer = setTimeout(() => sessions.delete(token), TTL)
  timer.unref()
  sessions.set(token, { result, expires:Date.now()+TTL, timer })
  const textLayers = result.layers.filter(layer => layer.type === 'text')
  const previewLayers = textLayers.filter(layer => layer.textPreview)
  return { token, kind:'psd', name:result.name, artboard:result.artboard, totalBytes:result.totalBytes, stats:{layerCount:result.layers.length,imageCount:result.layers.filter(layer => layer.type === 'image').length,fontCount:0}, width:result.width,height:result.height,dpi:result.dpi,warnings:result.warnings,fonts:[],unresolved:[], textPreview:{ available:previewLayers.length, unavailable:textLayers.length-previewLayers.length, layerIds:previewLayers.map(layer => layer.id) } }
}
function cancel(token) { const session = sessions.get(token); if (session) clearTimeout(session.timer); return { ok:sessions.delete(token), canceled:true } }
function commit(token, { rasterizeText = false } = {}) {
  expire()
  const session = sessions.get(token)
  if (!session) throw new Error('PSD 检查已失效，请重新选择文件')
  const data = session.result, designs = require('./designs.cjs'), assets = {}
  const layers = data.layers.map(layer => {
    const { textPreview, ...original } = layer
    const preview = layer.type === 'text' && rasterizeText ? textPreview : null
    if (layer.type !== 'image' && !preview) return original
    const imageIndex = preview ? preview.imageIndex : layer.imageIndex
    const asset = designs.importImageBuffer(Buffer.from(data.images[imageIndex]), layer.name + '.png', 'managed')
    assets[asset.id] = asset
    const { imageIndex: _imageIndex, ...out } = original
    return preview ? { ...out, type:'image', x:preview.x, y:preview.y, w:preview.w, h:preview.h, rotation:0, assetId:asset.id } : { ...out, assetId:asset.id }
  })
  const result = designs.saveDesign(normalizeDesign({ name:data.name,artboard:data.artboard,layers,groups:data.groups,assets }))
  clearTimeout(session.timer)
  sessions.delete(token)
  return result
}
if (!isMainThread && workerData?.filePath) {
  try { parentPort.postMessage({ result:parse(workerData.filePath) }) } catch (err) { parentPort.postMessage({ error:err.message || 'PSD 解析失败' }) }
}
module.exports = { inspect, cancel, commit, parse, pngFromPixels }

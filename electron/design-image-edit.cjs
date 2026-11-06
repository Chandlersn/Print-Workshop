/** Image edits use source pixel coordinates, independent of canvas zoom/crop/rotation. */
const EDIT_LIMITS = Object.freeze({ strokes: 200, points: 20000 })
function normalizeErasures(value, width, height) {
  if (!Array.isArray(value) || value.length > EDIT_LIMITS.strokes) throw new Error('擦除操作最多支持 200 笔')
  let count = 0
  const num = (v, min, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error('擦除位置或大小超出原图范围')
    return v
  }
  return value.map(s => {
    if (!s || typeof s !== 'object') throw new Error('擦除区域无效')
    if (s.type === 'rect') {
      const r = { type: 'rect', x: num(s.x, 0, width), y: num(s.y, 0, height), w: num(s.w, 0.001, width), h: num(s.h, 0.001, height) }
      if (r.x + r.w > width + 1e-7 || r.y + r.h > height + 1e-7) throw new Error('擦除区域超出原图范围')
      return r
    }
    if (s.type !== 'brush' || !Array.isArray(s.points) || !s.points.length) throw new Error('擦除笔迹无效')
    count += s.points.length
    if (count > EDIT_LIMITS.points) throw new Error('擦除笔迹过多，请先应用当前修改')
    return { type: 'brush', size: num(s.size, 1, Math.max(width, height)), points: s.points.map(p => ({ x: num(p?.x, 0, width), y: num(p?.y, 0, height) })) }
  })
}
function erasureMarkup(strokes) {
  return strokes.map(s => s.type === 'rect'
    ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="black"/>`
    : s.points.length === 1
      ? `<circle cx="${s.points[0].x}" cy="${s.points[0].y}" r="${s.size / 2}" fill="black"/>`
      : `<path d="${s.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')}" fill="none" stroke="black" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
}
function erasureMask(strokes, width, height) {
  if (!strokes?.length) return ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><mask id="e" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:luminance"><rect width="${width}" height="${height}" fill="white"/>${erasureMarkup(strokes)}</mask></defs><rect width="${width}" height="${height}" fill="white" mask="url(#e)"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
/** Change the visible rectangle while keeping source pixels at their existing canvas positions. */
function cropImageLayer(layer, crop) {
  const old = layer.crop || { x: 0, y: 0, w: 1, h: 1 }
  const w = layer.w * crop.w / old.w, h = layer.h * crop.h / old.h
  const dx = ((crop.x + crop.w / 2 - old.x) / old.w - 0.5) * layer.w * (layer.flipX ? -1 : 1)
  const dy = ((crop.y + crop.h / 2 - old.y) / old.h - 0.5) * layer.h * (layer.flipY ? -1 : 1)
  const a = (layer.rotation || 0) * Math.PI / 180
  const round = n => Math.round(n * 1e6) / 1e6
  return { ...layer, crop, w: round(w), h: round(h), x: round(layer.x + layer.w / 2 + dx * Math.cos(a) - dy * Math.sin(a) - w / 2), y: round(layer.y + layer.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) - h / 2) }
}
/** Snapshot the variable frame as a normal editor-only image, preserving its current fit. */
function referenceImageLayer(layer, asset, id) {
  if (!layer?.variable || layer.type !== 'image' || !asset?.width || !asset?.height) throw new Error('请先选择有照片的变量图')
  const sample = { ...layer, id, name: `参考样图 · ${layer.name}`.slice(0, 120), assetId: asset.id, referenceFor: layer.id, editorOnly: true, locked: false, crop: { x: 0, y: 0, w: 1, h: 1 }, flipX: false, flipY: false }
  delete sample.variable; delete sample.bindColumn; delete sample.fit; delete sample.focal; delete sample.radius
  const ratio = asset.width / asset.height, frameRatio = layer.w / layer.h
  const focal = layer.focal || { x: 0.5, y: 0.5 }
  if (layer.fit === 'contain') {
    sample.w = Math.min(layer.w, layer.h * ratio); sample.h = sample.w / ratio
    const dx = (layer.w - sample.w) * (focal.x - 0.5), dy = (layer.h - sample.h) * (focal.y - 0.5)
    const angle = (layer.rotation || 0) * Math.PI / 180
    sample.x = layer.x + layer.w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - sample.w / 2
    sample.y = layer.y + layer.h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - sample.h / 2
  } else {
    sample.crop.w = Math.min(1, frameRatio / ratio); sample.crop.h = Math.min(1, ratio / frameRatio)
    sample.crop.x = (1 - sample.crop.w) * focal.x; sample.crop.y = (1 - sample.crop.h) * focal.y
  }
  return sample
}
module.exports = { EDIT_LIMITS, normalizeErasures, erasureMask, cropImageLayer, referenceImageLayer }

/** Shared variable-photo recipe. All positions are relative to the output frame. */
const VERSION = 3
const clamp = (value, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, value))
function normalizeRecipe(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('照片处理设置无效')
  const number = (v, fallback, min, max) => {
    const n = v === undefined ? fallback : Number(v)
    if (!Number.isFinite(n) || n < min || n > max) throw new Error('照片处理参数超出范围')
    return n
  }
  const width = number(value.width, 1200, 64, 4096), height = number(value.height, 1600, 64, 4096)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 16000000) throw new Error('样板尺寸必须为整数，且不超过 1600 万像素')
  const fit = value.fit || 'contain'
  if (!['contain', 'cover'].includes(fit)) throw new Error('照片适配方式无效')
  const edgeTarget = value.edgeTarget || 'frame'
  if (!['frame', 'subject'].includes(edgeTarget)) throw new Error('羽化范围无效')
  return { version: VERSION, width, height, fit, cutout: Boolean(value.cutout), subjectFit: Boolean(value.subjectFit),
    scale: number(value.scale, 1, .25, 2), offsetX: number(value.offsetX, 0, -1, 1), offsetY: number(value.offsetY, 0, -1, 1),
    bottom: Boolean(value.bottom), bottomStart: number(value.bottomStart, .75, 0, .99), bottomOpacity: number(value.bottomOpacity, 0, 0, 1),
    edge: Boolean(value.edge), edgeWidth: number(value.edgeWidth, .08, .001, .4), edgeOpacity: number(value.edgeOpacity, .5, 0, 1), edgeTarget,
    faceAlign: Boolean(value.faceAlign), faceHeight: number(value.faceHeight, .3, .08, .8), eyeY: number(value.eyeY, .32, .1, .75) }
}
function orientedRgba(bitmap, width, height, orientation = 1) {
  if (bitmap.length !== width * height * 4) throw new Error('照片像素数据不完整')
  const w = orientation >= 5 ? height : width, h = orientation >= 5 ? width : height
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let dx = x, dy = y
    if (orientation === 2) dx = width - 1 - x
    if (orientation === 3) { dx = width - 1 - x; dy = height - 1 - y }
    if (orientation === 4) dy = height - 1 - y
    if (orientation === 5) { dx = y; dy = x }
    if (orientation === 6) { dx = height - 1 - y; dy = x }
    if (orientation === 7) { dx = height - 1 - y; dy = width - 1 - x }
    if (orientation === 8) { dx = y; dy = width - 1 - x }
    const src = (y * width + x) * 4, dst = (dy * w + dx) * 4, a = bitmap[src + 3]
    // NativeImage exposes a premultiplied BGRA bitmap on Windows.
    for (let c = 0; c < 3; c++) data[dst + c] = a ? bitmap[src + 2 - c] * 255 / a : 0
    data[dst + 3] = a
  }
  return { data, width: w, height: h }
}
function sampleMask(data, width, height, x, y) {
  x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1)
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1), tx = x - x0, ty = y - y0
  return (data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx) * (1 - ty) + (data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx) * ty
}
function applyMatte(image, mask, mw, mh) {
  let subject = 0
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4 + 3
    let a = clamp(sampleMask(mask, mw, mh, (x + .5) * mw / image.width - .5, (y + .5) * mh / image.height - .5))
    if (a < .015) a = 0
    if (a > .97) a = 1
    image.data[i] *= a
    if (image.data[i] > 32) subject++
  }
  if (subject < image.width * image.height * .002) throw new Error('没有检测到可用的人物，请关闭抠图或更换样板照片')
}
function alphaBounds(image) {
  let left = image.width, top = image.height, right = -1, bottom = -1
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.data[(y * image.width + x) * 4 + 3] > 32) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  if (right < left) throw new Error('照片没有可见主体')
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}
function innerDistances(data, width, height) {
  const distance = new Float32Array(width * height), diagonal = Math.SQRT2
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x
    distance[i] = data[i * 4 + 3] < 8 ? 0 : Math.min(x + 1, y + 1, width - x, height - y, 1e6)
    if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1)
    if (y) { distance[i] = Math.min(distance[i], distance[i - width] + 1); if (x) distance[i] = Math.min(distance[i], distance[i - width - 1] + diagonal); if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i - width + 1] + diagonal) }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x
    if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + 1] + 1)
    if (y + 1 < height) { distance[i] = Math.min(distance[i], distance[i + width] + 1); if (x) distance[i] = Math.min(distance[i], distance[i + width - 1] + diagonal); if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + width + 1] + diagonal) }
  }
  return distance
}
function photoTransform(image, recipe, faces = []) {
  const { width, height } = recipe
  const bounds = recipe.subjectFit ? alphaBounds(image) : { x: 0, y: 0, w: image.width, h: image.height }
  let factor = (recipe.fit === 'cover' ? Math.max(width / bounds.w, height / bounds.h) : Math.min(width / bounds.w, height / bounds.h)) * recipe.scale
  let left = (width - bounds.w * factor) / 2 - bounds.x * factor + recipe.offsetX * width / 2
  let top = (height - bounds.h * factor) / 2 - bounds.y * factor + recipe.offsetY * height / 2
  const issues = []
  if (recipe.faceAlign) {
    if (faces.length !== 1) issues.push(faces.length ? 'multiple-faces' : 'no-face')
    else {
      const face = faces[0], eye = { x: (face.eyes[0].x + face.eyes[1].x) / 2, y: (face.eyes[0].y + face.eyes[1].y) / 2 }
      factor = height * recipe.faceHeight / face.h * recipe.scale
      left = width / 2 - eye.x * factor + recipe.offsetX * width / 2
      top = height * recipe.eyeY - eye.y * factor + recipe.offsetY * height / 2
      if (face.x * factor + left < 0 || (face.x + face.w) * factor + left > width || face.y * factor + top < 0 || (face.y + face.h) * factor + top > height) issues.push('face-clipped')
    }
  }
  const visible = recipe.cutout ? alphaBounds(image) : bounds
  if (recipe.cutout && (visible.x * factor + left < -1 || (visible.x + visible.w) * factor + left > width + 1 || visible.y * factor + top < -1)) issues.push('subject-clipped')
  if (factor > 1.5) issues.push('upscaled')
  return { factor, left, top, issues, faces }
}
function processPixels(image, input, transform) {
  const recipe = normalizeRecipe(input), { width, height } = recipe
  const { factor, left, top } = transform || photoTransform(image, recipe)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = (x + .5 - left) / factor - .5, sy = (y + .5 - top) / factor - .5
    if (sx < -.5 || sx > image.width - .5 || sy < -.5 || sy > image.height - .5) continue
    const x0 = Math.floor(clamp(sx, 0, image.width - 1)), y0 = Math.floor(clamp(sy, 0, image.height - 1)), tx = clamp(sx - x0), ty = clamp(sy - y0)
    const indexes = [y0 * image.width + x0, y0 * image.width + Math.min(x0 + 1, image.width - 1), Math.min(y0 + 1, image.height - 1) * image.width + x0, Math.min(y0 + 1, image.height - 1) * image.width + Math.min(x0 + 1, image.width - 1)]
    const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]
    let alpha = 0; const rgb = [0, 0, 0]
    for (let n = 0; n < 4; n++) { const i = indexes[n] * 4, a = image.data[i + 3] * weights[n]; alpha += a; for (let c = 0; c < 3; c++) rgb[c] += image.data[i + c] * a }
    const dst = (y * width + x) * 4
    for (let c = 0; c < 3; c++) data[dst + c] = alpha ? rgb[c] / alpha : 0
    data[dst + 3] = alpha
  }
  const distances = recipe.edge && recipe.edgeTarget === 'subject' ? innerDistances(data, width, height) : null
  // Fade the visible photograph/person, including when fitting left transparent
  // padding above or below it. The canvas's empty bottom is not the subject edge.
  const bottomBounds = recipe.bottom ? alphaBounds({ data, width, height }) : null
  const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t) }
  const radius = recipe.edgeWidth * Math.min(width, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let alpha = 1
    if (recipe.bottom) alpha *= 1 - (1 - recipe.bottomOpacity) * smooth(((y - bottomBounds.y) / Math.max(1, bottomBounds.h - 1) - recipe.bottomStart) / (1 - recipe.bottomStart))
    if (recipe.edge) { const distance = distances ? distances[y * width + x] : Math.min(x, y, width - 1 - x, height - 1 - y); alpha *= recipe.edgeOpacity + (1 - recipe.edgeOpacity) * smooth(distance / radius) }
    data[(y * width + x) * 4 + 3] *= alpha
  }
  return { data, width, height }
}
module.exports = { VERSION, normalizeRecipe, orientedRgba, applyMatte, processPixels, photoTransform, alphaBounds, sampleMask }

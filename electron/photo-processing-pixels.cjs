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
    faceAlign: Boolean(value.faceAlign), faceHeight: number(value.faceHeight, .3, .08, .8), eyeY: number(value.eyeY, .32, .1, .75),
    sharpen: Boolean(value.sharpen), sharpenStrength: number(value.sharpenStrength, .6, 0, 1) }
}
// Sharpen colour only, using alpha-weighted neighbours so transparent padding
// cannot introduce dark fringes. Preserve alpha and suppress tiny differences.
function sharpenPixels(data, width, height, strength) {
  if (!strength) return
  const source = new Uint8ClampedArray(data)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (!source[i + 3]) continue
    const left = x ? i - 4 : i, right = x + 1 < width ? i + 4 : i
    const top = y ? i - width * 4 : i, bottom = y + 1 < height ? i + width * 4 : i
    const a = source[left + 3], b = source[right + 3], c = source[top + 3], d = source[bottom + 3]
    const weight = a + b + c + d
    if (!weight) continue
    for (let channel = 0; channel < 3; channel++) {
      const average = (source[left + channel] * a + source[right + channel] * b + source[top + channel] * c + source[bottom + channel] * d) / weight
      const difference = source[i + channel] - average
      if (Math.abs(difference) > 2) data[i + channel] = source[i + channel] + strength * difference
    }
  }
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
function normalizeProtectPolygon(points) {
  if (points == null) return null
  if (!Array.isArray(points) || points.length < 3 || points.length > 512) throw new Error('人物选区需要 3 至 512 个点')
  const polygon = points.map(point => {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error('人物选区超出图片范围')
    return { x: point.x, y: point.y }
  })
  let area = 0
  for (let i = 0; i < polygon.length; i++) { const a = polygon[i], b = polygon[(i + 1) % polygon.length]; area += a.x * b.y - b.x * a.y }
  if (Math.abs(area) < 0.0001) throw new Error('人物选区太小或没有围成有效区域，请重新圈选')
  return polygon
}
// The lasso is a loose spatial hint, not an opaque mask. Keep contextual
// padding for hair and limbs outside a roughly drawn outline.
function subjectRegion(image, points) {
  const polygon = normalizeProtectPolygon(points)
  if (!polygon) return null
  const xs = polygon.map(point => point.x * image.width), ys = polygon.map(point => point.y * image.height)
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys)
  const padX = Math.max(16, (right - left) * .25), padY = Math.max(16, (bottom - top) * .25)
  const x = Math.max(0, Math.floor(left - padX)), y = Math.max(0, Math.floor(top - padY))
  const r = Math.min(image.width, Math.ceil(right + padX)), b = Math.min(image.height, Math.ceil(bottom + padY))
  return { x, y, width: Math.max(1, r - x), height: Math.max(1, b - y) }
}
function subjectPrior(image, mw, mh, region, polygon) {
  const distance = new Float32Array(mw * mh), dx = region.width / mw, dy = region.height / mh
  const diagonal = Math.hypot(dx, dy), infinity = image.width + image.height + 1
  for (let y = 0; y < mh; y++) {
    const scanY = (region.y + (y + .5) * dy) / image.height, crossings = []
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length]
      if ((a.y > scanY) !== (b.y > scanY)) crossings.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y))
    }
    crossings.sort((a, b) => a - b)
    let k = 0
    for (let x = 0; x < mw; x++) {
      const scanX = (region.x + (x + .5) * dx) / image.width
      while (k < crossings.length && scanX >= crossings[k]) k++
      distance[y * mw + x] = k % 2 ? 0 : infinity
    }
  }
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const i = y * mw + x
    if (x) distance[i] = Math.min(distance[i], distance[i - 1] + dx)
    if (y) { distance[i] = Math.min(distance[i], distance[i - mw] + dy); if (x) distance[i] = Math.min(distance[i], distance[i - mw - 1] + diagonal); if (x + 1 < mw) distance[i] = Math.min(distance[i], distance[i - mw + 1] + diagonal) }
  }
  for (let y = mh - 1; y >= 0; y--) for (let x = mw - 1; x >= 0; x--) {
    const i = y * mw + x
    if (x + 1 < mw) distance[i] = Math.min(distance[i], distance[i + 1] + dx)
    if (y + 1 < mh) { distance[i] = Math.min(distance[i], distance[i + mw] + dy); if (x) distance[i] = Math.min(distance[i], distance[i + mw - 1] + diagonal); if (x + 1 < mw) distance[i] = Math.min(distance[i], distance[i + mw + 1] + diagonal) }
  }
  const radius = Math.max(6, Math.min(region.width, region.height) * .15)
  for (let i = 0; i < distance.length; i++) {
    const t = clamp((distance[i] - radius * .3) / (radius * .7))
    distance[i] = 1 - t * t * (3 - 2 * t)
  }
  return distance
}
function applySubjectMatte(image, mask, mw, mh, points, region) {
  const polygon = normalizeProtectPolygon(points)
  if (!polygon || !region) throw new Error('请先圈选人物的大致范围')
  const prior = subjectPrior(image, mw, mh, region, polygon)
  let subject = 0
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4 + 3
    if (x < region.x || x >= region.x + region.width || y < region.y || y >= region.y + region.height) { image.data[i] = 0; continue }
    const mx = (x + .5 - region.x) * mw / region.width - .5, my = (y + .5 - region.y) * mh / region.height - .5
    let alpha = clamp(sampleMask(mask, mw, mh, mx, my))
    if (alpha < .015) alpha = 0
    if (alpha > .97) alpha = 1
    image.data[i] *= alpha * sampleMask(prior, mw, mh, mx, my)
    if (image.data[i] > 32) subject++
  }
  if (subject < Math.max(4, region.width * region.height * .002)) throw new Error('选区内未识别到可用人物，请扩大范围或重新圈选')
}
function applyMatte(image, mask, mw, mh, protectedArea = null) {
  const polygon = normalizeProtectPolygon(protectedArea)
  let subject = 0
  for (let y = 0; y < image.height; y++) {
    const intersections = []
    if (polygon) {
      const scanY = (y + .5) / image.height
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length]
        if ((a.y > scanY) !== (b.y > scanY)) intersections.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y))
      }
      intersections.sort((a, b) => a - b)
    }
    let interval = 0
    for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4 + 3
    const scanX = (x + .5) / image.width
    while (interval < intersections.length && scanX >= intersections[interval]) interval++
    let a = interval % 2 ? 1 : clamp(sampleMask(mask, mw, mh, (x + .5) * mw / image.width - .5, (y + .5) * mh / image.height - .5))
    if (a < .015) a = 0
    if (a > .97) a = 1
    image.data[i] *= a
    if (image.data[i] > 32) subject++
    }
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
  if (recipe.sharpen) sharpenPixels(data, width, height, recipe.sharpenStrength)
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
module.exports = { VERSION, normalizeRecipe, normalizeProtectPolygon, subjectRegion, applySubjectMatte, orientedRgba, applyMatte, processPixels, photoTransform, alphaBounds, sampleMask }

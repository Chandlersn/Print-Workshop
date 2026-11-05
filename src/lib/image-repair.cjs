/** Fill a selected region by interpolating its surrounding pixels, preserving all unselected pixels.
 * RGBA pixels and mask alpha share the same dimensions. Supports opaque and transparent source images.
 */
async function repairImagePixels(data, mask, width, height, options = {}) {
  const count = width * height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== count * 4 || mask.length !== count) throw new Error('图片修复数据无效')
  if (count > 12000000) throw new Error('选区过大，请缩小选区或分多次修复。')
  const result = new Uint8ClampedArray(data)
  const horizontal = new Float32Array(count)
  const canceled = options.canceled || (() => false)
  const pause = options.yield || (() => new Promise(resolve => setTimeout(resolve, 0)))
  let changed = 0
  // Each masked run is interpolated between the two closest unmasked endpoints.
  // A one-sided run continues the available edge colour to the image boundary.
  function sample(offset, end, step, start, stop, pixel) {
    const left = start > 0 ? offset + (start - 1) * step : -1
    const right = stop < end ? offset + stop * step : -1
    if (left < 0 && right < 0) return null
    const distance = left < 0 ? stop - pixel : right < 0 ? pixel - start + 1 : Math.min(pixel - start + 1, stop - pixel)
    const t = left < 0 ? 1 : right < 0 ? 0 : (pixel - start + 1) / (stop - start + 1)
    const a = left < 0 ? right : left, b = right < 0 ? left : right
    return { a: a * 4, b: b * 4, t, weight: 1 / Math.max(1, distance) }
  }
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) { if (canceled()) throw new Error('修复已取消'); await pause() }
    const base = y * width
    for (let x = 0; x < width;) {
      if (!mask[base + x]) { x++; continue }
      const start = x
      while (x < width && mask[base + x]) x++
      for (let px = start; px < x; px++) {
        const i = base + px, s = sample(base, width, 1, start, x, px)
        changed++
        if (!s) continue
        horizontal[i] = s.weight
        for (let c = 0; c < 4; c++) result[i * 4 + c] = data[s.a + c] * (1 - s.t) + data[s.b + c] * s.t
      }
    }
  }
  if (!changed) throw new Error('请先用画笔或矩形选中需要修复的区域。')
  for (let x = 0; x < width; x++) {
    if (x % 64 === 0) { if (canceled()) throw new Error('修复已取消'); await pause() }
    for (let y = 0; y < height;) {
      if (!mask[y * width + x]) { y++; continue }
      const start = y
      while (y < height && mask[y * width + x]) y++
      for (let py = start; py < y; py++) {
        const i = py * width + x, s = sample(x, height, width, start, y, py)
        const weight = horizontal[i]
        if (!s && !weight) throw new Error('选区没有可参考的周围背景，请缩小选区。')
        for (let c = 0; c < 4; c++) {
          const vertical = s ? data[s.a + c] * (1 - s.t) + data[s.b + c] * s.t : 0
          const value = s ? (result[i * 4 + c] * weight + vertical * s.weight) / (weight + s.weight) : result[i * 4 + c]
          const alpha = mask[i] / 255
          result[i * 4 + c] = value * alpha + data[i * 4 + c] * (1 - alpha)
        }
      }
    }
  }
  return result
}
module.exports = { repairImagePixels }

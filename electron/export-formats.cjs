/**
 * 出图格式白名单——**唯一权威源**，Vue 与 Node 共用（定位同 design-layout.cjs）。
 *
 * 为什么不放在 design-export.cjs 里：那个模块要 `fs` / `path` / `crypto`，
 * 渲染进程 import 不了，格式表就会在界面里被抄成第二份（抄了必漂移）。
 * 这里刻意**只用纯字符串处理**（连 `path.extname` 都不用，见 extensionOf），
 * 于是导出面板与出图实现读的是同一张表。
 *
 * 字段含义：
 * - `transparent`：该格式**能不能**承载透明像素。JPEG 不能，勾了透明就自动铺底
 *   （见 design-export 的 prepareExport），并把这件事如实报给界面。
 * - `quality`：有损格式的默认质量；PNG 为 `null`（无损，质量参数对它无意义）。
 * - `dpi`：物理分辨率的落法。PNG 走 `pHYs`；JPEG 走 JFIF APP0 的 density 字段；
 *   **WebP 没有公认的 DPI 容器**（塞进 EXIF 也不是所有看图器认），如实不写——
 *   界面必须说明，别让用户以为文件里带了 DPI。
 * - `exts`：接受的扩展名，`.jpg` 与 `.jpeg` 等价。
 */
const FORMATS = Object.freeze({
  png: { mime: 'image/png', label: 'PNG 图片', exts: ['png'], transparent: true, quality: null, dpi: 'phys' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG 图片', exts: ['jpg', 'jpeg'], transparent: false, quality: 90, dpi: 'jfif' },
  webp: { mime: 'image/webp', label: 'WebP 图片', exts: ['webp'], transparent: true, quality: 80, dpi: 'none' },
})

/** 所有被接受的扩展名（不含点），供报错文案使用。 */
const KNOWN_EXTS = Object.freeze([...new Set(Object.values(FORMATS).flatMap(format => format.exts))])

function normalizeFormat(value) {
  if (value === undefined || value === null || value === '') return 'png'
  const key = String(value).toLowerCase()
  // `.jpg` 是 `.jpeg` 的通行别名，两者落到同一个格式上。
  const canonical = key === 'jpg' ? 'jpeg' : key
  if (!Object.hasOwn(FORMATS, canonical)) throw new Error(`不支持的出图格式：${value}（仅支持 ${Object.keys(FORMATS).join('、')}）`)
  return canonical
}

function normalizeQuality(value, format) {
  const fallback = FORMATS[format].quality
  if (fallback === null) return null
  if (value === undefined || value === null || value === '') return fallback
  const quality = Number(value)
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('图片质量必须是 1~100 的整数')
  return quality
}

/** 取扩展名（小写、不含点）。刻意不用 `path.extname`，好让渲染进程也能 import 本模块。 */
function extensionOf(filePath) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filePath))
  return match ? match[1].toLowerCase() : ''
}

/** 按扩展名反查格式；无法识别时返回 null，由调用方决定怎么报错。 */
function formatOfPath(filePath) {
  const ext = extensionOf(filePath)
  return ext ? Object.keys(FORMATS).find(kind => FORMATS[kind].exts.includes(ext)) || null : null
}

/**
 * 导出体积估算——**是模型，不是预言**。
 *
 * 编码器体积由内容复杂度决定，事前不可能算准；这里只保证三件可测的事：
 * 量级对得上、同格式下质量越高估得越大、WebP 估得比同质量 JPEG 小。
 * 所以界面上一律写「约」，导出完成后用**真实字节数**覆盖它。
 *
 * PNG 是无损的，质量滑杆对它没有意义，估出来的数字也帮不了用户做任何决定
 * （矢量内容与照片能差几十倍）——因此**如实返回 null**，界面直接不显示。
 */
const JPEG_BYTES_PER_PIXEL = Object.freeze([[0, 0.02], [50, 0.12], [75, 0.25], [90, 0.5], [95, 0.75], [100, 1.2]])
function bytesPerPixel(anchors, quality) {
  const q = Math.min(100, Math.max(0, quality))
  for (let i = 1; i < anchors.length; i++) {
    if (q > anchors[i][0]) continue
    const [lowQ, lowValue] = anchors[i - 1]
    const [highQ, highValue] = anchors[i]
    const ratio = highQ === lowQ ? 1 : (q - lowQ) / (highQ - lowQ)
    // 在对数空间插值：字节数随质量是乘法式增长，线性插值会把中段估得偏高。
    return lowValue * Math.pow(highValue / lowValue, ratio)
  }
  return anchors[anchors.length - 1][1]
}
function estimateOutputBytes({ width, height, format, quality } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('输出尺寸无效')
  const kind = normalizeFormat(format)
  if (FORMATS[kind].quality === null) return null
  const level = normalizeQuality(quality, kind)
  const perPixel = bytesPerPixel(JPEG_BYTES_PER_PIXEL, level) * (kind === 'webp' ? 0.6 : 1)
  return Math.round(width * height * perPixel)
}

module.exports = { FORMATS, KNOWN_EXTS, normalizeFormat, normalizeQuality, extensionOf, formatOfPath, estimateOutputBytes }

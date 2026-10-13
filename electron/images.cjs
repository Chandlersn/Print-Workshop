/**
 * 图片尺寸检测：纯解析字节，零依赖。
 * 支持 PNG（IHDR）与 JPEG（SOF 标记扫描），覆盖底图上传场景。
 */

function pngSize(buf) {
  // PNG 签名 8 字节 + IHDR 长度/类型 8 字节 + 宽高各 4 字节
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue }
    const marker = buf[i + 1]
    // SOF0~SOF15（除 DHT=C4 / DAC=CC / RST 段）携带宽高
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    const len = buf.readUInt16BE(i + 2)
    i += 2 + len
  }
  return null
}

/**
 * WebP：RIFF 容器，尺寸藏在第一个 chunk 里，三种编码各不相同。
 * - `VP8X`（扩展）：画布宽高各占 3 字节小端，存的是「实际值 - 1」
 * - `VP8 `（有损）：帧头 3 字节 tag + 3 字节起始码，之后宽高各 2 字节小端（低 14 位）
 * - `VP8L`（无损）：1 字节签名后 4 字节里塞了 14 位宽 + 14 位高，同样存「实际值 - 1」
 */
function webpSize(buf) {
  // RIFF 头 12 字节 + chunk 头 8 字节 = 20；各编码还要再多读几个字节，逐个下面再判。
  if (buf.length < 20) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8X') {
    if (buf.length < 30) return null
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  }
  if (chunk === 'VP8 ') {
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (buf.length < 25 || buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

/**
 * 按内容嗅探图片类型——**不信任调用方给的文件名 / 扩展名**。
 *
 * 拖拽与剪贴板粘贴场景下，前端传来的文件名完全不可信（可以随手把别的东西改名成 .png）。
 * 所以真实格式一律以字节判定；同时只认 PNG / JPEG 两种「确实能读出尺寸」的，
 * WebP 的尺寸解析尚未实现，因此上传入口只提供 PNG / JPEG。
 */
function sniffImageExt(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return '.png'
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  return null
}

/**
 * 从内存字节读图片尺寸：拖拽 / 剪贴板粘贴时用，不需要先落盘。
 *
 * WebP 也在这里解——但**上传入口仍然只收 PNG / JPEG**（见 `sniffImageExt`）。
 * 加 WebP 解析是为了验出图（design-export 的 WebP 导出要核对真实像素），
 * 不是放开素材导入；素材格式要扩，得连着看缩略图、打印解码与体积预算一起改。
 */
function imageSizeFromBuffer(buf) {
  return pngSize(buf) || jpegSize(buf) || webpSize(buf)
}

function imageSize(filePath, fs) {
  return imageSizeFromBuffer(fs.readFileSync(filePath))
}

module.exports = { pngSize, jpegSize, webpSize, sniffImageExt, imageSizeFromBuffer, imageSize }


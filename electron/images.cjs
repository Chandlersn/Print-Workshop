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
 * 按内容嗅探图片类型——**不信任调用方给的文件名 / 扩展名**。
 *
 * 拖拽与剪贴板粘贴场景下，前端传来的文件名完全不可信（可以随手把别的东西改名成 .png）。
 * 所以真实格式一律以字节判定；同时只认 PNG / JPEG 两种「确实能读出尺寸」的，
 * webp 虽然在允许扩展名里但尺寸解析不支持，存进去也画不出来，故一律拒绝。
 */
function sniffImageExt(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return '.png'
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  return null
}

/** 从内存字节读图片尺寸：拖拽 / 剪贴板粘贴时用，不需要先落盘 */
function imageSizeFromBuffer(buf) {
  return pngSize(buf) || jpegSize(buf)
}

function imageSize(filePath, fs) {
  return imageSizeFromBuffer(fs.readFileSync(filePath))
}

module.exports = { pngSize, jpegSize, sniffImageExt, imageSizeFromBuffer, imageSize }

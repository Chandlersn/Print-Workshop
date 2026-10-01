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

function imageSize(filePath, fs) {
  const buf = fs.readFileSync(filePath)
  return pngSize(buf) || jpegSize(buf)
}

module.exports = { pngSize, jpegSize, imageSize }

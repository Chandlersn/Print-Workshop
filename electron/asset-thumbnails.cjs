/**
 * 素材缩略图适配器（Electron 宿主层）。
 *
 * 列表里几百张图不能每次都拿原件喂给渲染进程——原件最大的好几 MB。
 * 这里用 Electron 的 nativeImage 把图压到最长边 320px 的 PNG 缓存，
 * 纯 Node 下没有这能力，所以放在宿主层，由 ipc.cjs 注入 ctx.thumbs。
 *
 * 领域层（asset-library.cjs）只要求回调签名 `{ buffer, maxSide } -> Buffer|null`，
 * 不关心是不是 nativeImage；本文件是「宿主解码能力」的唯一实现点。
 */
const { nativeImage } = require('electron')

/**
 * @param {{ buffer: Buffer, maxSide: number }} input
 * @returns {Buffer|null} 缩略图 PNG 字节；解码失败或空图返回 null（上层退化为无缩略图占位）
 */
function makeThumbnail({ buffer, maxSide }) {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return null
  const size = image.getSize()
  const longest = Math.max(size.width, size.height) || 1
  const scale = Math.min(1, maxSide / longest)
  const resized = scale < 1
    ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
    : image
  return resized.toPNG()
}

module.exports = { makeThumbnail }

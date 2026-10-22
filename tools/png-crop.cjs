#!/usr/bin/env node
/**
 * 证书局部裁剪 —— 目视核对形近字用
 *
 * 背景：2481×3508 的成品图在缩略图下「钥/玥」「街/节」这类只差一个偏旁的字看不出来，
 * 而「一字之差」恰好是这批数据最高频的错误（指导老师、学校名）。
 * 本工具纯 Node 解码 PNG（无第三方依赖），把指定矩形裁出来并可选放大，
 * 输出的小图不会被预览层二次压缩，字形可辨。
 *
 * 用法：
 *   node tools/png-crop.cjs <源图> <输出图> [x y w h] [scale]
 *   省略 x y w h 时默认裁「就读学校 + 指导教师」两行（2481×3508 版式下 y=2130 起 330 高）
 *
 * 例：
 *   node tools/png-crop.cjs "证书/1000_某某.png" /tmp/a.png 380 2130 1250 330 2
 */
const fs = require('fs')
const zlib = require('zlib')

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(buf) {
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

/** 解 PNG：支持 8bit 灰度/RGB/RGBA；不支持调色板与隔行（出片不会用到） */
function decode(file) {
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG：' + file)

  let off = 8
  let ihdr = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('缺 IHDR')

  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]

  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth)
  if (interlace) throw new Error('不支持隔行 PNG')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    line.copy(cur)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      if (ft === 1) cur[i] = (cur[i] + a) & 0xff
      else if (ft === 2) cur[i] = (cur[i] + b) & 0xff
      else if (ft === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    prev = cur
  }
  return { width, height, channels, data: out }
}

function crop(img, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) {
    throw new Error(`裁剪区超出图像范围 ${img.width}x${img.height}：${x},${y} ${w}x${h}`)
  }
  const { width, channels, data } = img
  const out = Buffer.alloc(w * h * channels)
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * width + x) * channels
    data.copy(out, row * w * channels, s, s + w * channels)
  }
  return { width: w, height: h, channels, data: out }
}

/** 最近邻放大：核对字形要的是原像素，插值会让偏旁糊成一片 */
function encode(img, outFile, scale = 1) {
  const { width, height, channels, data } = img
  const w = width * scale
  const h = height * scale
  const raw = Buffer.alloc((w * channels + 1) * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * channels + 1)
    raw[rowStart] = 0
    const srcY = Math.floor(y / scale)
    for (let x = 0; x < w; x++) {
      const s = (srcY * width + Math.floor(x / scale)) * channels
      const d = rowStart + 1 + x * channels
      for (let c = 0; c < channels; c++) raw[d + c] = data[s + c]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0
  fs.writeFileSync(outFile, Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]))
  return { w, h }
}

function main(argv) {
  const [src, dst, xs, ys, ws, hs, ss] = argv
  if (!src || !dst) {
    console.error('用法: node tools/png-crop.cjs <源图> <输出图> [x y w h] [scale]')
    return 2
  }
  const scale = Number(ss || 1)
  const img = decode(src)
  // 默认区域对准成品证书的「就读学校 / 指导教师」两行
  const x = Number(xs ?? Math.round(img.width * 0.153))
  const y = Number(ys ?? Math.round(img.height * 0.607))
  const w = Number(ws ?? Math.round(img.width * 0.504))
  const h = Number(hs ?? Math.round(img.height * 0.094))
  const out = encode(crop(img, x, y, w, h), dst, scale)
  console.log(`源 ${img.width}x${img.height} → 裁 ${x},${y} ${w}x${h} ×${scale} → ${out.w}x${out.h}`)
  console.log('输出 ' + dst)
  return 0
}

if (require.main === module) process.exit(main(process.argv.slice(2)))

module.exports = { decode, crop, encode }

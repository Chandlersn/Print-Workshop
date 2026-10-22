#!/usr/bin/env node
/**
 * 把项目级 Agent Skill 打成分发包（zip）。
 *
 * 为什么自己写 zip 而不用 exec 调 python 脚本或 PowerShell：
 *   - 项目的零原生依赖原则同样适用于脚本工具，不引 archiver/adm-zip；
 *   - skill-creator 的 package_skill.py 在 WorkBuddy 安装目录里，路径随安装位置变化，
 *     不能写进 npm script（换台机器就断）；
 *   - PowerShell 的 Compress-Archive 只在 Windows 有，且对中文路径的编码不可控。
 * Node 自带的 zlib.deflateRawSync 够用，剩下的只是 zip 头部的几十行。
 *
 * 产物刻意放 packages/ 而不是 dist/：dist/ 是 vite 的产物目录，每次 build 都会被清空，
 * 分包放在那里会在下一次打包时无声消失。
 *
 * 用法：
 *   npm run pack:skill                  # 打包到 packages/
 *   node scripts/pack-skill.cjs --check # 只校验 skill 结构，不写文件
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, '.workbuddy', 'skills', 'batch-output-integrity')
const OUT_DIR = path.join(ROOT, 'packages')
const OUT = path.join(OUT_DIR, 'batch-output-integrity.zip')
const CHECK_ONLY = process.argv.includes('--check')

let bad = 0
const fail = (msg) => { bad++; console.error(`[pack:skill] FAIL - ${msg}`) }
const ok = (msg) => console.log(`[pack:skill] ok   - ${msg}`)

// —— 结构校验：skill 少了 SKILL.md 就是一包死文件，装上去也不会被识别 ——
if (!fs.existsSync(SRC)) fail(`skill 目录不存在：${SRC}`)
const skillMd = path.join(SRC, 'SKILL.md')
if (!fs.existsSync(skillMd)) fail('缺少 SKILL.md')
else {
  const text = fs.readFileSync(skillMd, 'utf-8')
  // 行尾必须容忍 CRLF：仓库开了 autocrlf，clone 到 Windows 后工作区全是 \r\n，
  // 只认 \n 会让「打包」在别人机器上直接失败（本机第一次就踩了）。
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) fail('SKILL.md 缺少 YAML frontmatter')
  else {
    if (!/^name:\s*\S+/m.test(m[1])) fail('frontmatter 缺少 name')
    if (!/^description:\s*\S+/m.test(m[1])) fail('frontmatter 缺少 description')
    else ok('frontmatter 含 name / description')
  }
}

/** 递归收集待打包文件，路径相对 SRC，统一用 / 分隔（zip 规范）。 */
function walk(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(abs, rel))
    else out.push({ abs, rel })
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

// —— 最小 zip 写入：deflate + CRC32，只用到 ZIP 规范里必需的那几个字段 ——
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** DOS 时间/日期（zip 只支持这个精度，够用）。 */
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function makeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  const now = dosTime(new Date())

  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel, 'utf-8')
    const raw = e.data
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    // 压缩后反而更大就存原文（store），别为了「压缩」把包撑大
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)                 // version needed
    local.writeUInt16LE(0x0800, 6)             // flag: 文件名按 UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8) // method
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, body)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)                   // version made by
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10)
    cen.writeUInt16LE(now.time, 12)
    cen.writeUInt16LE(now.date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)              // 本地头偏移
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

if (bad) {
  console.error(`[pack:skill] 结构校验未通过（${bad} 项），没有生成 zip`)
  process.exit(1)
}

const files = walk(SRC)
if (!files.length) fail('没有可打包的文件')
const TEXT_EXT = /[.](md|txt|json|ya?ml)$/i
// 文本统一成 LF 再入包：同一个 skill 在 Win / mac / Linux 打出来的 zip 内容一致，
// 免得「分发包里的行尾取决于谁在哪台机器打的」。
const entries = files.map((f) => ({
  rel: f.rel,
  data: TEXT_EXT.test(f.rel)
    ? Buffer.from(fs.readFileSync(f.abs, 'utf-8').replace(/\r\n/g, '\n'), 'utf-8')
    : fs.readFileSync(f.abs),
}))

if (CHECK_ONLY) {
  ok(`结构可打包：${entries.length} 个文件 / ${entries.reduce((n, e) => n + e.data.length, 0)} 字节`)
  console.log('[pack:skill] --check 模式，未写文件')
  process.exit(0)
}

const zip = makeZip(entries)
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(OUT, zip)
ok(`已生成 ${path.relative(ROOT, OUT)}（${entries.length} 个文件 / ${zip.length} 字节）`)
for (const e of entries) console.log(`       + ${e.rel}`)

/**
 * 数据层：JSON 原子读写。
 * 原子写 = 先写临时文件再 rename，进程中途被杀也不会留半截文件。
 * 目录由主进程入口决定（开发态仓库 data/，打包后 %APPDATA%/data）。
 */
const path = require('path')
const fs = require('fs')

const DATA_DIR = process.env.PRINTPRESS_DATA_DIR

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`)
}

function loadJson(name) {
  const fp = filePath(name)
  if (!fs.existsSync(fp)) return null
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'))
  } catch (err) {
    // 坏文件不吞：抛错让上层决策（后续可加 .bak 自动恢复）
    throw new Error(`JSON 解析失败 ${fp}: ${err.message}`)
  }
}

function saveJson(name, value) {
  const fp = filePath(name)
  // 目录可能不存在（首次写入/测试环境），自足建目录不依赖调用方
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${fp}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(tmp, fp)
  return { ok: true, path: fp }
}

module.exports = { loadJson, saveJson }

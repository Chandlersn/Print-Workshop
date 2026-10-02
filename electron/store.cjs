/**
 * 数据层：JSON 原子读写 + 存储路径守卫。
 * 原子写 = 先写临时文件再 rename，进程中途被杀也不会留半截文件。
 * 目录由主进程入口决定（开发态仓库 data/，打包后 %APPDATA%/data）。
 */
const path = require('path')
const fs = require('fs')

const DATA_DIR = process.env.PRINTPRESS_DATA_DIR

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`)
}

/**
 * 把存储里的相对路径解析为数据目录内的绝对路径，**拒绝任何越界**。
 *
 * 为什么必须有：background（底图）、snapshot（快照）都来自 JSON 文件，
 * 而 JSON 是用户可触达的文件（README 鼓励备份/迁库）。少了这道校验，
 * `background: "../x"` 就能删掉数据目录外的文件、`snapshot: "../x"` 就能读出来。
 * 协议层（main.cjs 的 pp://）已做同级防护，存储层这里补齐——两处都要有。
 *
 * @param {string} rel 存储中的相对路径（如 'print-bg/xxx.png'）
 * @returns {string} 数据目录内的绝对路径
 * @throws 路径越界 / 非字符串时抛错，调用方不得吞掉
 */
function resolveInsideDataDir(rel) {
  if (typeof rel !== 'string' || !rel.trim()) {
    throw new Error(`非法的存储路径: ${String(rel)}`)
  }
  // 绝对路径直接拒绝：存储里只应出现相对路径
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
    throw new Error(`存储路径必须是相对路径，收到: ${rel}`)
  }
  const base = path.resolve(DATA_DIR)
  const abs = path.resolve(base, rel)
  // path.relative 为空表示同一目录；'..' 开头或为绝对路径均表示已跳出数据目录
  const inside = path.relative(base, abs)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`存储路径越界（必须位于数据目录内）: ${rel}`)
  }
  return abs
}

/**
 * 读取 JSON。
 * - 文件不存在 → null（上层按「首次运行」处理）
 * - 内容损坏 / 类型为 null → 视为损坏：先把原文件改名留存（.corrupt-<ts>），
 *   再尝试从 .bak 恢复；恢复失败才抛错。
 *   不能静默返回空数组：那会让上层下一次 persistAll 把用户数据整体覆盖掉。
 * - 期望数组但读到对象等类型错配 → 同上按损坏处理。
 */
function loadJson(name, { expect = null } = {}) {
  const fp = filePath(name)
  if (!fs.existsSync(fp)) return null
  let raw
  try {
    raw = fs.readFileSync(fp, 'utf-8')
  } catch (err) {
    throw new Error(`读取失败 ${fp}: ${err.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return recoverCorrupt(name, fp, `JSON 解析失败: ${err.message}`)
  }
  // null 是合法 JSON 但不是合法数据（一号文件就是 null 一定是坏了）
  if (parsed === null || (expect === 'array' && !Array.isArray(parsed))) {
    return recoverCorrupt(name, fp, expect === 'array' ? '内容不是数组' : '内容为 null')
  }
  return parsed
}

/** 损坏兜底：留存 .corrupt-<ts> → 试 .bak → 都不行才抛错（宁可报错也不静默清空用户数据） */
function recoverCorrupt(name, fp, why) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const corruptPath = `${fp}.corrupt-${ts}`
  try {
    fs.renameSync(fp, corruptPath)
  } catch {
    // 连改名都失败（文件被占用等）：直接抛，别赌
    throw new Error(`${name}.json 损坏且无法留存（${why}）：${fp}`)
  }
  const bak = `${fp}.bak`
  if (fs.existsSync(bak)) {
    try {
      const back = JSON.parse(fs.readFileSync(bak, 'utf-8'))
      fs.writeFileSync(fp, JSON.stringify(back, null, 2), 'utf-8')
      console.warn(`[store] ${name}.json 损坏（${why}），已从 .bak 恢复；原文件留存为 ${path.basename(corruptPath)}`)
      return back
    } catch {
      /* .bak 也不可用，走下面的抛错 */
    }
  }
  throw new Error(
    `${name}.json 损坏（${why}），且无可用备份。原文件已留存为 ${path.basename(corruptPath)}，` +
    '请检查该文件后手动修复，或删除它让应用按空数据启动'
  )
}

/**
 * 原子写。失败时清理临时文件——否则 Windows 上被杀毒/索引器占用时，
 * 残留的 .tmp 会一直堆着（实测过 EPERM 抖动）。
 */
function saveJson(name, value) {
  const fp = filePath(name)
  // 目录可能不存在（首次写入/测试环境），自足建目录不依赖调用方
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${fp}.tmp`
  // 备份必须在 rename 之前做：rename 之后 fp 已是新内容，copy 到的就不是上一版了
  try {
    if (fs.existsSync(fp)) fs.copyFileSync(fp, `${fp}.bak`)
  } catch { /* .bak 是加分项，失败不阻断主流程 */ }
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
    fs.renameSync(tmp, fp)
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* 清理失败不影响主错误 */ }
    throw new Error(`写入失败 ${fp}: ${err.message}`)
  }
  return { ok: true, path: fp }
}

module.exports = { loadJson, saveJson, resolveInsideDataDir }
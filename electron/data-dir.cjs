/**
 * 数据目录决策（领域层，不依赖 electron，可独立测试）。
 *
 * 优先级：用户自定义目录（bootstrap 配置）> 打包默认（userData/data）> 开发默认（appPath/data）。
 * bootstrap 配置存 userData 根的 data-dir.json——它在默认数据目录之外，
 * 因此「数据目录指到哪里」这件事本身不随数据迁移而丢失。
 */
const fs = require('fs')
const path = require('path')

const BOOTSTRAP_FILE = 'data-dir.json'

/** 读取自定义数据目录配置；无配置/配置非法返回 null */
function readCustomDataDir(userDataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(userDataDir, BOOTSTRAP_FILE), 'utf-8'))
    if (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir.trim()) {
      return cfg.dataDir.trim()
    }
  } catch { /* 无配置或损坏 → 视为未自定义 */ }
  return null
}

/** 写入/清除自定义目录配置（dataDir 传 null/undefined 即清除，恢复默认） */
function writeCustomDataDir(userDataDir, dataDir) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const fp = path.join(userDataDir, BOOTSTRAP_FILE)
  if (dataDir) {
    fs.writeFileSync(fp, JSON.stringify({ dataDir }, null, 2), 'utf-8')
  } else {
    fs.rmSync(fp, { force: true })
  }
  return { ok: true }
}

/** 目录可写探测：建目录 + 写删探针文件 */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${Date.now()}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 嵌套守卫：目标目录不得与当前数据目录相同或互为父子
 * （把数据目录迁到自己的子目录里，复制会无限递归；迁到父目录会把旧数据一起搬走）。
 * 返回 null 表示安全，否则返回中文原因。
 */
function nestingIssue(target, current) {
  const t = path.resolve(target)
  const c = path.resolve(current)
  if (t === c) return '新目录与当前数据目录相同'
  const rel = path.relative(c, t)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '新目录不能在当前数据目录内部'
  const relBack = path.relative(t, c)
  if (relBack && !relBack.startsWith('..') && !path.isAbsolute(relBack)) return '新目录不能是当前数据目录的祖先目录'
  return null
}

/** 递归复制目录（合并语义：目标已存在的同名文件被覆盖） */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
  }
}

/**
 * 启动时数据目录决策（唯一权威定义源）。
 * 自定义配置存在且可写 → 用之；配置了但不可写 → 忽略并回退默认（不阻塞启动）。
 */
function resolveDataDir({ isPackaged, userDataDir, appPath }) {
  const fallback = isPackaged
    ? path.join(userDataDir, 'data')
    : path.join(appPath, 'data')
  const custom = readCustomDataDir(userDataDir)
  if (custom && isWritableDir(custom)) {
    return { dataDir: custom, custom: true, fallback }
  }
  return { dataDir: fallback, custom: false, fallback }
}

module.exports = {
  BOOTSTRAP_FILE,
  readCustomDataDir,
  writeCustomDataDir,
  isWritableDir,
  nestingIssue,
  copyDirSync,
  resolveDataDir,
}

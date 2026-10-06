/**
 * 系统缓存：大小汇总、一键释放，以及「运行时删不掉的留到下次启动清」。
 *
 * 为什么需要「下次启动」这一手（实测结论）：
 * Chromium 运行时自己持有 GPUCache / DawnCache，应用**运行期间**删它们必然拿到
 * EPERM——而这两个目录恰恰是缓存体积的大头。但**启动早期**（GPU 进程还没打开它们）
 * 删得掉。所以把删不掉的记进 pending 文件，下次启动第一件事就是清它。
 *
 * 不静默吞异常：以前这里 `catch {}` 把 EPERM 吃掉了，界面于是「点了没反应」——
 * 用户看不到任何结果，也无从知道为什么。
 *
 * 纯 Node 模块，不依赖 electron：userDataDir 由调用方（main.cjs / api.cjs）传入。
 */

const fs = require('fs')
const path = require('path')

const PENDING_FILE = 'cache-cleanup-pending.json'

/**
 * 可安全清理的系统缓存目录（Chromium 运行时自动生成，删掉会按需重建）。
 * 刻意排除 data（用户数据）/ Local Storage / Session Storage / Network / config
 * —— 那些是应用状态，不是缓存，删了会丢东西。
 */
const SYSTEM_CACHE_DIRS = [
  'Cache', 'GPUCache', 'Code Cache', 'DawnCache', 'DawnGraphiteCache',
  'blob_storage', 'ShaderCache', 'GrShaderCache', 'Media Cache',
]

/** 递归求目录字节数；个别文件读不到就跳过，不因为一个文件放弃整个统计 */
function dirSize(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) total += dirSize(p)
        else total += fs.statSync(p).size
      } catch { /* 无权读取，跳过 */ }
    }
  } catch { /* 目录不存在/无权限，视为 0 */ }
  return total
}

function pendingPath(userDataDir) {
  return path.join(userDataDir, PENDING_FILE)
}

/** 读「待清理」清单；文件不存在或损坏都当作空清单（不能因此卡住启动） */
function readPending(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingPath(userDataDir), 'utf-8'))
    const dirs = Array.isArray(raw && raw.dirs) ? raw.dirs : []
    // 只认白名单里的名字：清单文件可被手工编辑，不能让 `..` 之类的越界路径流进来
    return dirs.filter((n) => SYSTEM_CACHE_DIRS.includes(n))
  } catch {
    return []
  }
}

/** 覆写待清理清单；传空数组即删除清单文件 */
function writePending(userDataDir, dirs) {
  const fp = pendingPath(userDataDir)
  try {
    const uniq = [...new Set(dirs)].filter((n) => SYSTEM_CACHE_DIRS.includes(n))
    if (!uniq.length) {
      fs.rmSync(fp, { force: true })
      return []
    }
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.writeFileSync(fp, JSON.stringify({ dirs: uniq, at: new Date().toISOString() }, null, 2), 'utf-8')
    return uniq
  } catch {
    return []
  }
}

/** 缓存大小汇总。pending 是「已排队、下次启动清」的目录名 */
function cacheInfo(userDataDir) {
  let size = 0
  const entries = []
  for (const name of SYSTEM_CACHE_DIRS) {
    const d = path.join(userDataDir, name)
    if (!fs.existsSync(d)) continue
    const s = dirSize(d)
    size += s
    entries.push({ name, size: s })
  }
  return { size, entries, base: userDataDir, pending: readPending(userDataDir) }
}

/**
 * 释放缓存：能删的当场删；删不掉的（运行中的 GPU / Dawn 缓存）排队等下次启动。
 * 返回 freed / removed / failed（带原因）/ queued，供界面如实反馈。
 */
function clearCache(userDataDir) {
  let freed = 0
  const removed = []
  const failed = []
  for (const name of SYSTEM_CACHE_DIRS) {
    const d = path.join(userDataDir, name)
    if (!fs.existsSync(d)) continue
    const s = dirSize(d)
    try {
      fs.rmSync(d, { recursive: true, force: true })
      freed += s
      removed.push(name)
    } catch (err) {
      failed.push({ name, size: s, error: String((err && (err.code || err.message)) || err) })
    }
  }
  const queued = writePending(userDataDir, [...readPending(userDataDir), ...failed.map((f) => f.name)])
  return { freed, removed, failed, queued }
}

/**
 * 启动早期调用：把上次没清掉的缓存目录删掉。
 *
 * **必须在 Chromium 打开它们之前**（main.cjs 里紧跟数据目录解析之后、app.whenReady 之前），
 * 否则一样 EPERM。删掉后 Chromium 会按需重建，属正常。
 */
function runPendingCleanup(userDataDir) {
  const names = readPending(userDataDir)
  if (!names.length) return { attempted: 0, removed: [], still: [] }
  const removed = []
  const still = []
  for (const name of names) {
    const d = path.join(userDataDir, name)
    if (!fs.existsSync(d)) { removed.push(name); continue }
    try {
      fs.rmSync(d, { recursive: true, force: true })
      removed.push(name)
    } catch {
      still.push(name)
    }
  }
  writePending(userDataDir, still)
  return { attempted: names.length, removed, still }
}

module.exports = {
  SYSTEM_CACHE_DIRS, dirSize, cacheInfo, clearCache,
  readPending, writePending, runPendingCleanup,
}

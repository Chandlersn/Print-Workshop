/**
 * 数据目录互斥（I-54）：GUI 生命周期持锁，命令行写入前探测。
 *
 * 为什么必须有：GUI 与命令行（`bin/pp.cjs`）默认共用同一份数据目录，而两边都走
 * `store.cjs` 的「读整份 JSON → 改 → 整份写回」。原子替换只保证单文件不半截，
 * **不保证语义正确**：两个进程各自读到旧值、各自写回，后写的那次会安静地吃掉前一次
 * 的修改（比如 CLI 导入的名单被 GUI 的一次编辑整体覆盖）。单用户桌面工具里，
 * 「窗口开着时命令行只读」比「悄悄丢数据」可接受得多。
 *
 * 设计取舍（为什么不是别的方案）：
 *  - **不在 `saveJson` 里加短锁**：那只把窗口从「整个读写期间」缩到「写期间」，
 *    交错依然会丢更新，却给人「已经修好了」的错觉，比不修更糟。
 *  - **不上版本号 CAS**：语义最准，但要给六个领域模块的 JSON 都加信封、改掉全部损坏恢复
 *    路径与大量裸写夹具（`designs.cjs` 的 `DESIGN_CONFLICT` 已是范式，留给 v0.7 单独做）。
 *  - 所以这里只做**可见的互斥**：GUI 持锁（带心跳租约），命令行写操作前探测；只读永远不受限。
 *
 * 三个易错点（都有前例可循）：
 *  - 锁路径必须**每次现取** `process.env.PRINTPRESS_DATA_DIR`（`store.cjs` 是加载期缓存，
 *    `test/sheets-import.cjs` 会中途换目录，照抄就会指错地方）；
 *  - Windows 上被杀软/索引器瞬时持有会返回 `EPERM`/`EBUSY` 而不是 `EEXIST`
 *    （`store.cjs` 里记过这次 EPERM 抖动）——退让一次再判定，别一概当成「有人持有」；
 *  - 释放失败绝不抛（`designs.cjs` 的既定原则）：锁删不掉就留给下次按陈旧回收。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 锁文件名落在 `.gitignore` 既有的 `data/*.json` 覆盖内，仓库数据目录与测试目录都不会变脏 */
const LOCK_NAME = 'data-dir.lock.json'
/** 心跳租约：GUI 每 10s 刷一次，超过 45s 没刷新才按陈旧回收（强杀后最坏 45s 可写） */
const TTL_MS = 45_000
const BEAT_MS = 10_000

let heartbeat = null

/** 锁路径现取：不缓存 env（见文件头第三个易错点） */
function lockPath() {
  const dir = process.env.PRINTPRESS_DATA_DIR
  return dir ? path.join(dir, LOCK_NAME) : null
}

function busyError() {
  return Object.assign(
    new Error('批印坊正在运行，数据目录暂时只读。请先关闭批印坊窗口，或在应用内完成这次修改。'),
    { code: 'DATA_DIR_BUSY' },
  )
}

/** 进程是否还活着：EPERM 表示「存在但没权限碰」——那也算活着 */
function processIsAlive(pid) {
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

/** 读持有者：坏内容 / 普通文件占位一律视为「可回收」，否则一个误建文件会永久锁死数据目录 */
function readHolder() {
  const p = lockPath()
  if (!p) return null
  let st
  try { st = fs.lstatSync(p) } catch { return null }
  if (!st.isFile() || st.size > 4096) return { malformed: true }
  try {
    const holder = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!holder || typeof holder.pid !== 'number' || !Number.isFinite(holder.pid)) return { malformed: true }
    return holder
  } catch { return { malformed: true } }
}

/** 陈旧判据：坏内容 / pid 已不在 / 心跳过期 / 心跳早于本次开机（Windows 会复用 pid） */
function isStale(holder) {
  if (!holder || holder.malformed) return true
  if (!processIsAlive(holder.pid)) return true
  const beat = Number(holder.beatAt || holder.startedAt || 0)
  if (!beat || Date.now() - beat > TTL_MS) return true
  if (beat < Date.now() - os.uptime() * 1000) return true
  return false
}

/** 退让 50ms 的同步等（只走「瞬时占用」这一条罕见路径，忙等足够） */
function sleepSync(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeat = setInterval(() => {
    const p = lockPath()
    if (!p) return
    try {
      const holder = readHolder()
      // 锁已经不是我的了（被别的进程回收/顶掉）：停心跳，别把别人的锁刷新成自己的
      if (!holder || holder.malformed || holder.pid !== process.pid) { stopHeartbeat(); return }
      fs.writeFileSync(p, JSON.stringify({ ...holder, beatAt: Date.now() }), 'utf-8')
    } catch { /* 心跳失败不改业务结果：最坏是死后被按陈旧回收 */ }
  }, BEAT_MS)
  if (heartbeat.unref) heartbeat.unref()
}

function stopHeartbeat() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
}

/**
 * GUI 取锁（主进程启动时调用，进程存活期间一直持有）。
 * @returns {{ok: true} | {ok: false, reason: string}}
 * @throws DATA_DIR_BUSY 另一个活跃实例已经持有
 */
function acquireForHost() {
  const p = lockPath()
  if (!p) return { ok: false, reason: 'no-data-dir' }
  try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch { /* 目录建不了让写入路径去报错 */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx', 0o600)
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid, role: 'gui', startedAt: Date.now(), beatAt: Date.now(),
      }))
      fs.closeSync(fd)
      startHeartbeat()
      return { ok: true }
    } catch (err) {
      if (err.code === 'EEXIST') {
        if (isStale(readHolder())) {
          try { fs.unlinkSync(p); continue } catch { throw busyError() }
        }
        throw busyError()
      }
      // 瞬时占用（杀软/索引器）：退让一次再判，别把 EPERM 一概当「有人持有」
      if (attempt === 0 && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) { sleepSync(50); continue }
      throw busyError()
    }
  }
  throw busyError()
}

/**
 * 客户端（命令行）写操作前的探测：
 *  - 没有锁 / 锁是陈旧的 → 放行（顺手清掉陈旧锁）；
 *  - 锁是我的（GUI 自己、或测试里的同进程）→ 放行；
 *  - 有活跃持有者 → 抛 DATA_DIR_BUSY（只读操作不该调这个函数）。
 */
function assertWritableByClient() {
  const p = lockPath()
  if (!p) return
  const holder = readHolder()
  if (!holder) return
  if (!holder.malformed && holder.pid === process.pid) return
  if (!isStale(holder)) throw busyError()
  try { fs.unlinkSync(p) } catch { throw busyError() }
}

/** 释放：只删自己的锁；删不掉只告警，绝不抛（否则会顶掉调用方真正要报的结果） */
function release() {
  stopHeartbeat()
  const p = lockPath()
  if (!p) return
  const holder = readHolder()
  if (!holder || holder.malformed || holder.pid !== process.pid) return
  try { fs.unlinkSync(p) } catch {
    console.warn('[data-lock] 锁文件未能删除，下次启动会按陈旧锁回收')
  }
}

module.exports = {
  LOCK_NAME,
  TTL_MS,
  lockPath,
  readHolder,
  isStale,
  processIsAlive,
  acquireForHost,
  assertWritableByClient,
  release,
}
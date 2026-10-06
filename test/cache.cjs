/**
 * 系统缓存清理：大小汇总、一键释放，以及「运行时删不掉的排队到下次启动清」。
 *
 * 为什么单独成套：这条链上原来有个**静默吞异常**的坑——clearCache 里 `catch {}` 把
 * 运行中 GPUCache / DawnCache 的 EPERM 吃掉了，返回值里没有任何失败痕迹，前端也不说话，
 * 用户点了「清理缓存」看到的就是「没反应」。现在失败必须进 failed、必须排队、必须如实
 * 反馈给界面，所以逐条钉住，别再退化回去。
 *
 * 造「删不掉」的办法：Windows 上进程 CWD 所在目录带一个没有 share-delete 的句柄，
 * 删它会 EBUSY —— 跟 Chromium 持有 GPUCache 是同一类失败，而且完全同步、可复现。
 * （持文件句柄、chmod 只读都不行：fs.rmSync 内部会自己重试并成功。）
 *
 * 运行：node test/cache.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const cache = require('../electron/cache.cjs')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cache-'))
const CWD0 = process.cwd()

/** 造一个缓存目录，里面塞 n 个文件（每个 10 字节），返回目录路径 */
function mkCache(userData, name, n = 1, nested = false) {
  const d = path.join(userData, name)
  fs.mkdirSync(d, { recursive: true })
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.bin`), 'x'.repeat(10))
  if (nested) {
    const sub = path.join(d, 'sub')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'deep.bin'), 'y'.repeat(90))
  }
  return d
}

function pendingFile(userData) {
  return path.join(userData, 'cache-cleanup-pending.json')
}

/**
 * 在「本进程 CWD = dir」的条件下跑 fn。
 * Windows 上 CWD 所在目录带一个无 share-delete 的句柄，删除必然失败 —— 这就是
 * 复现「运行中删不掉」的手段。CWD 必须在 finally 里还原：目录万一被删掉，
 * 进程会卡在一个不存在的 CWD 上，后面所有相对路径都完蛋。
 */
function withCwd(dir, fn) {
  process.chdir(dir)
  try { return fn() } finally { process.chdir(CWD0) }
}

// ───────────────────────── 1. 大小汇总 ─────────────────────────

console.log('== 1. dirSize / cacheInfo ==')
{
  const ud = path.join(ROOT, 'u1')
  fs.mkdirSync(ud, { recursive: true })
  ok(cache.dirSize(path.join(ud, '不存在')) === 0, '目录不存在 → 0（不抛错）')

  mkCache(ud, 'GPUCache', 3)
  ok(cache.dirSize(path.join(ud, 'GPUCache')) === 30, '目录大小按字节累加', cache.dirSize(path.join(ud, 'GPUCache')))

  mkCache(ud, 'Cache', 1, true)
  ok(cache.dirSize(path.join(ud, 'Cache')) === 100, '子目录递归计入', cache.dirSize(path.join(ud, 'Cache')))

  const info = cache.cacheInfo(ud)
  ok(info.size === 130, 'cacheInfo 汇总所有缓存目录', info.size)
  ok(info.base === ud, '带上数据目录本身（界面要显示位置）', info.base)
  ok(info.entries.length === 2, '只列实际存在的目录', info.entries)
  ok(info.entries.every((e) => typeof e.name === 'string' && typeof e.size === 'number'),
    'entries 是 {name,size} 结构')
  ok(Array.isArray(info.pending) && info.pending.length === 0, 'pending 初始为空数组（不是 undefined）')

  // 空目录也算「存在」，但要计 0 —— 不能因为 0 就当作没有
  fs.mkdirSync(path.join(ud, 'Code Cache'))
  const info2 = cache.cacheInfo(ud)
  ok(info2.entries.some((e) => e.name === 'Code Cache' && e.size === 0),
    '空缓存目录照样列出（大小为 0）', info2.entries)
}

// ───────────────────────── 2. 待清理清单 ─────────────────────────

console.log('== 2. readPending / writePending ==')
{
  const ud = path.join(ROOT, 'u2')
  fs.mkdirSync(ud, { recursive: true })

  ok(cache.readPending(ud).length === 0, '清单文件不存在 → 空数组（不能因此卡住启动）')

  const wrote = cache.writePending(ud, ['GPUCache', 'GPUCache', 'Cache'])
  ok(wrote.length === 2, '写入时去重', wrote)
  ok(JSON.stringify(cache.readPending(ud)) === JSON.stringify(['GPUCache', 'Cache']), '写入后读回一致')

  // 白名单：清单文件可被手工编辑，不能让 data / 越界路径流进来
  fs.writeFileSync(pendingFile(ud), JSON.stringify({ dirs: ['GPUCache', 'data', '../evil', 'Local Storage', 'Cache'] }), 'utf-8')
  ok(JSON.stringify(cache.readPending(ud)) === JSON.stringify(['GPUCache', 'Cache']),
    '非白名单条目（data / Local Storage / ../evil）读出来就被滤掉', cache.readPending(ud))

  cache.writePending(ud, ['data', '../evil'])
  ok(!fs.existsSync(pendingFile(ud)), '全是非法名 → 不写清单文件')
  ok(cache.readPending(ud).length === 0, '非法名一个都进不去')

  fs.writeFileSync(pendingFile(ud), '{ 这不是 JSON', 'utf-8')
  ok(cache.readPending(ud).length === 0, '清单损坏 → 当空清单（不抛错）')

  fs.writeFileSync(pendingFile(ud), JSON.stringify(['GPUCache']), 'utf-8')
  ok(cache.readPending(ud).length === 0, '结构不对（不是 {dirs:[]}）→ 空清单')

  cache.writePending(ud, ['GPUCache'])
  ok(fs.existsSync(pendingFile(ud)), '有内容时清单文件落盘')
  cache.writePending(ud, [])
  ok(!fs.existsSync(pendingFile(ud)), '传空数组 → 清单文件删掉（不留空壳）')
}

// ───────────────────────── 3. 能删就当场删 ─────────────────────────

console.log('== 3. clearCache：全部可删 ==')
{
  const ud = path.join(ROOT, 'u3')
  fs.mkdirSync(ud, { recursive: true })
  mkCache(ud, 'Cache', 2)
  mkCache(ud, 'Code Cache', 1)
  fs.mkdirSync(path.join(ud, 'data'), { recursive: true })
  fs.writeFileSync(path.join(ud, 'data', '名单.csv'), '姓名\n张三\n', 'utf-8')

  const r = cache.clearCache(ud)
  ok(r.freed === 30, 'freed 是实际释放的字节数', r.freed)
  ok(r.removed.length === 2 && r.removed.includes('Cache') && r.removed.includes('Code Cache'),
    'removed 列出删掉的目录名', r.removed)
  ok(r.failed.length === 0, '全删成功时 failed 为空', r.failed)
  ok(r.queued.length === 0, '全删成功时没有排队项', r.queued)
  ok(!fs.existsSync(pendingFile(ud)), '没失败就不留清单文件')
  ok(!fs.existsSync(path.join(ud, 'Cache')), '缓存目录真的没了')
  ok(fs.existsSync(path.join(ud, 'data', '名单.csv')), '**用户数据（data/）一根汗毛没动**')
  ok(cache.cacheInfo(ud).size === 0, '清完再查大小为 0')

  const r2 = cache.clearCache(ud)
  ok(r2.freed === 0 && r2.removed.length === 0, '重复点击：freed 0、removed 空（界面据此说「已无可清理」）', r2)
}

// ───────────────────────── 4. 删不掉的排队等下次启动 ─────────────────────────

console.log('== 4. clearCache：锁定目录 → failed + queued ==')
{
  // 先单独验一下「CWD 占住就删不掉」这个前提成立，免得后面把环境问题误判成代码问题
  const probe = mkCache(path.join(ROOT, 'u4probe'), 'GPUCache', 1)
  let blocked = false
  withCwd(probe, () => {
    try { fs.rmSync(probe, { recursive: true, force: true }) } catch { blocked = true }
  })
  ok(blocked, '前提：CWD 占住时该目录确实删不掉（复现 Chromium 持锁 GPUCache）')

  const ud = path.join(ROOT, 'u4')
  fs.mkdirSync(ud, { recursive: true })
  mkCache(ud, 'Cache', 1)                    // 这个能删
  const locked = mkCache(ud, 'GPUCache', 2)  // 这个删不掉（每个文件 10 字节）

  const r = withCwd(locked, () => cache.clearCache(ud))
  ok(r.failed.length === 1 && r.failed[0].name === 'GPUCache',
    '删不掉的进 failed（不再被 catch {} 静默吞掉）', r.failed)
  ok(r.failed.length === 1 && typeof r.failed[0].error === 'string' && r.failed[0].error.length > 0,
    'failed 带失败原因（EPERM / EBUSY 之类），界面能说清楚', r.failed)
  ok(r.failed.length === 1 && r.failed[0].size === 20,
    'failed 带体积，界面才能说「还剩多少正被占用」', r.failed)
  ok(JSON.stringify(r.queued) === JSON.stringify(['GPUCache']),
    '**删不掉的自动排队到下次启动**', r.queued)
  ok(JSON.stringify(cache.readPending(ud)) === JSON.stringify(['GPUCache']), '队列已落盘')

  ok(r.removed.includes('Cache'), '一个删不掉不阻断其余（能删的照样删）', r.removed)
  ok(r.freed === 10, 'freed 只算真正删掉的那部分', r.freed)
  ok(fs.existsSync(locked), '锁定目录还在（没被误判为已清）')

  // 再点一次：队列不能因为重复点击而丢项，也不能重复堆叠
  const r2 = withCwd(locked, () => cache.clearCache(ud))
  ok(JSON.stringify(r2.queued) === JSON.stringify(['GPUCache']),
    '重复点击后队列仍是那一项（不丢也不重复）', r2.queued)
}

// ───────────────────────── 5. 下次启动把队列清掉 ─────────────────────────

console.log('== 5. runPendingCleanup：启动早期清队列 ==')
{
  const ud = path.join(ROOT, 'u5')
  fs.mkdirSync(ud, { recursive: true })
  ok(cache.runPendingCleanup(ud).attempted === 0, '没队列 → attempted 0（启动不做多余动作）')

  mkCache(ud, 'GPUCache', 2)
  mkCache(ud, 'DawnCache', 1)
  cache.writePending(ud, ['GPUCache', 'DawnCache', 'Cache']) // Cache 实际不存在
  const swept = cache.runPendingCleanup(ud)
  ok(swept.attempted === 3, 'attempted 是队列长度', swept.attempted)
  ok(swept.removed.includes('GPUCache') && swept.removed.includes('DawnCache'), '真删掉的进 removed', swept.removed)
  ok(swept.removed.includes('Cache'), '队列里有、目录已不存在的也算清掉（否则永远留在队列里）', swept.removed)
  ok(swept.still.length === 0, '都清掉了，still 为空', swept.still)
  ok(!fs.existsSync(pendingFile(ud)), '清干净后清单文件删掉')
  ok(!fs.existsSync(path.join(ud, 'GPUCache')), 'GPUCache 真的没了')

  // 启动早期也删不掉（比如还开着别的实例）→ 留在队列里等下一次
  const ud2 = path.join(ROOT, 'u5b')
  fs.mkdirSync(ud2, { recursive: true })
  const locked = mkCache(ud2, 'DawnCache', 1)
  cache.writePending(ud2, ['DawnCache'])
  const s2 = withCwd(locked, () => cache.runPendingCleanup(ud2))
  ok(JSON.stringify(s2.still) === JSON.stringify(['DawnCache']), '这次仍删不掉 → 进 still', s2)
  ok(JSON.stringify(cache.readPending(ud2)) === JSON.stringify(['DawnCache']),
    '**still 的项写回清单，留待下一次启动**（一次失败不放弃）')
}

// ───────────────────────── 6. 安全边界 ─────────────────────────

console.log('== 6. 安全边界：只碰白名单里的系统缓存 ==')
{
  const ud = path.join(ROOT, 'u6')
  fs.mkdirSync(ud, { recursive: true })
  const keep = ['data', 'Local Storage', 'Session Storage', 'Network', 'print-bg', 'fonts']
  for (const name of keep) {
    fs.mkdirSync(path.join(ud, name), { recursive: true })
    fs.writeFileSync(path.join(ud, name, 'keep.bin'), 'keep', 'utf-8')
  }
  mkCache(ud, 'GPUCache', 1)

  // 手工往清单里塞非法名，模拟「清单文件被人改过」
  fs.writeFileSync(pendingFile(ud), JSON.stringify({ dirs: [...keep, 'GPUCache', '..\\..\\evil', '/abs'] }), 'utf-8')

  const swept = cache.runPendingCleanup(ud)
  ok(swept.attempted === 1, '越界 / 非缓存名在读清单时就被滤掉，根本没进循环', swept)
  ok(!swept.removed.some((n) => keep.includes(n)), '启动清理不会动 data / Local Storage 等应用状态', swept.removed)
  for (const name of keep) {
    ok(fs.existsSync(path.join(ud, name, 'keep.bin')), `「${name}」完好无损`)
  }
  ok(!fs.existsSync(path.join(ud, 'GPUCache')), '白名单里的照清不误')

  // 一键清理这条路径同样不许碰它们
  mkCache(ud, 'GPUCache', 1)
  cache.clearCache(ud)
  ok(keep.every((n) => fs.existsSync(path.join(ud, n, 'keep.bin'))), 'clearCache 也不碰应用状态目录')
  ok(!fs.existsSync(path.join(ud, 'GPUCache')), 'clearCache 清掉了白名单目录')

  const info = cache.cacheInfo(ud)
  ok(info.entries.every((e) => cache.SYSTEM_CACHE_DIRS.includes(e.name)),
    'cacheInfo 也只统计白名单目录', info.entries.map((e) => e.name))
}

// ───────────────────────── 收尾 ─────────────────────────

process.chdir(CWD0)
rmDeep(ROOT)
console.log(`\n系统缓存清理：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

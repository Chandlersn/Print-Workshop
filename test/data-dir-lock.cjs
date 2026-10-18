/**
 * 数据目录互斥验收（I-54）。
 *
 * 守的是「两个进程各读一份、各写回，后写的安静吃掉前一次修改」这件事：
 *  - GUI 生命周期持锁（带心跳租约），命令行写操作前探测并明确拒绝；
 *  - 只读永远不受限（agent 在窗口开着时仍能 list / render / validate）；
 *  - 强杀留下的陈旧锁必须能自愈，否则一次崩溃就让数据目录永久不可写；
 *  - 锁文件不能变成「误建一个文件就永久锁死」的雷（坏内容/普通文件占位按可回收处理）；
 *  - 释放失败绝不抛（会顶掉调用方真正要报的结果，designs.cjs 的既定原则）。
 *
 * 用 spawnSync 造「另一个真实进程」：手写一个别的 pid 的锁文件不足以覆盖 pid 存活判定。
 * 纯 Node、零 Electron 依赖，数据目录指向 test/.tmp-data-lock。
 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { rmDeep } = require('./helpers/rm.cjs')

const TMP = path.join(__dirname, '.tmp-data-lock')
const ROOT = path.join(__dirname, '..')

rmDeep(TMP)
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

// 「另一个真实存活的进程」：必须用异步 spawn——spawnSync 会等子进程结束才返回，
// 拿它当「活着的持有者」会立刻变成死 pid，于是陈旧回收把测试自己给放行了（踩过一次）
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
sleeper.unref()
const LIVE_PID = sleeper.pid

const dataLock = require('../electron/data-lock.cjs')

const LOCK = path.join(TMP, dataLock.LOCK_NAME)
let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}
const clean = () => { try { fs.unlinkSync(LOCK) } catch { /* 本来就没有 */ } }
/** 手写一把属于「另一个进程」的活锁：pid 用当前测试进程的子进程号，保证真实存活 */
function writeHolder(pid, over = {}) {
  fs.writeFileSync(LOCK, JSON.stringify({
    pid, role: 'gui', startedAt: Date.now(), beatAt: Date.now(), ...over,
  }), 'utf-8')
}

console.log('== 1. 取锁 / 释放：文件到位、内容可读、释放后消失 ==')

check('无锁时取锁成功，锁文件含自己的 pid 与心跳', () => {
  clean()
  const res = dataLock.acquireForHost()
  assert.equal(res.ok, true, '空目录上取锁必须成功')
  const holder = dataLock.readHolder()
  assert.ok(holder && holder.pid === process.pid, `锁里的 pid 必须是本进程，实得 ${JSON.stringify(holder)}`)
  assert.ok(Number(holder.beatAt) > 0, '必须写入心跳时间（否则会被自己的陈旧判据回收）')
  dataLock.release()
})

check('释放后锁文件消失（下一次启动/另一个进程立刻可用）', () => {
  assert.equal(fs.existsSync(LOCK), false, '释放后锁文件必须已删除')
  const again = dataLock.acquireForHost()
  assert.equal(again.ok, true, '释放后应能再次取锁')
  dataLock.release()
})

console.log('\n== 2. 活跃持有者：CLI 写入被拒，只读不受限 ==')

check('另一个存活进程持锁时，取锁抛 DATA_DIR_BUSY 且不删别人的锁', () => {
  clean()
  assert.ok(dataLock.processIsAlive(LIVE_PID), `探针进程必须活着（pid ${LIVE_PID}）`)
  writeHolder(LIVE_PID)
  let err = null
  try { dataLock.acquireForHost() } catch (e) { err = e }
  assert.ok(err, '活跃持有者存在时必须拒绝')
  assert.equal(err.code, 'DATA_DIR_BUSY', `错误码应为 DATA_DIR_BUSY，实得 ${err.code}`)
  assert.equal(fs.existsSync(LOCK), true, '不能删掉别人的锁')
  assert.equal(dataLock.readHolder().pid, LIVE_PID, '锁的持有者不应被改写')
  clean()
})

check('CLI 探测：活跃持有者 → DATA_DIR_BUSY；只读路径不调用探测所以不受影响', () => {
  clean()
  writeHolder(LIVE_PID)
  let err = null
  try { dataLock.assertWritableByClient() } catch (e) { err = e }
  assert.ok(err && err.code === 'DATA_DIR_BUSY', '写操作必须被拒')
  assert.equal(dataLock.readHolder().pid, LIVE_PID, '探测不得动别人的锁')
  clean()
  dataLock.assertWritableByClient() // 无锁 → 放行，不该抛
})

check('持有者是自己时探测放行（GUI 自己写 / 同进程测试）', () => {
  clean()
  writeHolder(process.pid)
  dataLock.assertWritableByClient()
  clean()
})

console.log('\n== 3. 陈旧锁自愈：进程死了 / 心跳过期 / 早于本次开机 ==')

check('pid 已不存在的锁会被回收（一次崩溃不该让数据目录永久不可写）', () => {
  clean()
  // 找一个几乎不可能存在的 pid：先取一个真实 pid 再杀掉
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  writeHolder(child.pid)
  const res = dataLock.acquireForHost()
  assert.equal(res.ok, true, '死 pid 的锁应被回收后取锁成功')
  assert.equal(dataLock.readHolder().pid, process.pid, '锁应已归本进程')
  dataLock.release()
})

check('心跳早于本次开机的锁会被回收（Windows 会复用 pid）', () => {
  clean()
  writeHolder(process.pid, { beatAt: Date.now() - os.uptime() * 1000 - 60_000 })
  const res = dataLock.acquireForHost()
  assert.equal(res.ok, true, '早于本次开机的锁应被回收')
  dataLock.release()
})

check('心跳超过 TTL 的锁会被回收（强杀后最坏 45s 可写）', () => {
  clean()
  writeHolder(process.pid, { beatAt: Date.now() - dataLock.TTL_MS - 1000 })
  const res = dataLock.acquireForHost()
  assert.equal(res.ok, true, '过期心跳应被回收')
  dataLock.release()
})

check('锁位是普通文件 / 坏 JSON 时按可回收处理（不给「误建文件 = 永久锁死」留门）', () => {
  clean()
  fs.writeFileSync(LOCK, '不是 JSON', 'utf-8')
  assert.equal(dataLock.acquireForHost().ok, true, '坏内容应被可回收')
  dataLock.release()
  fs.writeFileSync(LOCK, JSON.stringify({ role: 'gui' }), 'utf-8') // 没有 pid
  assert.equal(dataLock.acquireForHost().ok, true, '缺 pid 的锁应被可回收')
  dataLock.release()
})

check('CLI 探测遇到陈旧锁：清掉并放行（不能因为残留把命令行也锁死）', () => {
  clean()
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, role: 'gui', beatAt: Date.now() - dataLock.TTL_MS - 1000 }), 'utf-8')
  dataLock.assertWritableByClient()
  assert.equal(fs.existsSync(LOCK), false, '陈旧锁应被清掉')
})

console.log('\n== 4. 锁路径现取 env（不缓存）；释放失败不许抛 ==')

check('中途改 PRINTPRESS_DATA_DIR，锁路径跟着换（照抄 store.cjs 的加载期缓存就会指错目录）', () => {
  const other = path.join(TMP, 'other')
  fs.mkdirSync(other, { recursive: true })
  const prev = process.env.PRINTPRESS_DATA_DIR
  process.env.PRINTPRESS_DATA_DIR = other
  try {
    assert.equal(dataLock.lockPath(), path.join(other, dataLock.LOCK_NAME), '锁路径必须现取 env')
    const res = dataLock.acquireForHost()
    assert.equal(res.ok, true, '新目录上应能取锁')
    assert.equal(fs.existsSync(path.join(other, dataLock.LOCK_NAME)), true, '锁应落在新目录')
    assert.equal(fs.existsSync(LOCK), false, '旧目录不该被碰')
    dataLock.release()
  } finally { process.env.PRINTPRESS_DATA_DIR = prev }
  rmDeep(other)
})

check('释放失败只告警不抛（不能让清理失败顶掉调用方真正的结果）', () => {
  clean()
  dataLock.acquireForHost()
  const realUnlink = fs.unlinkSync
  fs.unlinkSync = () => { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e }
  try {
    dataLock.release() // 不得抛出
  } finally { fs.unlinkSync = realUnlink }
  assert.equal(dataLock.readHolder().pid, process.pid, '此时锁还在（下次启动按陈旧回收）')
  clean()
})

check('删除别人的锁不在释放的职责内（只删自己的）', () => {
  clean()
  writeHolder(123456)
  dataLock.release()
  assert.equal(fs.existsSync(LOCK), true, 'release 不得删不属于自己的锁')
  clean()
})

console.log('\n== 5. 用户可见文案与接线（I-48 / I-54）==')

check('BUSY 文案：纯中文、无绝对路径、无 errno、无 pid', () => {
  clean()
  writeHolder(LIVE_PID)
  let msg = ''
  try { dataLock.assertWritableByClient() } catch (e) { msg = e.message }
  clean()
  assert.ok(msg.length > 0, '必须有文案')
  assert.ok(!/[A-Za-z]:\\/.test(msg), `文案里不许出现绝对路径: ${msg}`)
  assert.ok(!/\b(EPERM|EBUSY|EEXIST|ENOENT|EACCES)\b/.test(msg), `文案里不许出现 errno: ${msg}`)
  assert.ok(!/\d{3,}/.test(msg), `文案里不许出现 pid / 时间戳: ${msg}`)
  assert.ok(/批印坊/.test(msg) && /关闭/.test(msg), `文案要说清对象与出口: ${msg}`)
})

check('GUI 入口真的取了锁：main.cjs 在种子之前 acquireForHost，且用 process.on(exit) 兜释放', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf-8')
  assert.ok(/acquireForHost\(\)/.test(src), 'main.cjs 必须真的取锁')
  assert.ok(/data-lock/.test(src), 'main.cjs 必须引用 data-lock.cjs')
  const acquireAt = src.indexOf('acquireForHost()')
  const seedAt = src.indexOf('seedIfFirstRun')
  assert.ok(seedAt > acquireAt && acquireAt > 0, '取锁必须排在种子/迁移之前（那些步骤自己会写 JSON）')
  assert.ok(/process\.on\('exit'/.test(src), "必须用 process.on('exit')：app.exit() 不触发 will-quit")
  assert.ok(/requestSingleInstanceLock/.test(src), 'GUI vs GUI 交给 Electron 内置单实例锁')
})

check('写闸门接在权限之后（缺写权限仍报 WRITE_FORBIDDEN，而不是 BUSY）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'api.cjs'), 'utf-8')
  const forbiddenAt = src.indexOf('writeForbidden(name)')
  const busyAt = src.indexOf('assertWritableByClient()')
  assert.ok(busyAt > forbiddenAt && forbiddenAt > 0, '互斥探测必须在写权限闸门之后')
  assert.ok(src.includes("require('./data-lock.cjs')"), 'api.cjs 必须引用 data-lock.cjs')
})

check('数据目录迁移不搬走锁文件（否则新目录被一把别人 pid 的死锁占住）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'data-dir.cjs'), 'utf-8')
  assert.ok(/LOCK_NAME/.test(src), 'copyDirSync 必须跳过锁文件')
  // 真跑一次：源目录带锁，复制后目标目录里不该有它
  const srcDir = path.join(TMP, 'migrate-src')
  const dstDir = path.join(TMP, 'migrate-dst')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'datasets.json'), '[]', 'utf-8')
  fs.writeFileSync(path.join(srcDir, dataLock.LOCK_NAME), '{"pid":1}', 'utf-8')
  require('../electron/data-dir.cjs').copyDirSync(srcDir, dstDir)
  assert.equal(fs.existsSync(path.join(dstDir, 'datasets.json')), true, '普通文件必须照常复制')
  assert.equal(fs.existsSync(path.join(dstDir, dataLock.LOCK_NAME)), false, '锁文件不该被搬过去')
})

check('CLI 的 DATA_DIR_BUSY 有独立退出码与帮助说明（agent 能据码决策）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'pp.cjs'), 'utf-8')
  assert.ok(/DATA_DIR_BUSY:\s*4/.test(src), 'bin/pp.cjs 必须给 DATA_DIR_BUSY 一个独立退出码')
  assert.ok(/关于批印坊窗口开着的时候/.test(src), '帮助文本必须说明窗口开着时命令行只读')
})

check('本套件已挂进 npm test（不挂 = 等于没写）', () => {
  const chain = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).scripts.test || '')
  assert.ok(chain.includes('test/data-dir-lock.cjs'), 'test/data-dir-lock.cjs 必须在 npm test 链里')
})

rmDeep(TMP)
try { sleeper.kill() } catch { /* 探针进程不存在也无所谓 */ }
console.log(`\n数据目录互斥：${passed} 项通过${process.exitCode ? '（有失败）' : ''}`)
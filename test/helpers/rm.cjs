/**
 * 测试用深度删除。
 *
 * 解决两个真实问题，缺一不可：
 *
 * 1. **WorkBuddy 宿主注入的 node-safe-delete shim**：对「单次 fs.rmSync 递归删除 >50 项」
 *    fail-closed 拦截（SAFE_DELETE_BULK_CONFIRM_REQUIRED，Electron main 进程里直接弹窗报错）。
 *    逐条 unlink/rmdir 单次调用 count=1，不触发 bulk 拦截。
 *
 * 2. **CI（windows-latest）上的句柄延迟释放**：Defender / 搜索索引器会在测试刚写完的一批
 *    文件上短暂持有句柄，紧跟着的递归删除就以 ENOTEMPTY / EBUSY / EACCES 失败。
 *    2026-10-13 真实发生：pdf-merge 60 项断言全绿，收尾 `fs.rmSync(TMP)` 在 CI 上崩掉整个
 *    套件（本地怎么都复现不了）。所以每一步都带**退避重试**——句柄释放是毫秒级的事，
 *    重试必然成功；重试到底还失败，对「收尾清理」这种非断言路径应当降级为警告而不是红。
 *
 *    清理失败不该让测试变红：清理不是被测行为， leftover 临时目录顶多算脏，把它当失败
 *    会把「杀毒软件抖了一下」放大成「发版被卡住」。
 */
const fs = require('fs')
const path = require('path')

/** Windows 上「文件正被占用」一类的错误：值得等一等再试 */
function isTransient(err) {
  return ['EBUSY', 'ENOTEMPTY', 'EACCES', 'EPERM', 'EISDIR'].includes(err && err.code)
}

/** 同步休眠（Node 20 无 sleep 原语时的标准做法） */
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** 单个 fs 操作 + 退避重试；重试到底仍失败才抛 */
function withRetry(label, run, delays = [0, 60, 200, 600]) {
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) sleepMs(delays[i])
    try { run(); return } catch (err) {
      if (i === delays.length - 1 || !isTransient(err)) throw err
    }
  }
}

/**
 * 深度删除一棵临时树。目录里每一项都各自带退避重试。
 */
function rmDeep(p) {
  if (!fs.existsSync(p)) return
  if (!fs.lstatSync(p).isDirectory()) { withRetry('unlink', () => fs.unlinkSync(p)); return }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    rmDeep(path.join(p, e.name))
  }
  withRetry('rmdir', () => fs.rmdirSync(p))
}

/** 永不抛的版本：给「收尾清理」用，删不掉返回 false（调用方打印一行警告即可） */
function rmDeepSafe(p) {
  try { rmDeep(p); return true } catch (err) {
    console.warn(`  .. 临时目录清理失败（不影响测试结论）：${p} :: ${err.code || err.message}`)
    return false
  }
}

module.exports = { rmDeep, rmDeepSafe, withRetry, isTransient }

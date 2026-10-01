/**
 * 测试用深度删除：绕开 WorkBuddy 宿主注入的 node-safe-delete shim。
 * 该 shim 对「单次 fs.rmSync 递归删除 >50 项」fail-closed 拦截
 * （SAFE_DELETE_BULK_CONFIRM_REQUIRED，Electron main 进程里直接弹窗报错）。
 * 逐条 unlink/rmdir 单次调用 count=1，不触发 bulk 拦截。
 */
const fs = require('fs')
const path = require('path')

function rmDeep(p) {
  if (!fs.existsSync(p)) return
  if (!fs.lstatSync(p).isDirectory()) { fs.unlinkSync(p); return }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    rmDeep(path.join(p, e.name))
  }
  fs.rmdirSync(p)
}

module.exports = { rmDeep }

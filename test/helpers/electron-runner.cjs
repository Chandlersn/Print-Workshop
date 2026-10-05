#!/usr/bin/env node
/**
 * Electron e2e 启动器：摘掉会破坏 Electron 的环境变量，再拉起真正的 Electron。
 *
 * 为什么需要它：
 * - 宿主环境常设 `ELECTRON_RUN_AS_NODE=1`。Electron 二进制一旦看到它，就完全按
 *   纯 Node 运行：`require('electron')` 返回二进制路径字符串而非 API，`app` 为
 *   undefined，主进程随即静默退出——**退出码 0、零输出**，e2e 测试看起来"通过但
 *   什么都没跑"。摘掉即可恢复。
 * - 宿主还会注入 `NODE_OPTIONS=--require=<shim>`，子进程会继承它，往主进程里塞代码。
 *   测试要干净环境，一并摘掉。
 *
 * 为什么用 Node 写而不是写进 npm script：`env -u X` 在 Windows 的 cmd 下不可用，
 * npm script 在 Windows 默认走 cmd。这里做跨平台处理。
 *
 * 用法：
 *   node test/helpers/electron-runner.cjs <electron 脚本> [额外参数...]
 *   node test/helpers/electron-runner.cjs --dry-run [脚本]   # 只报告环境处理结果，不拉起 Electron
 */
const { spawnSync } = require('child_process')
const path = require('path')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const rest = argv.filter((a) => a !== '--dry-run')
const script = rest[0]

// 缺参数先快速失败，避免把「参数写错」误报成「Electron 起不来」
if (!script && !dryRun) {
  console.error('用法: node test/helpers/electron-runner.cjs <electron 脚本> [参数...]')
  process.exit(2)
}

const env = { ...process.env }
const stripped = []
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
  if (key in env) {
    delete env[key]
    stripped.push(key)
  }
}
if (stripped.length) console.log(`[e2e] 已摘除环境变量: ${stripped.join(', ')}`)

// 纯 Node 下 require('electron') 返回 Electron 二进制路径（不是 API）
const electronBin = require('electron')

if (dryRun) {
  console.log(`[e2e] electron 二进制: ${electronBin}`)
  console.log(`[e2e] 待运行脚本: ${script ? path.resolve(script) : '(未指定)'}`)
  process.exit(0)
}

const r = spawnSync(electronBin, [path.resolve(script), ...rest.slice(1)], {
  stdio: 'inherit',
  env,
})

if (r.error) {
  console.error('[e2e] 拉起 Electron 失败:', r.error.message)
  process.exit(1)
}
process.exit(r.status === null ? 1 : r.status)

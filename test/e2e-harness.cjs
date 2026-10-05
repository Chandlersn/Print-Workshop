/**
 * Electron e2e 启动器守卫：确保 `npm run test:e2e` 在 agent 沙箱里真的能跑起来。
 *
 * 背景（真踩过的坑）：宿主环境常设 `ELECTRON_RUN_AS_NODE=1`。Electron 二进制一旦
 * 看到它就会退化成纯 Node —— `require('electron')` 返回二进制路径字符串而非 API，
 * `app` 为 undefined，主进程静默退出、退出码 0、零输出。此时 e2e 脚本"看起来通过了
 * 但什么都没跑"，而且没有任何报错提示。修法是经 test/helpers/electron-runner.cjs
 * 启动，它会摘掉 ELECTRON_RUN_AS_NODE 与 NODE_OPTIONS。
 *
 * 本套件用静态断言钉住这个约定，防止有人把 test:e2e 改回裸 electron 调用。
 * 运行：node test/e2e-harness.cjs
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label) }
  else { fail++; console.log('  FAIL - ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) }
}

const ROOT = path.join(__dirname, '..')
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

console.log('== 1. 启动器存在且摘掉了破坏性环境变量 ==')
const RUNNER = 'test/helpers/electron-runner.cjs'
ok(fs.existsSync(path.join(ROOT, RUNNER)), '启动器文件存在')
const runnerSrc = src(RUNNER)
ok(/for \(const key of \['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'\]\)/.test(runnerSrc), '启动器把两个破坏性变量列入摘除清单')
ok(/delete env\[key\]/.test(runnerSrc), '确实执行了删除（而非只记录）')
ok(/require\('electron'\)/.test(runnerSrc), '用 require("electron") 取二进制路径（纯 Node 下返回路径字符串）')
ok(/stdio: 'inherit'/.test(runnerSrc), 'stdio 继承，输出不被吞')
ok(/r\.status === null \? 1 : r\.status/.test(runnerSrc), '退出码透传（拿不到状态时按失败处理）')
ok(/if \(r\.error\)/.test(runnerSrc), '拉起失败时给出非 0 退出码，不静默成功')

console.log('== 2. package.json 的 test:e2e 必须经启动器 ==')
const pkg = JSON.parse(src('package.json'))
const e2e = (pkg.scripts && pkg.scripts['test:e2e']) || ''
ok(e2e.length > 0, 'test:e2e 脚本存在', e2e)
ok(e2e.includes('electron-runner.cjs'), 'test:e2e 经启动器启动', e2e)
ok(!/^electron\s/.test(e2e), 'test:e2e 不再是裸 electron 调用（那样在沙箱里静默无效）', e2e)
ok(e2e.includes('m3-e2e.cjs'), 'test:e2e 仍指向 m3-e2e.cjs', e2e)

console.log('== 3. 启动器行为：缺参数要快速失败 ==')
const r = spawnSync(process.execPath, [path.join(ROOT, RUNNER)], { encoding: 'utf-8' })
ok(r.status === 2, '无参数时退出码为 2', r.status)
ok(/用法/.test(r.stderr || ''), '无参数时打印用法提示', (r.stderr || '').trim())
ok(!/Electron/.test(r.stdout || ''), '缺参数时不进入 Electron 启动流程', (r.stdout || '').trim())

console.log('== 4. 启动器行为：真的会摘掉环境变量（--dry-run，不拉起 Electron） ==')
// 用 ELECTRON_RUN_AS_NODE=1 启动启动器，观察它是否报告摘除、并仍能解析出 electron 二进制路径。
// 走 --dry-run 而不是真的拉 Electron：脚本路径不存在时 Electron 会弹错误框并阻塞，
// 那会把测试卡死——测试里永远不要拉起会弹窗的 GUI 进程。
ok(/dry-run/.test(runnerSrc), '启动器支持 --dry-run（供测试无副作用地验证环境处理）')
const r2 = spawnSync(process.execPath, [path.join(ROOT, RUNNER), '--dry-run'], {
  encoding: 'utf-8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  timeout: 60000,
})
const firstLine = (r2.stdout || '').trim().split('\n')[0]
ok(r2.status === 0, '--dry-run 退出码为 0', r2.status)
ok(/已摘除环境变量/.test(r2.stdout || ''), '启动器报告摘除了环境变量', firstLine)
ok(/ELECTRON_RUN_AS_NODE/.test(r2.stdout || ''), '报告中含 ELECTRON_RUN_AS_NODE', firstLine)
ok(/NODE_OPTIONS/.test(r2.stdout || ''), '报告中含 NODE_OPTIONS', firstLine)
ok(/electron 二进制: .+/.test(r2.stdout || ''), '仍能解析出 electron 二进制路径', (r2.stdout || '').trim())
ok(!/\berror\b/i.test(r2.stderr || ''), '--dry-run 无错误输出', (r2.stderr || '').trim())

console.log('== 5. 主进程 e2e 脚本的既有约定未被破坏 ==')
const e2eSrc = src('test/m3-e2e.cjs')
ok(/disableHardwareAcceleration/.test(e2eSrc), 'm3-e2e 关硬件加速')
ok(/appendSwitch\('disable-gpu'\)/.test(e2eSrc), 'm3-e2e 关 GPU')
ok(/appendSwitch\('in-process-gpu'\)/.test(e2eSrc), 'm3-e2e 用 in-process-gpu')
ok(/appendSwitch\('disable-breakpad'\)/.test(e2eSrc), 'm3-e2e 关 breakpad（沙箱 crashpad 易损坏）')

console.log(`\ne2e 夹具：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

/**
 * IPC 装配验收（纯 Node，用假 electron 模块替身）。
 *
 * 为什么必须有这一套：api.cjs 抽取把 ipc.cjs 从「手写 39 个 ipcMain.handle」
 * 变成了「遍历注册表挂载」。这种重构最典型的失败模式是**静默丢通道**——
 * 某个通道没挂上，渲染进程一调就是 "No handler registered"，界面上表现为
 * 「某个按钮点了没反应」，既不报错也不崩，纯 Node 的测试套件完全看不到。
 *
 * 为什么不用真 Electron：本环境里 Electron 运行时会退化到「退出码 0 且零输出」
 * 的静默状态（连 electron . --smoke 都会中招），拿它做断言等于把测试建在流沙上。
 * 而「装配」这件事本质就是「有没有调 ipcMain.handle、参数归一化对不对」，
 * 用一个假 electron 模块即可完整覆盖，且确定性、无 GPU、能进 npm test。
 *
 * 把守三件事：
 *   1. 注册表里 42 个操作全部挂上，且没有多余的旁路通道
 *   2. preload 暴露的通道全部有实现（否则渲染层点了没反应）
 *   3. 位置参数 → 规范参数对象的归一化逐通道正确（最容易写错的一环：
 *      写错不会报错，只会把 undefined 悄悄传给领域层）
 *
 * 运行：node test/ipc-wiring.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(__dirname, '.tmp-data-wiring')

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
const api = require(path.join(ROOT, 'electron', 'api.cjs'))

// ══════════════════ 假 electron 模块 ══════════════════
// ipc.cjs 只用到这几样：ipcMain.handle、app 的几个属性、dialog 三个方法、
// shell.openPath、BrowserWindow（构造 + 两个静态方法）。替身只需覆盖这些。

const registered = new Map()
const appStub = {
  getVersion: () => '0.0.0-stub',
  isPackaged: false,
  getPath: () => TMP,
  relaunch: () => {},
  exit: () => {},
}
const dialogStub = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
}
const BrowserWindowStub = function BrowserWindow() {
  return { loadURL: async () => {}, destroy() {}, webContents: {} }
}
BrowserWindowStub.getFocusedWindow = () => null
BrowserWindowStub.getAllWindows = () => []

const electronStub = {
  ipcMain: { handle: (ch, fn) => registered.set(ch, fn) },
  app: appStub,
  dialog: dialogStub,
  shell: { openPath: async () => '' },
  BrowserWindow: BrowserWindowStub,
}

// 必须在 require ipc.cjs 之前替换（printer.cjs 也在此时解构 BrowserWindow）
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}
let registerIpc
try {
  registerIpc = require(path.join(ROOT, 'electron', 'ipc.cjs')).registerIpc
  registerIpc()
} finally {
  Module._load = origLoad
}

// 捕获 ipc.cjs 传给 api.call 的 (name, params, ctx)
let captured = []
const origCall = api.call
api.call = (name, params, ctx) => {
  captured.push({ name, params, ctx })
  return { stubbed: true }
}

/** 触发某个通道的 handler，返回它交给 api.call 的那一份三元组 */
function fire(channel, ...args) {
  const handler = registered.get(channel)
  if (!handler) throw new Error(`通道未注册: ${channel}`)
  captured = []
  handler({ sender: { isDestroyed: () => false, send: () => {} } }, ...args)
  return captured[0]
}

// ══════════════════════════ 断言 ══════════════════════════

async function main() {

  console.log('== 1. 注册表里的操作必须全部真的挂上 ==')
  {
    const ops = api.describe().map((o) => o.name)
    const missing = ops.filter((n) => !registered.has(n))
    ok(missing.length === 0, `注册表 ${ops.length} 个操作全部挂到 ipcMain`, missing)

    const extra = [...registered.keys()].filter((n) => !ops.includes(n))
    ok(extra.length === 0, 'ipcMain 上没有注册表之外的通道（没有旁路）', extra)
  }

  console.log('== 2. preload 暴露的通道必须有实现（否则是「点了没反应」） ==')
  {
    // app:meta / app:checkUpdate 在 main.cjs 里单独注册，不在注册表内——
    // 从源码收集，避免把这两个合法例外硬编码成白名单
    const mainChannels = [...src('electron/main.cjs')
      .matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((m) => m[1])
    const allRegistered = new Set([...registered.keys(), ...mainChannels])

    const preloadChannels = [...src('electron/preload.cjs')
      .matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map((m) => m[1])
    ok(preloadChannels.length > 0, `preload 暴露了 ${preloadChannels.length} 个通道`)

    const unreachable = preloadChannels.filter((c) => !allRegistered.has(c))
    ok(unreachable.length === 0, 'preload 暴露的通道全部有实现', unreachable)

    const ops = api.describe().map((o) => o.name)
    const fromMain = mainChannels.filter((c) => !ops.includes(c))
    ok(fromMain.length === 2, 'main.cjs 只额外注册 app:meta / app:checkUpdate', fromMain)
  }

  console.log('== 3. 位置参数 → 规范参数对象的归一化（写错只会静默传 undefined） ==')
  {
    // 每条：[通道, handler 收到的位置参数, 期望 api.call 收到的 params]
    const CASES = [
      // 单对象参数：原样透传
      ['dataset:importSheets', [{ filePath: 'a.xlsx', selections: [{ name: 'S1' }], mode: 'merge' }],
        { filePath: 'a.xlsx', selections: [{ name: 'S1' }], mode: 'merge' }],
      ['dataset:updateCell', [{ datasetId: 'd', rowIndex: 1, key: 'k', value: 'v' }],
        { datasetId: 'd', rowIndex: 1, key: 'k', value: 'v' }],
      ['dataset:deleteRow', [{ datasetId: 'd', rowIndex: 2 }], { datasetId: 'd', rowIndex: 2 }],
      ['dataset:setColumnPrint', [{ datasetId: 'd', key: 'k', printOn: true }],
        { datasetId: 'd', key: 'k', printOn: true }],
      ['print:validate', [{ datasetId: 'd', templateId: 't', rows: [0, 2] }],
        { datasetId: 'd', templateId: 't', rows: [0, 2] }],
      ['print:generate', [{ datasetId: 'd', templateId: 't' }], { datasetId: 'd', templateId: 't' }],
      ['print:exportPdf', [{ datasetId: 'd', templateId: 't', savePath: 'C:/x.pdf' }],
        { datasetId: 'd', templateId: 't', savePath: 'C:/x.pdf' }],
      ['print:send', [{ datasetId: 'd', templateId: 't', silent: true }],
        { datasetId: 'd', templateId: 't', silent: true }],

      // 位置参数：必须被包成具名对象，否则领域层拿到 undefined
      ['store:load', ['settings'], { name: 'settings' }],
      ['store:save', ['settings', { theme: 'dark' }], { name: 'settings', value: { theme: 'dark' } }],
      ['dataset:inspect', ['C:/a.csv'], { filePath: 'C:/a.csv' }],
      ['dataset:get', ['d1'], { id: 'd1' }],
      ['dataset:delete', ['d1'], { id: 'd1' }],
      ['dataset:renameColumn', ['d1', 'k', '别名'], { id: 'd1', key: 'k', alias: '别名' }],
      ['dataset:addRow', ['d1'], { id: 'd1' }],
      ['catalog:fields', ['d1'], { id: 'd1' }],
      ['template:get', ['t1'], { id: 't1' }],
      ['template:save', [{ name: '版式' }], { template: { name: '版式' } }],
      ['template:matchDataset', ['t1', 'd1'], { templateId: 't1', datasetId: 'd1' }],
      ['template:rebindDataset', ['t1', 'd1'], { templateId: 't1', datasetId: 'd1' }],
      ['template:delete', ['t1'], { id: 't1' }],
      ['font:delete', ['a.ttf'], { file: 'a.ttf' }],
      ['job:openSnapshot', ['j1'], { id: 'j1' }],
      ['job:delete', ['j1'], { id: 'j1' }],
    ]

    const wrong = []
    for (const [channel, args, expected] of CASES) {
      const c = fire(channel, ...args)
      if (!c) { wrong.push(`${channel}:未调用 api`); continue }
      if (c.name !== channel) { wrong.push(`${channel}:路由到 ${c.name}`); continue }
      if (JSON.stringify(c.params) !== JSON.stringify(expected)) {
        wrong.push(`${channel}:${JSON.stringify(c.params)} != ${JSON.stringify(expected)}`)
      }
    }
    ok(wrong.length === 0, `${CASES.length} 个通道的参数归一化正确`, wrong)

    // 无参通道：params 为 undefined 是既有语义（api.call 内部会兜成 {}）
    const noArg = ['app:ping', 'app:env', 'app:cacheInfo', 'app:clearCache', 'app:changeDataDir',
      'app:resetDataDir', 'app:openDataDir', 'app:relaunch', 'dataset:importDialog',
      'dataset:list', 'template:list', 'template:uploadBackgroundDialog', 'font:list',
      'font:uploadDialog', 'job:list']
    const badNoArg = noArg.filter((ch) => {
      const c = fire(ch)
      return !c || (c.params !== undefined && Object.keys(c.params).length !== 0)
    })
    ok(badNoArg.length === 0, `${noArg.length} 个无参通道不误传参数`, badNoArg)
  }

  console.log('== 4. ctx 注入：写权限给满、GUI 能力齐备、打印通道是同一个实例 ==')
  {
    const c = fire('app:ping')
    ok(c.ctx.allowWrite === true, 'GUI 通道 allowWrite=true（与抽取前行为一致）')
    ok(typeof c.ctx.app.version === 'string', 'ctx.app.version 来自宿主')
    ok(c.ctx.app.userDataDir === TMP, 'ctx.app.userDataDir 来自宿主')

    const dialogMethods = ['openDirectory', 'openFile', 'saveFile', 'openPath', 'openSnapshotWindow']
    const missingDialog = dialogMethods.filter((m) => typeof c.ctx.dialog[m] !== 'function')
    ok(missingDialog.length === 0, 'ctx.dialog 五个能力齐备', missingDialog)

    // printer 必须是真模块（不是替身）：它是两个出口的唯一实现
    const printer = require(path.join(ROOT, 'electron', 'printer.cjs'))
    ok(c.ctx.printer === printer, 'ctx.printer 就是 printer.cjs 模块本身')
    ok(typeof c.ctx.printer.exportPdf === 'function' && typeof c.ctx.printer.sendToPrinter === 'function',
      'printer 的 exportPdf / sendToPrinter 都在')

    ok(typeof c.ctx.emit === 'function', 'ctx.emit 是函数')
  }

  console.log('== 5. 进度事件：经 ctx.emit 落到 event.sender，且判 isDestroyed ==')
  {
    const sent = []
    const live = { sender: { isDestroyed: () => false, send: (ch, p) => sent.push({ ch, p }) } }

    captured = []
    registered.get('dataset:importSheets')(live, { filePath: 'a.xlsx', selections: [{ name: 'S1' }] })
    const ctxLive = captured[0].ctx

    ctxLive.emit('import:progress', { stage: 'parse', pct: 50 })
    ok(sent.length === 1 && sent[0].ch === 'import:progress', 'emit 用 import:progress 通道发出去', sent)
    ok(sent[0].p.pct === 50, '进度载荷原样透传')

    // 窗口已销毁时不得再 send（否则导入流程会被一句 "Object has been destroyed" 打断）
    const dead = { sender: { isDestroyed: () => true, send: () => { throw new Error('不该被调用') } } }
    captured = []
    registered.get('dataset:importSheets')(dead, { filePath: 'a.xlsx', selections: [{ name: 'S1' }] })
    const ctxDead = captured[0].ctx

    let threw = false
    try { ctxDead.emit('import:progress', { pct: 90 }) } catch { threw = true }
    ok(!threw, '窗口销毁后 emit 静默丢弃（不抛错、不打断导入）')

    // preload 的监听名必须与这里发出的通道名一致，否则进度条永远不动
    ok(/ipcRenderer\.on\('import:progress'/.test(src('electron/preload.cjs')),
      'preload 监听的通道名与 emit 一致')
  }

  console.log('== 6. 对话框能力真的接到 Electron dialog（不是空壳） ==')
  {
    let gotOpts = null
    const origShowOpen = dialogStub.showOpenDialog
    // dialog 的实现在注册时已闭包捕获 dialogStub 这个对象，改属性即可生效
    dialogStub.showOpenDialog = async (parent, opts) => {
      gotOpts = opts
      return { canceled: false, filePaths: ['X:/picked.csv'] }
    }

    const ctx = fire('app:ping').ctx
    const r = await ctx.dialog.openFile({ title: '导入数据文件', properties: ['openFile'] })
    ok(gotOpts && gotOpts.title === '导入数据文件', 'openFile 把选项透传给 dialog.showOpenDialog', gotOpts)
    ok(r.filePaths[0] === 'X:/picked.csv', 'openFile 把对话框结果原样返回')

    dialogStub.showOpenDialog = origShowOpen
  }

  console.log('== 7. 出口操作必须真的拿到 printer（否则 GUI 侧也会 GUI_REQUIRED） ==')
  {
    // 这是最容易漏的一条：如果 ipc.cjs 忘了把 printer 放进 ctx，
    // 纯 Node 侧的 api-cli 测试照样全绿（它本来就期望 GUI_REQUIRED），
    // 但应用里点「导出 PDF」会直接报「需要 Electron 打印通道」。
    const c = fire('print:exportPdf', { datasetId: 'd', templateId: 't' })
    ok(c.ctx.printer && typeof c.ctx.printer.exportPdf === 'function',
      'print:exportPdf 的 ctx.printer 可用')

    const c2 = fire('print:send', { datasetId: 'd', templateId: 't' })
    ok(c2.ctx.printer && typeof c2.ctx.printer.sendToPrinter === 'function',
      'print:send 的 ctx.printer 可用')

    const c3 = fire('job:openSnapshot', 'j1')
    ok(typeof c3.ctx.dialog.openSnapshotWindow === 'function',
      'job:openSnapshot 的 ctx.dialog 可用')
  }
}

main()
  .then(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
    console.log(`\nIPC 装配（纯 Node）：${pass} 通过，${fail} 失败`)
    process.exit(fail ? 1 : 0)
  })
  .catch((err) => {
    console.error('测试本身崩溃:', err)
    fs.rmSync(TMP, { recursive: true, force: true })
    process.exit(1)
  })

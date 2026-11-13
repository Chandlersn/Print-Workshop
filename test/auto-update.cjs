/** 更新任务回归：使用事件与可控异步请求，验证真实状态转换，不访问网络或安装应用。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')

const ROOT = path.resolve(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ packaged = true, response = 1, parent = null, missingModule = false } = {}) {
  const check = deferred(), download = deferred()
  const updater = new EventEmitter()
  const calls = { check: 0, download: 0, install: 0, dialogs: [] }
  updater.checkForUpdates = () => {
    calls.check++
    updater.emit('checking-for-update')
    return check.promise.then(result => {
      updater.emit(result.isUpdateAvailable ? 'update-available' : 'update-not-available', { version: '0.7.0' })
      return result
    })
  }
  updater.downloadUpdate = () => { calls.download++; return download.promise }
  updater.quitAndInstall = (...args) => { calls.install++; assert.deepEqual(args, [true, true]) }
  const states = []
  const context = {
    module: { exports: {} }, console: { log() {}, warn() {} },
    require(name) {
      if (name === 'electron') return {
        app: { isPackaged: packaged },
        BrowserWindow: { getFocusedWindow: () => parent, getAllWindows: () => [] },
        dialog: { showMessageBox: async (...args) => { calls.dialogs.push(args); return { response } } },
      }
      if (name === 'electron-updater') {
        if (missingModule) throw new Error('module missing')
        return { autoUpdater: updater }
      }
      return require(path.join(ROOT, 'electron', name))
    },
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/auto-update.cjs'), 'utf8'), context)
  const api = context.module.exports
  api.initAutoUpdater(s => states.push(s))
  const available = () => check.resolve({ isUpdateAvailable: true })
  return { api, updater, calls, states, check, download, available }
}

async function main() {
  for (const opts of [{ packaged: false }, { missingModule: true }]) {
    const f = fixture(opts)
    assert.equal(f.api.startUpdate().started, false)
    assert.ok(f.api.startUpdate().reason)
    assert.equal((await f.api.checkUpdate()).status, 'unavailable')
    assert.equal(f.calls.check, 0)
    assert.equal(f.api.installUpdate().ok, false)
  }

  {
    const f = fixture()
    assert.equal(f.updater.autoDownload, false)
    assert.equal(f.updater.autoInstallOnAppQuit, false)
    assert.equal(f.updater.disableDifferentialDownload, true)
    f.api.startUpdate()
    const manual = f.api.checkUpdate()
    f.api.startUpdate()
    await tick()
    assert.equal(f.calls.check, 1, '启动与手动检测复用一个请求')
    assert.equal(f.api.installUpdate().ok, false, '未下载时不能退出安装')
    f.available()
    assert.equal((await manual).status, 'newer')
    await tick()
    assert.equal(f.calls.download, 1)
    assert.equal(f.api.currentState().phase, 'downloading', '首个进度事件前即显示下载中')
    f.updater.emit('download-progress', { percent: 42.8, transferred: 42, total: 100 })
    f.api.startUpdate()
    assert.equal((await f.api.checkUpdate()).status, 'newer')
    assert.equal(f.api.currentState().percent, 42, '重复检查不会清空进度')
    assert.equal(f.api.currentState().version, '0.7.0')
    assert.equal(f.calls.check, 1)
    f.updater.emit('update-downloaded', { version: '0.7.0' })
    f.download.resolve([])
    await tick()
    assert.equal(f.calls.dialogs.length, 1)
    assert.equal(f.calls.dialogs[0].length, 1, '无窗口时使用无父窗口对话框重载')
    assert.equal(f.calls.install, 0, '选择稍后不会自动安装')
    assert.equal((await f.api.checkUpdate()).status, 'newer')
    assert.equal(f.calls.check, 1, '已下载后检查不会重新下载或覆盖安装状态')
    assert.equal(f.api.currentState().phase, 'downloaded')
    assert.equal(f.api.installUpdate().ok, true)
    assert.equal(f.api.installUpdate().ok, true)
    assert.equal(f.calls.install, 1, '安装按钮防止重入')
  }

  {
    const parent = { id: 'main-window' }
    const f = fixture({ parent, response: 0 })
    f.api.startUpdate()
    f.available()
    await tick()
    f.updater.emit('update-downloaded', { version: '0.7.0' })
    f.download.resolve([])
    await tick()
    assert.equal(f.calls.dialogs[0][0], parent)
    assert.equal(f.calls.install, 1, '原生提示选择现在重启会安装')
  }

  {
    const f = fixture()
    const pending = f.api.checkUpdate()
    f.updater.emit('update-not-available')
    f.check.resolve({ isUpdateAvailable: false })
    assert.equal((await pending).status, 'current')
    assert.equal(f.calls.download, 0)
  }

  for (const stage of ['check', 'download']) {
    const f = fixture()
    f.api.startUpdate()
    if (stage === 'download') { f.available(); await tick() }
    f[stage].reject(new Error('net::ERR_CONNECTION_RESET'))
    await tick()
    assert.equal(f.api.currentState().phase, 'error')
    assert.ok(f.api.currentState().message)
    let retried = 0
    f.updater.checkForUpdates = async () => {
      retried++
      f.updater.emit('update-not-available')
      return { isUpdateAvailable: false }
    }
    assert.equal((await f.api.checkUpdate()).status, 'current', `${stage} 失败后可重试`)
    assert.equal(retried, 1)
  }

  {
    const f = fixture()
    f.updater.checkForUpdates = () => { throw new Error('检测同步失败') }
    assert.equal((await f.api.checkUpdate()).status, 'unavailable')
    f.updater.checkForUpdates = async () => null
    assert.equal((await f.api.checkUpdate()).status, 'unavailable')
  }

  {
    const f = fixture()
    f.api.startUpdate(); f.available(); await tick()
    f.updater.emit('update-downloaded', { version: '0.7.0' })
    f.download.resolve([]); await tick()
    f.updater.quitAndInstall = () => { throw new Error('安装程序启动失败') }
    assert.equal(f.api.installUpdate().ok, false)
    assert.equal(f.api.currentState().phase, 'error')
  }

  // 执行真实 App.vue 脚本，验证订阅时序、快照恢复和过期响应处理。
  {
    const vue = require('vue')
    let mounted, notify
    const settings = deferred()
    const script = fs.readFileSync(path.join(ROOT, 'src/App.vue'), 'utf8')
      .split('<script setup>')[1].split('</script>')[0].replace(/^import .+$/gm, '')
    // 该用例剥掉 import 后在 vm 沙箱里直接跑 App.vue 脚本，所以模块级符号要在
    // context 里补齐。配色用真实的 accent.js（ESM→动态 import），免得替身与源码走样。
    const accent = await import(pathToFileURL(path.join(ROOT, 'src/lib/accent.js')).href)
    const snapshot = { phase: 'downloaded', at: 10, version: '0.7.0', info: { version: '0.7.0' } }
    const context = {
      ...vue, ...accent, onMounted: cb => { mounted = cb }, onBeforeUnmount: () => {},
      cellNav: vue.ref(null), designerNav: vue.reactive({}), photoNav: vue.reactive({}),
      toUserMessage: e => e.message,
      // App.vue 顶层会 applyAccent() 写 :root 变量、并注册 pointer/keydown 监听，
      // 这里给最小 DOM 桩，避免为配色改造改坏这条「执行真实脚本」的用例。
      document: {
        documentElement: { dataset: {}, style: { setProperty() {} } },
        addEventListener() {}, removeEventListener() {},
      },
      localStorage: { getItem: () => null, setItem: () => {} },
      window: { printpress: {
        onUpdateState: cb => { notify = cb }, onUpdateAvailable() {},
        getAppMeta: async () => ({ version: '0.6.7', updateState: snapshot }),
        loadData: () => settings.promise, getEnv: async () => ({}),
        startUpdate: async () => ({ started: true, state: snapshot }),
      } },
    }
    vm.runInNewContext(script + '\nglobalThis.ui = { updateState, updateInfo, updateMsg, startRealUpdate, dismissUpdate };', context)
    const pending = mounted()
    assert.equal(typeof notify, 'function', 'loadData 未完成前已经订阅更新')
    await tick()
    assert.equal(context.ui.updateState.value.phase, 'downloaded', '晚订阅也能恢复已下载状态')
    notify({ ...snapshot, phase: 'error', message: '下载失败', at: 20 })
    await context.ui.startRealUpdate()
    assert.equal(context.ui.updateState.value.phase, 'error', '旧 IPC 响应不会覆盖新的推送')
    context.ui.dismissUpdate()
    notify({ ...snapshot, at: 21 })
    assert.equal(context.ui.updateInfo.value, null, '关闭横幅后进度推送不会再次弹出')
    settings.resolve({ onboarded: true })
    await pending
  }
  console.log('PASS 更新任务：并发检查、下载进度、缓存恢复、失败重试、安装确认及界面状态')
}

main().catch(e => { console.error(e); process.exitCode = 1 })

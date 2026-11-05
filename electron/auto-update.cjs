/**
 * 安装版统一从 GitHub Release 检测、下载并校验更新。
 * 启动检测与手动检查共用一次任务；只有用户确认后才重启安装。
 * 更新源与缓存配置由 electron-builder 写入 resources/app-update.yml。
 */
const { app, dialog, BrowserWindow } = require('electron')
const { toUserMessage } = require('./user-error.cjs')
const { RELEASES_URL } = require('./version-check.cjs')

let autoUpdater = null
let initialized = false
let notifyState = null
let checkPromise = null
let downloadPromise = null
let installPrompt = null
let installRequested = false
let state = { phase: 'idle', at: 0 }

function log(...a) { console.log('[updater]', ...a) }
function warn(...a) { console.warn('[updater]', ...a) }

function setState(next) {
  state = { ...next, at: Math.max(Date.now(), state.at + 1) }
  log('状态:', JSON.stringify(next))
  if (typeof notifyState === 'function') {
    try { notifyState(state) } catch (e) { warn('状态推送失败：', e && e.message) }
  }
}

function currentState() { return state }
function reasonOf(e, fallback) { return e ? toUserMessage(e, fallback) : fallback }
function fail(e, fallback) {
  warn(fallback, e && (e.stack || e.message))
  installRequested = false
  setState({ ...state, phase: 'error', message: reasonOf(e, fallback) })
}

/** 必须在 app.whenReady 后调用。失败与进度均通过状态回调送到界面。 */
function initAutoUpdater(onState) {
  if (initialized) return
  initialized = true
  notifyState = typeof onState === 'function' ? onState : null
  if (!app.isPackaged) {
    setState({ phase: 'unsupported', reason: '开发态不启用自动更新（请用安装版验证）' })
    return
  }
  try {
    autoUpdater = require('electron-updater').autoUpdater
  } catch (e) {
    setState({ phase: 'unsupported', reason: '未安装 electron-updater' })
    return
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 发布流程提供完整安装包，避免缺少旧版 blockmap 时先等待差异下载失败。
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.disableWebInstaller = true

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }))
  autoUpdater.on('error', e => fail(e, '更新过程出错'))
  autoUpdater.on('update-available', info => {
    const version = info.version
    setState({ phase: 'available', version, info: {
      version,
      notes: '',
      url: RELEASES_URL + '/latest',
    } })
  })
  autoUpdater.on('update-not-available', () => setState({ phase: 'none' }))
  autoUpdater.on('download-progress', p => setState({
    ...state,
    phase: 'downloading',
    percent: Math.max(0, Math.min(100, Math.floor(p.percent || 0))),
    transferred: p.transferred || 0,
    total: p.total || 0,
  }))
  autoUpdater.on('update-downloaded', info => {
    setState({ ...state, phase: 'downloaded', version: info.version, percent: 100 })
    promptInstall()
  })
}

function beginDownload() {
  if (downloadPromise || state.phase === 'downloaded') return
  // 网络连接、读取缓存和校验安装包期间也显示下载中，不能等首个进度事件。
  setState({ ...state, phase: 'downloading', percent: 0 })
  downloadPromise = Promise.resolve().then(() => autoUpdater.downloadUpdate())
    .catch(e => fail(e, '下载更新包失败'))
    .finally(() => { downloadPromise = null })
}

/** 下载完成只询问一次；「稍后」后仍可通过界面按钮安装。 */
function promptInstall() {
  if (installPrompt) return
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'info',
    title: '更新就绪',
    message: '新版本已下载完成，重启安装即可完成更新。',
    detail: '请先保存正在编辑的内容。选择「稍后」后，可点击「立即重启安装」继续更新。',
    buttons: ['现在重启', '稍后'],
    defaultId: 1,
    cancelId: 1,
  }
  installPrompt = Promise.resolve()
    .then(() => win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    .then(({ response }) => { if (response === 0) installUpdate() })
    .catch(e => warn('安装提示未显示：', e && e.message))
    .finally(() => { installPrompt = null })
}

/** 启动检测或复用当前任务，重复点击不会重置下载进度和已下载状态。 */
function startUpdate() {
  if (!autoUpdater) {
    return { started: false, reason: state.reason || '当前环境不支持应用内更新', state }
  }
  if (checkPromise || downloadPromise || state.phase === 'downloaded' || installRequested) {
    return { started: true, state }
  }
  setState({ phase: 'checking' })
  checkPromise = Promise.resolve().then(() => autoUpdater.checkForUpdates())
    .then(result => {
      if (!result) throw new Error('更新检测未返回结果，请稍后重试')
      if (result.isUpdateAvailable) beginDownload()
    })
    .catch(e => fail(e, '查询更新失败'))
    .finally(() => { checkPromise = null })
  return { started: true, state }
}

/** 保持 checkUpdate IPC 的返回格式；检测与下载使用同一份 Release 元数据。 */
async function checkUpdate() {
  const result = startUpdate()
  if (!result.started) return { status: 'unavailable', reason: result.reason, state }
  if (checkPromise) await checkPromise
  if (state.phase === 'none') return { status: 'current', state }
  if (state.phase === 'error') return { status: 'unavailable', reason: state.message, state }
  if (state.info) return { status: 'newer', info: state.info, state }
  return { status: 'unavailable', reason: '未能获取更新信息，请稍后重试', state }
}

/** 安装动作和原生提示共用检查，防止重入或在下载前退出应用。 */
function installUpdate() {
  if (!autoUpdater) return { ok: false, reason: state.reason || '当前环境不支持应用内更新' }
  if (installRequested) return { ok: true }
  if (state.phase !== 'downloaded') return { ok: false, reason: '更新尚未下载完成' }
  installRequested = true
  try {
    autoUpdater.quitAndInstall(true, true)
    return state.phase === 'error' ? { ok: false, reason: state.message } : { ok: true }
  } catch (e) {
    fail(e, '启动更新安装失败')
    return { ok: false, reason: state.message }
  }
}

module.exports = { initAutoUpdater, startUpdate, checkUpdate, installUpdate, currentState }

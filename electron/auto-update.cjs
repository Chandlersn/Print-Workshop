/**
 * 自动更新：基于 electron-updater 的全量自更新（「点更新 → 后台下载 → 重启安装」）。
 *
 * 设计边界（对应「自动化边界三问」）：
 * - 版本「检测/提示」仍由 version-check.cjs 负责（轻量信标，只决定要不要弹横幅）；
 *   本模块只接管「下载 + 安装」这一段——即普通软件那种点了就后台下、下完提示重启的体验。
 * - 主进程在确认有新版本后调用 startUpdate() 触发后台下载：autoDownload 关着，
 *   下载由 update-available 事件里显式 downloadUpdate() 触发（否则只会 emit 事件、不下载）；
 *   下载完成弹原生对话框「现在重启 / 稍后」，确认后 quitAndInstall(true,true) 静默安装并重启。
 * - 仅在打包态（app.isPackaged）启用；开发态跳过，避免 dev 下 electron-updater 因无更新源报错。
 * - 更新源：GitHub Release（provider: 'github'）。清单 latest.yml 由 scripts/release-upload.cjs
 *   在发版时按真实安装包算 sha512 一并上传，无需在代码里写死任何 URL。
 *
 * ── 状态可见性（2026-10-10 补）────────────────────────────────
 * 本模块**每一个阶段与每一次失败都必须能被界面看到**：
 *   - 早先所有错误只进 console.warn，打包态没有控制台 ⇒ 真下载失败也 100% 不可见，
 *     用户看到的只是「点了没反应」。这正是「看不见的失败最危险」的又一实例。
 *   - 现在统一走 setState()：阶段变化与失败原因都会经 onState 回调推给渲染层，
 *     由「关于」对话框与顶栏横幅如实呈现。
 *   - startUpdate() 也不再静默：不支持应用内更新时返回 { started:false, reason }，
 *     让界面能说清「为什么没下载」，而不是让用户对着一个没反应的按钮。
 *
 * 所有对外仓库常量集中此处；换仓库只改 OWNER / REPO。
 */
const { app, dialog, BrowserWindow } = require('electron')

const OWNER = 'Chandlersn'
const REPO = 'Print-Workshop'

let autoUpdater = null
let initialized = false
let notifyState = null

/**
 * 当前更新状态。phase 取值：
 *   idle         尚未做过任何检测
 *   unsupported  当前环境不支持应用内更新（开发态 / 缺模块 / 更新源配置失败）
 *   checking     正在向更新源查询
 *   available    查到新版本，准备下载
 *   downloading  下载中（带 percent）
 *   downloaded   已下载完成，等用户重启安装
 *   none         已是最新
 *   error        出错（带 message，界面必须显示出来）
 */
let state = { phase: 'idle' }

function log(...a) { console.log('[updater]', ...a) }
function warn(...a) { console.warn('[updater]', ...a) }

/** 记下状态并推给界面。推送本身失败不能影响更新流程。 */
function setState(next) {
  state = { ...next, at: Date.now() }
  log('状态:', JSON.stringify(next))
  if (typeof notifyState === 'function') {
    try { notifyState(state) } catch (e) { warn('状态推送失败：', e && e.message) }
  }
}

/** 当前状态（供界面在打开时才订阅、或断线重连后补齐） */
function currentState() { return state }

/** 把任意异常收敛成一句能显示给用户的中文原因 */
function reasonOf(e, fallback) {
  if (!e) return fallback
  const msg = e.message || String(e)
  return msg || fallback
}

/**
 * 初始化自动更新。幂等；开发态直接跳过。
 *
 * @param {(state: object) => void} [onState] 状态回调。主进程在这里把状态转发给渲染层；
 *        不传则只写日志（纯 Node / 测试环境照常可用）。
 * 必须在 app.whenReady 之后、首次 checkForUpdates 之前调用。
 */
function initAutoUpdater(onState) {
  if (initialized) return
  initialized = true
  notifyState = typeof onState === 'function' ? onState : null

  if (!app.isPackaged) {
    log('开发态跳过自动更新初始化')
    setState({ phase: 'unsupported', reason: '开发态不启用自动更新（请用安装版验证）' })
    return
  }

  let mod
  try {
    mod = require('electron-updater')
  } catch (e) {
    warn('未安装 electron-updater，自动更新不可用：', e && e.message)
    setState({ phase: 'unsupported', reason: '未安装 electron-updater' })
    return
  }
  autoUpdater = mod.autoUpdater
  // 确认有新版本后再手动触发下载，避免在已最新时也空跑一次网络
  autoUpdater.autoDownload = false
  // 安装动作由原生对话框确认，不偷偷在退出时装
  autoUpdater.autoInstallOnAppQuit = false

  try {
    autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO })
  } catch (e) {
    warn('setFeedURL 失败：', e && e.message)
    autoUpdater = null
    setState({ phase: 'unsupported', reason: '更新源配置失败：' + reasonOf(e, '未知原因') })
    return
  }

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }))

  autoUpdater.on('error', (e) => {
    warn('更新错误：', e && (e.stack || e.message))
    setState({ phase: 'error', message: reasonOf(e, '更新过程出错') })
  })

  autoUpdater.on('update-available', (info) => {
    const version = info && info.version
    log('有可用更新：', version)
    setState({ phase: 'available', version })
    // 关键：autoDownload 关着时，checkForUpdates() 只会 emit 本事件、不会下载
    // （electron-updater: downloadPromise = autoDownload ? downloadUpdate() : null）。
    // 必须在这里显式触发，否则永远走不到 update-downloaded、也就弹不出「现在重启」。
    autoUpdater.downloadUpdate().catch((e) => {
      warn('下载失败：', e && e.message)
      setState({ phase: 'error', message: reasonOf(e, '下载更新包失败') })
    })
  })

  autoUpdater.on('update-not-available', () => setState({ phase: 'none' }))

  autoUpdater.on('download-progress', (p) => setState({
    phase: 'downloading',
    percent: Math.floor((p && p.percent) || 0),
    transferred: (p && p.transferred) || 0,
    total: (p && p.total) || 0,
  }))

  autoUpdater.on('update-downloaded', (info) => {
    const version = info && info.version
    log('下载完成：', version)
    setState({ phase: 'downloaded', version })
    promptInstall()
  })

  log('已初始化（GitHub Release 更新源）')
}

/** 下载完成后提示用户重启安装 */
function promptInstall() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
  dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: '更新就绪',
    message: '新版本已下载完成，重启应用即可完成更新。',
    detail: '建议现在重启以应用更新；也可稍后手动重启。',
    buttons: ['现在重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0 && autoUpdater) autoUpdater.quitAndInstall(true, true)
  }).catch(() => { /* 对话框被关，不影响下次启动再提示 */ })
}

/**
 * 开始后台下载（幂等，重复调用无害）。
 *
 * 不再静默：拿不到 updater 时返回 { started:false, reason }，
 * 界面据此说明「为什么没下载」并给出「前往发布页」的出路。
 */
function startUpdate() {
  if (!autoUpdater) {
    return { started: false, reason: state.reason || '当前环境不支持应用内更新', state }
  }
  autoUpdater.checkForUpdates().catch((e) => {
    warn('checkForUpdates 失败：', e && e.message)
    setState({ phase: 'error', message: reasonOf(e, '查询更新失败') })
  })
  // checkForUpdates() 同步触发 checking-for-update，此处 state 已是 'checking'
  return { started: true, state }
}

/** 重启安装。只有真下载完了才允许——否则会重启到一个「什么都没变」的版本。 */
function installUpdate() {
  if (!autoUpdater) {
    return { ok: false, reason: state.reason || '当前环境不支持应用内更新' }
  }
  if (state.phase !== 'downloaded') {
    return { ok: false, reason: '更新尚未下载完成' }
  }
  autoUpdater.quitAndInstall(true, true)
  return { ok: true }
}

module.exports = { initAutoUpdater, startUpdate, installUpdate, currentState }

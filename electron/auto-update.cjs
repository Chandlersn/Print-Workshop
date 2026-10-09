/**
 * 自动更新：基于 electron-updater 的全量自更新（「点更新 → 后台下载 → 重启安装」）。
 *
 * 设计边界（对应「自动化边界三问」）：
 * - 版本「检测/提示」仍由 version-check.cjs 负责（轻量信标，只决定要不要弹横幅）；
 *   本模块只接管「下载 + 安装」这一段——即普通软件那种点了就后台下、下完提示重启的体验。
 * - 主进程在确认有新版本后调用 startUpdate() 触发后台下载（autoDownload 关，手动触发省带宽）；
 *   下载完成弹原生对话框「现在重启 / 稍后」，确认后 quitAndInstall(true,true) 静默安装并重启。
 * - 仅在打包态（app.isPackaged）启用；开发态跳过，避免 dev 下 electron-updater 因无更新源报错。
 * - 更新源：GitHub Release（provider: 'github'）。清单 latest.yml 由 scripts/release-upload.cjs
 *   在发版时按真实安装包算 sha512 一并上传，无需在代码里写死任何 URL。
 *
 * 所有对外仓库常量集中此处；换仓库只改 OWNER / REPO。
 */
const { app, dialog, BrowserWindow } = require('electron')

const OWNER = 'Chandlersn'
const REPO = 'Print-Workshop'

let autoUpdater = null
let initialized = false

function log(...a) { console.log('[updater]', ...a) }
function warn(...a) { console.warn('[updater]', ...a) }

/**
 * 初始化自动更新。幂等；开发态直接跳过。
 * 必须在 app.whenReady 之后、首次 checkForUpdates 之前调用。
 */
function initAutoUpdater() {
  if (initialized) return
  initialized = true
  if (!app.isPackaged) {
    log('开发态跳过自动更新初始化')
    return
  }
  let mod
  try {
    mod = require('electron-updater')
  } catch (e) {
    warn('未安装 electron-updater，自动更新不可用：', e && e.message)
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
  }

  autoUpdater.on('error', (e) => warn('更新错误：', e && (e.stack || e.message)))
  autoUpdater.on('update-available', (info) => log('有可用更新：', info && info.version))
  autoUpdater.on('update-not-available', () => log('已是最新'))
  autoUpdater.on('download-progress', (p) => log('下载进度', Math.floor((p && p.percent) || 0), '%'))
  autoUpdater.on('update-downloaded', (info) => {
    log('下载完成：', info && info.version)
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

/** 确认有新版本后调用：开始后台下载（幂等，重复调用无害） */
function startUpdate() {
  if (!autoUpdater) return
  autoUpdater.checkForUpdates().catch((e) => warn('checkForUpdates 失败：', e && e.message))
}

module.exports = { initAutoUpdater, startUpdate }

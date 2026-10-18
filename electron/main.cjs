#!/usr/bin/env node
/**
 * 批印坊 PrintPress - Electron 主进程入口
 *
 * 职责：窗口生命周期 + 数据目录决策 + IPC 装配。
 * 引擎逻辑不写在这里，见 electron/ipc.cjs（通道装配）与各引擎模块。
 */

const { app, BrowserWindow, dialog, protocol, net, shell, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const versionCheck = require('./version-check.cjs')
const autoUpdate = require('./auto-update.cjs')

// 运行数据目录：优先用户自定义（data-dir.json 引导配置），否则
// 开发态放仓库 data/（便于查看与备份），打包后放 %APPDATA%
const isSmoke = process.argv.includes('--smoke')
const dataDirModule = require('./data-dir.cjs')
// 测试注入口：外部已设 PRINTPRESS_DATA_DIR（e2e 隔离数据目录）时直接采用，
// 不读自定义配置也不迁移；生产环境无此变量，走常规解析
const resolved = process.env.PRINTPRESS_DATA_DIR
  ? { dataDir: process.env.PRINTPRESS_DATA_DIR, custom: false, fallback: process.env.PRINTPRESS_DATA_DIR }
  : dataDirModule.resolveDataDir({
      isPackaged: app.isPackaged,
      userDataDir: app.getPath('userData'),
      appPath: app.getAppPath(),
    })
const dataDir = resolved.dataDir

// 统一在模块加载前定好环境变量，供 ipc/store 模块读取
process.env.PRINTPRESS_DATA_DIR = dataDir
process.env.PRINTPRESS_DATA_DIR_CUSTOM = resolved.custom ? '1' : ''

// 补上次没清掉的系统缓存。**位置很关键**：必须赶在 GPU 进程打开 GPUCache / DawnCache
// 之前——应用运行期间删这两个目录会 EPERM（Chromium 自己持有），
// 那正是「清理缓存」点了像没反应的根因。这里清完 Chromium 会按需重建，属正常。
try {
  const cache = require('./cache.cjs')
  const swept = cache.runPendingCleanup(app.getPath('userData'))
  if (swept.removed.length) console.log(`[cache] 启动清理完成: ${swept.removed.join(', ')}`)
  if (swept.still.length) console.log(`[cache] 仍占用，留待下次: ${swept.still.join(', ')}`)
} catch (err) {
  // 清不掉不影响启动，别让它挡住主流程
  console.warn('[cache] 启动清理跳过:', err && err.message)
}

// pp:// 协议：渲染进程访问数据目录媒体（底图/上传字体）的唯一通道。
// 必须在 app.ready 之前注册特权 scheme。
protocol.registerSchemesAsPrivileged([
  { scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

/** pp://media/<相对路径> → 数据目录内绝对路径。穿越防护在归一化之前拦 `..`。 */
function registerMediaProtocol() {
  require('./media-protocol.cjs').registerMediaProtocol(require('electron').session.defaultSession)
}

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f6f2e9', // 宣纸底色，避免白闪
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 页内外链（target=_blank / window.open）一律交给系统浏览器，不在应用内开新窗口。
  // default 分支必须是 deny：原来返回 allow，渲染层任何一处注入的
  // file:// / javascript: / smb: 都能在应用窗口里开一个新页面。
  // 放行的条件比「是 http」更严——只放 https，http 没有正当理由。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) {
      shell.openExternal(url)
    } else if (/^https?:\/\//i.test(url)) {
      // http 仍不开应用内窗口，只放系统浏览器（并留下痕迹便于排查）
      console.warn('[main] 拒绝以 http 打开应用内窗口:', url)
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  return win
}

function main() {
  // GUI 与 GUI 之间交给 Electron 内置能力（第二个实例直接退出并聚焦首窗）；
  // 文件锁只负责「GUI vs 命令行」这一半，见 data-lock.cjs
  //
  // 冒烟 / e2e 必须跳过这道锁：它按 Electron 的 userData（默认 %APPDATA%\批印坊）判同，
  // **不看**我们的 PRINTPRESS_DATA_DIR。测试一个接一个起多个实例、甚至与开发者已开着的
  // 窗口并存，第二个实例会静默 app.quit()，症状是「窗口没出现 / CDP 连不上」，
  // 排查起来完全不指向锁。生产环境不设这个变量，照常生效。
  const isolatedInstance = Boolean(process.env.PRINTPRESS_DATA_DIR)
  if (!isolatedInstance && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  if (!isolatedInstance) {
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }

  // 打印工具无重度图形需求，禁用硬件加速换取最大兼容性
  // （远程桌面 / 沙箱 / 老显卡上 GPU 进程崩溃会导致整个应用无法启动）
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('in-process-gpu')

  ensureDataDir()

  // 数据目录互斥（I-54）：GUI 生命周期持锁，于是「窗口开着时命令行写入」会被明确拒绝，
  // 而不是两个进程各自读到旧值、各自写回、后写的安静吃掉前一次修改。
  // 取锁必须排在种子与各类迁移之前——那些步骤本身就会写 JSON。
  try {
    const dataLock = require('./data-lock.cjs')
    dataLock.acquireForHost()
    // 必须用 process.on('exit')：冒烟路径走 app.exit()，它不触发 will-quit
    process.on('exit', () => { try { require('./data-lock.cjs').release() } catch { /* 退出路径不许抛 */ } })
    app.on('will-quit', () => { try { dataLock.release() } catch { /* 同上 */ } })
  } catch (err) {
    if (err && err.code === 'DATA_DIR_BUSY') {
      // 有出口的提示：说清该做什么，而不是丢一句 errno 或路径（I-48）
      dialog.showErrorBox('批印坊已在运行', '另一个批印坊窗口正在使用同一份数据。请先关闭它，再重新打开本窗口。')
      app.exit(1)
      return
    }
    console.warn('[data-lock] 取锁异常，按无锁继续启动')
  }

  // 首启种子：示例名单 + 7 套示例模板（证书文书 3 + 拼版小件 4；失败不阻塞启动，下次启动重试）
  try {
    const seedDir = app.isPackaged
      ? path.join(process.resourcesPath, 'seed')
      : path.join(app.getAppPath(), 'build', 'seed')
    const { seedIfFirstRun } = require('./seed-demo.cjs')
    const seedResult = seedIfFirstRun(seedDir)
    if (seedResult.seeded) console.log('首启示例数据已就绪')
    else if (seedResult.reason && seedResult.reason !== 'already') console.error('种子失败:', seedResult.reason)
  } catch (err) {
    console.error('种子异常:', err)
  }

  // 原件迁移先于模板迁移和媒体读取：独立素材目录只存受管理原件。
  try {
    const designs = require('./designs.cjs')
    const temporary = designs.migrateEphemeralOriginals()
    const managed = designs.migrateManagedOriginals()
    if (temporary.migrated) console.log(`临时底图原件迁移 ${temporary.migrated} 件`)
    if (managed.migrated) console.log(`素材库原件迁移 ${managed.migrated} 件`)
  } catch (err) {
    console.error('素材原件迁移异常:', err)
  }

  // 存量迁移：旧 print-bg 背景转素材库 assetId（幂等；失败不阻塞启动）
  try {
    const templates = require('./templates.cjs')
    const r = templates.migrateBackgrounds()
    if (r.migrated) console.log(`模板底图迁移 ${r.migrated} 条`)
  } catch (err) {
    console.error('模板底图迁移异常:', err)
  }

  // 工程包事务收敛：上次运行中途崩溃 / 强杀留下的导入事务在这里结清——
  // 索引里已有该工程的认定成功（提交标记没写完不算失败），没有的回滚本次写出的字体与版本目录。
  // 失败不阻塞启动：残留事务只会让那一次导入没结果，不影响别的功能。
  try {
    const designPackage = require('./design-package.cjs')
    const recovered = designPackage.recoverPendingTransactions()
    if (recovered.recovered.length || recovered.rolledBack.length) {
      console.log(`工程包事务收敛：完成 ${recovered.recovered.length} 个，回滚 ${recovered.rolledBack.length} 个`)
    }
    const purged = designPackage.purgeStaging()
    if (purged.removed.length) console.log(`清理过期导入暂存 ${purged.removed.length} 项`)
  } catch (err) {
    console.error('启动事务恢复异常:', err)
  }
  try {
    const photoRecovery = require('./photo-library.cjs').recoverPendingImports()
    if (photoRecovery.recovered.length || photoRecovery.rolledBack.length || photoRecovery.failed.length) {
      console.log(`照片导入恢复：完成 ${photoRecovery.recovered.length} 个，回滚 ${photoRecovery.rolledBack.length} 个，失败 ${photoRecovery.failed.length} 个`)
    }
  } catch (err) { console.error('照片导入恢复异常:', err) }

  // 产品化接口位（M5 预留，不提前实现）：
  // 1. 自动更新：当前用 version-check.cjs 做轻量版本信标检测（只提示不自装），
  //    后续若做全量自更新再挂 electron-updater；
  // 2. 授权校验：settings.json 预留 license 字段位（{ key, activatedAt }），
  //    对外产品化时在此挂载启动时校验与功能门控。

  // 更新检测 IPC：meta 给渲染层版本与出口链接；checkUpdate 支持手动触发（卡点可见）
  ipcMain.handle('app:meta', () => ({
    version: app.getVersion(),
    releasesUrl: versionCheck.RELEASES_URL,
    feedbackUrl: versionCheck.FEEDBACK_URL,
  }))
  ipcMain.handle('app:checkUpdate', async () =>
    versionCheck.checkForUpdate({ currentVersion: app.getVersion() }))

  // IPC 通道装配（store / 后续 dataset / template / print 引擎都在这里挂载）
  const { registerIpc } = require('./ipc.cjs')
  registerIpc()

  app.whenReady().then(() => {
    registerMediaProtocol()
    // 更新状态全程可见：阶段变化（检测中 / 下载 N% / 已下载 / 失败原因）都推给渲染层。
    // 早先失败只进 console.warn，打包态没有控制台 ⇒ 真失败也看不见，用户只看到「点了没反应」。
    // 窗口在下面才创建，所以按调用时刻取窗口，不做提前绑定。
    autoUpdate.initAutoUpdater((state) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
        w.webContents.send('update:state', state)
      }
    })
    const win = createWindow()

    // 启动自动更新检测：页面加载完才查一次、3 秒超时、任何失败静默——
    // 只有远程版本更大才通知渲染层弹横幅（离线用户零打扰）
    win.webContents.on('did-finish-load', () => {
      versionCheck.checkForUpdate({ currentVersion: app.getVersion() })
        .then((r) => {
          if (r.status === 'newer') {
            win.webContents.send('update:available', r.info)
            // 检测到新版即后台下载，实现「点更新 → 自动下载 → 重启安装」
            autoUpdate.startUpdate()
          }
        })
        .catch(() => { /* 检测永不阻塞、永不报错 */ })
    })

    if (isSmoke) {
      // 冒烟模式：窗口创建且页面加载完成后退出，供脚本验证
      // --shot=<path>：加载完成后截图存盘再退出（主题/视觉回归用）
      const shotArg = process.argv.find((a) => a.startsWith('--shot='))
      win.webContents.on('did-finish-load', () => {
        if (shotArg) {
          setTimeout(() => {
            win.webContents.capturePage().then((img) => {
              fs.writeFileSync(shotArg.slice(7), img.toPNG())
              console.log('SHOT_OK')
              app.exit(0)
            }).catch((err) => {
              console.error('SHOT_FAIL', err)
              app.exit(1)
            })
          }, 800)
          return
        }
        console.log('SMOKE_OK')
        setTimeout(() => app.exit(0), 500)
      })
      setTimeout(() => {
        console.error('SMOKE_TIMEOUT')
        app.exit(1)
      }, 15000)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

main()

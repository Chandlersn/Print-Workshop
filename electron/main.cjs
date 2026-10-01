#!/usr/bin/env node
/**
 * 批印坊 PrintPress - Electron 主进程入口
 *
 * 职责：窗口生命周期 + 数据目录决策 + IPC 装配。
 * 引擎逻辑不写在这里，见 electron/ipc.cjs（通道装配）与各引擎模块。
 */

const { app, BrowserWindow, protocol, net, shell, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const versionCheck = require('./version-check.cjs')

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

// pp:// 协议：渲染进程访问数据目录媒体（底图/上传字体）的唯一通道。
// 必须在 app.ready 之前注册特权 scheme。
protocol.registerSchemesAsPrivileged([
  { scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

/** pp://media/<相对路径> → 数据目录内绝对路径。穿越防护在归一化之前拦 `..`。 */
function registerMediaProtocol() {
  protocol.handle('pp', async (request) => {
    try {
      const u = new URL(request.url)
      // hostname 只是命名空间标签（media），真实相对路径在 pathname；
      // 若把 hostname 拼进路径会多出一层不存在的目录（M2 遗留 bug，M3 修复）
      const rel = decodeURIComponent(u.pathname).replace(/\\/g, '/').replace(/^\/+/, '')
      if (!rel || rel.split('/').includes('..')) {
        return new Response('bad path', { status: 403 })
      }
      const abs = path.join(dataDir, rel)
      const resp = await net.fetch(pathToFileURL(abs).toString())
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
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

  // 页内外链（target=_blank / window.open）一律交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  return win
}

function main() {
  // 打印工具无重度图形需求，禁用硬件加速换取最大兼容性
  // （远程桌面 / 沙箱 / 老显卡上 GPU 进程崩溃会导致整个应用无法启动）
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('in-process-gpu')

  ensureDataDir()

  // 首启种子：示例名单 + 4 套示例模板（失败不阻塞启动，下次启动重试）
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
    const win = createWindow()

    // 启动自动更新检测：页面加载完才查一次、3 秒超时、任何失败静默——
    // 只有远程版本更大才通知渲染层弹横幅（离线用户零打扰）
    win.webContents.on('did-finish-load', () => {
      versionCheck.checkForUpdate({ currentVersion: app.getVersion() })
        .then((r) => {
          if (r.status === 'newer') win.webContents.send('update:available', r.info)
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

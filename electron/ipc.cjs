/**
 * IPC 装配薄壳：把 electron/api.cjs 的操作表挂到 ipcMain 上。
 *
 * 本文件只做三件事，业务逻辑一律不写在这里：
 *   1. 把 Electron 的宿主能力包成 ctx（对话框 / 打印通道 / 应用元信息）
 *   2. 遍历操作表注册通道，用 op.fromIpc 把位置参数归一化成规范参数对象
 *   3. 注入 allowWrite: true —— GUI 通道拥有完整写权限
 *
 * 为什么写权限在这里给而不是在 api 里默认打开：api.cjs 是给 CLI / agent
 * 共用的，那里必须默认关（agent 默认不能删数据）。GUI 是用户本人在操作，
 * 权限给满，与抽取前行为一致。
 *
 * 通道清单见 api.cjs 的 OPS；渲染进程真正能调到的范围由 preload.cjs 的
 * contextBridge 白名单决定——那才是面向渲染层的契约面。
 */
const { ipcMain, app, dialog, shell, BrowserWindow } = require('electron')
const { pathToFileURL } = require('url')
const api = require('./api.cjs')
const printer = require('./printer.cjs')

/** 对话框统一挂主窗口：无主对话框在 Windows 上可能被主窗口遮挡，用户看似「没反应」 */
function dialogParent() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
}

/**
 * 宿主能力袋。
 *
 * dialog 与 printer 是「GUI 出口层」的全部内容：api.cjs 只认这个接口，
 * 不认 Electron。CLI 传 null 时，需要它们的操作会得到 GUI_REQUIRED 错误，
 * 而不是一个 import 就崩在 require('electron') 上。
 */
function hostContext(event) {
  return {
    // GUI 是用户本人在操作，写权限给满（与抽取前一致）
    allowWrite: true,

    app: {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      userDataDir: app.getPath('userData'),
      relaunch: () => {
        app.relaunch()
        app.exit(0)
        return { ok: true }
      },
    },

    dialog: {
      openDirectory: (opts) => dialog.showOpenDialog(dialogParent(), opts),
      openFile: (opts) => dialog.showOpenDialog(dialogParent(), opts),
      saveFile: (opts) => dialog.showSaveDialog(dialogParent(), opts),
      openPath: (p) => shell.openPath(p),
      openSnapshotWindow: async (abs, title) => {
        const win = new BrowserWindow({
          width: 1000,
          height: 780,
          autoHideMenuBar: true,
          title,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        })
        await win.loadURL(pathToFileURL(abs).toString())
        return { ok: true }
      },
    },

    printer,

    // 进度事件走独立通道推给渲染进程（分阶段 yield，可实时重绘进度条）。
    // 发送前判 isDestroyed：窗口关掉的瞬间进度回调可能还在飞，
    // 对已销毁的 sender 调 send 会抛错并打断导入流程。
    emit: (channel, payload) => {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send(channel, payload)
      }
    },
  }
}

function registerIpc() {
  for (const { name, fromIpc } of api.ipcTable()) {
    ipcMain.handle(name, (event, ...args) =>
      api.call(name, fromIpc(...args), hostContext(event)))
  }
}

module.exports = { registerIpc }

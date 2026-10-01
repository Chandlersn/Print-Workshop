/**
 * Electron 打印通道：隐藏窗口加载批量 HTML → printToPDF / webContents.print。
 * 只做「加载与输出」，校验与留痕在 print.cjs（领域层），装配在 ipc.cjs。
 *
 * 注意：本模块 require('electron')，只能在主进程使用；
 * 领域层测试不引入本模块。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
const { BrowserWindow } = require('electron')

/** 隐藏窗口（不出现在任务栏，不抢焦点） */
function offscreenWindow() {
  return new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
}

/**
 * 加载批量 HTML（双轨容错）：
 * 1. data: URL（无磁盘依赖，首选）
 * 2. file:// 临时文件（data: 通道偶发 ERR_FAILED 时的后备）
 */
async function loadHtmlOnce(win, html) {
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return
  } catch (err) { /* 落到 file:// 后备 */ }

  const tmp = path.join(os.tmpdir(), `printpress-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  fs.writeFileSync(tmp, html, 'utf-8')
  try {
    await win.loadURL(pathToFileURL(tmp).toString())
  } finally {
    // 延迟清理：加载完成即可删，晚 10 秒避开 Windows 文件锁
    setTimeout(() => fs.unlink(tmp, () => {}), 10000)
  }
}

/** 加载 HTML 并等待字体/底图就绪；窗口级重试（崩溃的 webContents 不会自愈） */
async function loadHtml(html, { attempts = 3 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const win = offscreenWindow()
    try {
      await loadHtmlOnce(win, html)
      // 等待 @font-face 就绪（无字体 API 时直接过）
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 1) : 1',
      ).catch(() => 1)
      // 渲染缓冲宽限：底图解码偶发慢于 loadURL 返回
      await new Promise((r) => setTimeout(r, 300))
      return win
    } catch (err) {
      lastErr = err
      win.destroy()
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw lastErr || new Error('HTML 加载重试耗尽')
}

/** 导出 PDF：preferCSSPageSize 让 @page 尺寸（毫米）直接决定纸张 */
async function exportPdf(html, savePath) {
  const win = await loadHtml(html)
  try {
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    })
    fs.writeFileSync(savePath, buf)
    return { ok: true, path: savePath, bytes: buf.length }
  } finally {
    win.destroy()
  }
}

/** 直接送打印机：silent=false 时弹系统打印对话框（默认，用户可确认/取消） */
async function sendToPrinter(html, { silent = false } = {}) {
  const win = await loadHtml(html)
  try {
    return await new Promise((resolve) => {
      win.webContents.print({ silent, printBackground: true }, (ok, failureReason) => {
        resolve(ok ? { ok: true } : { ok: false, error: failureReason || '打印被取消或失败' })
      })
    })
  } finally {
    win.destroy()
  }
}

module.exports = { exportPdf, sendToPrinter, loadHtml }

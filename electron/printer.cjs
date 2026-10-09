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
function offscreenWindow(capture = false) {
  return new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Screenshot output needs a live compositor even with a visible main window.
      // PDF/printing keep their existing window settings.
      ...(capture ? { offscreen: true, backgroundThrottling: false } : {}),
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

/** 在打印窗口里执行：实际解码图片（含 CSS 底图）并检查字体，失败不得出空白 PDF。 */
async function waitPrintResources(timeoutMs = 20000) {
  let timer
  const ready = async () => {
    const urls = new Set()
    const collectUrls = (value) => {
      const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g
      let hit
      while ((hit = re.exec(value || ''))) urls.add((hit[1] || hit[2] || hit[3] || '').trim())
    }
    // 共享 CSS 中的原图仅解码一次，多页不会启动数百次相同图片任务。
    const scanRules = (rules) => {
      for (const rule of rules) {
        if (rule.style) collectUrls(rule.style.backgroundImage)
        if (rule.cssRules) scanRules(rule.cssRules)
      }
    }
    for (const sheet of document.styleSheets) scanRules(sheet.cssRules)
    for (const el of document.querySelectorAll('[style]')) collectUrls(el.style.backgroundImage)
    const decode = async (img) => {
      if (typeof img.decode === 'function') await img.decode()
      else if (!img.complete) await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('图片加载失败'))
      })
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片解码失败，请检查底图素材')
    }
    const imageTasks = Array.from(document.images, decode)
    for (const url of urls) {
      const img = new Image()
      img.src = url
      imageTasks.push(decode(img))
    }
    const fontsReady = async () => {
      if (!document.fonts) return
      // 触发布局，保证本页实际用到的字体都已进入 FontFaceSet 的加载队列。
      document.body.getBoundingClientRect()
      await document.fonts.ready
      const failed = Array.from(document.fonts).filter((font) => font.status === 'error')
      if (failed.length) throw new Error(`字体加载失败：${failed.map((font) => font.family).join('、')}`)
    }
    await Promise.all([...imageTasks, fontsReady()])
    return true
  }
  try {
    return await Promise.race([
      ready(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('打印资源加载超时，请检查底图和字体')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 加载 HTML 并等待字体/底图就绪；窗口级重试（崩溃的 webContents 不会自愈） */
async function loadHtml(html, { attempts = 3, capture = false } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const win = offscreenWindow(capture)
    try {
      await loadHtmlOnce(win, html)
      await win.webContents.executeJavaScript(`(${waitPrintResources.toString()})()`)
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

module.exports = {
  exportPdf, sendToPrinter, loadHtml, waitPrintResources,
  prepareDesignPng: (payload) => require('./design-export.cjs').prepareExport(payload),
  exportDesignPng: (prepared, filePath) => require('./design-export.cjs').exportPng(prepared, filePath),
}

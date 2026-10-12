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
const { BrowserWindow, shell } = require('electron')

/**
 * 隐藏窗口（不出现在任务栏，不抢焦点）。
 * partition：分批导出时给每批一个独立内存 session（S1.3-b）——Chromium 会
 * 复用同源 file:// 页面的渲染进程，批间解码缓存只累不释（S1 实测批间
 * 3.4→5.5GB）；temp: 前缀是内存型 session，随最后一个窗口销毁即回收，
 * 等于逼出「一批一个渲染进程」。pp:// 全局协议处理器对所有 session 生效，
 * 照片原件引用不受影响。
 */
function offscreenWindow(capture = false, partition = null) {
  return new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      ...(partition ? { partition } : {}),
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
  // External original photos need a file origin; large HTML should avoid URL encoding copies.
  const preferFile = Buffer.byteLength(html, 'utf8') > 8 * 1024 * 1024 || /pp:\/\/media\//i.test(html)
  if (!preferFile) {
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      return
    } catch (err) { /* 落到 file:// 后备 */ }
  }

  const tmp = path.join(os.tmpdir(), `printpress-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  fs.writeFileSync(tmp, html, 'utf-8')
  try {
    await win.loadURL(pathToFileURL(tmp).toString())
  } finally {
    // 延迟清理：加载完成即可删，晚 10 秒避开 Windows 文件锁
    setTimeout(() => fs.unlink(tmp, () => {}), 10000)
  }
}

/**
 * 资源守卫超时：随图片数放大。
 *
 * 500 张大图从冷缓存加载可以几十秒（压测导入期同量级数据 89s），固定 20s 会把
 * 「慢而非坏」的大作业误判成失败——大作业恰恰是最不能被误杀的。上限 120s：
 * 真卡死的页面不该让用户等得更久。
 */
function defaultResourceTimeout(html) {
  const imgs = (String(html).match(/<img\b/gi) || []).length
  return Math.min(120000, Math.max(20000, imgs * 250))
}

/**
 * 在打印窗口里执行：等图片全部加载完成、抽检解码、检查字体——失败不得出空白 PDF。
 *
 * 为什么不再「8 并发强制全量 decode」：S1 实测（docs/S1压测基准报告.md §0）8 并发
 * 强制解码在第 7 张、累计 ~231MB 必然 EncodingError；而 Chromium 为显示本来就已
 * 解码过一次，强制再解码是纯额外分配，直接撞渲染进程的解码预算墙——守卫生生成了
 * 大作业出不了片的原因。顺序逐张 decode 实测 500/500 可过（渲染进程 ~2.4GB，
 * 超预算即逐出），但 500 张要 8.5 分钟，同样不能作为守卫。
 * 折中（本版）：
 *   ① 等所有 <img> 加载完成——缺原件/坏图在这一步暴露，与旧版语义等价
 *   ② naturalWidth>0 兜底：加载成功但零尺寸的坏图
 *   ③ CSS 底图全部解码（数量少，且打印时背景同样要解码，语义保留）
 *   ④ 按 src 去重后**顺序**抽检前 3 张 <img> 真解码（证明解码链路通；
 *      顺序 = 同时只有一张在分配位图，3×34MB 也远低于 231MB 的墙）
 */
async function waitPrintResources(timeoutMs = 20000) {
  let timer
  const ready = async () => {
    const fontsReady = async () => {
      if (!document.fonts) return
      // 触发布局，保证本页实际用到的字体都已进入 FontFaceSet 的加载队列。
      document.body.getBoundingClientRect()
      await document.fonts.ready
      const failed = Array.from(document.fonts).filter((font) => font.status === 'error')
      if (failed.length) throw new Error(`字体加载失败：${failed.map((font) => font.family).join('、')}`)
    }
    const imagesReady = async () => {
      // ① 等加载：complete 为真即结束（成功或失败都由 naturalWidth 判定）
      const imgs = [...document.images]
      await Promise.all(imgs.map((img) => new Promise((resolve, reject) => {
        if (img.complete) return resolve()
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('图片加载失败，请检查底图素材'))
      })))
      // ② 零尺寸 = 解码失败的坏图（data: 损坏、文件被截断等都走到这）
      const broken = imgs.filter((img) => !img.naturalWidth || !img.naturalHeight)
      if (broken.length) throw new Error(`图片解码失败，请检查底图素材（共 ${broken.length} 张）`)
      // ③ CSS 底图：共享样式里的 url() 去重后逐个加载 + 解码
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
      urls.delete('')
      for (const url of urls) {
        const bg = new Image()
        bg.src = url
        await new Promise((resolve, reject) => {
          if (bg.complete) return resolve()
          bg.onload = () => resolve()
          bg.onerror = () => reject(new Error('图片加载失败，请检查底图素材'))
        })
        if (typeof bg.decode === 'function') await bg.decode()
        if (!bg.naturalWidth || !bg.naturalHeight) throw new Error('图片解码失败，请检查底图素材')
      }
      // ④ 抽检：按 src 去重取前 3 张顺序真解码（不碰预算墙，又能抓住「能加载不能解码」）
      const sample = []
      const seen = new Set()
      for (const img of imgs) {
        const key = img.currentSrc || img.src || ''
        if (seen.has(key)) continue
        seen.add(key)
        sample.push(img)
        if (sample.length >= 3) break
      }
      for (const img of sample) {
        if (typeof img.decode !== 'function') continue
        await img.decode()
      }
      return true
    }
    return Promise.race([
      Promise.all([imagesReady(), fontsReady()]).then(() => true),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('打印资源加载超时，请检查底图和字体')), timeoutMs)
      }),
    ])
  }
  try {
    return await ready()
  } finally {
    clearTimeout(timer)
  }
}

/** 加载 HTML 并等待字体/底图就绪；窗口级重试（崩溃的 webContents 不会自愈）。
 *  partition 见 offscreenWindow——分批导出的批间渲染进程回收靠它。 */
async function loadHtml(html, { attempts = 3, capture = false, timeoutMs, partition } = {}) {
  let lastErr
  const timeout = timeoutMs || defaultResourceTimeout(html)
  for (let i = 0; i < attempts; i++) {
    const win = offscreenWindow(capture, partition)
    try {
      await loadHtmlOnce(win, html)
      await win.webContents.executeJavaScript(`(${waitPrintResources.toString()})(${timeout})`)
      return win
    } catch (err) {
      lastErr = err
      win.destroy()
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw lastErr || new Error('HTML 加载重试耗尽')
}

/**
 * 单批出片：加载 → printToPDF → 返回 Buffer（**不落盘**）。
 * 落盘 / 校验 / 合并 / 发布由上层编排（print-batch.cjs）——每批独立临时
 * 输出、验证后才发布，是 S1.3-b「中途失败不把半成品标记为成功」的分层。
 */
async function printToPdfBuffer(html, { timeoutMs, partition } = {}) {
  const win = await loadHtml(html, { timeoutMs, partition })
  try {
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    })
  } finally {
    win.destroy()
  }
}

/** 导出 PDF：preferCSSPageSize 让 @page 尺寸（毫米）直接决定纸张 */
async function exportPdf(html, savePath, { partition } = {}) {
  const buf = await printToPdfBuffer(html, { partition })
  fs.writeFileSync(savePath, buf)
  return { ok: true, path: savePath, bytes: buf.length }
}

/** 直接送打印机：silent=false 时弹系统打印对话框（默认，用户可确认/取消） */
async function sendToPrinter(html, { silent = false, partition } = {}) {
  const win = await loadHtml(html, { partition })
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

/**
 * 最近一次**成功**导出的 PNG 绝对路径。
 *
 * 为什么记在主进程、而不是让渲染进程把路径传进来：`shell.openPath` /
 * `shell.showItemInFolder` 会拿这个字符串去**启动系统程序**，渲染进程若能传任意
 * 路径，就等于拿到了「以当前用户身份打开任意本地文件 / 可执行文件」的能力。
 * 所以路径只由本模块在真正写出文件之后自己记下，注册表那两条操作
 * （design:revealExport / design:openExport）**不接受任何参数**。
 */
let lastDesignPng = null

async function exportDesignPng(prepared, filePath) {
  const result = await require('./design-export.cjs').exportPng(prepared, filePath)
  // 只在真写出文件之后才更新：渲染失败 / 用户取消都不能让「打开」指向上一次的文件。
  if (result && !result.canceled && result.filePath) lastDesignPng = result.filePath
  return result
}

/**
 * 「打开」类操作的统一前置检查。
 *
 * 不做静默兜底：没导出过、或文件已被用户挪走/删掉时，`showItemInFolder` 什么都不做、
 * `openPath` 只回一句英文系统错误——用户看到的是「点了没反应」。这里一律抛出中文原因。
 */
function requireLastDesignPng() {
  if (!lastDesignPng) throw new Error('还没有导出过 PNG，请先导出一次。')
  if (!fs.existsSync(lastDesignPng)) throw new Error('刚导出的 PNG 已被移动或删除，请重新导出。')
  return lastDesignPng
}

/** 在系统文件管理器里定位刚导出的 PNG（选中它），用户双击就能用系统看图器打印。 */
function revealLastDesignPng() {
  const filePath = requireLastDesignPng()
  shell.showItemInFolder(filePath)
  return { ok: true, filePath }
}

/** 用系统默认程序打开刚导出的 PNG。 */
async function openLastDesignPng() {
  const filePath = requireLastDesignPng()
  const failure = await shell.openPath(filePath)
  if (failure) throw new Error(`系统未能打开该文件：${failure}`)
  return { ok: true, filePath }
}

module.exports = {
  exportPdf, sendToPrinter, loadHtml, waitPrintResources, printToPdfBuffer,
  prepareDesignPng: (payload) => require('./design-export.cjs').prepareExport(payload),
  exportDesignPng,
  revealLastDesignPng,
  openLastDesignPng,
}

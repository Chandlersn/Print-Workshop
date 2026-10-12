#!/usr/bin/env node
/**
 * S1 大批量测量与稳定性（docs/v0.6后续优化开发计划.md §三）。
 *
 * 目的：建立 50 / 500 张**不同**大原图的可重复基准，分别测量
 *   导入 → 打开匹配表格 → 打印预览 → 完整 PDF 导出 → 归档
 * 各阶段耗时、主进程/渲染进程内存与峰值、产物体积，并核对
 *   页数、记录顺序、JPEG 原始码流、归档可迁移。
 *
 * 使用隔离数据目录（PRINTPRESS_DATA_DIR 指向临时目录），绝不读取真实用户名单。
 * 夹具（不同大图）生成一次后按 sha256 缓存，复测不重新生成。
 *
 * 用法：
 *   node test/helpers/electron-runner.cjs test/photo-stress.cjs --gen
 *   node test/helpers/electron-runner.cjs test/photo-stress.cjs --scale=50
 *   node test/helpers/electron-runner.cjs test/photo-stress.cjs --scale=500 --rounds=2
 *   node test/helpers/electron-runner.cjs test/photo-stress.cjs            # 全量
 *   node test/helpers/electron-runner.cjs test/photo-stress.cjs --no-preview
 *
 * 结果目录：.workbuddy-ai/tmp/photo-stress/runs/<时间戳>/report.json（每阶段增量落盘，
 * 进程崩溃也能保留已测出的数据）。
 */
const { app, BrowserWindow, protocol, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name) => { const hit = argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null }

const STRESS_ROOT = path.join(ROOT, '.workbuddy-ai', 'tmp', 'photo-stress')
const FIXTURES = path.join(STRESS_ROOT, 'fixtures')
const TEMP = fs.mkdtempSync(path.join(__dirname, '.tmp-photo-stress-'))
const DATA = path.join(TEMP, 'data')

process.env.PRINTPRESS_DATA_DIR = DATA
app.setPath('userData', path.join(TEMP, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')

// 500 张两轮 + 分批探测约 40~60 分钟；默认 90 分钟兜底（可用 --timeout 覆盖）
const TIMEOUT_MS = Number(opt('timeout')) || 90 * 60 * 1000
const watchdog = setTimeout(() => { console.error('PHOTO_STRESS_TIMEOUT'); app.exit(2) }, TIMEOUT_MS)
protocol.registerSchemesAsPrivileged([{ scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
// 没有常驻窗口：离屏打印窗口一开一关就会触发 window-all-closed，
// 默认行为是直接退出整个应用（静默、无报错）——必须显式拦住。
app.on('window-all-closed', () => {})
process.on('uncaughtException', (err) => { console.error('UNCAUGHT', err); try { log.notes.push({ uncaught: String(err && err.stack || err) }); persist() } catch { /* ignore */ } })
process.on('unhandledRejection', (err) => { console.error('UNHANDLED_REJECTION', err); try { log.notes.push({ unhandled: String(err && err.stack || err) }); persist() } catch { /* ignore */ } })
app.on('render-process-gone', (e, details) => console.error('RENDER_PROCESS_GONE', JSON.stringify(details)))
app.on('child-process-gone', (e, details) => console.error('CHILD_PROCESS_GONE', JSON.stringify(details)))

const t0 = Date.now()
const log = { startedAt: new Date().toISOString(), machine: {}, phases: [], checks: [], notes: [] }
let runDir = null
let lastTemplate = null
let lastJobDir = null
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (...a) => console.log(`[${stamp()}]`, ...a)

function persist() {
  if (!runDir) return
  try { fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(log, null, 2)) } catch { /* 落盘失败不影响测量 */ }
}

const ok = (condition, label) => {
  log.checks.push({ label, ok: Boolean(condition) })
  say(condition ? '  ok -' : '  FAIL -', label)
  persist()
  return Boolean(condition)
}

// ---------- 内存与事件循环采样 ----------
const samples = []
let sampling = false

function memNow() {
  const m = process.memoryUsage()
  let sysRss = 0
  let procs = 0
  let tabs = 0
  try {
    const metrics = app.getAppMetrics()
    procs = metrics.length
    for (const p of metrics) {
      sysRss += (p.memory?.workingSetSize || 0) * 1024 // Electron 的 workingSetSize 单位是 KB
      if (p.type === 'Tab') tabs += (p.memory?.workingSetSize || 0) * 1024
    }
  } catch { /* 指标不可用时只报主进程 */ }
  // windows：webContents.getProcessId() 在本环境返回占位 pid（实测 4，与 getAppMetrics
  // 的真实 pid 对不上），因此渲染进程内存按 Tab 类型进程汇总——压测全程同时只有
  // 一个打印窗口在跑，peakTabs 就是该窗口的峰值。
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, sysRss, procs, tabs }
}

function startSampling() {
  if (sampling) return
  sampling = true
  let expected = Date.now() + 500
  setInterval(() => {
    const now = Date.now()
    const drift = now - expected
    expected = now + 500
    const s = { t: now - t0, drift, ...memNow() }
    const hr = process.hrtime.bigint()
    setImmediate(() => { s.lag = Number(process.hrtime.bigint() - hr) / 1e6 })
    samples.push(s)
  }, 500)
}

function summarize(fromIndex) {
  const slice = fromIndex === undefined ? samples : samples.slice(fromIndex)
  if (!slice.length) return null
  let peakSys = 0
  let peakTabs = 0
  let maxDrift = 0
  let maxLag = 0
  for (const s of slice) {
    peakSys = Math.max(peakSys, s.sysRss || 0)
    peakTabs = Math.max(peakTabs, s.tabs || 0)
    maxDrift = Math.max(maxDrift, s.drift || 0)
    maxLag = Math.max(maxLag, s.lag || 0)
  }
  return {
    peakSysRss: peakSys, peakTabRss: peakTabs,
    maxTimerDriftMs: maxDrift, maxEventLoopLagMs: Math.round(maxLag * 10) / 10,
    sampleCount: slice.length,
  }
}

async function phase(name, fn) {
  const before = memNow()
  const from = samples.length
  const started = Date.now()
  let result = null
  let error = null
  try { result = await fn() } catch (err) { error = err }
  // 注意：result 必须整体放在 .result 下，不能平铺——返回值里的 name/files 等字段
  // 会把阶段自身的 name 覆盖掉（实测踩过：汇总表里阶段名变成数据集名）。
  const entry = {
    name, ms: Date.now() - started, at: new Date().toISOString(),
    memBefore: before, memAfter: memNow(), peak: summarize(from),
    result: result || null,
    ...(error ? { error: error && error.message ? error.message : String(error), stack: String(error && error.stack || '') } : {}),
  }
  log.phases.push(entry)
  say(`${error ? 'FAIL' : 'done'} ${name}: ${entry.ms} ms` + (error ? ` (${error.message})` : ''))
  persist()
  return entry
}

// ---------- 机器与夹具信息 ----------
function machineInfo() {
  let diskFree = null
  try { diskFree = fs.statfsSync(ROOT).bavail * fs.statfsSync(ROOT).bsize } catch { /* 老 node 无此 API */ }
  return {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0].model} x ${os.cpus().length}`,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    diskFreeGB: diskFree ? Math.round(diskFree / 1024 ** 3 * 10) / 10 : null,
    electron: process.versions.electron,
    node: process.version,
    sourceVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    appVersion: (() => { try { return app.getVersion() } catch { return 'dev' } })(),
  }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
const mb = (n) => Math.round(n / 1048576 * 10) / 10

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)

/** 渐变 + 逐像素噪声：压缩率可控、每张唯一、跨机器可用同一 seed 复现。 */
function pixels(w, h, seed, alpha) {
  const buf = Buffer.alloc(w * h * 4)
  const rand = mulberry32(seed)
  const base = [rand() * 180 + 40 | 0, rand() * 180 + 40 | 0, rand() * 180 + 40 | 0]
  const gx = rand() * 1.4 + 0.3, gy = rand() * 1.4 + 0.3
  let i = 0
  for (let y = 0; y < h; y++) {
    const yGrad = (y / h) * gy * 70 - 35
    const yh = Math.imul(y, 668265263)
    for (let x = 0; x < w; x++) {
      const n = (Math.imul(x, 374761393) + yh + Math.imul(seed, 2246822519)) % 97 - 48
      buf[i++] = clamp255(base[0] + yGrad + n + (x / w) * gx * 50 - 25)
      buf[i++] = clamp255(base[1] + n + (y / h) * 40 - 20)
      buf[i++] = clamp255(base[2] - yGrad + n + (x / w) * 30 - 15)
      buf[i++] = alpha ? ((x / w) * 255) | 0 : 255
    }
  }
  return buf
}

/** 在 JPEG 码流里插入最小 EXIF（Orientation），模拟相机竖拍照片。 */
function withExifOrientation(jpeg, orientation) {
  // TIFF 头 8 字节 + IFD0：1 条目（tag 0x0112 SHORT×1），值字段位于偏移 18
  const tiff = Buffer.from([
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // MM + 0x002A + IFD0@8
    0x00, 0x01,                                     // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // tag/type/count/value
    0x00, 0x00, 0x00, 0x00,                         // next IFD = 0
  ])
  tiff.writeUInt16BE(orientation, 18)
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff])
  const app1 = Buffer.alloc(4 + exif.length)
  app1[0] = 0xFF; app1[1] = 0xE1
  app1.writeUInt16BE(exif.length + 2, 2)
  exif.copy(app1, 4)
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

function encodeJpeg(w, h, seed, quality) {
  return nativeImage.createFromBitmap(pixels(w, h, seed, false), { width: w, height: h }).toJPEG(quality)
}

/**
 * 生成一套夹具。set50/set500 为纯 JPEG 不同大图；mixed 覆盖横/竖/方/透明 PNG/EXIF 方向。
 * 已有 manifest 且逐文件 sha256 一致时直接复用（可重复基准，复测不需重新生成）。
 */
async function genSet(kind, count) {
  const dir = path.join(FIXTURES, kind)
  const manifestFile = path.join(dir, 'manifest.json')
  if (fs.existsSync(manifestFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (old.files.length === count && old.files.every(f => {
        try { return sha256(fs.readFileSync(path.join(dir, f.name))) === f.sha256 } catch { return false }
      })) {
        say(`夹具 ${kind} 命中缓存：${count} 张，合计 ${mb(old.bytes)} MB`)
        return old
      }
    } catch { /* 重新生成 */ }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  let bytes = 0
  const shapes = [[3600, 2400], [2400, 3600], [3000, 3000], [4096, 2731], [2731, 4096], [2000, 3000], [3000, 2000]]
  let quality = 86
  for (let attempt = 0; attempt < 4; attempt++) {
    files.length = 0; bytes = 0
    const started = Date.now()
    for (let i = 0; i < count; i++) {
      let name, buf, w, h, meta
      if (kind === 'mixed') {
        // mixed 的使命是格式/方向/透明通道的正确性，不是体积（大图边界由 set50/set500 覆盖）。
        // 因此长边压到 ≤1200px：24 张全部解码仅 ~92MB，能塞进单个打印窗口的解码预算，
        // 否则走应用真实预解码路径会在第 5~6 张就 EncodingError（拿不到逐张尺寸核对）。
        const slot = i % 12
        if (slot < 6) { w = 1200; h = 800; buf = encodeJpeg(w, h, 1000 + i, 85); name = `mix-${String(i + 1).padStart(2, '0')}.jpg`; meta = { kind: 'jpeg-landscape' } }
        else if (slot < 9) { w = 800; h = 1200; buf = encodeJpeg(w, h, 2000 + i, 85); name = `mix-${String(i + 1).padStart(2, '0')}.jpg`; meta = { kind: 'jpeg-portrait' } }
        else if (slot < 10) { w = 1000; h = 1000; buf = nativeImage.createFromBitmap(pixels(w, h, 3000 + i, true), { width: w, height: h }).toPNG(); name = `mix-${String(i + 1).padStart(2, '0')}.png`; meta = { kind: 'png-alpha' } }
        else { const o = i % 2 ? 6 : 8; w = 1200; h = 800; buf = withExifOrientation(encodeJpeg(w, h, 4000 + i, 85), o); name = `mix-${String(i + 1).padStart(2, '0')}-exif${o}.jpg`; meta = { kind: 'jpeg-exif', orientation: o } }
      } else {
        const [sw, sh] = shapes[i % shapes.length]
        w = sw; h = sh
        buf = encodeJpeg(w, h, 7000 + i * 31, quality)
        name = `P${String(i + 1).padStart(4, '0')}.jpg`
        meta = { kind: sw > sh ? 'landscape' : sw < sh ? 'portrait' : 'square' }
      }
      fs.writeFileSync(path.join(dir, name), buf)
      bytes += buf.length
      files.push({ name, bytes: buf.length, sha256: sha256(buf), width: w, height: h, ...meta })
      if (i % 25 === 0) say(`  gen ${kind} ${i + 1}/${count} …`)
    }
    const limit = kind === 'mixed' ? 64 * 1024 ** 2 : 1.8 * 1024 ** 3
    if (bytes <= limit || kind === 'mixed') break
    quality -= 6
    say(`  ${kind} 合计 ${mb(bytes)} MB 超出预算，降低画质重试（q=${quality}）`)
    say(`  gen ${kind} 完成 ${((Date.now() - started) / 1000).toFixed(0)}s，q=${quality}`)
  }
  const manifest = {
    kind, count, quality: kind === 'mixed' ? null : quality, bytes,
    generatedAt: new Date().toISOString(), files,
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  say(`夹具 ${kind} 已生成：${count} 张，合计 ${mb(bytes)} MB（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
  return manifest
}

// ---------- pp 协议（与真实应用一致：缩略图缓存 + 原件） ----------
function setupProtocol() {
  const { net } = require('electron')
  protocol.handle('pp', async (request) => {
    try {
      const id = decodeURIComponent(new URL(request.url).pathname.slice(1))
      if (/^design-thumbnails\/[a-f0-9]{64}\.png$/.test(id)) return net.fetch(pathToFileURL(path.join(DATA, id)).href)
      const designs = require('../electron/designs.cjs')
      const asset = designs.assetInfo(id)
      return net.fetch(pathToFileURL(path.join(DATA, asset.path)).href)
    } catch { return new Response('not found', { status: 404 }) }
  })
}

function photoSrcs(html) {
  return [...html.matchAll(/data-photo-column="[^"]*" src="([^"]+)"/g)].map(m => m[1])
}

/**
 * Buffer 级 PDF 页数统计：50 张大图出片 ~750MB，toString('latin1') 会撞
 * V8 字符串长度上限（ERR_STRING_TOO_LONG），必须避开字符串化。
 * 语义等同 /\/Type\s*\/Page\b/（/Pages 节点不算页）。
 */
function countPdfPages(pdf) {
  let count = 0
  let i = 0
  const needle = Buffer.from('/Type')
  const isWord = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95
  while ((i = pdf.indexOf(needle, i)) >= 0) {
    let j = i + 5
    while (j < pdf.length && (pdf[j] === 0x20 || pdf[j] === 0x0A || pdf[j] === 0x0D || pdf[j] === 0x09)) j++
    if (pdf[j] === 0x2F && pdf[j + 1] === 0x50 && pdf[j + 2] === 0x61 && pdf[j + 3] === 0x67 && pdf[j + 4] === 0x65 && !isWord(pdf[j + 5])) count++
    i += 5
  }
  return count
}

function countBytes(haystack, needle) {
  let count = 0
  let i = 0
  const n = Buffer.from(needle)
  while ((i = haystack.indexOf(n, i)) >= 0) { count++; i += n.length }
  return count
}

/** 复刻 printer.loadHtmlOnce 的 file:// 双轨之一（含 pp:// 外链时必走 file://）。 */
function writeBatchHtmlFile(html) {
  const tmp = path.join(os.tmpdir(), `photo-stress-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  fs.writeFileSync(tmp, html, 'utf-8')
  return tmp
}

function offscreenPrintWindow() {
  return new BrowserWindow({
    show: false, skipTaskbar: true,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },
  })
}

/**
 * 逐张扫描解码预算：不走 loadHtml（它会在第一张失败时整体抛错，拿不到边界数据）。
 * 返回成功解码张数、累计解码字节、失败位置。
 */
async function scanDecodeEnvelope(html, manifest) {
  const file = writeBatchHtmlFile(html)
  const win = offscreenPrintWindow()
  try {
    await win.loadURL(pathToFileURL(file).toString())
    return await win.webContents.executeJavaScript(`(async () => {
      const out = { ok: 0, failed: -1, bytes: 0, perImage: [] }
      for (const img of document.images) {
        try { await img.decode(); out.ok++; out.bytes += img.naturalWidth * img.naturalHeight * 4; out.perImage.push(1) }
        catch (e) { if (out.failed < 0) out.failed = out.ok; out.perImage.push(0) }
      }
      return out
    })()`)
  } finally {
    win.destroy()
    setTimeout(() => fs.unlink(file, () => {}), 10000)
  }
}

/** 不预解码的打印路径：等图片加载完成 + 字体就绪后直接 printToPDF。 */
async function printWithoutGuard(html) {
  const file = writeBatchHtmlFile(html)
  const win = offscreenPrintWindow()
  try {
    await win.loadURL(pathToFileURL(file).toString())
    const loaded = await win.webContents.executeJavaScript(`(async () => {
      const imgs = [...document.images]
      await Promise.all(imgs.map(img => new Promise(resolve => {
        if (img.complete && img.naturalWidth > 0) return resolve()
        img.onload = () => resolve()
        img.onerror = () => resolve()
      })))
      if (document.fonts) await document.fonts.ready
      return { count: imgs.length, blank: imgs.filter(i => !i.naturalWidth).length }
    })()`)
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } })
    return { pdf, loaded }
  } finally { win.destroy(); setTimeout(() => fs.unlink(file, () => {}), 10000) }
}

/**
 * 与 waitPrintResources 同算法的带桩副本（8 并发逐张 decode）。
 * loadHtml 的异常跨 IPC 序列化后只剩空壳（[object Object]，无 name/message），
 * 拿不到失败点；这个副本用来回答「第几张、什么错误、累计解码多少」。
 */
async function guardFailureProbe(html) {
  const file = writeBatchHtmlFile(html)
  const win = offscreenPrintWindow()
  try {
    await win.loadURL(pathToFileURL(file).toString())
    return await win.webContents.executeJavaScript(`(async () => {
      const imgs = [...document.images]
      const out = { total: imgs.length, done: 0, failed: -1, failName: null, failMsg: null, decodedBytes: 0 }
      const decode = async (img) => {
        if (typeof img.decode === 'function') await img.decode()
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片解码失败，请检查底图素材')
      }
      let next = 0
      const worker = async () => {
        while (next < imgs.length) {
          const img = imgs[next++]
          try { await decode(img); out.done++; out.decodedBytes += img.naturalWidth * img.naturalHeight * 4 }
          catch (e) {
            if (out.failed < 0) { out.failed = out.done; out.failName = e && e.name; out.failMsg = e && e.message }
            throw e
          }
        }
      }
      try { await Promise.all([...Array.from({ length: Math.min(8, imgs.length) }, worker)]) }
      catch { /* 首败已记录，后续并发结果不重要 */ }
      return out
    })()`)
  } finally { win.destroy(); setTimeout(() => fs.unlink(file, () => {}), 10000) }
}

/** 应用真实守卫路径：成功拿到窗口；失败时带回结构化诊断（含带桩探测的失败点）。 */
async function tryGuard(html) {
  const printer = require('../electron/printer.cjs')
  try {
    return { win: await printer.loadHtml(html, { attempts: 1 }), failed: false }
  } catch (err) {
    return {
      win: null, failed: true,
      errName: err && err.name, errMsg: err && err.message,
      probe: await guardFailureProbe(html),
    }
  }
}

function dirBytes(dir) {
  let total = 0
  let count = 0
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else { total += fs.statSync(p).size; count++ }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { bytes: total, files: count }
}

/** 一份「人像工程 + 模板 + 名单」的最小出片链。 */
function makeStack(ds, photoColumn, artboard = { w: 90, h: 60 }) {
  const designs = require('../electron/designs.cjs')
  const templates = require('../electron/templates.cjs')
  const doc = designs.saveDesign({
    name: '压测人像工程',
    artboard: { w: artboard.w, h: artboard.h, background: '#ffffff' },
    assets: {},
    layers: [{
      id: 'portrait-1', type: 'image', name: '变量图', variable: true, bindColumn: photoColumn,
      x: 6, y: 5, w: Math.min(34, artboard.w - 12), h: Math.min(50, artboard.h - 10),
      fit: 'cover', focal: { x: 0.5, y: 0.5 }, radius: 0, rotation: 0, opacity: 1, visible: true, locked: false,
    }],
  }, { recordUse: false })
  const tpl = templates.saveTemplate({
    name: '压测模板', datasetId: ds.id, pageSize: { id: 'custom', w: artboard.w, h: artboard.h },
    backgroundDesign: { id: doc.id, revision: doc.revision }, fields: [],
  })
  return { doc, tpl }
}

async function importPhotos(ds, photoColumn, folder, n) {
  const dataset = require('../electron/dataset.cjs')
  const photos = require('../electron/photo-library.cjs')
  const thumbs = require('../electron/asset-thumbnails.cjs')
  dataset.setPhotoMatchColumn(ds.id, photoColumn)
  let last = 0
  const imported = await photos.importFolder(
    { datasetId: ds.id, column: photoColumn, folder },
    { makeThumbnail: thumbs.makeThumbnail, onProgress: (p) => { if (p.done - last >= Math.max(1, n / 10)) { last = p.done; say(`  import ${p.done}/${p.total}`) } } },
  )
  return imported
}

/** 一轮完整测量：导入 → 匹配表格 → 预览 HTML → 预览加载 → PDF → 归档。 */
async function runRound(manifest, round, { withPreview = true, keepPdf = true } = {}) {
  const n = manifest.count
  const label = `scale${n}-r${round}`
  const dataset = require('../electron/dataset.cjs')
  const photos = require('../electron/photo-library.cjs')
  const print = require('../electron/print.cjs')
  const printer = require('../electron/printer.cjs')

  const csv = path.join(TEMP, `people-${label}.csv`)
  const lines = ['\ufeff姓名,照片']
  for (let i = 0; i < n; i++) lines.push(`姓名-${String(i + 1).padStart(4, '0')},${manifest.files[i].name.replace(/\.[^.]+$/, '')}`)
  fs.writeFileSync(csv, lines.join('\r\n'))

  const dsEntry = await phase(`${label} dataset-import`, async () => {
    const summary = dataset.importFromFile(csv)
    const detail = dataset.getDataset(summary.id)
    return { id: detail.id, rows: detail.rows.length, name: detail.name }
  })
  const ds = dsEntry.result
  if (!ds) throw new Error('名单导入失败')
  const photoColumn = dataset.getDataset(ds.id).columns[1].key

  await phase(`${label} photo-import`, async () => {
    const res = await importPhotos(ds, photoColumn, path.join(FIXTURES, manifest.kind), n)
    return { matched: res.counts.matched, missing: res.counts.missing, files: res.files.length }
  })

  const report = (await phase(`${label} report`, async () => {
    const res = await photos.report({ datasetId: ds.id, column: photoColumn })
    return { matched: res.counts.matched, files: res.files.length }
  })).result

  const built = (await phase(`${label} build-html`, async () => {
    const { tpl } = makeStack(ds, photoColumn)
    const out = print.buildBatchHtml(ds.id, tpl.id)
    return { htmlBytes: Buffer.byteLength(out.html), snapshotBytes: Buffer.byteLength(out.snapshotHtml), pageCount: out.pageCount, templateId: tpl.id }
  })).result
  if (!built) throw new Error('HTML 组装失败')
  lastTemplate = { dsId: ds.id, templateId: built.templateId }

  // 记录级身份核对：HTML 里每条记录的照片引用必须与名单行序一一对应。
  // 重新 build 一次只为拿 html/snapshot 原文（phase 记录里不存大字符串，避免 report.json 膨胀）。
  const builtFull = print.buildBatchHtml(ds.id, built.templateId)
  const res2 = await photos.report({ datasetId: ds.id, column: photoColumn })
  const want = res2.results.map(r => (r.assetId ? `pp://media/${r.assetId}` : null))
  const got = photoSrcs(builtFull.html)
  ok(report.matched === n, `${label} 匹配表全部命中（${report.matched}/${n}）`)
  ok(JSON.stringify(got) === JSON.stringify(want), `${label} HTML 照片引用与名单行序逐条一致（${got.length} 条）`)

  // —— 打印预览：应用真实路径（loadHtml 预解码守卫）——
  if (withPreview) {
    await phase(`${label} preview-guard`, async () => {
      const r = await tryGuard(builtFull.snapshotHtml)
      if (r.win) {
        try {
          const imgs = await r.win.webContents.executeJavaScript(
            `[...document.querySelectorAll('img[data-photo-column]')].map(i => ({nw:i.naturalWidth, nh:i.naturalHeight, complete:i.complete}))`)
          return { guard: 'passed', imgs: imgs.length, allLoaded: imgs.every(i => i.complete && i.nw > 0) }
        } finally { r.win.destroy() }
      }
      // 守卫失败是测量结果而非脚本 bug：结构化记录 + 带桩探测定位失败点
      const p = r.probe || {}
      say(`  守卫路径失败于第 ${p.failed}/${p.total} 张：${p.failName} ${p.failMsg}（累计解码 ${mb(p.decodedBytes || 0)} MB）`)
      log.notes.push({ [`${label} guard boundary`]: { errName: r.errName, errMsg: r.errMsg, ...p } })
      return { guard: 'failed', errName: r.errName, errMsg: r.errMsg, probe: p }
    }).then((entry) => {
      if (!entry.result) return
      const r = entry.result
      if (r.guard === 'passed') ok(r.allLoaded, `${label} 守卫路径预览全部图片就绪（${r.imgs} 张）`)
    })

    // —— 解码预算扫描：逐张 decode，量出「单个打印窗口能扛多少不同大图」——
    await phase(`${label} preview-decode-scan`, async () => {
      const scan = await scanDecodeEnvelope(builtFull.snapshotHtml, manifest)
      return {
        decodedOk: scan.ok, failedAt: scan.failed, decodedBytes: scan.bytes,
        decodedMB: Math.round(scan.bytes / 1048576), total: n,
        firstFailureIndex: scan.perImage.indexOf(0),
      }
    }).then((entry) => {
      if (entry.result) {
        const r = entry.result
        say(`  解码预算：${r.decodedOk}/${n} 张通过，累计解码 ${r.decodedMB} MB`)
        log.notes.push({ [`${label} decode envelope`]: r })
      }
    })
  }

  // —— PDF：应用真实路径（含预解码守卫）——
  await phase(`${label} pdf-guard`, async () => {
    const r = await tryGuard(builtFull.html)
    if (r.win) {
      try {
        const pdf = await r.win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } })
        return { guard: 'passed', pdfBytes: pdf.length, pages: countPdfPages(pdf) }
      } finally { r.win.destroy() }
    }
    const p = r.probe || {}
    say(`  守卫路径失败于第 ${p.failed}/${p.total} 张：${p.failName} ${p.failMsg}`)
    return { guard: 'failed', errName: r.errName, errMsg: r.errMsg, probe: p }
  }).then((entry) => {
    if (!entry.result) return
    const r = entry.result
    if (r.guard === 'passed') ok(r.pages === n, `${label} 守卫路径 PDF 实际页数 = 记录数（${r.pages}/${n}）`)
  })

  // —— PDF：不预解码路径（等图片加载完成直接出片，大作业候选方案）——
  await phase(`${label} pdf-noguard`, async () => {
    const { pdf, loaded } = await printWithoutGuard(builtFull.html)
    const pdfPath = path.join(runDir, `pdf-${label}.pdf`)
    fs.writeFileSync(pdfPath, pdf)
    // 特征化：Chromium 对大原图会降采样并重编码（无损 Flate），原始 JPEG 码流
    // 通常不再逐字节保留；字节级保留的责任在归档层（见 archive 阶段）。
    return {
      pdfBytes: pdf.length, pages: countPdfPages(pdf), blankImages: loaded.blank,
      flate: countBytes(pdf, '/FlateDecode'), dct: countBytes(pdf, '/DCTDecode'), pdfPath,
    }
  }).then(async (entry) => {
    if (!entry.result) return entry
    const r = entry.result
    ok(r.pages === n, `${label} 无守卫路径 PDF 实际页数 = 记录数（${r.pages}/${n}）`)
    ok(r.blankImages === 0, `${label} 无守卫路径无空白图片（blank=${r.blankImages}）`)
    say(`  PDF 内嵌流特征：Flate ${r.flate} / DCT ${r.dct}（体积 ${mb(r.pdfBytes)} MB）`)
    if (!keepPdf && r.pdfPath) {
      try { fs.unlinkSync(r.pdfPath); r.pdfPath = null; say(`  已删除 ${label} PDF（体积 ${mb(r.pdfBytes)} MB，仅保留记录）`) } catch { /* 留待人工清理 */ }
      persist()
    }
    return entry
  })

  await archiveAndVerify(label, ds, builtFull, manifest, n)

  // 小规模加做「拷走整个任务目录后仍能回看」的现实检查（500 张太大，留给发布前验收）
  if (n <= 50 && lastJobDir) {
    await phase(`${label} archive-relocate`, async () => {
      // 仓库根目录含中文：pathToFileURL 会做百分号编码，file:///D:/%E4%B8%AA… 在沙箱里
      // 直接 ERR_FAILED（photo-e2e 同样中招）。改拷到 os.tmpdir() 下的纯 ASCII 路径再验。
      // 窗口配置与应用的 offscreenWindow 一致（sandbox:false）：sandbox:true 的渲染进程
      // 在此环境加载 file:// 主页同样 ERR_FAILED（探针实测）。
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-stress-reloc-'))
      const moved = path.join(base, `moved-${label}`)
      try {
        fs.cpSync(lastJobDir, moved, { recursive: true })
        const browser = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false } })
        try {
          await browser.loadURL(pathToFileURL(path.join(moved, 'snapshot.html')).href)
          // 可迁移性 = 迁移后相对引用仍能加载出图（自然尺寸>0）。
          // 完整预解码守卫在同一快照上的边界已在 preview-guard 测过（~231MB 即失败），
          // 这里只记录不作为断言：「回看」要的是能看到，不是守卫通过。
          const loaded = await browser.webContents.executeJavaScript(`(async () => {
            const imgs = [...document.images]
            await Promise.all(imgs.map(img => new Promise(r => { if (img.complete) return r(); img.onload = r; img.onerror = r })))
            return { total: imgs.length, loaded: imgs.filter(i => i.naturalWidth > 0).length }
          })()`)
          let guard = 'passed'
          try { await browser.webContents.executeJavaScript(`(${printer.waitPrintResources.toString()})()`) }
          catch (e) { guard = `failed: ${(e && e.name) || 'error'}` }
          return { ...loaded, guard }
        } finally { browser.destroy() }
      } finally { fs.rmSync(base, { recursive: true, force: true }) }
    }).then((e) => {
      if (!e.result) return
      ok(e.result.loaded === e.result.total, `${label} 归档目录整体迁移后照片仍可加载回看（${e.result.loaded}/${e.result.total}）`)
      say(`  迁移后守卫路径：${e.result.guard}（记录用，不作为断言）`)
    })
  }
}

/**
 * 归档 + 保真核对：原件逐字节等于夹具（sha256）、快照只引用相对照片文件、逐张复制。
 * runRound（JPEG 大图）与 runMixed（横竖方/透明 PNG/EXIF）共用。
 */
async function archiveAndVerify(label, ds, built, manifest, n) {
  const print = require('../electron/print.cjs')
  const entry = await phase(`${label} archive`, async () => {
    const job = print.createJob({
      templateId: built.templateId, templateName: '压测模板', datasetId: ds.id, datasetName: ds.name,
      mode: 'pdf', recordCount: built.recordCount, totalRows: ds.rows.length,
      partial: Boolean(built.scope.partial), selection: built.selection,
      snapshotHtml: built.snapshotHtml, photoAssets: built.photoAssets, status: 'ok', detail: '压测归档',
    })
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    const jobDir = path.join(DATA, 'archive', month, job.id)
    const info = dirBytes(jobDir)
    const snap = fs.readFileSync(path.join(jobDir, 'snapshot.html'), 'utf8')
    // 原件逐字节保留：归档的每张照片都应等于某张夹具的字节（PDF 内嵌图已被重编码，
    // 「原始码流 / 原件哈希」的保证落在归档层）
    const fixtureSha = new Set(manifest.files.map(f => f.sha256))
    let byteExact = 0
    for (const name of fs.readdirSync(path.join(jobDir, 'photos'))) {
      if (fixtureSha.has(sha256(fs.readFileSync(path.join(jobDir, 'photos', name))))) byteExact++
    }
    return {
      jobDir, archiveBytes: info.bytes, archiveFiles: info.files, byteExact,
      noPpUrl: !snap.includes('pp://'), noInlinePhoto: !snap.includes('data:image'),
    }
  })
  if (entry.result) {
    const r = entry.result
    lastJobDir = r.jobDir
    ok(r.noPpUrl && r.noInlinePhoto, `${label} 归档快照只引用相对照片文件`)
    ok(r.archiveFiles === n + 1, `${label} 归档照片逐张复制（${r.archiveFiles - 1}/${n}）`)
    ok(r.byteExact === n, `${label} 归档照片逐字节等于原图（${r.byteExact}/${n}）`)
  }
  return entry
}

/**
 * 分批出片探测（S1.2「是否分批」的对照数据）：按固定张数连续行区间分批，
 * 每批走同一条「不预解码」导出路径。回答：分批后单批峰值内存/耗时/产物体积，
 * 以及分批是否绕开单次全量导出的内存墙。PDF 只测量不落盘（单批即 GB 级）。
 */
async function runBatchExport(dsId, templateId, batchSize, batches) {
  const print = require('../electron/print.cjs')
  const out = []
  for (let b = 0; b < batches; b++) {
    const selection = Array.from({ length: batchSize }, (_, i) => b * batchSize + i)
    const built = print.buildBatchHtml(dsId, templateId, selection)
    const entry = await phase(`batch-export-${batchSize} #${b + 1}`, async () => {
      const { pdf, loaded } = await printWithoutGuard(built.html)
      return { rows: selection.length, pages: countPdfPages(pdf), pdfBytes: pdf.length, blank: loaded.blank }
    })
    if (entry.result) {
      ok(entry.result.pages === batchSize, `第 ${b + 1} 批（${batchSize} 张）导出页数正确（${entry.result.pages}）`)
      ok(entry.result.blank === 0, `第 ${b + 1} 批无空白图片`)
      out.push(entry.result)
    }
  }
  const totalBytes = out.reduce((s, r) => s + (r.pdfBytes || 0), 0)
  const totalMs = log.phases.filter(p => p.name.startsWith(`batch-export-${batchSize} `)).reduce((s, p) => s + p.ms, 0)
  log.notes.push({ batchExport: { batchSize, batches, done: out.length, totalBytes, totalMs, avgBytes: out.length ? Math.round(totalBytes / out.length) : 0 } })
  say(`  分批汇总：${out.length} 批 × ${batchSize} 张，合计 ${mb(totalBytes)} MB / ${(totalMs / 1000).toFixed(0)}s`)
  return out
}

/** 最小准备（--batch-only 用）：名单 + 照片入库 + 模板，不跑重型阶段。 */
async function prepareForBatch(manifest) {
  const n = manifest.count
  const dataset = require('../electron/dataset.cjs')
  const csv = path.join(TEMP, 'people-batch.csv')
  const lines = ['\ufeff姓名,照片']
  for (let i = 0; i < n; i++) lines.push(`姓名-${String(i + 1).padStart(4, '0')},${manifest.files[i].name.replace(/\.[^.]+$/, '')}`)
  fs.writeFileSync(csv, lines.join('\r\n'))
  const ds = dataset.getDataset(dataset.importFromFile(csv).id)
  const photoColumn = dataset.getDataset(ds.id).columns[1].key
  const res = await importPhotos(ds, photoColumn, path.join(FIXTURES, manifest.kind), n)
  ok(res.counts.matched === n, `batch-only 匹配表全部命中（${res.counts.matched}/${n}）`)
  const { tpl } = makeStack(ds, photoColumn)
  lastTemplate = { dsId: ds.id, templateId: tpl.id }
  return ds
}

/** 混合媒体：横/竖/方/透明 PNG/EXIF 方向 JPEG，核对解码尺寸与方向。 */
async function runMixed(manifest) {
  const n = manifest.count
  const label = 'mixed'
  const dataset = require('../electron/dataset.cjs')
  const photos = require('../electron/photo-library.cjs')
  const print = require('../electron/print.cjs')
  const csv = path.join(TEMP, 'mixed.csv')
  fs.writeFileSync(csv, '\ufeff姓名,照片\r\n' + manifest.files.map((f, i) => `混合-${String(i + 1).padStart(2, '0')},${f.name.replace(/\.[^.]+$/, '')}`).join('\r\n'))
  const ds = dataset.getDataset(dataset.importFromFile(csv).id)
  const photoColumn = dataset.getDataset(ds.id).columns[1].key
  await phase(`${label} photo-import`, async () => {
    const res = await importPhotos(ds, photoColumn, path.join(FIXTURES, manifest.kind), n)
    return { matched: res.counts.matched, files: res.files.length }
  })
  await phase(`${label} report`, async () => {
    const res = await photos.report({ datasetId: ds.id, column: photoColumn })
    return { matched: res.counts.matched }
  })
  const built = await phase(`${label} build-html`, async () => {
    const { tpl } = makeStack(ds, photoColumn, { w: 120, h: 80 })
    const out = print.buildBatchHtml(ds.id, tpl.id)
    return { pageCount: out.pageCount, templateId: tpl.id }
  })
  if (!built.result) return
  const full = print.buildBatchHtml(ds.id, built.result.templateId)
  await phase(`${label} preview-guard`, async () => {
    const r = await tryGuard(full.snapshotHtml)
    if (!r.win) {
      const p = r.probe || {}
      say(`  守卫路径失败于第 ${p.failed}/${p.total} 张：${p.failName} ${p.failMsg}`)
      return { guard: 'failed', probe: p }
    }
    try {
      const imgs = await r.win.webContents.executeJavaScript(
        `[...document.querySelectorAll('img[data-photo-column]')].map(i => ({nw:i.naturalWidth, nh:i.naturalHeight, complete:i.complete}))`)
      return { guard: 'passed', imgs, allDecoded: imgs.every(i => i.complete && i.nw > 0 && i.nh > 0) }
    } finally { r.win.destroy() }
  }).then((entry) => {
    if (!entry.result || entry.result.guard !== 'passed') return
    const imgs = entry.result.imgs
    ok(entry.result.allDecoded, `${label} ${n} 张混合原图全部解码成功`)
    const mism = []
    imgs.forEach((img, i) => {
      const f = manifest.files[i]
      const swapped = f.kind === 'jpeg-exif'
      const wantW = swapped ? f.height : f.width
      const wantH = swapped ? f.width : f.height
      if (img.nw !== wantW || img.nh !== wantH) mism.push(`${f.name} 解码 ${img.nw}x${img.nh} ≠ 期望 ${wantW}x${wantH}`)
    })
    ok(mism.length === 0, `${label} 逐张解码尺寸符合预期（含 EXIF 方向旋转、透明 PNG）${mism.length ? '：' + mism.join('；') : ''}`)
    return entry
  })
  // 归档保真：混合媒体（含透明 PNG、EXIF 方向 JPEG）同样要逐字节进归档
  await archiveAndVerify(label, ds, full, manifest, n)
}

/** 业务异常与排版边界（小数据，重在正确性）。 */
async function runEdges() {
  const dataset = require('../electron/dataset.cjs')
  const photos = require('../electron/photo-library.cjs')
  const print = require('../electron/print.cjs')
  const printer = require('../electron/printer.cjs')

  // ---- 业务异常：缺图/空值/重名/坏图/非法值/多人共用 ----
  const folder = path.join(TEMP, 'edge-photos')
  fs.mkdirSync(folder, { recursive: true })
  for (const name of ['good1', 'good2', 'good3', 'good4', 'good5']) {
    fs.writeFileSync(path.join(folder, `${name}.jpg`), nativeImage.createFromBitmap(pixels(600, 400, name.length * 97 + name.charCodeAt(4), false), { width: 600, height: 400 }).toJPEG(80))
  }
  fs.writeFileSync(path.join(folder, 'dup.jpg'), Buffer.from('not a real image at all'))
  fs.writeFileSync(path.join(folder, 'dup.png'), Buffer.from('still not an image'))
  const rows = ['good1', 'missing1', '', 'dup', 'dup', '../escape.jpg', 'good1', 'good2', 'good3', 'good4', 'good5']
  const csv = path.join(TEMP, 'edge-business.csv')
  fs.writeFileSync(csv, '\ufeff姓名,照片\r\n' + rows.map((r, i) => `异常-${i + 1},${r}`).join('\r\n'))
  const ds = dataset.getDataset(dataset.importFromFile(csv).id)
  const photoColumn = dataset.getDataset(ds.id).columns[1].key
  const res = await importPhotos(ds, photoColumn, folder, rows.length)
  await phase('edge-business report', async () => ({ counts: res.counts, files: res.files.length })).then((e) => {
    const c = e.result.counts
    ok(c.matched === 6 && c.missing === 1 && c.empty === 1 && c.ambiguous === 2 && c.broken === 0 && c.invalid === 1,
      `业务异常分类正确 matched=${c.matched} missing=${c.missing} empty=${c.empty} ambiguous=${c.ambiguous} invalid=${c.invalid}`)
    ok(res.files.filter(f => f.assetId).length === 5, '只有唯一匹配的有效照片入库（5 张），冲突与坏图未入库')
  })
  const { tpl } = makeStack(ds, photoColumn)
  let blocked = ''
  try { print.buildBatchHtml(ds.id, tpl.id) } catch (err) { blocked = err.message }
  ok(/照片出片检查|未匹配/.test(blocked), `全量出片被冲突/坏图/非法值阻断（${blocked.slice(0, 40)}…）`)
  const partial = print.buildBatchHtml(ds.id, tpl.id, [0, 6, 7])
  ok(partial.pageCount === 3 && photoSrcs(partial.html).length === 3, '只勾选正常行可出片：3 行 3 页，未选择行的异常不阻断')

  // ---- 排版边界：单页 / 多联 / 对折 / 末尾不足一页 / 部分选择 ----
  const folder2 = path.join(TEMP, 'layout-photos')
  fs.mkdirSync(folder2, { recursive: true })
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(folder2, `L${i + 1}.jpg`), nativeImage.createFromBitmap(pixels(500, 700, 900 + i, false), { width: 500, height: 700 }).toJPEG(80))
  const csv2 = path.join(TEMP, 'edge-layout.csv')
  fs.writeFileSync(csv2, '\ufeff姓名,照片\r\n' + Array.from({ length: 5 }, (_, i) => `版式-${i + 1},L${i + 1}`).join('\r\n'))
  const ds2 = dataset.getDataset(dataset.importFromFile(csv2).id)
  const col2 = dataset.getDataset(ds2.id).columns[1].key
  await importPhotos(ds2, col2, folder2, 5)
  const templates = require('../electron/templates.cjs')

  const layouts = [
    { key: 'single', pageSize: { id: 'custom', w: 90, h: 60 }, layout: undefined, artboard: { w: 90, h: 60 }, expectPages: 5 },
    { key: 'grid', pageSize: { id: 'a4', w: 210, h: 297 }, layout: { mode: 'grid', itemW: 90, itemH: 60 }, artboard: { w: 90, h: 60 }, expectPages: 1 },
    { key: 'fold', pageSize: { id: 'a4', w: 210, h: 297 }, layout: { mode: 'fold' }, artboard: { w: 210, h: 148.5 }, expectPages: 5 },
  ]
  for (const item of layouts) {
    const doc = require('../electron/designs.cjs').saveDesign({
      name: `版式-${item.key}`, artboard: { w: item.artboard.w, h: item.artboard.h, background: '#ffffff' }, assets: {},
      layers: [{
        id: `p-${item.key}`, type: 'image', name: '变量图', variable: true, bindColumn: col2,
        x: 5, y: 5, w: Math.min(30, item.artboard.w - 10), h: Math.min(45, item.artboard.h - 10),
        fit: 'cover', focal: { x: 0.5, y: 0.5 }, radius: 0, rotation: 0, opacity: 1, visible: true, locked: false,
      }],
    }, { recordUse: false })
    const tpl = templates.saveTemplate({
      name: `版式模板-${item.key}`, datasetId: ds2.id, pageSize: item.pageSize,
      backgroundDesign: { id: doc.id, revision: doc.revision }, fields: [], layout: item.layout,
    })
    const full = print.buildBatchHtml(ds2.id, tpl.id)
    ok(full.pageCount === item.expectPages, `${item.key}：5 条记录预计 ${item.expectPages} 页，实际 ${full.pageCount} 页`)
    const picked = print.buildBatchHtml(ds2.id, tpl.id, [1, 3])
    // fold 桌牌一页 = 一条记录 × 上下两个镜像半页，变量图每页出现 2 次（两半都印）
    const refsPerPage = item.key === 'fold' ? 2 : 1
    ok(photoSrcs(picked.html).length === 2 * refsPerPage, `${item.key}：勾选第 2、4 人出片，照片引用 ${2 * refsPerPage} 条（实际 ${photoSrcs(picked.html).length}）`)
    await phase(`edge-layout pdf ${item.key}`, async () => {
      const win = await printer.loadHtml(picked.html, { attempts: 1 })
      try {
        const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } })
        const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length
        return { pages, bytes: pdf.length }
      } finally { win.destroy() }
    }).then((e) => {
      if (e.result) ok(e.result.pages === (item.key === 'grid' ? 1 : 2), `${item.key}：勾选 2 人实际导出 ${e.result.pages} 页`)
    })
  }
}

function finish() {
  clearTimeout(watchdog)
  log.finishedAt = new Date().toISOString()
  log.durationMs = Date.now() - t0
  log.sampleSummary = { count: samples.length, ...summarize(0) }
  persist()
  const failed = log.checks.filter(c => !c.ok)
  say('')
  say('==== 汇总 ====')
  for (const p of log.phases) console.log(`  ${p.name.padEnd(28)} ${String(p.ms).padStart(8)} ms  peakSys ${mb(p.peak?.peakSysRss || 0).toString().padStart(7)} MB` + (p.error ? '  ERROR ' + p.error : ''))
  console.log(`  checks=${log.checks.length} failed=${failed.length} samples=${samples.length} dir=${runDir}`)
  say(`PHOTO_STRESS_DONE checks=${log.checks.length} failed=${failed.length}`)
  try { fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Electron 可能持锁，保留供检查 */ }
  app.exit(failed.length ? 1 : 0)
}

async function main() {
  setupProtocol()
  log.machine = machineInfo()
  fs.mkdirSync(STRESS_ROOT, { recursive: true })
  runDir = path.join(STRESS_ROOT, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(runDir, { recursive: true })
  startSampling()
  say(`结果目录 ${runDir}`)
  say(`机器 ${log.machine.cpu} / ${log.machine.memoryGB} GB / ${log.machine.platform} / electron ${log.machine.electron} / app ${log.machine.appVersion}`)
  // 一次性打印原始进程指标，确认 getAppMetrics 的单位与进程构成
  try {
    const raw = app.getAppMetrics().map(p => `${p.type}:ws=${p.memory.workingSetSize}`)
    say(`原始进程指标（workingSetSize 原值）: ${raw.join(' | ')}`)
    log.notes.push({ rawMetrics: raw })
  } catch (err) { say(`getAppMetrics 不可用: ${err.message}`) }
  persist()

  const wanted = opt('scale') || 'all'
  const rounds = Number(opt('rounds')) || (wanted === '50' ? 1 : 2)
  const withPreview = !flag('no-preview')
  // 分批导出必须在干净进程里测：500 张单次导出的失败会打挂渲染进程/打印管线，
  // 之后所有 printToPDF 都会秒失败（实测 5 批全部 1.3s 内 ERR），那是坏度量不是结论。
  const batchOnly = flag('batch-only')
  const batchSize = Number(opt('batch')) || 100
  try {
    if (batchOnly) {
      const m500 = await genSet('set500', 500)
      await prepareForBatch(m500)
      if (lastTemplate) await runBatchExport(lastTemplate.dsId, lastTemplate.templateId, batchSize, Math.ceil(500 / batchSize))
    } else if (wanted === 'gen') {
      await genSet('set50', 50)
      await genSet('mixed', 24)
      await genSet('set500', 500)
    } else if (wanted === 'all' || wanted === '50') {
      const m50 = await genSet('set50', 50)
      await runRound(m50, 1, { withPreview, keepPdf: true })
    }
    if (!batchOnly && (wanted === 'all' || wanted === 'mixed')) await runMixed(await genSet('mixed', 24))
    if (!batchOnly && (wanted === 'all' || wanted === 'edges')) await runEdges()
    if (!batchOnly && (wanted === 'all' || wanted === '500')) {
      const m500 = await genSet('set500', 500)
      for (let r = 1; r <= rounds; r++) {
        // PDF 不落盘：500 张大图单次出片 ~7.5GB，磁盘与缓冲都吃不消（本身就是要测的边界）
        await runRound(m500, r, { withPreview, keepPdf: false })
      }
      if (lastTemplate) await runBatchExport(lastTemplate.dsId, lastTemplate.templateId, 100, 5)
    }
  } catch (err) {
    log.notes.push({ fatal: String(err && err.stack || err) })
    say('FATAL', err)
  } finally {
    finish()
  }
}

app.whenReady().then(main)

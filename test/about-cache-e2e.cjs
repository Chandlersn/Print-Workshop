/**
 * 「关于 → 缓存与残留」这条行的**真渲染**证明（契约 I-49 第 10 条：派生件是缓存，就必须有管理入口）。
 *
 * 分工：
 * - `test/output-dpi.cjs` 第 9 节证明「线接上了」：api.cjs 用上了统计/清理、App.vue 读的是主进程给的数、
 *   两份说明都写了这一条。但那些全是**读源码**的静态断言。
 * - 本套件证明「在真界面上真的成立」：按钮上那个体积是不是真的含派生件、点下去是不是真的删掉了、
 *   清理结果是不是真的报出来了、以及**长结果文案下排版会不会塌**。
 *
 * 为什么必须有这一层：本套件第一次跑就抓到一个静态断言完全看不见的缺陷——结果文案变长后，
 * `.ar-label` 没有 `flex: 0 0 auto`，中文标签被挤成逐字换行的竖排（「缓存 / 与残 / 留」）。
 * 这类问题只有真渲染 + 读几何才看得出来。
 *
 * 为什么是「纯 Node 驱动 + CDP」而不是 electron-runner：
 * electron-runner 把脚本**当主进程**跑；本套件要的是「驱动一个真的应用窗口」，
 * 所以自己 spawn Electron 应用、再从 CDP 连进渲染进程。
 *
 * 运行：node test/about-cache-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
// 夹具一律放系统临时区：本机沙箱对「非系统临时区」的 rename/unlink 有代理拦截，
// 而主进程会往数据目录写 designs 的锁文件（靠 rename 原子获取）。
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-about-cache-ud-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-about-cache-data-'))
const artifacts = path.join(ROOT, '.workbuddy-ai', 'tmp', 'about-cache-e2e')
fs.mkdirSync(artifacts, { recursive: true })

let checks = 0
function ok(cond, msg) {
  if (!cond) throw new Error(msg)
  checks += 1
  console.log('  ✓', msg)
}

// 塞 3 个共 2.0 MB 的假派生件。全新 profile 的系统缓存只有约 1 MB（且是 Chromium 运行中
// 持有的 GPUCache，删不掉、只会排到下次启动），所以按钮上多出来的 2.0 MB 只可能来自派生件。
const SEED_FILES = 3
const SEED_BYTES = 2 * 1024 * 1024
const derivedDir = path.join(dataDir, 'photo-out')
fs.mkdirSync(derivedDir, { recursive: true })
{
  const each = Math.floor(SEED_BYTES / SEED_FILES)
  const full = Buffer.alloc(each, 7)
  for (let i = 0; i < SEED_FILES; i++) {
    const last = i === SEED_FILES - 1
    fs.writeFileSync(path.join(derivedDir, `seed-${i}.jpg`), last ? Buffer.alloc(SEED_BYTES - each * (SEED_FILES - 1), 7) : full)
  }
}

const PORT = 9334
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = cdp.n = (cdp.n || 0) + 1
    const timer = setTimeout(() => reject(new Error(`CDP 超时：${method}`)), 20000)
    const onMsg = (event) => {
      const raw = event && event.data !== undefined ? event.data : event
      const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  const env = { ...process.env }
  // 宿主常设 ELECTRON_RUN_AS_NODE=1：Electron 会退化成纯 Node 静默退出（退出码 0、零输出），
  // 那就变成「测试通过但什么都没跑」。NODE_OPTIONS 会往主进程里塞 shim，一并摘掉。
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.PRINTPRESS_DATA_DIR = dataDir

  const bin = path.join(ROOT, 'node_modules/electron/dist/electron.exe')
  const child = spawn(bin, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-sandbox'], {
    cwd: ROOT, env, stdio: 'ignore', detached: false,
  })
  const kill = () => { try { child.kill() } catch { /* 已退出 */ } }
  const watchdog = setTimeout(() => { console.error('ABOUT_CACHE_E2E_TIMEOUT'); kill(); process.exit(2) }, 120000)

  let ws
  try {
    let target = null
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500)
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find(t => t.type === 'page' && !t.url.includes('devtools'))
      } catch { /* 端口还没开 */ }
    }
    if (!target) throw new Error('拿不到渲染进程 target')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    await cdp(ws, 'Runtime.enable')
    await cdp(ws, 'Page.enable')

    const ev = async (expr) => {
      const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails))
      return r.result.value
    }
    const shot = async (name) => {
      const s = await cdp(ws, 'Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(artifacts, name), Buffer.from(s.data, 'base64'))
    }

    console.log('== 1. 打开「关于」==')
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await ev(`return document.querySelectorAll('.nav-label').length >= 3`)
      if (!ready) await sleep(500)
    }
    ok(ready, '界面渲染完成（导航栏已挂载）')
    // 首启引导弹窗会盖住整页，先关掉
    await ev(`
      const g = [...document.querySelectorAll('button')].find(b => /开始使用|我知道了|关闭/.test(b.textContent))
      if (g) { g.click(); await new Promise(r => setTimeout(r, 400)) }
      return 1`)
    const opened = await ev(`
      const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '关于')
      if (!b) return { opened: false }
      b.click()
      await new Promise(r => setTimeout(r, 900))
      return { opened: !!document.querySelector('.about') }`)
    ok(opened && opened.opened, '「关于」弹窗真的打开了')

    console.log('== 2. 缓存行：读数必须含派生件 ==')
    const row = await ev(`
      const label = [...document.querySelectorAll('.about-row .ar-label')].find(e => e.textContent.trim() === '缓存与残留')
      if (!label) return null
      const group = label.parentElement.querySelector('.ar-value')
      const btn = group.querySelector('button')
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return {
        title: label.getAttribute('title') || '',
        btnText: btn.textContent.trim(),
        status: [...group.querySelectorAll('span')].map(e => e.textContent.trim()).filter(Boolean),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        hit: hit ? (hit.className || hit.tagName) : null,
      }`)
    ok(!!row, '找得到「缓存与残留」这一行')
    ok(/出片派生件/.test(row.title), '标签 title 交代了「出片派生件」也可安全清理')
    ok(row.rect.w > 0 && row.rect.h > 0, `按钮在布局里（${row.rect.w}×${row.rect.h}）`)
    ok(!row.hit || /footer-btn|BUTTON/.test(row.hit), `按钮中心点没被遮罩盖住（命中 ${row.hit}）`)

    const sizeOf = (t) => {
      const m = String(t).match(/（([\d.]+) (KB|MB)）$/)
      if (!m) return null
      return m[2] === 'MB' ? parseFloat(m[1]) * 1024 * 1024 : parseFloat(m[1]) * 1024
    }
    const beforeBytes = sizeOf(row.btnText)
    ok(beforeBytes != null, `按钮文案是「清理缓存与残留（体积）」的形状：${row.btnText}`)
    ok(beforeBytes >= SEED_BYTES * 0.95, `按钮读数 ${row.btnText} 含进了 3 个派生件（2.0 MB）`)
    ok(!row.status.includes('缓存已空'), '塞了 2.0 MB 派生件，不该显示「缓存已空」')
    await shot('about-cache-before.png')

    console.log('== 3. 真点一下：走完整 IPC 往返 ==')
    const rect = row.rect
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 })
    await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(1800)

    const after = await ev(`
      const label = [...document.querySelectorAll('.about-row .ar-label')].find(e => e.textContent.trim() === '缓存与残留')
      const group = label.parentElement.querySelector('.ar-value')
      const lr = label.getBoundingClientRect()
      return {
        btnText: group.querySelector('button').textContent.trim(),
        status: [...group.querySelectorAll('span')].map(e => e.textContent.trim()).filter(Boolean),
        labelRect: { w: Math.round(lr.width), h: Math.round(lr.height) },
      }`)
    const left = fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).length : 0

    ok(after.status.some(s => /清理了\s*3\s*个出片派生件/.test(s)),
      `清理结果如实报出 3 个派生件：${JSON.stringify(after.status)}`)
    ok(left === 0, `磁盘上 photo-out/ 已清空（剩 ${left} 个）`)
    // 清理后读数**不会**归零：Chromium 运行中持有的 GPUCache 删不掉，主进程按设计排队到下次启动清。
    // 所以断言的是「少了正好一个 seed 的量」，而不是「归零」——后者是错的期望（本套件第一版就这么错过）。
    const afterBytes = sizeOf(after.btnText)
    const dropped = beforeBytes != null && afterBytes != null ? beforeBytes - afterBytes : null
    ok(dropped != null && Math.abs(dropped - SEED_BYTES) <= 0.1 * 1024 * 1024,
      `读数按派生件体积下降：${row.btnText} → ${after.btnText}（差 ${dropped} 字节）`)
    ok(after.status.some(s => /正被系统占用，将在下次启动时清理/.test(s)),
      '排到下次启动的系统缓存被如实交代，没有静默当成清干净')

    console.log('== 4. 长结果文案下排版不许塌 ==')
    // 13px 单行约 20px；被压成竖排会到 40px+ 且宽度塌到十几像素
    ok(after.labelRect && after.labelRect.h <= 30 && after.labelRect.w >= 60,
      `「缓存与残留」标签仍是单行（${after.labelRect && after.labelRect.w}×${after.labelRect && after.labelRect.h}）`)
    // 反面：短值必须仍然贴右边缘。修上面那条时很容易顺手把值列改成 flex:1，
    // 那样「开源协议 MIT」会挤到标签旁边——本套件第一版就这么错过一次。
    const align = await ev(`
      const rows = [...document.querySelectorAll('.about-row')].map(r => {
        const l = r.querySelector('.ar-label'); const v = r.querySelector('.ar-value')
        return l && v ? { label: l.textContent.trim(), vr: Math.round(v.getBoundingClientRect().right) } : null
      }).filter(Boolean)
      const box = document.querySelector('.about-rows').getBoundingClientRect()
      return { rows, boxRight: Math.round(box.right) }`)
    const lic = align.rows.find(r => r.label === '开源协议')
    const gap = lic ? align.boxRight - lic.vr : null
    ok(gap != null && gap >= 0 && gap <= 26,
      `短值仍贴右边缘（「开源协议」距容器右边 ${gap}px，值列没被改成 flex:1）`)
    await shot('about-cache-after.png')

    const result = { checks, seededBytes: SEED_BYTES, seededFiles: SEED_FILES, artifactDir: artifacts }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
    console.log(`\n关于弹窗缓存行（I-49）验收：${checks} 项通过`)
    console.log('ABOUT_CACHE_E2E_OK', JSON.stringify(result))
  } finally {
    clearTimeout(watchdog)
    if (ws) try { ws.close() } catch { /* 已关 */ }
    kill()
  }
}

main().catch(err => {
  console.error('ABOUT_CACHE_E2E_FAIL', err && err.message ? err.message : err)
  process.exit(1)
})

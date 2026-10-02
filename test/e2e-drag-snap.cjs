/**
 * E2E：模板页拖拽跟手性 + 居中吸附全链（隔离数据目录）。
 * 背景：boss 真机反馈「辅助线不灵敏、拖动怪怪的」。静态推导指出 grabX
 * 多加了 boxW*ratio 会导致 ①按下瞬间字段左跳半个盒宽 ②吸附边缘整体错位。
 * 本套件在打包产物上实测这两点，防止再靠静态核查下结论。
 *
 * 断言链（修复后应全过）：
 *  1. 按下不动（Δ=0）→ 字段原地不动（跟手）
 *  2. 指针移到画布中心线 → 吸附辅助线出现
 *  3. 松手 → 字段盒中心精确落在画布中心（吸附写入正确）
 *
 * 运行：node test/e2e-drag-snap.cjs （需先出包，或 PRINTPRESS_EXE 指定）
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')

const ROOT = path.join(__dirname, '..')
const EXE_CANDIDATES = [
  process.env.PRINTPRESS_EXE,
  path.join(ROOT, 'release-025', 'win-unpacked', '批印坊.exe'),
  path.join(ROOT, 'release', 'win-unpacked', '批印坊.exe'),
].filter(Boolean)
const EXE = EXE_CANDIDATES.find((p) => fs.existsSync(p)) || EXE_CANDIDATES[0]
const PORT = 9471
const DATA = path.join(__dirname, '.tmp-data-drag')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + label) }
  else { fail += 1; console.error('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

function seed() {
  rmDeep(DATA)
  fs.mkdirSync(DATA, { recursive: true })
  const datasets = [{
    id: 'ds-drag',
    name: 'e2e-拖拽表',
    source: { type: 'csv', fileName: 'e2e.csv', importedAt: new Date().toISOString() },
    columns: [
      { key: '姓名', alias: '姓名', type: 'text', avgLen: 3, filled: 2, printOn: true },
    ],
    rows: [{ 姓名: '张三' }, { 姓名: '李四' }],
  }]
  // 字段1 x=40（不在任何目标线上，专测跟手性）；字段2 x=50（提供画布中心附近的对齐目标）
  const templates = [{
    id: 'tpl-drag',
    name: 'e2e-拖拽模板',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    bgSize: { width: 794, height: 1123 },
    datasetId: 'ds-drag',
    fields: [
      { column: '姓名', label: '姓名', x: 40, y: 30, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
      { column: '姓名', label: '姓名2', x: 50, y: 60, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]
  fs.writeFileSync(path.join(DATA, 'datasets.json'), JSON.stringify(datasets))
  fs.writeFileSync(path.join(DATA, 'templates.json'), JSON.stringify(templates))
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ demoSeeded: true, seedVersion: 2 }))
}

async function main() {
  seed()
  if (!fs.existsSync(EXE)) {
    console.error('未找到打包产物：' + EXE)
    process.exit(1)
  }
  const env = { ...process.env, PRINTPRESS_DATA_DIR: DATA }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore', env })

  try {
    let page = null
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try {
        const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
        page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url)) || null
        if (page) break
      } catch { /* 端口未就绪 */ }
    }
    ok(page, '找到主窗口调试目标')

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let msgId = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
    async function evalJs(expr) {
      const id = ++msgId
      const p = new Promise((res) => pending.set(id, res))
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
      const r = await p
      if (r.result && r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      }
      return r.result ? r.result.result : null
    }
    await sleep(1500)

    // ---- 进模板页并选中种子模板 ----
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='模板')?.click()`)
    await sleep(800)
    await evalJs(`[...document.querySelectorAll('.tpl-item')].find(e=>e.textContent.includes('e2e-拖拽模板'))?.click()`)
    await sleep(1500)

    // ---- 场景 1：按下不动（Δ=0），字段必须原地不动 ----
    const down1 = (await evalJs(`(function(){
      const cv = document.querySelector('.canvas')
      const fb = cv.querySelector('.field-box')
      if (!cv || !fb) return { err: 'no canvas/field' }
      const cr = cv.getBoundingClientRect()
      const fr = fb.getBoundingClientRect()
      const cx = fr.left + fr.width / 2
      const cy = fr.top + fr.height / 2
      fb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy }))
      return { leftBefore: fb.style.left, boxW: fr.width, cvW: cr.width }
    })()`)).value
    ok(!down1.err, '画布与字段存在', down1)
    await sleep(80)
    // 指针原地 dispatch 一次 pointermove（监听在 window 上）
    await evalJs(`(function(){
      const cv = document.querySelector('.canvas')
      const fb = cv.querySelector('.field-box')
      const fr = fb.getBoundingClientRect()
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: fr.left + fr.width / 2, clientY: fr.top + fr.height / 2 }))
      return true
    })()`)
    await sleep(120)
    const hold1 = (await evalJs(`(function(){
      const fb = document.querySelector('.canvas .field-box')
      return { leftAfter: fb.style.left, transform: fb.style.transform }
    })()`)).value
    const pctBefore = parseFloat(down1.leftBefore)
    const pctAfter = parseFloat(hold1.leftAfter)
    ok(Math.abs(pctAfter - pctBefore) < 0.2,
      `按下不动字段不跳（style.left ${pctBefore}% → ${pctAfter}%）`,
      { before: down1.leftBefore, after: hold1.leftAfter })
    // 松手，结束场景 1
    await evalJs(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`)
    await sleep(80)

    // ---- 场景 2：拖到画布中心线，吸附必须让盒中心精确落线 ----
    const down2 = (await evalJs(`(function(){
      const cv = document.querySelector('.canvas')
      const fb = cv.querySelector('.field-box')
      const cr = cv.getBoundingClientRect()
      const fr = fb.getBoundingClientRect()
      const cx = fr.left + fr.width / 2
      const cy = fr.top + fr.height / 2
      fb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy }))
      // 指针移到画布中心线（y 不变）
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cr.left + cr.width / 2, clientY: cy }))
      return { cvW: cr.width, cvLeft: cr.left }
    })()`)).value
    await sleep(120)
    const mid2 = (await evalJs(`(function(){
      const guide = document.querySelector('.snap-guide.guide-v')
      const cv = document.querySelector('.canvas')
      const fb = cv.querySelector('.field-box')
      const cr = cv.getBoundingClientRect()
      const fr = fb.getBoundingClientRect()
      return {
        guideShown: !!guide,
        guideLeft: guide ? guide.getBoundingClientRect().left - cr.left : null,
        styleLeft: fb.style.left,
        boxCenter: fr.left + fr.width / 2 - cr.left,
        cvCenter: cr.width / 2,
      }
    })()`)).value
    ok(mid2.guideShown, '靠近中心线时吸附辅助线出现', mid2)
    // 松手前盒中心就应被吸附到中心线（吸附是实时的，不等 up）
    ok(Math.abs(mid2.boxCenter - mid2.cvCenter) <= 1.5,
      `吸附后盒中心贴线（盒中心 ${mid2.boxCenter.toFixed(1)}px vs 线 ${mid2.cvCenter.toFixed(1)}px）`, mid2)
    await evalJs(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`)
    await sleep(120)
    const end2 = (await evalJs(`(function(){
      const cv = document.querySelector('.canvas')
      const fb = cv.querySelector('.field-box')
      const cr = cv.getBoundingClientRect()
      const fr = fb.getBoundingClientRect()
      return { styleLeft: fb.style.left, boxCenter: fr.left + fr.width / 2 - cr.left, cvCenter: cr.width / 2 }
    })()`)).value
    ok(Math.abs(parseFloat(end2.styleLeft) - 50) < 0.2,
      `松手后字段 x 落在 50%（实际 ${end2.styleLeft}）`, end2)
    ok(Math.abs(end2.boxCenter - end2.cvCenter) <= 1.5,
      `松手后盒中心仍在画布中心（偏 ${(end2.boxCenter - end2.cvCenter).toFixed(1)}px）`, end2)
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
  }

  console.log(`\n拖拽吸附 e2e：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

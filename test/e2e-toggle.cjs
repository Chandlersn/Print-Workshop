// E2E：列头「印」开关 → 侧栏「印 N」徽标与置顶排序的即时联动（对打包产物实测）
// 用法：node test/e2e-toggle.cjs  （需先出包 release/win-unpacked）
// 数据目录注入 PRINTPRESS_DATA_DIR：不碰用户真实数据（真实数据会漂移，demo.csv 之类条目随时可能被删）
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')

const EXE = path.join(__dirname, '..', 'release', 'win-unpacked', '批印坊.exe')
const PORT = 9333
const DATA = path.join(__dirname, '.tmp-data-e2e-toggle')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 种子：zero（零激活）+ two（印2）+ one（印1），排序行为完全确定 */
function seed() {
  rmDeep(DATA)
  fs.mkdirSync(DATA, { recursive: true })
  const mk = (id, name, prints) => ({
    id, name,
    source: { type: 'csv', fileName: name, importedAt: new Date().toISOString() },
    columns: [
      { key: '姓名', alias: '姓名', type: 'text', avgLen: 3, filled: 5, printOn: prints > 0 },
      { key: '奖项', alias: '奖项', type: 'text', avgLen: 2, filled: 5, printOn: prints > 1 },
    ],
    rows: Array.from({ length: 5 }, (_, i) => ({ 姓名: '选手' + (i + 1), 奖项: '金奖' })),
  })
  const datasets = [mk('ds-zero', 'e2e-zero.csv', 0), mk('ds-two', 'e2e-two.csv', 2), mk('ds-one', 'e2e-one.csv', 1)]
  fs.writeFileSync(path.join(DATA, 'datasets.json'), JSON.stringify(datasets))
  fs.writeFileSync(path.join(DATA, 'templates.json'), '[]')
  // 阻止首启种子：目录全新时 seedIfFirstRun 会种入 demo.csv 示例数据，干扰确定性断言
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ demoSeeded: true }))
}

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + label) }
  else { fail += 1; console.error('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

async function main() {
  seed()
  const env = { ...process.env, PRINTPRESS_DATA_DIR: DATA }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore', env })

  try {
    let page = null
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json/list')
        const targets = await res.json()
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

    await sleep(1200) // 等首屏渲染

    const order = () => evalJs(`[...document.querySelectorAll('.ds-item .ds-name')].map(e=>e.textContent.trim())`)
    const idxOf = (kw) => evalJs(
      `[...document.querySelectorAll('.ds-item .ds-name')].findIndex(e=>e.textContent.includes(${JSON.stringify(kw)}))`)

    // 徽标可见性检查：不仅要在 DOM 里，还必须几何上落在卡片可见范围内（防 ellipsis 裁切）
    const badgeOf = (kw) => evalJs(
      `(function(){const key=${JSON.stringify(kw)};const it=[...document.querySelectorAll('.ds-item')].find(e=>e.textContent.includes(key));const f=it&&it.querySelector('.ds-print-flag');if(!f)return null;const r=f.getBoundingClientRect(),c=it.getBoundingClientRect();return {text:f.textContent.trim(), visible: r.width>0 && r.right<=c.right+1}})()`)

    // A. 初始：zero 零激活 → 排在非置顶区末尾；置顶区 [two(2), one(1)]
    const names0 = (await order()).value
    ok(Array.isArray(names0) && names0.length === 3, '侧栏有 3 个种子数据集', names0)
    const zeroIdx0 = (await idxOf('e2e-zero.csv')).value
    ok(zeroIdx0 === 2, 'zero 初始在非置顶区末尾（index 2）', zeroIdx0)
    console.log('  zero 初始位置:', zeroIdx0, '/ 共', names0.length)

    // B. 选中 zero
    await evalJs(`document.querySelectorAll('.ds-item')[${zeroIdx0}].click()`)
    await sleep(400)
    const targetName = (await evalJs(`document.querySelector('.detail-title').textContent.trim()`)).value
    const toggleCount = (await evalJs(`document.querySelectorAll('.print-toggle').length`)).value
    ok(toggleCount === 2, '数据表格出现 2 个列头印开关', toggleCount)

    // C. 点第一个灰「印」→ 变红 + 徽标「印 1」可见 + 跳进置顶组（印 1 与 one 并列、按稳定序插到 one 前）
    const firstOff = (await evalJs(
      `[...document.querySelectorAll('.print-toggle')].findIndex(x=>!x.classList.contains('on'))`)).value
    ok(firstOff >= 0, '存在灰印开关', firstOff)
    await evalJs(`document.querySelectorAll('.print-toggle')[${firstOff}].click()`)
    await sleep(600)
    const nowOn = (await evalJs(
      `document.querySelectorAll('.print-toggle')[${firstOff}].classList.contains('on')`)).value
    ok(nowOn, '开关即时变红（on）')
    const badge = (await badgeOf(targetName)).value
    ok(badge && badge.text === '印 1' && badge.visible, '侧栏即时出现可见的「印 1」徽标', badge)
    const zeroIdx1 = (await idxOf('e2e-zero.csv')).value
    const badges = (await evalJs(
      `[...document.querySelectorAll('.ds-item')].map(e=>{const f=e.querySelector('.ds-print-flag');const m=f?f.textContent.match(/印\\s*(\\d+)/):null;return m?+m[1]:0})`)).value
    ok(zeroIdx1 === 1 && badges.join(',') === '2,1,1',
      '跳进置顶组（two 印2 仍居首，zero 以印1 插到 one 前）', { from: zeroIdx0, to: zeroIdx1, badges })

    // D. 点同一个开关取消 → 徽标即时消失、回到原位
    await evalJs(`document.querySelectorAll('.print-toggle')[${firstOff}].click()`)
    await sleep(600)
    const nowOff = (await evalJs(
      `document.querySelectorAll('.print-toggle')[${firstOff}].classList.contains('on')`)).value
    ok(!nowOff, '取消后开关即时变灰')
    const badgeRevert = (await badgeOf(targetName)).value
    ok(!badgeRevert, '徽标即时消失', badgeRevert)
    const zeroIdx2 = (await idxOf('e2e-zero.csv')).value
    ok(zeroIdx2 === zeroIdx0, '回到原位', { from: zeroIdx1, to: zeroIdx2 })
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
  }
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1) })

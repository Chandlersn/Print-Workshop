/**
 * E2E：行级出片范围全流程（隔离数据目录，不碰用户数据）。
 *
 * 种子：6 行名单，其中第 3 行（0 基 2）奖项为空；模板已绑定。
 * 验证：默认全量 → 取消全选 + 搜索勾选 → 出片范围切换为「部分」→
 *       部分范围同样进入出口校验（空值行号按全量行号提示）。
 *
 * 运行：node test/e2e-scope.cjs
 * 说明：直接跑源码版（electron + 已构建的 dist/），无需重新出包。
 */
// 用 node 运行（不是 electron）：本脚本只负责 spawn 应用 + 走 CDP，
// 依赖 Node 的全局 WebSocket（Electron 28 内置的 Node 18 没有）。
// 运行：node test/e2e-scope.cjs
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9471
const DATA = path.join(__dirname, '.tmp-data-escope')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + label) }
  else { fail += 1; console.error('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

function seed() {
  rmDeep(DATA)
  fs.mkdirSync(DATA, { recursive: true })
  const rows = Array.from({ length: 6 }, (_, i) => ({
    姓名: '选手' + (i + 1),
    奖项: i === 2 ? '' : (i % 2 ? '金奖' : '银奖'),
  }))
  const datasets = [{
    id: 'ds-scope',
    name: 'e2e-范围表',
    source: { type: 'csv', fileName: 'e2e.csv', importedAt: new Date().toISOString() },
    columns: [
      { key: '姓名', alias: '姓名', type: 'text', avgLen: 3, filled: 6, printOn: true },
      { key: '奖项', alias: '奖项', type: 'text', avgLen: 2, filled: 5, printOn: true },
    ],
    rows,
  }]
  const templates = [{
    id: 'tpl-scope',
    name: 'e2e-范围模板',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    background: 'e2e-bg.png', // 只需 truthy，文件不存在不影响校验流
    bgSize: { width: 794, height: 1123 },
    datasetId: 'ds-scope',
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 30, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
      { column: '奖项', label: '奖项', x: 50, y: 60, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]
  fs.writeFileSync(path.join(DATA, 'datasets.json'), JSON.stringify(datasets))
  fs.writeFileSync(path.join(DATA, 'templates.json'), JSON.stringify(templates))
  // 阻止首启种子，保证断言确定性
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ demoSeeded: true }))
}

async function main() {
  seed()
  if (!fs.existsSync(ELECTRON)) {
    console.error('未找到 electron：' + ELECTRON)
    process.exit(1)
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('未找到 dist/index.html，请先 npm run build')
    process.exit(1)
  }
  const env = { ...process.env, PRINTPRESS_DATA_DIR: DATA }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + PORT], { stdio: 'ignore', env })

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
    await sleep(1800) // 等首屏渲染

    // ---- 进入打印中心并选模板 ----
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='打印中心')?.click()`)
    await sleep(800)
    await evalJs(`document.querySelector('.toolbar .custom-select .cs-trigger')?.click()`)
    await sleep(400)
    await evalJs(`document.querySelector('.cs-menu .cs-option')?.click()`)
    await sleep(2500) // 等预览 + 行数据加载

    // ---- 1. 默认应为全量 ----
    const initial = (await evalJs(
      `(function(){return {
        hasBar: !!document.querySelector('.range-bar'),
        barText: document.querySelector('.range-bar')?.textContent.replace(/\\s+/g,' ').trim()||'',
        previewMeta: document.querySelector('.preview-meta')?.textContent.replace(/\\s+/g,' ').trim()||'',
      }})()`)).value
    ok(initial.hasBar, '出片范围栏出现', initial)
    ok(initial.barText.includes('全量出片') && initial.barText.includes('全部 6 行'), '默认全量 6 行', initial.barText)
    ok(initial.previewMeta.includes('6 页'), '预览为全量 6 页', initial.previewMeta)

    // ---- 2. 打开选择面板：默认全选 ----
    await evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='选择打印行')?.click()`)
    await sleep(600)
    const opened = (await evalJs(
      `(function(){return {
        open: !!document.querySelector('.modal-wide'),
        count: document.querySelector('.scope-count')?.textContent.replace(/\\s+/g,' ').trim()||'',
        rows: document.querySelectorAll('.scope-row').length,
      }})()`)).value
    ok(opened.open, '选择面板打开', opened)
    ok(opened.rows === 6, '列出全部 6 行', opened.rows)
    ok(opened.count.includes('已选 6 / 共 6 行'), '默认全选 6 行', opened.count)

    // ---- 3. 取消全选 → 搜索 → 勾选命中项 ----
    await evalJs(`[...document.querySelectorAll('.modal-wide button')].find(x=>x.textContent.trim()==='取消全选')?.click()`)
    await sleep(300)
    const none = (await evalJs(`document.querySelector('.scope-count')?.textContent.replace(/\\s+/g,' ').trim()||''`)).value
    ok(none.includes('已选 0 / 共 6 行'), '取消全选后为 0', none)

    await evalJs(`(function(){const el=document.querySelector('.scope-input');el.value='选手3';el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await sleep(500)
    const searched = (await evalJs(
      `(function(){return {
        rows: document.querySelectorAll('.scope-row').length,
        texts: [...document.querySelectorAll('.scope-row .scope-text')].map(e=>e.textContent.trim()),
      }})()`)).value
    ok(searched.rows === 1 && searched.texts[0].includes('选手3'), '搜索缩小到 1 行', searched)

    await evalJs(`[...document.querySelectorAll('.modal-wide button')].find(x=>x.textContent.trim()==='勾选命中项')?.click()`)
    await sleep(300)
    const hit = (await evalJs(`document.querySelector('.scope-count')?.textContent.replace(/\\s+/g,' ').trim()||''`)).value
    ok(hit.includes('已选 1 / 共 6 行'), '勾选命中项后为 1', hit)

    await evalJs(`[...document.querySelectorAll('.modal-wide .btn-primary')].find(x=>x.textContent.trim()==='确定')?.click()`)
    await sleep(2500)

    // ---- 4. 范围栏切换为「部分出片」，预览同步为 1 页 ----
    const partial = (await evalJs(
      `(function(){return {
        barText: document.querySelector('.range-bar')?.textContent.replace(/\\s+/g,' ').trim()||'',
        previewMeta: document.querySelector('.preview-meta')?.textContent.replace(/\\s+/g,' ').trim()||'',
        hasReset: [...document.querySelectorAll('.range-bar button')].some(x=>x.textContent.trim()==='恢复全量'),
        toast: document.querySelector('.toast')?.textContent.trim()||'',
      }})()`)).value
    if (partial.toast) console.log('  [debug] toast: ' + partial.toast)
    ok(partial.barText.includes('部分出片') && partial.barText.includes('已选 1 / 6 行'), '范围栏显示部分出片 1/6', partial.barText)
    ok(partial.previewMeta.includes('1 页'), '预览同步为 1 页', partial.previewMeta)
    ok(partial.hasReset, '出现「恢复全量」入口', partial)

    // ---- 5. 部分范围进入出口校验：空值行号按全量行号提示（选手3 = 第 3 行） ----
    await evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='导出 PDF')?.click()`)
    await sleep(1800)
    const modal = (await evalJs(
      `(function(){const chips=[...document.querySelectorAll('.fix-chip')];return {
        open: !!document.querySelector('.modal'),
        chipTexts: chips.map((c)=>c.textContent.trim()),
      }})()`)).value
    ok(modal.open, '部分范围同样触发出口校验弹窗', modal)
    ok(modal.chipTexts.includes('第 3 行'), '空值行号回填为全量行号（第 3 行）', modal.chipTexts)

    // 关掉弹窗，恢复全量，范围栏应回到全量
    await evalJs(`[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='返回补全')?.click()`)
    await sleep(500)
    await evalJs(`[...document.querySelectorAll('.range-bar button')].find(x=>x.textContent.trim()==='恢复全量')?.click()`)
    await sleep(2000)
    const restored = (await evalJs(`document.querySelector('.range-bar')?.textContent.replace(/\\s+/g,' ').trim()||''`)).value
    ok(restored.includes('全量出片') && restored.includes('全部 6 行'), '「恢复全量」回到全量范围', restored)
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
    rmDeep(DATA)
  }
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1) })

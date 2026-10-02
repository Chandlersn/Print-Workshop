/**
 * E2E：多联版式全流程（隔离数据目录，不碰用户数据）。
 *
 * 种子：10 行名单 + 一个「A4 竖版 + 成品 85×54mm」的多联模板。
 * 验证：模板工坊画布切换为「单个成品」尺寸、版式摘要正确；
 *       打印中心预览页数按「每页格数」折算（10 条 → 1 页）。
 *
 * 运行：node test/e2e-grid.cjs（跑源码版，需先 npm run build）
 */
// 用 node 运行（不是 electron）：本脚本只负责 spawn 应用 + 走 CDP，
// 依赖 Node 的全局 WebSocket（Electron 28 内置的 Node 18 没有）。
// 运行：node test/e2e-grid.cjs
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9472
const DATA = path.join(__dirname, '.tmp-data-egrid')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + label) }
  else { fail += 1; console.error('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

const ITEM_W = 85
const ITEM_H = 54

function seed() {
  rmDeep(DATA)
  fs.mkdirSync(DATA, { recursive: true })
  const rows = Array.from({ length: 10 }, (_, i) => ({ 姓名: '选手' + (i + 1) }))
  const datasets = [{
    id: 'ds-grid',
    name: 'e2e-多联表',
    source: { type: 'csv', fileName: 'e2e.csv', importedAt: new Date().toISOString() },
    columns: [{ key: '姓名', alias: '姓名', type: 'text', avgLen: 3, filled: 10, printOn: true }],
    rows,
  }]
  const templates = [{
    id: 'tpl-grid',
    name: 'e2e-多联模板',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    background: 'e2e-bg.png',
    bgSize: { width: 321, height: 204 }, // 85:54 比例
    datasetId: 'ds-grid',
    layout: { mode: 'grid', itemW: ITEM_W, itemH: ITEM_H, showCutMarks: true },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 12, color: '#000', align: 'center', fontFamily: '', bold: false },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]
  fs.writeFileSync(path.join(DATA, 'datasets.json'), JSON.stringify(datasets))
  fs.writeFileSync(path.join(DATA, 'templates.json'), JSON.stringify(templates))
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ demoSeeded: true }))
}

async function main() {
  seed()
  if (!fs.existsSync(ELECTRON)) { console.error('未找到 electron：' + ELECTRON); process.exit(1) }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { console.error('请先 npm run build'); process.exit(1) }

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
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result ? r.result.result : null
    }
    await sleep(1800)

    // ---- 模板工坊：打开多联模板 ----
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='模板')?.click()`)
    await sleep(800)
    await evalJs(`document.querySelector('.tpl-item')?.click()`)
    await sleep(2000)

    const studio = (await evalJs(
      `(function(){
        const canvas = document.querySelector('.canvas');
        const cells = [...document.querySelectorAll('.canvas-cell')];
        const first = cells[0];
        const cr = first ? first.getBoundingClientRect() : null;
        const warn = [...document.querySelectorAll('.warn-line')].map(e=>e.textContent.replace(/\\s+/g,' ').trim());
        return {
          hasCanvas: !!canvas,
          canvasW: canvas ? canvas.offsetWidth : 0,
          canvasH: canvas ? canvas.offsetHeight : 0,
          cellCount: cells.length,
          cellW: cr ? cr.width : 0,
          cellH: cr ? cr.height : 0,
          fieldBoxes: document.querySelectorAll('.field-box').length,
          warns: warn,
        };
      })()`)).value

    ok(studio.hasCanvas, '画布存在', studio)
    // 画布仍显示**整张纸**（A4 竖版 297/210 ≈ 1.414），而不是单个成品
    const pageRatio = studio.canvasW ? studio.canvasH / studio.canvasW : 0
    ok(Math.abs(pageRatio - 297 / 210) < 0.02, '画布按整张纸显示（竖版 297/210）',
      { got: pageRatio.toFixed(3), w: studio.canvasW, h: studio.canvasH })
    // 页面上必须真的画出 2×5 = 10 个格子，且每格是成品比例
    ok(studio.cellCount === 10, '画布上画出 2 列 × 5 行 = 10 个格子', studio.cellCount)
    const cellRatio = studio.cellW ? studio.cellH / studio.cellW : 0
    ok(Math.abs(cellRatio - ITEM_H / ITEM_W) < 0.05,
      `每格为成品比例（${ITEM_H}/${ITEM_W} ≈ ${(ITEM_H / ITEM_W).toFixed(3)}）`, { got: cellRatio.toFixed(3) })
    ok(studio.fieldBoxes === 10, '字段在每格同步渲染（10 处）', studio.fieldBoxes)

    const gridLine = studio.warns.find((t) => t.includes('多联版式')) || ''
    ok(gridLine.includes('2 列 × 5 行'), '版式摘要算出 2 列 × 5 行', gridLine)
    ok(gridLine.includes('每页 10 个'), '版式摘要给出每页数量', gridLine)
    ok(gridLine.includes(`${ITEM_W}×${ITEM_H}mm`), '版式摘要标明成品尺寸', gridLine)

    // ---- 打印中心：预览页数按每页格数折算 ----
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='打印中心')?.click()`)
    await sleep(800)
    await evalJs(`document.querySelector('.toolbar .custom-select .cs-trigger')?.click()`)
    await sleep(400)
    await evalJs(`document.querySelector('.cs-menu .cs-option')?.click()`)
    await sleep(2500)

    const preview = (await evalJs(
      `(function(){
        const meta = document.querySelector('.preview-meta');
        const frame = document.querySelector('.preview-frame');
        return {
          meta: meta ? meta.textContent.replace(/\\s+/g,' ').trim() : '',
          frameH: frame ? Math.round(parseFloat(frame.style.height) || 0) : 0,
        };
      })()`)).value

    ok(preview.meta.includes('1 页'), '10 条记录在 2×5 多联下 → 1 页', preview.meta)
    ok(preview.meta.includes('10 条') && preview.meta.includes('每页 2×5'), '预览标注每页格数', preview.meta)
    ok(preview.meta.includes('A4 竖版'), '纸张识别为竖版（pageSpec 修复生效）', preview.meta)
    // 预览 iframe 高度应等于 1 页纸高（≈1123px），而非 10 页
    ok(preview.frameH > 900 && preview.frameH < 1400, '预览 iframe 高度按页数而非记录数', preview.frameH)
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
    rmDeep(DATA)
  }
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1) })

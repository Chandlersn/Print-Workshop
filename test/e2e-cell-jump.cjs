/**
 * E2E：去补录直达全流程（隔离数据目录，不碰用户数据）。
 * 种一个含空值的数据集 + 绑定模板 → 打印中心导出 → 校验弹窗出现行号 chip
 * → 点击 chip → 数据页对应单元格聚焦编辑 + 闪烁。
 * 运行：node test/e2e-cell-jump.cjs （需先出包 release/win-unpacked 或 PRINTPRESS_EXE 指定）
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')

const ROOT = path.join(__dirname, '..')
// 打包目录不固定（换目录避开占用时会产生 release-024 之类），按候选列表取第一个存在的
const EXE_CANDIDATES = [
  process.env.PRINTPRESS_EXE,
  path.join(ROOT, 'release', 'win-unpacked', '批印坊.exe'),
  path.join(ROOT, 'release-024', 'win-unpacked', '批印坊.exe'),
].filter(Boolean)
const EXE = EXE_CANDIDATES.find((p) => fs.existsSync(p)) || EXE_CANDIDATES[1]
const PORT = 9470
const DATA = path.join(__dirname, '.tmp-data-jump')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + label) }
  else { fail += 1; console.error('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

// ---- 种数据：12 行，奖项列在 rowIndex 2 与 5 为空 ----
function seed() {
  rmDeep(DATA)
  fs.mkdirSync(DATA, { recursive: true })
  const rows = Array.from({ length: 12 }, (_, i) => ({
    姓名: '选手' + (i + 1),
    奖项: i === 2 || i === 5 ? '' : (i % 2 ? '金奖' : '银奖'),
  }))
  const datasets = [{
    id: 'ds-jump',
    name: 'e2e-空值表',
    source: { type: 'csv', fileName: 'e2e.csv', importedAt: new Date().toISOString() },
    columns: [
      { key: '姓名', alias: '姓名', type: 'text', avgLen: 3, filled: 12, printOn: true },
      { key: '奖项', alias: '奖项', type: 'text', avgLen: 2, filled: 10, printOn: true },
    ],
    rows,
  }]
  const templates = [{
    id: 'tpl-jump',
    name: 'e2e-空值模板',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    background: 'e2e-bg.png', // 只需 truthy，文件不存在不影响校验流
    bgSize: { width: 794, height: 1123 },
    datasetId: 'ds-jump',
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 30, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
      { column: '奖项', label: '奖项', x: 50, y: 60, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]
  fs.writeFileSync(path.join(DATA, 'datasets.json'), JSON.stringify(datasets))
  fs.writeFileSync(path.join(DATA, 'templates.json'), JSON.stringify(templates))
  // 阻止首启种子：目录全新时 seedIfFirstRun 会种入示例数据，干扰确定性断言。
  // 必须写 seedVersion —— ver = seedVersion || (demoSeeded ? 1 : 0)，
  // 只写 demoSeeded 会被判成 ver=1 而走「迁移」分支，照样种进示例数据。
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
    await sleep(1500) // 等首屏渲染

    // 1. 打印中心：选模板（种子模板应为下拉唯一项）→ 导出 PDF → 校验弹窗
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='打印中心')?.click()`)
    await sleep(800)
    await evalJs(`document.querySelector('.toolbar .custom-select .cs-trigger')?.click()`)
    await sleep(400)
    // 按名字选，不取第一个：模板按最近编辑置序，种子模板可能排在夹具前面
    await evalJs(`[...document.querySelectorAll('.cs-menu .cs-option')].find(e=>e.textContent.includes('e2e-空值模板'))?.click()`)
    await sleep(2500) // 等预览渲染
    await evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='导出 PDF')?.click()`)
    await sleep(1500)

    const modal = (await evalJs(
      `(function(){const chips=[...document.querySelectorAll('.fix-chip')];return {
        open: !!document.querySelector('.modal'),
        chipTexts: chips.map((c)=>c.textContent.trim()),
        missingBlocked: document.body.textContent.includes('字段缺失'),
      }})()`)).value
    ok(modal.open, '校验弹窗出现（数据含空值）', modal)
    ok(modal.chipTexts.includes('第 3 行') && modal.chipTexts.includes('第 6 行'),
      '行号 chip 精确到空值行（0 基 2/5 → 显示 3/6）', modal.chipTexts)

    // 2. 点第一个 chip → 数据页对应单元格聚焦编辑 + 闪烁
    await evalJs(`document.querySelector('.fix-chip')?.click()`)
    await sleep(1800)
    const jump = (await evalJs(
      `(function(){const editing=document.querySelector('.cell-input');const flash=document.querySelector('td.cell.flash');
        return {
          onDataset: document.body.textContent.includes('数据表格'),
          activeDs: document.querySelector('.detail-title')?.textContent.trim()||'',
          editing,
          editingValue: editing?editing.value:null,
          flash: !!flash,
          flashRow: flash?flash.getAttribute('data-ri'):null,
          flashCol: flash?flash.getAttribute('data-ck'):null,
        }})()`)).value
    ok(jump.onDataset, '自动切到数据页', jump)
    ok(jump.activeDs.includes('e2e-空值表'), '自动选中目标数据集', jump.activeDs)
    ok(jump.editing, '目标单元格直接进入编辑态', jump)
    ok(jump.editingValue === '', '编辑框为空值待补', jump.editingValue)
    ok(jump.flash, '目标格闪烁提示', jump)
    ok(jump.flashRow === '2' && jump.flashCol === '奖项', '闪烁定位在 rowIndex=2 的奖项列', jump)
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
  }
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1) })

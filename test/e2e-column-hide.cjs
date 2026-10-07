/**
 * E2E：数据页列显隐全链（隔离数据目录，不碰用户数据）。
 *
 * 种子：4 列 × 6 行（「奖项」第 3 行留空），一个绑定该数据集的模板。
 * 验证：列头「▾」隐藏一列 → 工具栏出现「已隐藏 N 列」胶囊 →
 *       **改字号不冲掉隐藏状态**（这是加字段时最容易踩的那个坑）→
 *       切页再回来仍隐藏（持久化）→ 胶囊里勾回来 → 「只看此列」→
 *       藏到只剩一列被拦住 → **补录跳转撞上隐藏列会自动展开** →
 *       全程 datasets.json 里的「印」标记一个没动。
 *
 * 关键交互一律走**真鼠标**（`Input.dispatchMouseEvent`）：入口是 hover 才显形的，
 * `el.click()` 会绕过指针命中测试与遮罩，验不出「用户点不点得到」。
 *
 * 运行：node test/e2e-column-hide.cjs（跑源码版，需先 npm run build）
 */
// 用 node 运行（不是 electron）：本脚本只负责 spawn 应用 + 走 CDP，
// 依赖 Node 的全局 WebSocket（Electron 28 内置的 Node 18 没有）。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9474
const DATA = path.join(__dirname, '.tmp-data-colhide')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + label) }
  else { fail += 1; console.error('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')) }
}

const DS_ID = 'ds-hide'
const DS_NAME = 'e2e-列显隐表'

function seed() {
  rmDeep(DATA)
  fs.mkdirSync(DATA, { recursive: true })
  const rows = Array.from({ length: 6 }, (_, i) => ({
    姓名: '选手' + (i + 1),
    单位: '单位' + (i + 1),
    // rowIndex 2 留空：用来触发打印前校验，从而拿到「第 3 行」的补录 chip
    奖项: i === 2 ? '' : (i % 2 ? '金奖' : '银奖'),
    备注: '',
  }))
  const datasets = [{
    id: DS_ID,
    name: DS_NAME,
    source: { type: 'csv', fileName: 'e2e.csv', importedAt: new Date().toISOString() },
    columns: [
      { key: '姓名', alias: '姓名', type: 'text', avgLen: 3, filled: 6, printOn: true },
      { key: '单位', alias: '单位', type: 'text', avgLen: 3, filled: 6, printOn: false },
      { key: '奖项', alias: '奖项', type: 'text', avgLen: 2, filled: 5, printOn: true },
      { key: '备注', alias: '备注', type: 'text', avgLen: 0, filled: 0, printOn: false },
    ],
    rows,
  }]
  const templates = [{
    id: 'tpl-hide',
    name: 'e2e-列显隐模板',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    background: 'e2e-bg.png', // 只需 truthy，文件不存在不影响校验流
    bgSize: { width: 794, height: 1123 },
    datasetId: DS_ID,
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 30, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
      { column: '奖项', label: '奖项', x: 50, y: 60, fontSize: 24, color: '#000', align: 'center', fontFamily: '', bold: false },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]
  fs.writeFileSync(path.join(DATA, 'datasets.json'), JSON.stringify(datasets))
  fs.writeFileSync(path.join(DATA, 'templates.json'), JSON.stringify(templates))
  // 阻止首启种子（必须写 seedVersion，只写 demoSeeded 会被判成 ver=1 走迁移分支）。
  // onboarded 也必须写：不写会弹首启引导，遮罩盖住整页——
  // 程序化 click() 能穿透它，真实鼠标点不到，本套件偏偏要用真鼠标验 hover。
  fs.writeFileSync(path.join(DATA, 'settings.json'),
    JSON.stringify({ demoSeeded: true, seedVersion: 2, onboarded: true }))
}

const prefs = () => {
  const fp = path.join(DATA, 'display-settings.json')
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch { return 'CORRUPT' }
}

const dsOnDisk = () =>
  JSON.parse(fs.readFileSync(path.join(DATA, 'datasets.json'), 'utf-8')).find((d) => d.id === DS_ID)

const printOnOf = (key) => {
  const c = dsOnDisk().columns.find((x) => x.key === key)
  return c ? c.printOn === true : null
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
    async function cdp(method, params) {
      const id = ++msgId
      const p = new Promise((res) => pending.set(id, res))
      ws.send(JSON.stringify({ id, method, params }))
      return p
    }
    async function evalJs(expr) {
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result ? r.result.result : null
    }
    const val = async (expr) => (await evalJs(expr)).value
    // 真鼠标：本套件的入口是「hover 才显形」的按钮，程序化 click() 绕过了
    // 指针事件与遮罩，验不出「用户够不够得着」，所以关键两步用真实输入事件走
    const moveTo = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    const realClick = async (x, y) => {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
    }

    // CDP 连得上 ≠ Vue 挂载完：轮询等导航项出现（顶栏共 3 项：数据 / 模板 / 打印中心）
    let navReady = 0
    for (let i = 0; i < 30; i++) {
      await sleep(300)
      navReady = await val(`document.querySelectorAll('.nav-item').length`)
      if (navReady >= 3) break
    }
    ok(navReady >= 3, '界面挂载完成（导航项就位）', navReady)

    const gotoDataset = async () => {
      await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='数据')?.click()`)
      await sleep(700)
      await evalJs(`[...document.querySelectorAll('.ds-item')].find(e=>e.textContent.includes(${JSON.stringify(DS_NAME)}))?.click()`)
      await sleep(900)
    }

    /** 表头 / 表体 / 胶囊 / 菜单 的一次性快照 */
    const SNAP = `(function(){
      const heads=[...document.querySelectorAll('.col-head')];
      const pill=document.querySelector('.hidden-pill');
      const first=document.querySelector('tbody tr');
      return {
        cols: heads.map(e=>e.textContent.replace(/[印▾\\s]/g,'')),
        thCount: document.querySelectorAll('thead th').length,
        tdCount: first ? first.querySelectorAll('td').length : 0,
        pill: pill ? pill.textContent.replace(/\\s+/g,' ').trim() : '',
        menuOpen: !!document.querySelector('.col-menu'),
        menuItems: [...document.querySelectorAll('.col-menu .cm-item')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()),
        menuHint: [...document.querySelectorAll('.col-menu .cm-hint')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()),
        checks: [...document.querySelectorAll('.col-menu .cm-check')].map(e=>({
          name: e.querySelector('.cm-check-label').textContent.trim(),
          checked: e.querySelector('input').checked,
          disabled: e.querySelector('input').disabled,
        })),
      };
    })()`

    /** 真鼠标点：sel 选元素，可选按文案匹配（默认全等，opts.contains 用包含） */
    const clickReal = async (sel, text, opts) => {
      const g = await val(`(function(){
        const list=[...document.querySelectorAll(${JSON.stringify(sel)})];
        const t=${JSON.stringify(text === undefined ? null : text)};
        const inc=${opts && opts.contains ? 'true' : 'false'};
        const e = t === null ? list[0]
          : list.find(x => inc ? x.textContent.includes(t) : x.textContent.trim() === t);
        if(!e) return null;
        const r=e.getBoundingClientRect();
        return { x:r.left+r.width/2, y:r.top+r.height/2, text:e.textContent.trim().slice(0, 60) };
      })()`)
      if (!g) return false
      await moveTo(g.x, g.y)
      await sleep(80)
      await realClick(g.x, g.y)
      return true
    }

    const colBtnGeom = (alias) => val(`(function(){
      const th=[...document.querySelectorAll('.col-head')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(alias)}));
      if(!th) return null;
      const btn=th.querySelector('.col-menu-btn');
      const r=btn.getBoundingClientRect();
      const t=th.getBoundingClientRect();
      return { thX:t.left+t.width/2, thY:t.top+t.height/2, x:r.left+r.width/2, y:r.top+r.height/2,
               opacity:getComputedStyle(btn).opacity };
    })()`)

    /** 真鼠标点列头「▾」：先把指针挪开量一次透明度，再 hover 列头、点按钮 */
    const clickColMenu = async (alias) => {
      await moveTo(10, 400)
      await sleep(150)
      const rest = await colBtnGeom(alias)
      if (!rest) return null
      await moveTo(rest.thX, rest.thY)
      await sleep(180)
      const hot = await colBtnGeom(alias)
      await moveTo(hot.x, hot.y)
      await sleep(120)
      await realClick(hot.x, hot.y)
      return { restOpacity: rest.opacity, hoverOpacity: hot.opacity }
    }

    const clickMenuItem = async (text) => {
      const g = await val(`(function(){
        const b=[...document.querySelectorAll('.col-menu .cm-item')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}));
        if(!b) return { state:'missing' };
        const r=b.getBoundingClientRect();
        return { state: b.disabled ? 'disabled' : 'ok', x:r.left+r.width/2, y:r.top+r.height/2 };
      })()`)
      if (!g || g.state === 'missing') return 'missing'
      if (g.state === 'disabled') return 'disabled'
      await moveTo(g.x, g.y)
      await sleep(80)
      await realClick(g.x, g.y)
      return true
    }

    // ---- 1. 初始：4 列全可见 ----
    await gotoDataset()
    let s = await val(SNAP)
    ok(s.cols.length === 4, '初始 4 列全可见', s.cols)
    ok(s.thCount === 6, '表头是「# + 4 列 + 操作」', s.thCount)
    ok(s.tdCount === 6, '表体同步（4 列数据 + 序号 + 操作）', s.tdCount)
    ok(s.pill === '', '没有隐藏列时不出现胶囊', s.pill)

    // ---- 2. 列头「▾」打开菜单（真鼠标） ----
    ok(await val(`!!document.querySelector('.col-head .col-menu-btn')`), '列头有「▾」入口')
    const opened = await clickColMenu('奖项')
    await sleep(250)
    s = await val(SNAP)
    ok(opened && s.menuOpen, '真鼠标点「奖项」的「▾」弹出菜单', opened)
    ok(opened && opened.restOpacity === '0' && Number(opened.hoverOpacity) > 0,
      '「▾」平时隐身、hover 才显形（真鼠标量出来的透明度）', opened)
    ok(s.menuItems.includes('隐藏此列') && s.menuItems.includes('只看此列'),
      '菜单含「隐藏此列 / 只看此列」', s.menuItems)
    ok(s.menuHint.some((t) => t.includes('仅隐藏显示，不影响')), '菜单里写明不影响打印', s.menuHint)

    // ---- 3. 隐藏「奖项」 ----
    ok((await clickMenuItem('隐藏此列')) === true, '点「隐藏此列」')
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 3 && !s.cols.includes('奖项'), '「奖项」从表格消失', s.cols)
    ok(s.tdCount === 5, '表体也少了一列（不是只藏表头）', s.tdCount)
    ok(s.pill.includes('已隐藏 1 列'), '工具栏出现「已隐藏 1 列」胶囊', s.pill)
    ok(!s.menuOpen, '选完自动收起菜单')

    // ---- 4. 关键回归：改字号不许把隐藏状态冲掉 ----
    // display-settings 原先是 { tableSize: v } 单字段覆写，加 hiddenColumns 后
    // 用户点一次字号就会静默清空隐藏状态。这里真机验一遍。
    ok(await clickReal('.size-item', '大'), '真鼠标点字号「大」')
    await sleep(600)
    const p1 = prefs()
    ok(p1 && p1.tableSize === 'l', '字号已存盘（大）', p1 && p1.tableSize)
    ok(p1 && p1.hiddenColumns && p1.hiddenColumns[DS_ID]
      && p1.hiddenColumns[DS_ID].includes('奖项'),
      '**改字号之后隐藏状态仍在盘上**（单字段覆写的老写法会把它清掉）', p1 && p1.hiddenColumns)
    s = await val(SNAP)
    ok(s.cols.length === 3 && s.pill.includes('已隐藏 1 列'), '界面上也还在隐藏', s.cols)

    // ---- 5. 切页再回来：持久化生效 ----
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='模板')?.click()`)
    await sleep(700)
    await gotoDataset()
    s = await val(SNAP)
    ok(s.cols.length === 3 && !s.cols.includes('奖项'), '切页回来后仍隐藏（重新挂载读了落盘值）', s.cols)
    ok(s.pill.includes('已隐藏 1 列'), '胶囊也恢复了', s.pill)

    // ---- 6. 胶囊里的复选框：唯一的回头路 ----
    await clickReal('.hidden-pill')
    await sleep(250)
    s = await val(SNAP)
    ok(s.checks.length === 4, '胶囊里列出全部 4 列', s.checks)
    const award = s.checks.find((c) => c.name === '奖项')
    ok(award && award.checked === false, '「奖项」显示为未勾选', award)
    ok(s.checks.filter((c) => c.checked).length === 3, '其余三列勾着', s.checks)
    ok(s.checks.find((c) => c.name === '备注')?.disabled === false,
      '还有别的可见列时，勾掉这一列是允许的')

    // 勾回来（真鼠标点复选框）
    const chk = await val(`(function(){
      const row=[...document.querySelectorAll('.col-menu .cm-check')].find(e=>e.querySelector('.cm-check-label').textContent.trim()==='奖项');
      if(!row) return null;
      const r=row.querySelector('input').getBoundingClientRect();
      return { x:r.left+r.width/2, y:r.top+r.height/2 };
    })()`)
    ok(chk, '找到「奖项」那一行的复选框')
    await moveTo(chk.x, chk.y)
    await sleep(80)
    await realClick(chk.x, chk.y)
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 4 && s.cols.includes('奖项'), '勾回来后列回来了', s.cols)
    ok(s.pill === '', '没有隐藏列了，胶囊随之消失', s.pill)

    // ---- 7. 只看此列 ----
    await clickColMenu('单位')
    await sleep(250)
    ok((await clickMenuItem('只看此列')) === true, '点「只看此列」')
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 1 && s.cols[0] === '单位', '只剩「单位」一列', s.cols)
    ok(s.pill.includes('已隐藏 3 列'), '胶囊如实报 3 列', s.pill)

    // 恢复全部
    await clickReal('.hidden-pill')
    await sleep(250)
    ok((await clickMenuItem('全部显示')) === true, '点「全部显示」')
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 4, '四列全回来了', s.cols)
    ok(prefs() && !(prefs().hiddenColumns && prefs().hiddenColumns[DS_ID]),
      '全部恢复后盘上不留空数组', prefs() && prefs().hiddenColumns)

    // ---- 8. 藏到只剩一列必须被拦住 ----
    for (const name of ['单位', '奖项', '备注']) {
      await clickColMenu(name)
      await sleep(200)
      await clickMenuItem('隐藏此列')
      await sleep(300)
    }
    s = await val(SNAP)
    ok(s.cols.length === 1 && s.cols[0] === '姓名', '藏到只剩「姓名」一列', s.cols)
    await clickColMenu('姓名')
    await sleep(250)
    const lastTry = await clickMenuItem('隐藏此列')
    s = await val(SNAP)
    ok(lastTry === 'disabled', '最后一列的「隐藏此列」是禁用的', lastTry)
    ok(s.menuItems.includes('隐藏此列'), '菜单还在（只是这一项不可点）', s.menuItems)
    ok((await val(`document.querySelectorAll('.col-head').length`)) === 1, '列数没被减到 0')
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
    await sleep(200)
    ok((await val(`!!document.querySelector('.col-menu')`)) === false, 'Esc 收起菜单')

    // ---- 9. 补录跳转撞上隐藏列：必须自动展开，否则跳过来只看到一片空白 ----
    // 先把列恢复齐（上一节藏到了只剩一列）
    await clickReal('.hidden-pill')
    await sleep(250)
    await clickMenuItem('全部显示')
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 4, '先把四列恢复齐', s.cols)

    // 再藏掉「奖项」，从打印中心点「第 3 行」的补录 chip 跳回来
    await clickColMenu('奖项')
    await sleep(250)
    ok((await clickMenuItem('隐藏此列')) === true, '先藏掉「奖项」')
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 3 && !s.cols.includes('奖项'), '「奖项」已藏', s.cols)

    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='打印中心')?.click()`)
    let pcReady = false
    for (let i = 0; i < 20 && !pcReady; i++) {
      await sleep(300)
      pcReady = await val(`!!document.querySelector('.toolbar .custom-select .cs-trigger')`)
    }
    ok(pcReady, '打印中心工具栏就位')
    await clickReal('.toolbar .custom-select .cs-trigger')
    await sleep(400)
    // 选项文案带后缀（模板名 · 数据集名），所以用包含匹配
    const opts = await val(`[...document.querySelectorAll('.cs-menu .cs-option')].map(e=>e.textContent.trim())`)
    ok(opts.some((t) => t.includes('e2e-列显隐模板')), '模板下拉里有夹具模板', opts)
    ok(await clickReal('.cs-menu .cs-option', 'e2e-列显隐模板', { contains: true }), '选中夹具模板')
    await sleep(2500)
    ok(await clickReal('button', '导出 PDF'), '点「导出 PDF」触发打印前校验')
    await sleep(1500)
    const modal = await val(`(function(){
      return { open: !!document.querySelector('.modal'),
               chips: [...document.querySelectorAll('.fix-chip')].map(c=>c.textContent.trim()) };
    })()`)
    ok(modal.open, '校验弹窗出现（「奖项」第 3 行是空值）', modal)
    ok(modal.chips.includes('第 3 行'), '行号 chip 指向第 3 行', modal.chips)

    ok(await clickReal('.fix-chip'), '点补录 chip')
    await sleep(2000)
    const jump = await val(`(function(){
      const editing=document.querySelector('.cell-input');
      const flash=document.querySelector('td.cell.flash');
      const pill=document.querySelector('.hidden-pill');
      return {
        onDataset: document.body.textContent.includes('数据表格'),
        cols: [...document.querySelectorAll('.col-head')].map(e=>e.textContent.replace(/[印▾\\s]/g,'')),
        editing: !!editing,
        flashCol: flash ? flash.getAttribute('data-ck') : null,
        pill: pill ? pill.textContent.replace(/\\s+/g,' ').trim() : '',
      };
    })()`)
    ok(jump.onDataset, '自动切回数据页', jump)
    ok(jump.cols.includes('奖项'), '**被藏的那一列自动展开了**（否则用户看到的是一片空白）', jump.cols)
    ok(jump.pill === '', '自动展开后胶囊也随之消失', jump.pill)
    ok(jump.editing, '目标格直接进入编辑态', jump)
    ok(jump.flashCol === '奖项', '闪烁定位在「奖项」列', jump)

    // ---- 10. 全程「印」一个都没动 ----
    ok(printOnOf('姓名') === true, '「姓名」的印仍开着（藏过又展开，没被顺手取消）')
    ok(printOnOf('奖项') === true, '「奖项」的印仍开着（隐藏列 ≠ 取消印）')
    ok(printOnOf('单位') === false && printOnOf('备注') === false,
      '原本没开的列也没被打开')

    // ---- 11. 收尾：恢复后不该有空表 ----
    await clickReal('.hidden-pill')
    await sleep(250)
    await clickMenuItem('全部显示')
    await sleep(400)
    s = await val(SNAP)
    ok(s.cols.length === 4 && s.pill === '', '收尾：四列全可见、胶囊消失', s)
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
    rmDeep(DATA)
  }
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1) })

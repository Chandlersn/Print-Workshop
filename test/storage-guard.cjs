/**
 * 存储安全边界验收：路径穿越拦截、JSON 损坏兜底、数值钳制、属性消毒。
 * 这些场景在原有 12 个套件里一条都没覆盖——出问题时是静默的（删错文件/读出目录外/数据被清空），
 * 所以单独成套，随每次改动回归。
 *
 * 运行：node test/storage-guard.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { rmDeep } = require('./helpers/rm.cjs')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}
function throws(fn, label) {
  try { fn() } catch { pass++; console.log(`  ok - ${label}`); return true }
  fail++; console.error(`  FAIL - ${label}（未抛错）`)
  return false
}

// 数据目录放在临时根的 data 子目录：这样 ../ 能跳到「目录外」，便于验证拦截
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-guard-'))
const DATA = path.join(ROOT, 'data')
fs.mkdirSync(DATA, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = DATA

// 必须在设好 PRINTPRESS_DATA_DIR 之后再 require（各模块在加载时读该值）
const store = require('../electron/store.cjs')
const dataset = require('../electron/dataset.cjs')
const templates = require('../electron/templates.cjs')
const printDomain = require('../electron/print.cjs')
const engine = require('../electron/render-engine.cjs')

function makeDataset(name = '名单.csv', rows = '姓名\n张三\n李四\n') {
  const fp = path.join(DATA, name)
  fs.writeFileSync(fp, rows, 'utf-8')
  const ds = dataset.importFromFile(fp)
  dataset.setColumnPrint(ds.id, '姓名', true)
  return ds
}

console.log('== 1. 存储路径守卫（穿越拦截） ==')
{
  const inside = store.resolveInsideDataDir('print-bg/bg.png')
  ok(inside === path.join(DATA, 'print-bg', 'bg.png') || inside === path.join(DATA, 'print-bg\\bg.png'),
    '目录内相对路径正常解析', inside)

  throws(() => store.resolveInsideDataDir('../victim.txt'), '拒绝 ../ 越界')
  throws(() => store.resolveInsideDataDir('a/../../victim.txt'), '拒绝嵌套 ../ 越界')
  throws(() => store.resolveInsideDataDir('..\\victim.txt'), '拒绝 Windows 反斜杠越界')
  throws(() => store.resolveInsideDataDir('C:/Windows/win.ini'), '拒绝绝对盘符路径')
  throws(() => store.resolveInsideDataDir('\\\\server\\share\\x'), '拒绝 UNC 路径')
  throws(() => store.resolveInsideDataDir(''), '拒绝空字符串')
  throws(() => store.resolveInsideDataDir(null), '拒绝 null')
  throws(() => store.resolveInsideDataDir(123), '拒绝非字符串')

  // 同名子目录不能被当成越界（Windows 上 DATA/x 与 DATA 本身同名目录易误判）
  const sub = path.join(DATA, 'sub')
  fs.mkdirSync(sub, { recursive: true })
  ok(store.resolveInsideDataDir('sub').startsWith(path.resolve(DATA)), '子目录不算越界')
}

console.log('== 2. 删除模板不得删到数据目录外 ==')
{
  const ds = makeDataset()
  const victim = path.join(ROOT, 'victim.txt')
  fs.writeFileSync(victim, 'IMPORTANT', 'utf-8')
  const tpl = templates.saveTemplate({
    name: '穿越模板', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    background: '../victim.txt',
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  const html = engine.buildHtml(tpl, [{ 姓名: '张三' }], { withToolbar: false })
  ok(!html.includes(Buffer.from('IMPORTANT').toString('base64')),
    '渲染 HTML 不内联数据目录外的文件')
  templates.deleteTemplate(tpl.id)
  ok(fs.existsSync(victim), 'background 为 ../ 时目录外文件未被删除')
  ok(!templates.listTemplates().some((t) => t.id === tpl.id), '模板记录本身仍被删除（元数据清理不受阻）')
}

console.log('== 3. 快照路径守卫 ==')
{
  const secret = path.join(ROOT, 'secret.txt')
  fs.writeFileSync(secret, 'TOP SECRET', 'utf-8')
  const jobs = [{
    id: 'job_evil', templateId: 'tpl_x', datasetId: 'ds_x', mode: 'pdf', status: 'ok',
    createdAt: new Date().toISOString(), recordCount: 1, pageCount: 1,
    snapshot: '../secret.txt', totalRows: 1,
  }]
  store.saveJson('print-jobs', jobs)
  throws(() => printDomain.resolveSnapshot('job_evil'), 'resolveSnapshot 拒绝越界路径')
  // 删除时同样不得递归删到目录外
  const victimDir = path.join(ROOT, 'victim-dir')
  fs.mkdirSync(victimDir, { recursive: true })
  fs.writeFileSync(path.join(victimDir, 'x.txt'), 'x', 'utf-8')
  store.saveJson('print-jobs', [{
    id: 'job_evil2', templateId: 'tpl_x', datasetId: 'ds_x', mode: 'pdf', status: 'ok',
    createdAt: new Date().toISOString(), recordCount: 1, pageCount: 1,
    snapshot: '../victim-dir/snapshot.html', totalRows: 1,
  }])
  printDomain.deleteJob('job_evil2')
  ok(fs.existsSync(path.join(victimDir, 'x.txt')), 'deleteJob 未递归删除目录外目录')
  ok(!printDomain.listJobs().some((j) => j.id === 'job_evil2'), '越界 job 的元数据仍被删除')
}

console.log('== 4. JSON 损坏 / null 兜底 ==')
{
  const tplJson = path.join(DATA, 'templates.json')
  const tplBak = path.join(DATA, 'templates.json.bak')
  const jobsJson = path.join(DATA, 'print-jobs.json')
  // 每个子场景都先把 .bak 清掉：否则「有备份就恢复」会盖掉「无备份应抛错」的判定
  const reset = () => {
    for (const f of fs.readdirSync(DATA)) {
      if (/^templates\.json(\.|$)/.test(f) || /^print-jobs\.json(\.|$)/.test(f)) fs.unlinkSync(path.join(DATA, f))
    }
  }

  // 场景 A：无 .bak + 内容为 null → 必须抛错，且留存原文件（宁可报错也不静默清空用户数据）
  reset()
  fs.writeFileSync(tplJson, 'null', 'utf-8')
  throws(() => templates.listTemplates(), 'templates.json 为 null 且无备份 → 抛错')
  const corruptFiles = fs.readdirSync(DATA).filter((f) => f.includes('.corrupt-'))
  ok(corruptFiles.length === 1, '损坏文件被留存为 .corrupt-<ts>', fs.readdirSync(DATA))
  ok(!fs.existsSync(tplJson), '原路径已腾空（不覆盖留存件）')

  // 场景 B：无 .bak + JSON 语法破损 → 同样抛错
  reset()
  fs.writeFileSync(tplJson, '[broken', 'utf-8')
  throws(() => templates.listTemplates(), 'JSON 语法破损且无备份 → 抛错')

  // 场景 C：内容为 null 但有可用 .bak → 静默恢复，用户无感
  // .bak 只在「已有旧文件」时才产生（saveJson 备份的是上一版），所以要写两次
  reset()
  store.saveJson('templates', [{ id: 'tpl_old', name: '上一版' }])       // 首次写入：建立主文件
  store.saveJson('templates', [{ id: 'tpl_bak', name: '备份里的模板' }])  // 二次写入：.bak 留住上一版
  ok(fs.existsSync(tplBak), '二次写入后 .bak 存在（备份的是上一版而非新版）')
  fs.writeFileSync(tplJson, 'null', 'utf-8')
  const recovered = templates.listTemplates()
  ok(Array.isArray(recovered) && recovered[0] && recovered[0].id === 'tpl_old',
    '内容损坏时回退到上一版（.bak 存的是上一版，不是最新那次）', recovered && recovered.map((t) => t.id))
  ok(Array.isArray(JSON.parse(fs.readFileSync(tplJson, 'utf-8'))),
    '恢复结果已写回主文件（下次启动不再撞同一处损坏）')

  // 场景 D：.bak 本身也是坏的 → 不能拿它顶包，必须抛错
  reset()
  fs.writeFileSync(tplJson, 'null', 'utf-8')
  fs.writeFileSync(tplBak, '{ also broken', 'utf-8')
  throws(() => templates.listTemplates(), '.bak 同样损坏 → 抛错而非顶包')

  // 场景 E：类型错配（期望数组读到对象）→ 按损坏处理
  reset()
  fs.writeFileSync(jobsJson, '{"not":"array"}', 'utf-8')
  throws(() => printDomain.listJobs(), '期望数组但读到对象 → 抛错')

  // 场景 F：文件不存在 → 返回 null，上层按首次运行处理
  reset()
  ok(store.loadJson('never-existed-store') === null, '不存在的库返回 null（首次运行）')
}

console.log('== 5. 数值钳制 ==')
{
  const tiny = engine.resolveLayout({ mode: 'grid', itemW: 0.001, itemH: 0.001 }, { w: 210, h: 297 })
  ok(tiny.enabled === false, '成品尺寸过小不再产生天文数字版式', tiny)
  ok(typeof tiny.reason === 'string' && tiny.reason.length > 0, '回退必须带 reason 供界面提示')

  const big = engine.resolveLayout({ mode: 'grid', itemW: 1, itemH: 1 }, { w: 210, h: 297 })
  ok(big.enabled === false || big.perPage <= 400, '每页格数有上限', big.perPage)

  // 既有边界不得被改坏
  ok(engine.resolveLayout({ mode: 'grid', itemW: 0, itemH: 0 }, { w: 210, h: 297 }).enabled === false, '尺寸 0 仍回退')
  ok(engine.resolveLayout({ mode: 'grid', itemW: 'abc', itemH: null }, { w: 210, h: 297 }).enabled === false, 'NaN 仍回退')
  const normal = engine.resolveLayout({ mode: 'grid', itemW: 85, itemH: 54 }, { w: 210, h: 297 })
  ok(normal.enabled === true && normal.cols === 2 && normal.rows === 5, '正常多联不受钳制影响', normal)
  const one = engine.resolveLayout({ mode: 'grid', itemW: 200, itemH: 200 }, { w: 210, h: 297 })
  ok(one.enabled === false && /放不下/.test(one.reason || ''), '放不下 2 个仍按原语义回退')

  ok(!engine.fieldStyle({ x: 999, y: -50 }).includes('999'), '越界坐标被钳制', engine.fieldStyle({ x: 999, y: -50 }))
  ok(engine.fieldStyle({ fontSize: 100000 }).includes('font-size:500pt'), '超大字号被钳到上限', engine.fieldStyle({ fontSize: 100000 }))
}

console.log('== 6. 样式属性消毒 ==')
{
  // color 含双引号即可闭合 style 属性、注入任意标签
  const evil = engine.fieldStyle({ x: 50, y: 50, color: 'red" onmouseover="alert(1)', fontSize: 12 })
  ok(!evil.includes('"'), '注入用的双引号被剔除', evil)
  ok(!/onmouseover/i.test(evil), '注入的事件属性未进入输出', evil)
  const evilFam = engine.fieldStyle({ x: 50, y: 50, fontFamily: "x';background:url(javascript:alert(1));" })
  ok(!evilFam.includes(';background'), 'fontFamily 里的 CSS 语法字符被剔除', evilFam)
  const evilAlign = engine.fieldStyle({ x: 50, y: 50, align: 'center" onload="x' })
  ok(!evilAlign.includes('"'), '非法 align 值不进入输出', evilAlign)

  // 合法值必须原样保留（不能矫枉过正）
  ok(engine.fieldStyle({ color: '#c0392b' }).includes('color:#c0392b;'), '合法颜色保留')
  ok(engine.fieldStyle({ color: '#ABC' }).includes('color:#ABC;'), '三位十六进制保留')
  ok(engine.fieldStyle({ fontFamily: '楷体' }).includes("font-family:'楷体';"), '合法字体名保留')
  ok(engine.fieldStyle({ x: 50, y: 40, align: 'center' }).includes('transform:translateX(-50%);'), '居中 translate 保留')
  ok(engine.fieldStyle({ x: 50, y: 40, align: 'right' }).includes('transform:translateX(-100%);'), '右对齐 translate 保留')
  ok(engine.fieldStyle({ x: 50, y: 40, align: 'left' }).includes('text-align:left;'), '左对齐保留')
}

console.log('== 7. 版式回退原因必须能传到界面 ==')
{
  const ds = makeDataset()
  const tpl = templates.saveTemplate({
    name: '放不下的多联', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 200, itemH: 200 },
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  const built = printDomain.buildBatchHtml(ds.id, tpl.id, null)
  // 回退时必须带 mode 与 reason，否则界面无法区分「回退」与「本来就是单页」
  ok(built.layout.enabled === false, '放不下时回退单页')
  ok(typeof built.layout.reason === 'string' && built.layout.reason.length > 0, '回退时 reason 透传给前端', built.layout)
  ok(built.layout.mode === 'grid', '回退时保留原 mode（界面据此提示）', built.layout)
}

console.log('== 8. 留痕上限 ==')
{
  const ds = makeDataset()
  const tpl = templates.saveTemplate({
    name: '留痕上限', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  for (let i = 0; i < 260; i++) {
    printDomain.createJob({
      templateId: tpl.id, datasetId: ds.id, mode: 'pdf', status: 'ok',
      recordCount: 1, pageCount: 1, totalRows: 2,
      scope: { partial: false, selected: 0, total: 2 },
      snapshotHtml: `<html><body>${i}</body></html>`, withSnapshot: false,
    })
  }
  ok(printDomain.listJobs().length <= 200, '留痕条数有上限（防无限膨胀）', printDomain.listJobs().length)
}

rmDeep(ROOT)
console.log(`\n存储安全边界：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

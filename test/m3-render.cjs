/**
 * M3 领域层验收：渲染引擎（对拍 workbench 语义）+ 出口校验 + 留痕归档。
 * 运行：node test/m3-render.cjs
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-m3')

const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const path = require('path')
const assert = require('assert')

const { loadJson, saveJson } = require('../electron/store.cjs')
const engine = require('../electron/render-engine.cjs')
const printDomain = require('../electron/print.cjs')

const DATA = process.env.PRINTPRESS_DATA_DIR
let pass = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ok - ${name}`) } else {
    console.error(`  FAIL - ${name} :: ${JSON.stringify(extra)}`)
    process.exitCode = 1
  }
}

// ---------- 准备：伪造数据目录（上传字体 + 种子数据/模板） ----------
rmDeep(DATA)
fs.mkdirSync(path.join(DATA, 'print-fonts'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'print-fonts/测试楷体.ttf'), 'FAKE_TTF')

const dsRows = [
  { 姓名: '张三', 奖项: '一等奖', 备注: '含<标签>&"引号' },
  { 姓名: '', 奖项: '二等奖', 备注: '' },
  { 姓名: '李四', 奖项: '', 备注: '' },
]
const dsColumns = [
  { key: '姓名', alias: '姓名', type: 'text', filled: 2 },
  { key: '奖项', alias: '奖项', type: 'text', filled: 2 },
  { key: '备注', alias: '备注', type: 'text', filled: 1 },
]
saveJson('datasets', [{
  id: 'ds_test', name: '测试名单.csv', source: { type: 'csv' },
  columns: dsColumns, rows: dsRows,
}])
saveJson('templates', [{
  id: 'tpl_test', name: '测试奖状', pageSize: 'a4-landscape',
  background: 'print-bg/bg.png',
  fields: [
    { column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 24, align: 'center', bold: true, color: '#c0392b' },
    { column: '奖项', label: '奖项', x: 80, y: 60, align: 'right' },
    { column: '备注', label: '备注', x: 10, y: 20, fontFamily: "测试'楷体" },
  ],
}])

// ---------- 1. 转义 ----------
console.log('== 1. HTML 转义 ==')
ok(engine.escapeHtml('a<b>&"c') === 'a&lt;b&gt;&amp;&quot;c', '特殊字符全转义', engine.escapeHtml('a<b>&"c'))
ok(engine.escapeHtml(null) === '', 'null → 空串')

// ---------- 2. 字段样式（对拍 workbench _field_style） ----------
console.log('== 2. 字段样式 ==')
const st = engine.fieldStyle({ x: 50, y: 40, fontSize: 24, align: 'center', bold: true, color: '#c0392b' })
ok(st.includes('left:50%;') && st.includes('top:40%;'), '百分比坐标', st)
ok(st.includes('transform:translateX(-50%);'), '居中 translate 修正')
ok(st.includes('font-size:24pt;') && st.includes('font-weight:bold;'), '字号 pt 与加粗')
const stR = engine.fieldStyle({ x: 80, y: 60, align: 'right' })
ok(stR.includes('transform:translateX(-100%);') && stR.includes('text-align:right;'), '右对齐双修正')
const stF = engine.fieldStyle({ x: 1, y: 2, fontFamily: "测试'楷体" })
ok(stF.includes("font-family:'测试楷体';"), 'family 引号剥除', stF)

// ---------- 3. buildHtml：与 workbench build_html 输出语义一致 ----------
console.log('== 3. buildHtml ==')
const tpl = loadJson('templates')[0]
const ds = loadJson('datasets')[0]
const html = engine.buildHtml(tpl, ds.rows, { withToolbar: true })
ok((html.match(/<div class="page">/g) || []).length === 3, '一记录一页（3 页）')
ok(html.includes('@page { size: 297mm 210mm; margin: 0; }'), 'A4 横向毫米尺寸', html.match(/@page[^}]+/)?.[0])
ok(html.includes("url('pp://media/print-bg/bg.png')"), '底图走 pp:// 协议')
ok(html.includes('font-face') && html.includes("'测试楷体'") && html.includes("pp://media/print-fonts/"), '上传字体 @font-face 声明')
ok(html.includes('含&lt;标签&gt;&amp;&quot;引号'), '记录值转义渲染')
ok(html.includes('width: 297mm; height: 210mm;'), '页面物理尺寸')
ok(html.includes('window.print()') && html.includes('缩放 = 100%'), '浏览器回看工具条（withToolbar）')
const htmlSilent = engine.buildHtml(tpl, ds.rows, { withToolbar: false })
ok(!htmlSilent.includes('window.print()'), 'Electron 内部通道无工具条')

// ---------- 4. 空值兜底：空值渲染为空白（不报错） ----------
console.log('== 4. 空值兜底 ==')
const page2 = html.split('<div class="page">')[2] || ''
ok(page2.includes('style="left:50%;'), '空值字段仍占位渲染')

// ---------- 4b. 字段属性兼容：旧版 UI 只写 key（无 column）也必须渲染出数据 ----------
// 回归背景：工坊界面 push { key }，渲染引擎读 f.column，字段全被过滤 → 预览只剩底图
console.log('== 4b. 字段属性兼容（key / column 双形态） ==')
const tplKeyShape = structuredClone(tpl)
tplKeyShape.id = 'tpl_key_shape'
tplKeyShape.fields = [
  { key: '姓名', label: '姓名', x: 50, y: 40, align: 'center' },
  { key: '奖项', label: '奖项', x: 50, y: 60, align: 'center' },
]
saveJson('templates', [...loadJson('templates'), tplKeyShape])
const htmlKey = engine.buildHtml(tplKeyShape, ds.rows.slice(0, 1), { withToolbar: false })
const pfCount = (htmlKey.match(/<div class="pf"/g) || []).length
ok(pfCount === 2, 'key 形态字段渲染出值（不再是空版）', { pfCount })
ok(htmlKey.includes(' class="pf" style="left:50%;top:40%;'), 'key 形态定位样式正常')
const colIssue = printDomain.validateBatch('ds_test', 'tpl_key_shape')
ok(colIssue.fieldCount === 2, '校验层同样兼容 key 形态', colIssue.fieldCount)

// ---------- 5. 出口校验 ----------
console.log('== 5. 出口校验 ==')
const v = printDomain.validateBatch('ds_test', 'tpl_test')
ok(v.recordCount === 3 && v.fieldCount === 3, '校验基线：3 行 × 3 字段', v)
const nameIssue = v.issues.find((i) => i.key === '姓名')
ok(nameIssue && nameIssue.empty === 1, '姓名空 1 行', nameIssue)
const awardIssue = v.issues.find((i) => i.key === '奖项')
ok(awardIssue && awardIssue.empty === 1, '奖项空 1 行')
const noteIssue = v.issues.find((i) => i.key === '备注')
ok(noteIssue && noteIssue.empty === 2, '备注空 2 行')
ok(v.allEmptyFields.length === 0, '无整列空字段')
const dsEmpty = structuredClone(ds)
dsEmpty.id = 'ds_empty'
dsEmpty.rows = [{ 姓名: '', 奖项: '', 备注: '' }]
saveJson('datasets', [...loadJson('datasets'), dsEmpty])
const v2 = printDomain.validateBatch('ds_empty', 'tpl_test')
ok(v2.allEmptyFields.length === 3, '整列为空重点提示', v2.allEmptyFields)

// ---------- 6. 批量组装 ----------
console.log('== 6. 批量组装 ==')
const built = printDomain.buildBatchHtml('ds_test', 'tpl_test')
ok(built.recordCount === 3 && built.templateName === '测试奖状', '组装元信息')
ok(built.page.w === 297 && built.page.h === 210, '纸张毫米来自统一 PAGE_SIZES')
ok(built.snapshotHtml.includes('window.print()') && !built.html.includes('window.print()'), '快照带工具条/打印通道不带')

// ---------- 7. 120 人批量 ----------
console.log('== 7. 120 人批量 ==')
const rows120 = Array.from({ length: 120 }, (_, i) => ({ 姓名: `选手${i + 1}`, 奖项: '一等奖', 备注: '' }))
const html120 = engine.buildHtml(tpl, rows120, { withToolbar: false })
ok((html120.match(/<div class="page">/g) || []).length === 120, '120 记录 → 120 页')

// ---------- 8. 留痕归档 ----------
console.log('== 8. 留痕归档 ==')
const job = printDomain.createJob({
  templateName: '测试奖状', datasetName: '测试名单.csv',
  mode: 'pdf', recordCount: 3, snapshotHtml: html, status: 'ok', detail: 'test',
})
ok(job.id.startsWith('job_'), '任务 ID 生成')
const snapAbs = printDomain.resolveSnapshot(job.id)
ok(fs.existsSync(snapAbs) && snapAbs.includes('snapshot.html'), '快照落盘（按月分目录）', snapAbs)
const jobs = printDomain.listJobs()
ok(jobs.length === 1 && jobs[0].id === job.id, '留痕清单（新任务在前）')
ok(jobs[0].snapshot.startsWith('archive/'), '快照相对路径')
let threw = false
try { printDomain.resolveSnapshot('job_none') } catch { threw = true }
ok(threw, '未知任务/缺失快照抛错')

// ---------- 9. 纸张回退 ----------
console.log('== 9. 纸张回退 ==')
ok(engine.pageSpec('a4-portrait').h === 297, '已知纸张命中')
ok(engine.pageSpec('unknown').w === 297, '未知纸张回退默认（A4 横向）')

console.log(`\nM3 领域层：${pass} 项断言通过${process.exitCode ? '（存在失败）' : ''}`)

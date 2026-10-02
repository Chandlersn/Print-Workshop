/**
 * 第三批：数据兜底与前端健壮性的验收。
 *
 * 分两部分：
 *   1. 纯函数与领域层能直接跑的（超宽判定下限、行搜索过滤）
 *   2. 前端 Vue 里的改动用「源码静态核查」锁住——这些 bug 的共同点是
 *      不抛错、不变红，只是界面上默默做错事，不写断言根本发现不了。
 *
 * 运行：node test/robustness.cjs
 */
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

const TMP = path.join(__dirname, '.tmp-data-robust')
rmDeep(TMP)
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const printDomain = require('../electron/print.cjs')
const templates = require('../electron/templates.cjs')
const dataset = require('../electron/dataset.cjs')
const { filterRowIndexes } = require('../src/lib/print-scope.cjs')

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8')
const printView = () => src('src/views/PrintCenterView.vue')
const tplView = () => src('src/views/TemplateView.vue')
const dsView = () => src('src/views/DatasetView.vue')

function makeDataset(rows) {
  const fp = path.join(TMP, `名册${Math.random().toString(36).slice(2, 7)}.csv`)
  fs.writeFileSync(fp, `姓名,机构\n${rows}`, 'utf-8')
  const ds = dataset.importFromFile(fp)
  dataset.setColumnPrint(ds.id, '姓名', true)
  dataset.setColumnPrint(ds.id, '机构', true)
  return ds
}

console.log('== 1. 贴边布局在保存时就被拦下（而不是打印时刷假警报） ==')
{
  // align=center 且 x=0：文字有一半在纸外。旧口径一路放到打印，
  // 出口校验把每条都判「超宽」——5 条记录刷 5 条警报，用户以为校验坏了。
  // 正确做法是布局问题在画布上就拦住。
  const ds = makeDataset('张三,单位A\n李四,单位B\n王五,单位C\n赵六,单位D\n钱七,单位E\n')
  const mk = (fields, name) => templates.saveTemplate({
    name, datasetId: ds.id, pageSize: { w: 210, h: 297 }, fields,
  })
  const throwsOn = (fields, label) => {
    try { mk(fields, '不该存成功'); fail++; console.error(`  FAIL - ${label}（未抛错）`) }
    catch (e) { pass++; console.log(`  ok - ${label}`); return e }
  }
  throwsOn([{ key: '姓名', label: '姓名', x: 0, y: 50, fontSize: 12, align: 'center' }], '居中字段贴左边缘被拒')
  throwsOn([{ key: '姓名', label: '姓名', x: 100, y: 50, fontSize: 12, align: 'center' }], '居中字段贴右边缘被拒')
  throwsOn([{ key: '姓名', label: '姓名', x: -5, y: 50, fontSize: 12, align: 'center' }], 'x 为负被拒')
  throwsOn([{ key: '姓名', label: '姓名', x: 50, y: 120, fontSize: 12, align: 'center' }], 'y 越界被拒')
  throwsOn([{ key: '姓名', label: '姓名', x: 'abc', y: 50, fontSize: 12, align: 'center' }], '坐标非数值被拒')
  // 左/右对齐贴边是合法的（文字向纸内延伸），不得误伤
  const leftEdge = mk([{ key: '姓名', label: '姓名', x: 0, y: 50, fontSize: 12, align: 'left' }], '左对齐贴边')
  const rightEdge = mk([{ key: '姓名', label: '姓名', x: 100, y: 50, fontSize: 12, align: 'right' }], '右对齐贴边')
  ok(Boolean(leftEdge.id && rightEdge.id), '左/右对齐贴边合法（不误伤）')

  // 错误文案要说清是哪几个字段、为什么
  try {
    mk([
      { key: '姓名', label: '姓名', x: 0, y: 50, fontSize: 12, align: 'center' },
      { key: '机构', label: '机构', x: 50, y: 50, fontSize: 12, align: 'center' },
    ], '多字段')
    ok(false, '多字段时应抛错')
  } catch (e) {
    ok(/姓名/.test(e.message) && /边缘|出纸/.test(e.message), '报错指名道姓并说明后果', e.message)
  }

  // 合法布局：超宽判定不被下限放过
  const normal = mk([{ key: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }], '居中常规')
  const v3 = printDomain.validateBatch(ds.id, normal.id, null)
  ok(v3.issues.reduce((s, i) => s + i.overlong, 0) === 0, '居中常规字段不报超宽', v3.issues)
  const narrow = mk([{ key: '姓名', label: '姓名', x: 1, y: 50, fontSize: 90, align: 'center' }], '窄字段')
  const v2 = printDomain.validateBatch(ds.id, narrow.id, null)
  ok(v2.issues.reduce((s, i) => s + i.overlong, 0) > 0, '真正超宽的大字号仍被报出（没矫枉过正）', v2.issues)
}

console.log('== 2. 行范围搜索过滤 ==')
{
  const rows = [
    { 姓名: '张三', 机构: '单位A' },
    { 姓名: '李四', 机构: '北京研究院' },
    { 姓名: '', 机构: '' },
    { 姓名: '王五', 机构: '上海设计所' },
  ]
  ok(JSON.stringify(filterRowIndexes(rows, '')) === JSON.stringify([0, 1, 2, 3]), '空关键词返回全部')
  ok(JSON.stringify(filterRowIndexes(rows, '  ')) === JSON.stringify([0, 1, 2, 3]), '纯空白视为无关键词')
  ok(JSON.stringify(filterRowIndexes(rows, '李四')) === JSON.stringify([1]), '按姓名精确命中')
  ok(JSON.stringify(filterRowIndexes(rows, '研究')) === JSON.stringify([1]), '按机构片段命中')
  ok(JSON.stringify(filterRowIndexes(rows, 'beijing')) === '[]', '无匹配返回空数组')
  ok(filterRowIndexes(rows, null).length === 4, 'null 关键词不炸')
  ok(filterRowIndexes(null, 'x').length === 0, 'rows 为 null 不炸')
  ok(JSON.stringify(filterRowIndexes([{ a: 1 }, null, { a: 2 }], '2')) === JSON.stringify([2]), '跳过非对象行')

  // 全库全命中的极端场景：不应因为量大而出错
  const big = Array.from({ length: 5000 }, (_, i) => ({ 姓名: `第${i}号` }))
  const t0 = Date.now()
  const hits = filterRowIndexes(big, '4999')
  ok(JSON.stringify(hits) === JSON.stringify([4999]), '5000 行定位准确', hits)
  ok(Date.now() - t0 < 2000, '5000 行全表搜索在可接受耗时内', `${Date.now() - t0}ms`)
}

console.log('== 3. 前端静态核查：异步失败必须可见 ==')
{
  const pv = printView()
  const refreshBody = pv.slice(pv.indexOf('async function refreshAll'), pv.indexOf('async function rebuildPreview'))
  ok(/catch/.test(refreshBody), 'refreshAll 至少有一处 catch')
  ok((refreshBody.match(/catch/g) || []).length >= 3, '三个清单各自 catch（一个失败不拖垮整页）',
    (refreshBody.match(/catch/g) || []).length)
  ok(/say\(/.test(refreshBody), '失败时给用户可见提示（不静默）')

  const execBody = pv.slice(pv.indexOf('async function execute'), pv.indexOf('async function openSnapshot'))
  const execTryEnd = execBody.lastIndexOf('try {')
  ok(execTryEnd > 0, 'execute 收尾的刷新被包进 try')
  ok(execBody.indexOf('listJobs') > execTryEnd, 'listJobs 在 try 之内（旧代码在 try 之外会顶掉已报结果）')
  ok(execBody.indexOf('listDatasets') > execTryEnd, 'listDatasets 在 try 之内')

  const runBody = pv.slice(pv.indexOf('async function runAction'), pv.indexOf('async function confirmProceed'))
  ok(/catch/.test(runBody), 'runAction 有 catch（守卫之外的异常也要可见）')

  // 竞态守卫：晚到的旧响应必须被丢弃
  const rb = pv.slice(pv.indexOf('async function rebuildPreview'), pv.indexOf('/** 统一的打印请求载荷'))
  ok(/previewSeq/.test(rb), 'rebuildPreview 使用序号守卫')
  ok((rb.match(/seq !== previewSeq/g) || []).length >= 2, '成功与失败两条路径都校验序号')
  ok(/let previewSeq = 0/.test(pv), '序号变量已声明')
}

console.log('== 4. 前端静态核查：模板画布与数据页 ==')
{
  const tv = tplView()
  // P1-9 吸附顺序：吸附检测必须在多选成员摆位之前
  const pm = tv.slice(tv.indexOf('function onPointerMove'), tv.indexOf('function onPointerUp'))
  const snapIdx = pm.indexOf('const snapV = snap(')
  const followIdx = pm.indexOf('d.starts.length > 1')
  ok(snapIdx > 0 && followIdx > 0, 'onPointerMove 含吸附与多选跟随')
  ok(snapIdx < followIdx, '吸附检测在多选跟随之前（否则整组撕裂一帧）')
  const assignIdx = pm.indexOf('f.x = snapV ?')
  ok(assignIdx > 0 && assignIdx < followIdx, '主字段先落到吸附后的最终值，再统一算位移')

  // P1-10 清空尺寸不被静默锁死
  const dim = tv.slice(tv.indexOf('function onItemDim'), tv.indexOf('function onCutMarks'))
  ok(/!Number\.isFinite\(n\)|n <= 0/.test(dim), '空值/非法值不写回（不被钳成 5mm）')
  ok(!/Number\(val\) \|\| 0/.test(dim), '不再用 Number(val)||0 把空值变成 0')

  // 撤销栈须含 layout
  ok(/layout: t\.layout/.test(tv), '撤销快照含 layout（尺寸改错也能撤销）')
  ok(/snap\.layout/.test(tv), 'restoreSnapshot 恢复 layout')
  ok(/Array\.isArray\(snap\)/.test(tv), '兼容早期只存 fields 的快照')

  // P1-14 模态守卫 + P1-15 合并撤销
  const kd = tv.slice(tv.indexOf('function onKeydown'), tv.indexOf('function clamp'))
  ok(/pendingConfirm\.value\) return/.test(kd), '模态开着时不响应全局快捷键')
  ok(!/pendingConfirm[\s\S]{0,80}onKeydown/.test(kd.split('const pendingConfirm')[0] || ''), '守卫在函数前部而非末尾')
  ok(/pushUndoForNudge/.test(kd), '方向键走合并撤销入口')
  ok(/NUDGE_MERGE_MS\s*=\s*800/.test(tv), '合并窗口已定义（按住 1.3s 不冲光 50 级栈）')
  ok(!/e\.preventDefault\(\)\s*\n\s*pushUndo\(\)/.test(kd), '方向键不再每次按键都 pushUndo')

  // P1-11 跳转请求一次性
  const dv = dsView()
  const nav = dv.slice(dv.indexOf('watch(() => cellNav.req'), dv.indexOf('</script>'))
  ok(/ackCell\(\)/.test(nav), '消费后ack（否则每次进数据页重放上次跳转）')
  ok(/finally/.test(nav), 'ack 放在 finally（失败分支也要清）')
  ok(/cellNav\.req === req/.test(nav), '只 ack 同一条请求（处理期间的新请求不被吃掉）')
  ok(/import \{ cellNav, ackCell \}/.test(dv), 'ackCell 已导入')
  ok(/export function ackCell/.test(src('src/lib/cell-nav.js')), 'ackCell 已导出')
}

console.log('== 5. 前端静态核查：切数据集重置页码 ==')
{
  const dv = dsView()
  const sd = dv.slice(dv.indexOf('async function selectDataset'), dv.indexOf('async function startImport'))
  ok(/page\.value = 0/.test(sd), 'selectDataset 重置页码（否则表格空白且分页器消失）')
  // 顺序无所谓，但必须在 getDataset 之前或之后都成立——只要有一处即可
  ok((sd.match(/page\.value = 0/g) || []).length === 1, '只重置一次，不重复')
}

console.log('== 6. 前端静态核查：搜索防抖 ==')
{
  const pv = printView()
  ok(/scopeSearchDebounced/.test(pv), '搜索走防抖后的值')
  ok(/setTimeout\(\(\) => \{ scopeSearchDebounced\.value = v \}/.test(pv), '有 150ms 防抖定时器')
  ok(/clearTimeout\(scopeSearchTimer\)/.test(pv), '重复输入会清掉上一个定时器')
  ok(/onBeforeUnmount\(\(\) => clearTimeout\(scopeSearchTimer\)\)/.test(pv), '卸载时清定时器（不泄漏）')
  const openScope = pv.slice(pv.indexOf('function openScope'), pv.indexOf('function toggleScopeRow'))
  ok(/scopeSearchDebounced\.value = ''/.test(openScope), '打开面板时同步清防抖值')
  ok(/v-if="scopeSearchDebounced\.trim\(\)"/.test(pv), '按钮显示条件跟防抖值一致（不闪烁）')
  ok(/onBeforeUnmount/.test(pv.split('\n').slice(0, 12).join('\n')), 'onBeforeUnmount 已导入')
}

rmDeep(TMP)
console.log(`\n健壮性回归：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

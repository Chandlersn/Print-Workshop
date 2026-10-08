/**
 * 字段编辑数学纯函数验收：拖拽吸附、多选对齐换算、撤销快照。
 *
 * 这几处都是「差一点点就错」的地方：吸附阈值、对齐少算半个盒宽、撤销栈被冲光。
 * 抽成纯函数后能脱离 GUI 精确钉住（原来只能靠真机 e2e 黑盒覆盖）。
 *
 * 运行：node test/field-edit.cjs
 */
const assert = require('assert')
const {
  SNAP_PX, UNDO_CAP, NUDGE_MERGE_MS,
  clampPct, snapTo, snapshotOf, parseSnapshot, pushCapped,
  shouldStartNewNudge, alignedX, alignedY,
} = require('../src/lib/field-edit.cjs')

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}

console.log('== 1. 常量口径 ==')
{
  ok(SNAP_PX === 6, '吸附阈值 6px')
  ok(UNDO_CAP === 50, '撤销栈上限 50')
  ok(NUDGE_MERGE_MS === 800, '微调合并窗口 800ms')
}

console.log('== 2. 百分比钳位（0–100，1 位小数） ==')
{
  ok(clampPct(-5) === 0, '负值 → 0')
  ok(clampPct(105) === 100, '超 100 → 100')
  ok(clampPct(12.34) === 12.3, '保留 1 位小数')
  ok(clampPct(50) === 50, '正常值原样')
  ok(clampPct(99.96) === 100, '临界四舍五入后仍 ≤100')
}

console.log('== 3. 吸附（阈值内取最近） ==')
{
  const hit = snapTo([[10]], [12])
  ok(hit && hit.diff === 2 && hit.adjust === 2 && hit.line === 12, '阈值内命中并给出 adjust/line', hit)
  ok(snapTo([[10]], [30]) === null, '阈值外不命中')
  const multi = snapTo([[10], [20]], [18])
  ok(multi && multi.line === 18 && multi.adjust === -2, '多边缘取最近的一条', multi)
  ok(snapTo([], [5]) === null, '无边缘 → null')
  ok(snapTo([[0]], [10], 20) !== null, '可传自定义阈值')
  const withLabel = snapTo([[10, 'l']], [12])
  ok(withLabel && withLabel.line === 12, '兼容 [offset, label] 形态')
}

console.log('== 4. 撤销快照：含 fields+layout、不含底图、兼容旧形态 ==')
{
  ok(snapshotOf(null) === JSON.stringify({ fields: [] }), 'null 模板 → 空 fields 快照')
  const tpl = { fields: [{ x: 1 }], layout: { mode: 'grid' }, background: 'print-bg/x.png' }
  const snap = snapshotOf(tpl)
  ok(!/background/.test(snap), '底图不进快照（换/删图会真删文件）')
  const parsed = parseSnapshot(snap)
  ok(JSON.stringify(parsed.fields) === JSON.stringify([{ x: 1 }]), 'fields 往返一致')
  ok(parsed.layout && parsed.layout.mode === 'grid', 'layout 往返一致')
  const legacy = parseSnapshot(JSON.stringify([{ x: 2 }]))
  ok(Array.isArray(legacy.fields) && legacy.fields[0].x === 2 && legacy.layout === null,
    '兼容早期「只存 fields 数组」的快照', legacy)
  ok(parseSnapshot(snapshotOf({ fields: [] })).layout === null, '无 layout 时解析为 null')
}

console.log('== 5. 入栈去重与封顶 ==')
{
  const st = []
  ok(pushCapped(st, 'a') === true && st.length === 1, '首次入栈')
  ok(pushCapped(st, 'a') === false && st.length === 1, '连续同值去重（不入栈）')
  ok(pushCapped(st, 'b') === true && st.length === 2, '换值入栈')
  const st3 = []
  for (const v of ['a', 'b', 'c']) pushCapped(st3, v, 3)
  ok(st3.length === 3, '封顶前长度正常')
  pushCapped(st3, 'd', 3)
  ok(st3.length === 3 && st3[0] === 'b' && st3[2] === 'd', '超上限丢最旧（shift）', st3)
}

console.log('== 6. 方向键微调合并窗口 ==')
{
  ok(shouldStartNewNudge(1000, 0) === true, '首次（距上次很久）→ 新一段')
  ok(shouldStartNewNudge(1000, 500) === false, '窗口内 → 合并')
  ok(shouldStartNewNudge(1000, 200) === false, '恰好 800ms → 仍合并')
  ok(shouldStartNewNudge(1000, 199) === true, '刚过 800ms → 新一段')
  ok(shouldStartNewNudge(1000, 100) === true, '远超窗口 → 新一段')
}

console.log('== 7. 多选对齐换算（锚点 vs 像素，含 align 影响） ==')
{
  const box = { w: 100, h: 40 }
  const bounds = { minLeft: 50, maxRight: 250, minTop: 100, maxBottom: 300 }
  const W = 500
  const H = 500

  // r=0.5（居中字段）
  ok(alignedX('left', box, bounds, W, 0.5) === 20, '居中字段左对齐 → 20')
  ok(alignedX('center-h', box, bounds, W, 0.5) === 30, '居中字段水平居中 → 30')
  ok(alignedX('right', box, bounds, W, 0.5) === 40, '居中字段右对齐 → 40')
  // r=0（align=left）：盒左缘=锚点，故左对齐锚点=minLeft
  ok(alignedX('left', box, bounds, W, 0) === 10, 'align=left 左对齐 → 10')
  ok(alignedX('right', box, bounds, W, 0) === 30, 'align=left 右对齐 → 30')
  ok(alignedX('center-h', box, bounds, W, 0) === 20, 'align=left 水平居中 → 20')
  // r=1（align=right）
  ok(alignedX('center-h', box, bounds, W, 1) === 40, 'align=right 水平居中 → 40')
  // 非横向对齐 → null
  ok(alignedX('top', box, bounds, W, 0.5) === null, '纵向 kind → null（x 不动）')

  ok(alignedY('top', box, bounds, H) === 20, '顶对齐 → 20')
  ok(alignedY('center-v', box, bounds, H) === 36, '垂直居中 → 36')
  ok(alignedY('bottom', box, bounds, H) === 52, '底对齐 → 52')
  ok(alignedY('left', box, bounds, H) === null, '横向 kind → null（y 不动）')
}

console.log(`\n字段编辑数学：${pass} 通过`)
process.exit(0)

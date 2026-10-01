/**
 * 画布一键布局纯函数验收：evenRow（均分横排）/ columnSnap（列对齐）。
 * 运行：node test/canvas-layout.cjs
 */
const assert = require('assert')
const { evenRow, columnSnap } = require('../src/lib/field-layout.cjs')

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}
function near(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps
}

console.log('== 1. 均分横排 ==')
{
  const fields = [
    { x: 70, y: 30, label: 'c' },
    { x: 20, y: 80, label: 'a' },
    { x: 45, y: 55, label: 'b' },
  ]
  const plan = evenRow(fields)
  ok(plan.length === 3, '计划与输入同长')
  // 按 x 排序后 a(20)→8、b(45)→50、c(70)→92；y 统一中位数 55
  const byLabel = { a: plan[1], b: plan[2], c: plan[0] }
  ok(byLabel.a.x === 8 && byLabel.b.x === 50 && byLabel.c.x === 92, 'x 等距分布 8/50/92', plan)
  ok(plan.every((p) => p.y === 55), 'y 统一为中位数 55', plan)
  // 入参不被修改（纯函数）
  ok(fields[0].x === 70 && fields[1].y === 80, '纯函数不改入参')
}
{
  // 两个字段：8 与 92
  const plan = evenRow([{ x: 10, y: 5 }, { x: 90, y: 5 }])
  ok(plan[0].x === 8 && plan[1].x === 92, '两字段端点即 8/92', plan)
}
{
  // 单字段 / 空：原样返回，不除零
  const one = evenRow([{ x: 33, y: 66 }])
  ok(one.length === 1 && one[0].x === 33 && one[0].y === 66, '单字段原样', one)
  ok(evenRow([]).length === 0, '空数组安全')
}

console.log('== 2. 列对齐 ==')
{
  // 20/21/45 → 20/21 聚簇取中位 20，45 独簇 45；y 不动
  const fields = [{ x: 21, y: 10 }, { x: 45, y: 20 }, { x: 20, y: 30 }]
  const plan = columnSnap(fields)
  ok(plan[0].x === 20 && plan[2].x === 20, '20/21 聚簇对齐到 20', plan)
  ok(plan[1].x === 45, '45 独立成列不动', plan)
  ok(fields[0].y === 10 && fields[1].y === 20 && fields[2].y === 30, 'y 保持不变')
}
{
  // 乱序输入也按簇收敛
  const plan = columnSnap([{ x: 80.8, y: 0 }, { x: 50, y: 0 }, { x: 80, y: 0 }])
  ok(plan[0].x === 80 && plan[2].x === 80 && plan[1].x === 50, '80.8/80 收敛到 80', plan)
}
{
  const one = columnSnap([{ x: 12, y: 3 }])
  ok(one[0].x === 12, '单字段原样')
}

console.log('== 3. 与画布语义的一致性 ==')
{
  // evenRow 的 x 计划应用于字段后仍在画布百分比内
  const fields = Array.from({ length: 6 }, (_, i) => ({ x: i * 15, y: 40 }))
  const plan = evenRow(fields)
  ok(plan.every((p) => p.x >= 0 && p.x <= 100), '计划 x 全在 0~100 内')
  ok(near(plan[5].x - plan[4].x, plan[1].x - plan[0].x, 0.01), '等距（末对间距=首对间距）')
}

console.log(`\n画布布局：${pass} 项断言通过`)

/**
 * 画布一键布局纯函数验收：evenRow（均分横排）/ anchorRatio（锚点比例）。
 * 运行：node test/canvas-layout.cjs
 */
const assert = require('assert')
const { evenRow, anchorRatio } = require('../src/lib/field-layout.cjs')

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

console.log('== 2. 与画布语义的一致性 ==')
{
  // evenRow 的 x 计划应用于字段后仍在画布百分比内
  const fields = Array.from({ length: 6 }, (_, i) => ({ x: i * 15, y: 40 }))
  const plan = evenRow(fields)
  ok(plan.every((p) => p.x >= 0 && p.x <= 100), '计划 x 全在 0~100 内')
  ok(near(plan[5].x - plan[4].x, plan[1].x - plan[0].x, 0.01), '等距（末对间距=首对间距）')
}

console.log('== 3. 锚点比例与渲染引擎口径一致 ==')
{
  // x 是锚点：center 时锚点在盒中心（渲染 translateX(-50%)），right 在右缘，left 在左缘。
  // 画布 fieldStyle 用同一比例做位移——两者不一致即「画布看着居中、出片偏左半个身位」。
  ok(anchorRatio({ align: 'center' }) === 0.5, 'center → 0.5（盒中心）')
  ok(anchorRatio({ align: 'right' }) === 1, 'right → 1（右缘）')
  ok(anchorRatio({ align: 'left' }) === 0, 'left → 0（左缘）')
  ok(anchorRatio({}) === 0, '未设 align 按 left（左缘，与渲染默认值一致）')

  // 盒左缘 = 锚点px - ratio × 盒宽：据此反推，x=50 的居中字段左右留白相等（几何居中）
  const W = 1000
  const boxW = 240
  for (const align of ['center', 'right', 'left']) {
    const xPx = 0.5 * W
    const leftEdge = xPx - anchorRatio({ align }) * boxW
    const rightEdge = leftEdge + boxW
    if (align === 'center') {
      ok(near(leftEdge, W - rightEdge, 0.01), 'x=50 居中字段左右留白相等', { leftEdge, rightEdge })
    } else if (align === 'right') {
      ok(near(rightEdge, 500, 0.01), 'x=50 右缘字段右缘落在锚点线上', { rightEdge })
    } else {
      ok(near(leftEdge, 500, 0.01), 'x=50 左缘字段左缘落在锚点线上', { leftEdge })
    }
  }
}

console.log(`\n画布布局：${pass} 项断言通过`)

/**
 * 画布锚点换算纯函数验收：anchorRatio（锚点比例）。
 * 运行：node test/canvas-layout.cjs
 *
 * v0.6.2 注：本套件原先是「evenRow（均分横排）/ anchorRatio」两节。均分横排连按钮带函数
 * 一起下线了，原先那两节随之删除——为已下线的功能留测试，只会让后来者以为它还在。
 */
const assert = require('assert')
const { anchorRatio } = require('../src/lib/field-layout.cjs')

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}
function near(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps
}

console.log('== 1. 锚点比例的基本口径 ==')
{
  // x 是锚点：center 时锚点在盒中心（渲染 translateX(-50%)），right 在右缘，left 在左缘。
  // 画布 fieldStyle 用同一比例做位移——两者不一致即「画布看着居中、出片偏左半个身位」。
  ok(anchorRatio({ align: 'center' }) === 0.5, 'center → 0.5（盒中心）')
  ok(anchorRatio({ align: 'right' }) === 1, 'right → 1（右缘）')
  ok(anchorRatio({ align: 'left' }) === 0, 'left → 0（左缘）')
  ok(anchorRatio({}) === 0, '未设 align 按 left（左缘，与渲染默认值一致）')
}

console.log('== 2. 与画布语义的一致性 ==')
{
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

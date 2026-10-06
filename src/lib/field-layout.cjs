/**
 * 画布字段一键布局（纯函数，Node 可测）。
 * 坐标语义与渲染引擎一致：x/y 是**锚点**百分比——align=center 时 x 是文本中心线
 * （渲染 translateX(-50%)，画布同样位移），left/right 时为左/右缘；y 恒为上缘。
 * 因此布局只动锚点、不感知文本宽度——这正是画布与出片能对齐的前提。
 */

/** 锚点在盒内的比例：居中 0.5 / 右缘 1 / 左缘 0。盒左缘 = 锚点px - ratio × 盒宽 */
function anchorRatio(f) {
  return f.align === 'center' ? 0.5 : f.align === 'right' ? 1 : 0
}

/**
 * 均分横排：按现 x 排序后，y 统一取中位数，x 在 [start, end] 区间等距分布。
 * 返回与入参同序的 [{ x, y }]（不修改入参）。
 */
function evenRow(fields, { start = 8, end = 92 } = {}) {
  const n = fields.length
  if (n < 2) return fields.map((f) => ({ x: f.x || 0, y: f.y || 0 }))
  const order = fields
    .map((f, i) => ({ i, x: f.x || 0 }))
    .sort((a, b) => a.x - b.x)
  const ys = fields.map((f) => f.y || 0).sort((a, b) => a - b)
  const y = ys[Math.floor(ys.length / 2)]
  const plan = new Array(n)
  order.forEach((o, rank) => {
    plan[o.i] = {
      x: round2(start + ((end - start) * rank) / (n - 1)),
      y,
    }
  })
  return plan
}

function round2(v) {
  return Math.round(v * 100) / 100
}

module.exports = { evenRow, anchorRatio }

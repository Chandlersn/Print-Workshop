/**
 * 画布字段一键布局（纯函数，Node 可测）。
 * 坐标语义与渲染引擎一致：x/y 是锚点百分比——align=center 时文本以 x 居中
 * （translateX(-50%)），left/right 时为左/右缘。因此布局只动锚点，不感知文本宽度。
 */

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

/**
 * 列对齐：x 相近（间距 ≤ tol 个百分点）的字段聚成一列，统一取该列 x 的中位数。
 * y 不动。返回与入参同序的 [{ x }]。
 */
function columnSnap(fields, { tol = 2.5 } = {}) {
  const n = fields.length
  if (n < 2) return fields.map((f) => ({ x: f.x || 0 }))
  const order = fields
    .map((f, i) => ({ i, x: f.x || 0 }))
    .sort((a, b) => a.x - b.x)
  // 切簇：相邻 x 间距超过 tol 即新簇
  const clusters = [[order[0]]]
  for (let k = 1; k < order.length; k++) {
    const prev = clusters[clusters.length - 1]
    if (order[k].x - prev[prev.length - 1].x <= tol) prev.push(order[k])
    else clusters.push([order[k]])
  }
  const plan = new Array(n)
  for (const cluster of clusters) {
    const xs = cluster.map((o) => o.x).sort((a, b) => a - b)
    // 偶数簇取下中位：偏向先放置的锚点，行为可预期
    const target = round2(xs[Math.floor((xs.length - 1) / 2)])
    for (const o of cluster) plan[o.i] = { x: target }
  }
  return plan
}

function round2(v) {
  return Math.round(v * 100) / 100
}

module.exports = { evenRow, columnSnap }

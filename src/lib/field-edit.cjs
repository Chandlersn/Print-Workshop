/**
 * 字段编辑数学（纯函数，Node 可测）：拖拽吸附、多选对齐换算、撤销快照。
 *
 * DOM 测量（getBoundingClientRect）留在视图层，这里只接收「测量结果」做纯算术——
 * 于是这些最容易算错（差半个盒宽、方向搞反、栈被冲光）的部分可以脱离 GUI 单测。
 * 见 test/field-edit.cjs。
 */

const SNAP_PX = 6           // 吸附阈值（像素，源项目同值）
const UNDO_CAP = 50         // 撤销栈上限
const NUDGE_MERGE_MS = 800  // 连续方向键微调的合并窗口（距上次超过它才算新一段操作）

/** 百分比坐标钳位：0–100，保留 1 位小数 */
function clampPct(v) {
  return Math.min(100, Math.max(0, Math.round(v * 10) / 10))
}

/**
 * 吸附：自身盒子的若干边缘（像素 offset）里，最接近某条目标线的那个；
 * 阈值内才命中，返回 { diff, adjust, line }，否则 null。
 * valueEdges 兼容 [offset] 与 [offset, label] 两种形态（label 不参与计算）。
 */
function snapTo(valueEdges, targets, threshold = SNAP_PX) {
  let best = null
  for (const edge of valueEdges) {
    const offset = Array.isArray(edge) ? edge[0] : edge
    for (const t of targets) {
      const diff = Math.abs(offset - t)
      if (diff <= threshold && (!best || diff < best.diff)) {
        best = { diff, adjust: t - offset, line: t }
      }
    }
  }
  return best
}

/**
 * 撤销快照。必须含 layout：成品尺寸、裁切线也是模板的一部分，只快照 fields 的话
 * 误改尺寸后按撤销救不回来（字段没变，去重还会把它挡掉）。
 * 底图**故意不进快照**：换图 / 删图会真删文件，撤销回来只会是张破图。
 */
function snapshotOf(tpl) {
  return JSON.stringify(tpl ? { fields: tpl.fields, layout: tpl.layout || null } : { fields: [] })
}

/** 解析快照（兼容早期只存 fields 数组的形态） */
function parseSnapshot(json) {
  const snap = JSON.parse(json)
  if (Array.isArray(snap)) return { fields: snap, layout: null }
  return { fields: snap.fields, layout: snap.layout || null }
}

/**
 * 入栈（带去重与封顶）。返回是否真的入栈。
 * 去重：连续触发（focus / pointerdown 叠加）且状态未变时不重复入栈。
 */
function pushCapped(stack, snap, cap = UNDO_CAP) {
  if (stack.length && stack[stack.length - 1] === snap) return false
  stack.push(snap)
  if (stack.length > cap) stack.shift()
  return true
}

/** 方向键微调是否需要新开一段撤销（距上次超过窗口才算新操作） */
function shouldStartNewNudge(now, lastAt, ms = NUDGE_MERGE_MS) {
  return now - lastAt > ms
}

/**
 * 多选对齐的 x 轴换算。对齐目标是一个像素位置，而 f.x 是锚点百分比，写入前必须换算：
 *   盒左缘 = 锚点px − r×盒宽，盒中心 = 盒左缘 + 盒宽/2。
 * center-h 要「盒中心落在 targetCenter」⇒ 锚点px = targetCenter − (0.5 − r)×盒宽。
 * 漏掉换算会让非居中字段整体偏 (0.5 − r)×盒宽（拖动时吸附起点随之错位）。
 * box = { w }，bounds = { minLeft, maxRight }，W = 参照系宽度，r = anchorRatio(f)。
 * kind 非横向对齐时返回 null。
 */
function alignedX(kind, box, bounds, W, r) {
  if (kind === 'left') return clampPct(((bounds.minLeft + r * box.w) / W) * 100)
  if (kind === 'center-h') return clampPct((((bounds.minLeft + bounds.maxRight) / 2 + (r - 0.5) * box.w) / W) * 100)
  if (kind === 'right') return clampPct(((bounds.maxRight - (1 - r) * box.w) / W) * 100)
  return null
}

/** 多选对齐的 y 轴换算（y 锚点恒在盒中心，与 align 无关）；kind 非纵向对齐时返回 null */
function alignedY(kind, box, bounds, H) {
  if (kind === 'top') return clampPct((bounds.minTop / H) * 100)
  if (kind === 'center-v') return clampPct((((bounds.minTop + bounds.maxBottom) / 2 - box.h / 2) / H) * 100)
  if (kind === 'bottom') return clampPct(((bounds.maxBottom - box.h) / H) * 100)
  return null
}

module.exports = {
  SNAP_PX,
  UNDO_CAP,
  NUDGE_MERGE_MS,
  clampPct,
  snapTo,
  snapshotOf,
  parseSnapshot,
  pushCapped,
  shouldStartNewNudge,
  alignedX,
  alignedY,
}

/**
 * 底图编辑器的对齐辅助（纯函数，Node 可测）：标尺刻度、布局网格、吸附目标与最近目标求解。
 *
 * 为什么单拆一个纯模块：这几样是「毫米级对齐」的核心算术，也正是最容易「差一点点就错」
 * 的地方——阈值把 px 和 mm 串了、网格用浮点累加漂出去、明明关掉了某类目标却还在吸。
 * 把 DOM 测量（getBoundingClientRect / 指针坐标）留在视图层、这里只吃「测量结果」，
 * 这些算术就能脱离 GUI 单测。与 `src/lib/field-edit.cjs` 同一套做法。
 *
 * 坐标单位：除标注 px 的入参外一律是**毫米**，与工程文件一致。
 */

/**
 * 吸附目标的四个类别。每类在界面上有独立开关。
 *
 * 缺省**网格关**：网格本身默认不显示，而「看不见的吸附线」比不吸附更糟——
 * 用户会以为图层拖不动了。其余三类默认开，与加这个开关之前的行为逐字一致。
 */
const SNAP_TARGETS = Object.freeze(['artboard', 'guides', 'grid', 'layers'])
const DEFAULT_SNAP_TARGETS = Object.freeze({ artboard: true, guides: true, grid: false, layers: true })

/** 标尺主刻度候选步长（毫米），从密到疏取第一个「标签不打架」的。 */
const RULER_STEPS = Object.freeze([1, 2, 5, 10, 20, 25, 50, 100, 200, 500])
/** 相邻两根主刻度之间画几根次刻度。 */
const RULER_MINOR_PER_MAJOR = 5
/** 两个主刻度标签之间的最小像素间距——低于它就把步长调大一档。 */
const RULER_MIN_LABEL_PX = 34

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 标尺刻度。返回 `[{ mm, major }]`，`major` 为真的是带数字的主刻度。
 *
 * 步长自适应：画布放大时每毫米占的像素变多，就自动用更密的步长，反之变疏——
 * 否则缩小时标签会糊成一团，放大时又只剩几个孤零零的数字。
 */
function rulerTicks(lengthMm, pxPerMm, { minLabelPx = RULER_MIN_LABEL_PX } = {}) {
  const span = Number(lengthMm)
  const scale = Number(pxPerMm)
  if (!(span > 0) || !(scale > 0)) return []
  const major = RULER_STEPS.find((step) => step * scale >= minLabelPx) || RULER_STEPS[RULER_STEPS.length - 1]
  const minor = major / RULER_MINOR_PER_MAJOR
  const ticks = []
  /*
   * 用整数下标乘出位置，**不要** `mm += minor` 这样累加：浮点累加会让第 100 根刻度
   * 偏出零点几毫米，而标尺唯一的用途就是「照着它对齐」。同理末尾用容差判上界，
   * 免得 `span / minor` 恰好是整数时因为 0.9999999 少画最后一根。
   */
  const count = Math.floor(span / minor + 1e-9)
  for (let i = 0; i <= count; i += 1) {
    ticks.push({ mm: round(i * minor), major: i % RULER_MINOR_PER_MAJOR === 0 })
  }
  return ticks
}

/**
 * 布局网格线：主格线每 `spacing` 毫米一根，主格之间再等分 `subdivisions` 根次格线。
 * 返回 `[{ mm, major }]`，**铺满整块画布**（含 0 与末缘）。
 */
function gridLines(lengthMm, spacing, subdivisions) {
  const span = Number(lengthMm)
  const step = Number(spacing)
  const sub = Math.max(1, Math.round(Number(subdivisions) || 1))
  if (!(span > 0) || !(step > 0)) return []
  const minor = step / sub
  const lines = []
  const count = Math.floor(span / minor + 1e-9)
  for (let i = 0; i <= count; i += 1) {
    lines.push({ mm: round(i * minor), major: i % sub === 0 })
  }
  return lines
}

/**
 * 网格**渲染**用的像素步长：主格线与次格线各占多少像素。界面拿它画 CSS 重复渐变。
 *
 * 刻意由 `gridLines` 反推而不是自己写一遍 `spacing / subdivisions`：
 * 界面画的线与吸附用的线必须出自同一份算术，否则会出现「看着对齐了、其实没吸上」——
 * 而这种偏差在界面上完全看不出来。
 */
function gridPixelSteps(spacing, subdivisions, pxPerMm, spanMm = 100) {
  const step = Number(spacing)
  const scale = Number(pxPerMm)
  if (!(step > 0) || !(scale > 0)) return null
  // 跨度至少放得下两根主格线，否则取不到「第一根主格线」的位置。
  const lines = gridLines(Math.max(Number(spanMm) || 0, step * 2), step, subdivisions)
  const majorMm = lines.find((line) => line.major && line.mm > 0)?.mm || 0
  // 细分数为 1 时没有次格线，用主格线的间距顶上（次格带被主格带完全盖住，视觉无差别）。
  const minorMm = lines.find((line) => !line.major && line.mm > 0)?.mm || majorMm
  if (!(majorMm > 0)) return null
  return { major: majorMm * scale, minor: minorMm * scale }
}

/**
 * 网格的可吸附位置 = **主格线**（不含次格线）。
 *
 * 为什么不吸次格线：默认间距 10mm、细分数 5 ⇒ 次格线 2mm 一根，而吸附阈值换算过来
 * 约 1.7mm ⇒ 几乎每一帧都会命中次格线，边缘与参考线就再也抢不到吸附了。
 * 界面上次格线是**看的**，主格线才是**对的**（Photoshop 的网格吸附同理）。
 */
function gridSnapTargets(lengthMm, spacing) {
  const span = Number(lengthMm)
  const step = Number(spacing)
  if (!(span > 0) || !(step > 0)) return []
  const targets = []
  const count = Math.floor(span / step + 1e-9)
  for (let i = 0; i <= count; i += 1) targets.push(round(i * step))
  return targets
}

/**
 * 按开关汇总四类吸附目标，返回 `{ x, y }`（毫米）。
 *
 * `enabled[key] !== false` 而不是 `=== true`：调用方漏传某个键时应当**保留**该类目标，
 * 而不是悄悄把它关掉——「少吸一条线」在界面上完全看不出来，只有打出来才发现歪了。
 *
 * @param {object}   o
 * @param {{w:number,h:number}} o.artboard 画布尺寸（毫米）
 * @param {object}   o.enabled  四类开关
 * @param {Array}    o.guides   参考线 `[{ axis:'x'|'y', position }]`（axis='x' 是垂直线）
 * @param {object}   o.grid     布局网格 `{ spacing }`，仅在 enabled.grid 时用
 * @param {Array}    o.others   其他图层的包围盒 `[{ x, y, w, h }]`
 */
function snapTargets({ artboard, enabled = DEFAULT_SNAP_TARGETS, guides = [], grid = null, others = [] } = {}) {
  const x = []
  const y = []
  const on = (key) => enabled[key] !== false
  const boardW = Number(artboard?.w) || 0
  const boardH = Number(artboard?.h) || 0

  if (on('artboard')) {
    x.push(0, round(boardW / 2), boardW)
    y.push(0, round(boardH / 2), boardH)
  }
  if (on('guides')) {
    for (const guide of guides) {
      if (!guide) continue
      ;(guide.axis === 'x' ? x : y).push(Number(guide.position))
    }
  }
  if (on('grid') && grid && Number(grid.spacing) > 0) {
    x.push(...gridSnapTargets(boardW, grid.spacing))
    y.push(...gridSnapTargets(boardH, grid.spacing))
  }
  if (on('layers')) {
    for (const box of others) {
      if (!box) continue
      x.push(box.x, round(box.x + box.w / 2), box.x + box.w)
      y.push(box.y, round(box.y + box.h / 2), box.y + box.h)
    }
  }
  return { x: x.filter(Number.isFinite), y: y.filter(Number.isFinite) }
}

/**
 * 拖动时的吸附求解：在被拖包围盒的三条特征线（左/中/右）里，找最接近某条目标线的那个，
 * 阈值内才命中。返回 `{ dx, dy, x, y }`——`x`/`y` 是命中的目标线（毫米，未命中为 null），
 * 视图层拿它画那根粉色吸附提示线。
 *
 * `threshold` 与 `moving` 同单位（毫米）。调用方传的是 `SNAP_PX / pxPerMm`：
 * **阈值是像素口径**，这样不论缩放多少，「差 6 个像素以内就吸」的手感恒定。
 */
function computeSnap({ moving, dx = 0, dy = 0, targets, threshold = 0 } = {}) {
  const none = { dx, dy, x: null, y: null }
  if (!moving || !targets) return none
  const limit = Number(threshold)
  if (!(limit > 0)) return none

  const pick = (values, list) => {
    let found = { distance: limit, delta: 0, line: null }
    for (const value of values) {
      for (const target of list) {
        const delta = target - value
        if (Math.abs(delta) < found.distance) {
          found = { distance: Math.abs(delta), delta, line: target }
        }
      }
    }
    return found
  }

  const x = pick([moving.x + dx, moving.x + moving.w / 2 + dx, moving.x + moving.w + dx], targets.x || [])
  const y = pick([moving.y + dy, moving.y + moving.h / 2 + dy, moving.y + moving.h + dy], targets.y || [])
  return { dx: dx + x.delta, dy: dy + y.delta, x: x.line, y: y.line }
}

/**
 * 从标尺拖出参考线时的落点：把「指针相对画布左/上缘的像素偏移」换算成毫米，
 * **夹在画布内**并取 1 位小数。
 *
 * 为什么要夹：参考线位置超出画布会被判成「画布外」而不渲染、也不参与吸附，
 * 用户从标尺往画布外一拖就得到一条看不见也吸不到的线，只会以为功能坏了。
 */
function guidePositionFromOffset(offsetPx, pxPerMm, spanMm) {
  const scale = Number(pxPerMm)
  if (!(scale > 0)) return 0
  const span = Number(spanMm)
  const max = span > 0 ? span : 0
  const raw = Number(offsetPx) / scale
  const clamped = Math.min(max, Math.max(0, raw))
  return Number.isFinite(clamped) ? Math.round(clamped * 10) / 10 : 0
}

module.exports = {
  SNAP_TARGETS,
  DEFAULT_SNAP_TARGETS,
  RULER_MIN_LABEL_PX,
  rulerTicks,
  gridLines,
  gridPixelSteps,
  gridSnapTargets,
  snapTargets,
  computeSnap,
  guidePositionFromOffset,
}

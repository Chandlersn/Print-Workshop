/**
 * 模板版式几何（纯函数，Node 可测）。
 *
 * 画布与主进程 resolveLayout 同口径：
 *   单页   = 设计参照物是整张纸；
 *   多联   = 是「单个成品」（小成品在整页缩放下没法拖字段，画布切换为单个成品）；
 *   对折桌牌 = 是「半页成品」。
 * 这里只做纯几何换算，不碰响应式、不碰 DOM——视图层把 activeTpl / 纸张尺寸传进来即可。
 * 抽出来是为了让这套换算能脱离 GUI 单测（见 test/template-layout.cjs）。
 */

const DEFAULT_ITEM = { w: 85, h: 54 }
const DEFAULT_PAGE = { w: 210, h: 297 }

/** 版式模式归一：非 grid / fold 一律按 single */
function resolveLayoutMode(tpl) {
  const m = tpl && tpl.layout && tpl.layout.mode
  return m === 'grid' || m === 'fold' ? m : 'single'
}

/** 设计参照物尺寸：多联 = 单个成品；对折桌牌 = 半页成品；单页 = 整张纸 */
function resolveItemSpec(tpl) {
  if (!tpl) return { ...DEFAULT_PAGE }
  const mode = resolveLayoutMode(tpl)
  if (mode === 'grid') {
    const w = Number(tpl.layout && tpl.layout.itemW) || 0
    const h = Number(tpl.layout && tpl.layout.itemH) || 0
    return { w: w > 0 ? w : DEFAULT_ITEM.w, h: h > 0 ? h : DEFAULT_ITEM.h }
  }
  if (mode === 'fold') {
    return { w: tpl.pageSize.w, h: tpl.pageSize.h / 2 }
  }
  return { w: tpl.pageSize.w, h: tpl.pageSize.h }
}

/**
 * 多联摘要（仅用于界面提示；行列的权威计算在主进程 resolveLayout）。
 * ok=false 表示当前纸张放不下 2 个成品，出片时会退回单页。
 */
function computeGridInfo(pageSize, item) {
  const cols = Math.floor(pageSize.w / item.w)
  const rows = Math.floor(pageSize.h / item.h)
  return { cols, rows, perPage: cols * rows, ok: cols >= 1 && rows >= 1 && cols * rows >= 2 }
}

/**
 * 多联格子阵列（百分比定位，与主进程 resolveLayout 同口径）。
 * 放不下 2 个成品时返回空数组——不画网格，由界面红字提示原因。
 */
function buildGridCells(pageSize, item) {
  const iw = item.w
  const ih = item.h
  const cols = Math.max(1, Math.floor(pageSize.w / iw))
  const rows = Math.max(1, Math.floor(pageSize.h / ih))
  if (cols * rows < 2) return []
  const offX = (pageSize.w - cols * iw) / 2
  const offY = (pageSize.h - rows * ih) / 2
  const w = (iw / pageSize.w) * 100
  const h = (ih / pageSize.h) * 100
  const out = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        k: r * cols + c,
        left: ((offX + c * iw) / pageSize.w) * 100,
        top: ((offY + r * ih) / pageSize.h) * 100,
        w,
        h,
      })
    }
  }
  return out
}

/** 底图比例与设计参照物的偏差提示：比例差 > 2% 才提示，否则返回空串 */
function computeBgRatioWarn(bgSize, item, mode) {
  if (!bgSize) return ''
  const { w, h } = item
  const diff = Math.abs(bgSize.width / bgSize.height - w / h) / (w / h)
  const target = mode === 'grid' ? '成品尺寸' : (mode === 'fold' ? '半页成品' : '纸张')
  return diff > 0.02 ? `底图比例与${target}相差约 ${(diff * 100).toFixed(1)}%，打印时可能变形` : ''
}

/** 纸张自定义尺寸钳位（10–2000mm；空/非法按 0 处理后再钳到 10） */
function clampPageDim(val) {
  return Math.min(2000, Math.max(10, Math.round(Number(val) || 0)))
}

/**
 * 成品尺寸钳位（5–500mm）。
 * 空值/非法/≤0 返回 null，表示「不写回」——用户想清空重输时不该被静默锁成 5mm。
 * 视图层据此提前 return（见 TemplateView.onItemDim 注释）。
 */
function clampItemDim(val) {
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(500, Math.max(5, Math.round(n)))
}

/** pt → 画布 px（画布按整张纸等比缩放，故 pxPerMm = canvasW / pageW） */
function ptToPx(pt, pageW, canvasW) {
  return (pt * 25.4) / 72 * (canvasW / pageW)
}

module.exports = {
  DEFAULT_ITEM,
  DEFAULT_PAGE,
  resolveLayoutMode,
  resolveItemSpec,
  computeGridInfo,
  buildGridCells,
  computeBgRatioWarn,
  clampPageDim,
  clampItemDim,
  ptToPx,
}

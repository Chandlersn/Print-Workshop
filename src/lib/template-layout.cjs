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
 * ok=false 表示当前纸张放不下 2 个成品，或超过渲染引擎的每页 400 格上限；出片会退回单页。
 */
function computeGridInfo(pageSize, item) {
  const cols = Math.floor(pageSize.w / item.w)
  const rows = Math.floor(pageSize.h / item.h)
  const perPage = cols * rows
  return { cols, rows, perPage, ok: cols >= 1 && rows >= 1 && perPage >= 2 && perPage <= 400 }
}

/**
 * 多联格子阵列（百分比定位，与主进程 resolveLayout 同口径）。
 * 放不下 2 个成品或超过 400 格时返回空数组——与渲染引擎的单页回退一致。
 */
function buildGridCells(pageSize, item) {
  const iw = item.w
  const ih = item.h
  const cols = Math.floor(pageSize.w / iw)
  const rows = Math.floor(pageSize.h / ih)
  if (cols < 1 || rows < 1 || cols * rows < 2 || cols * rows > 400) return []
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

/**
 * 底图铺满成品后的**有效输出分辨率**（dpi）。
 *
 * 为什么需要这个：用户报「导出会吃底图清晰度」。实测下来导出链路是逐像素无损的
 * （PDF 里内嵌的就是源图原始码流，20 种格式 × 36 组合 × 300 页 × 216MP 全测过），
 * 真正决定"印出来清不清"的是**底图铺到成品上之后还剩多少 dpi**：
 *
 *   有效 dpi = min(底图宽像素 ÷ 成品宽英寸, 底图高像素 ÷ 成品高英寸)
 *
 * - 底图比例与成品一致 → 铺满不变形，dpi 完全由源像素决定（300dpi 的图就是 300dpi）
 * - 比例不一致 → CSS `background-size: 100% 100%` 会把图**拉伸**到成品尺寸，
 *   因此取较低的一轴，避免把清晰度报得过高
 *
 * @param {{width:number,height:number}} bgSize 底图像素尺寸
 * @param {{w:number,h:number}} item 成品尺寸（mm）——单页=纸张，多联=单格，对折=半页
 * @returns {{dpi:number, dpiX:number, dpiY:number, megapixel:number, level:'good'|'ok'|'low'|'bad', text:string, advice:string}}
 */
function computeBgDpi(bgSize, item) {
  const EMPTY = { dpi: 0, dpiX: 0, dpiY: 0, megapixel: 0, level: 'bad', text: '', advice: '' }
  if (!bgSize || !bgSize.width || !bgSize.height) return EMPTY
  if (!item || !(item.w > 0) || !(item.h > 0)) return EMPTY

  const dpiX = bgSize.width / (item.w / 25.4)
  const dpiY = bgSize.height / (item.h / 25.4)
  const megapixel = (bgSize.width * bgSize.height) / 1e6
  // 拉伸变形时以较差的一边为准，否则「一边 300、一边 120」会被报成合格
  const dpi = Math.min(dpiX, dpiY)

  // 分级按印刷常识：300 是照片级门槛，150 是「看得清字」的下限，96 是屏幕级。
  // 判定用**取整后**的值：纸张毫米是整数（A4 = 210×297），而 2480px 宽的
  // A4@300dpi 底图算出来是 299.96 —— 卡在门槛下方一分会被判成「不够清」，
  // 但用户手上就是标准的 300dpi 图。取整既消除这个边界噪声，也贴合直觉
  // （299.6 报「约 300 dpi」却判 ok 才奇怪）。
  const levelDpi = Math.round(dpi)
  const level = levelDpi >= 300 ? 'good' : (levelDpi >= 150 ? 'ok' : (levelDpi >= 96 ? 'low' : 'bad'))
  const text = `输出约 ${levelDpi} dpi`
  const neededWidth = Math.ceil(item.w / 25.4 * 300)
  const neededHeight = Math.ceil(item.h / 25.4 * 300)
  const advice = level === 'good'
    ? '清晰度足够印刷'
    : level === 'ok'
      ? `够日常打印；想要照片级清晰度，底图建议至少 ${neededWidth}×${neededHeight}px`
      : level === 'low'
        ? `偏软（屏幕级）。底图建议至少 ${neededWidth}×${neededHeight}px，否则打印会发虚`
        : `明显不够清晰。底图建议至少 ${neededWidth}×${neededHeight}px`
  return { dpi, dpiX, dpiY, megapixel, level, text, advice }
}

/**
 * 底图长宽比与成品的偏差（用于区分「变形」与「分辨率不够」两种"糊"）。
 * 返回放进 bgDpi 里一起展示，不另开提示位。
 */
function computeBgRatioDeviation(bgSize, item) {
  if (!bgSize || !item || !(item.w > 0) || !(item.h > 0)) return { dev: 0, stretched: false }
  const bgAr = bgSize.width / bgSize.height
  const itemAr = item.w / item.h
  const dev = Math.abs(itemAr - bgAr) / itemAr
  return { dev, stretched: dev > 0.02 }
}

module.exports = {
  DEFAULT_ITEM,
  DEFAULT_PAGE,
  resolveLayoutMode,
  resolveItemSpec,
  computeGridInfo,
  buildGridCells,
  computeBgRatioWarn,
  computeBgDpi,
  computeBgRatioDeviation,
  clampPageDim,
  clampItemDim,
  ptToPx,
}

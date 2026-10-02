/**
 * 打印中心的纯判定逻辑（从PrintCenterView.vue 抽出，便于直接跑测试）。
 *
 * 为什么要抽：这两条都是「错了用户只会看到结果不对、却不知原因」的判定——
 * 补打范围丢失会多打几百人，多联回退不提示会让页数凭空暴涨。
 * 写在 Vue 模板与 computed 里就只能靠手点验证，回归全靠运气。
 */

/**
 * 一键重打时恢复当时的出片范围。
 *
 * 留痕里 selection 存的是 0 基行号（仅部分出片时落盘，全量为 null）。
 * 漏掉这一步的后果：当初只打了 3 个人，补打却会打出全部 100 个人——
 * 一次误操作浪费一整包纸，而界面上看不出任何差别。
 *
 * @param {object} job 留痕记录
 * @returns {number[]|null} 0基行号数组；全量或数据异常时返回 null（走默认全量）
 */
function reprintScope(job) {
  const sel = job && job.selection
  if (!Array.isArray(sel) || !sel.length) return null
  const rows = sel
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0)
  // 全部行号都被判为非法 → 与全量等价，按全量走（而不是打出空集）
  if (!rows.length) return null
  return [...new Set(rows)].sort((a, b) => a - b)
}

/**
 * 多联回退提示文案。
 *
 * resolveLayout 在「成品放不下 2个 / 每页格数超上限」时会回退单页并给出 reason。
 * 不提示的后果：用户配好 2×3 多联，改小纸张后出片变成一页一张，
 * 页数从 10 页涨到 300 页，界面却什么都不说。
 *
 * 只在原mode 是 grid/fold 时给文案——单页版式本来就是 enabled:false，
 * 不该被当成「出问题了」。
 *
 * @param {object} layout buildBatchHtml 返回的 layout 字段
 * @returns {string} 提示文案，无需提示时为空串
 */
function layoutFallbackText(layout) {
  if (!layout || layout.enabled) return ''
  if (layout.mode !== 'grid' && layout.mode !== 'fold') return ''
  return layout.reason || '原版式无法在当前纸张上排布，已按单页出片'
}

module.exports = { reprintScope, layoutFallbackText }

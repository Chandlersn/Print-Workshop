/**
 * 行选择器 —— 数据集行的通用筛选/检测原语（纯函数，零依赖）。
 * 数据层（columnValues）与打印层（范围筛选、出口校验）共用，禁止各自另写。
 *
 * 设计原则：
 * - 筛选条件是纯数据结构：[{ key, values }]，条件间 AND，条件内值集合 OR
 * - 不含任何业务语义（"机构""证书"之类一律不出现）
 * - 占位值检测走值形态规则（括号包裹/纯标点），不写死业务字面量
 */

/** 行筛选：空筛选/空条件原样返回；只保留命中所有条件的行 */
function applyFilters(rows, filters) {
  if (!Array.isArray(filters)) return rows
  const conds = filters.filter(
    (f) => f && typeof f.key === 'string' && f.key && Array.isArray(f.values) && f.values.length > 0,
  )
  if (!conds.length) return rows
  return rows.filter((row) =>
    conds.every((c) => c.values.some((v) => String(v) === String(row[c.key] ?? ''))))
}

/**
 * 占位值检测（值形态规则）：
 * 1) 整值被成对括号包裹：（待补）、(TBD)、【占位】
 * 2) 仅由标点/符号构成：——、/、??、…
 * 命中只作「疑似占位」提示，绝不拦截、不等于空值。
 */
const PLACEHOLDER_SHAPES = [
  /^[（(【\[{<].+[）)】\]}>]$/,
  /^[\s\-—–_/\\.，。、;；:：?？!！*·~^°|｜]+$/,
]

function isPlaceholder(v) {
  const s = String(v ?? '').trim()
  if (!s) return false
  return PLACEHOLDER_SHAPES.some((re) => re.test(s))
}

module.exports = { applyFilters, isPlaceholder, PLACEHOLDER_SHAPES }

/**
 * 占位值检测 —— 纯函数、零依赖，打印出口校验专用。
 *
 * 设计原则：**只走值形态规则**（括号包裹 / 纯标点符号），不写死任何业务字面量，
 * 也不猜内容好坏。命中只作「疑似占位」提示，绝不拦截、不等于空值。
 */

/**
 * 占位值检测：
 * 1) 整值被成对括号包裹：（待补）、(TBD)、【占位】
 * 2) 仅由标点/符号构成：——、/、??、…
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

module.exports = { isPlaceholder, PLACEHOLDER_SHAPES }

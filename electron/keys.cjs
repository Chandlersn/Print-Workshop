/**
 * 键名规范化 —— 全项目唯一的「表头文本 → 存储键」转换函数。
 * 任何模块不得自写命名假设（workbench 双轨命名 bug 的教训）。
 *
 * 规则：去首尾空白；连续空白折叠为下划线；剔除安全字符集以外的符号
 * （保留中文、字母、数字、下划线）；空结果回退 'col'。
 */

// 允许保留：中英文字母、数字、下划线、空格（空格随后折叠为 _）
const UNSAFE_CHARS = /[^\w\u4e00-\u9fa5 ]/g

function normalizeHeaderKey(raw) {
  if (raw === null || raw === undefined) return 'col'
  const cleaned = String(raw).trim().replace(/\s+/g, '_').replace(UNSAFE_CHARS, '')
  return cleaned || 'col'
}

/**
 * 表头数组 → 列定义数组（带去重）。
 * key 规范化后如撞名，追加 _2 / _3；alias 保留用户原始表头。
 */
function buildColumns(headers) {
  const seen = new Map()
  return headers.map((raw, index) => {
    let key = normalizeHeaderKey(raw)
    const count = seen.get(key) || 0
    seen.set(key, count + 1)
    if (count > 0) key = `${key}_${count + 1}`
    const alias = raw === null || raw === undefined || String(raw).trim() === ''
      ? `列${index + 1}`
      : String(raw).trim()
    return { key, alias, type: 'text' }
  })
}

module.exports = { normalizeHeaderKey, buildColumns }

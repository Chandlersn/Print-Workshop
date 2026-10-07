/**
 * 数据页「列显隐」的纯逻辑（不依赖 Vue / DOM，Node 可直接测）。
 *
 * 隐藏状态按「数据集 id → 列 key 数组」存，落在**已有的** display-settings 里，
 * 不新开存储键（store 通道有白名单，且断言钉着「前端只能用两个键」）。
 *
 * 为什么记 key 而不是列序号或别名：key 由导入时的原始表头生成后落盘
 * （见 electron/keys.cjs），用户改别名不动 key、改数据不动顺序，
 * 只有它跨会话稳定。代价是重新导入同一个文件会生成新 key、隐藏状态不继承——
 * 这是可接受的，旧 key 会被 hiddenKeysOf 过滤掉，不会显示成「隐藏了 1 列」却看不见藏了谁。
 *
 * 硬规则：隐藏只影响数据页表格的渲染，与列上的「印」（该列是否进入模板设计页）
 * 完全无关。两者一旦耦合，用户隐藏一列就会让模板字段静默消失、打出白版。
 */

/** 落盘 JSON 是用户可手工编辑的：形状不对就当没存过，绝不把坏值带进渲染 */
function sanitizeHidden(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, keys] of Object.entries(raw)) {
    if (!id || !Array.isArray(keys)) continue
    const uniq = [...new Set(keys.filter((k) => typeof k === 'string' && k))]
    if (uniq.length) out[id] = uniq
  }
  return out
}

/** 当前数据集**真正存在**的隐藏列：盘上的旧 key（换过文件、列被改过）不算数 */
function hiddenKeysOf(map, datasetId, columns) {
  const known = new Set((columns || []).map((c) => c.key))
  const raw = (map && datasetId && map[datasetId]) || []
  return new Set(raw.filter((k) => known.has(k)))
}

/** 写回一份新的 map（不改入参）：去重；空集就删键，盘上不留一堆空数组 */
function withHidden(map, datasetId, keys) {
  const next = { ...(map || {}) }
  if (!datasetId) return next
  const uniq = [...new Set((keys || []).filter((k) => typeof k === 'string' && k))]
  if (uniq.length) next[datasetId] = uniq
  else delete next[datasetId]
  return next
}

function visibleColumnsOf(columns, hiddenKeys) {
  const hidden = hiddenKeys instanceof Set ? hiddenKeys : new Set(hiddenKeys || [])
  return (columns || []).filter((c) => !hidden.has(c.key))
}

/**
 * 至少留一列。空表看起来像坏了，而「已隐藏 N 列」胶囊只在有隐藏时才出现——
 * 真藏到 0 列，用户连回来的入口都找不到。
 */
function canHideMore(columns, hiddenKeys) {
  const total = (columns || []).length
  const hidden = hiddenKeys instanceof Set ? hiddenKeys.size : (hiddenKeys || []).length
  return total - hidden > 1
}

/**
 * 删掉已不存在的数据集留下的记录（长期使用后 map 会积攒垃圾）。
 * 数据集列表为空时不动手：可能是全删完了，也可能是列表读取异常，
 * 宁可留几条无用记录，也不要把用户的偏好一次抹掉。
 */
function pruneHidden(map, datasetIds) {
  const cur = map || {}
  const ids = datasetIds instanceof Set ? datasetIds : new Set(datasetIds || [])
  if (!ids.size) return { ...cur }
  const next = {}
  for (const [id, keys] of Object.entries(cur)) {
    if (ids.has(id)) next[id] = keys
  }
  return next
}

module.exports = {
  sanitizeHidden,
  hiddenKeysOf,
  withHidden,
  visibleColumnsOf,
  canHideMore,
  pruneHidden,
}

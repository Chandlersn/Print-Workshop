/** Pure editing operations. Inputs are untouched; geometry remains in absolute mm. */
const { normalizeDesign } = require('./design-layout.cjs')

function groupForLayer(doc, layerId) {
  return (doc.groups || []).find(group => group.layerIds.includes(layerId)) || null
}
function selectionIds(doc, ids, { expandGroups = true } = {}) {
  const selected = new Set(Array.isArray(ids) ? ids : [])
  if (expandGroups) {
    for (const group of doc.groups || []) if (group.layerIds.some(id => selected.has(id))) {
      for (const id of group.layerIds) selected.add(id)
    }
  }
  return doc.layers.filter(layer => selected.has(layer.id)).map(layer => layer.id)
}
function expandSelection(doc, ids) { return selectionIds(doc, ids) }
function editableSelection(doc, ids) {
  const selected = new Set(expandSelection(doc, ids))
  const locked = new Set(doc.layers.filter(layer => layer.locked).map(layer => layer.id))
  for (const group of doc.groups || []) if (group.layerIds.some(id => locked.has(id))) {
    for (const id of group.layerIds) locked.add(id)
  }
  return doc.layers.filter(layer => selected.has(layer.id) && !locked.has(layer.id)).map(layer => layer.id)
}
function selectLayer(doc, currentIds, layerId, { toggle = false } = {}) {
  const unit = expandSelection(doc, [layerId])
  if (!toggle) return unit
  const selected = new Set(expandSelection(doc, currentIds))
  const remove = unit.every(id => selected.has(id))
  for (const id of unit) remove ? selected.delete(id) : selected.add(id)
  return selectionIds(doc, [...selected])
}
function createGroup(input, ids, { id, name = '图层组' } = {}) {
  const doc = normalizeDesign(input)
  const selectedIds = expandSelection(doc, ids)
  if (selectedIds.length < 2) throw new Error('请至少选择两个图层后创建组')
  if (editableSelection(doc, ids).length !== selectedIds.length) throw new Error('所选图层组包含锁定图层，请先解锁再分组')
  const selected = new Set(selectedIds)
  const chosen = doc.layers.filter(layer => selected.has(layer.id))
  // Place the contiguous block at the topmost selected layer's former position.
  // Selected and unselected layers each retain their previous relative ordering.
  let insertion = 0
  let unselected = 0
  for (const layer of doc.layers) {
    if (selected.has(layer.id)) insertion = unselected
    else unselected++
  }
  const rest = doc.layers.filter(layer => !selected.has(layer.id))
  doc.layers = [...rest.slice(0, insertion), ...chosen, ...rest.slice(insertion)]
  doc.groups = doc.groups.filter(group => !group.layerIds.some(layerId => selected.has(layerId)))
  doc.groups.push({ id, name, layerIds: selectedIds })
  return normalizeDesign(doc)
}
function ungroupSelection(input, ids) {
  const doc = normalizeDesign(input)
  const selected = new Set(selectionIds(doc, ids))
  doc.groups = doc.groups.filter(group => !group.layerIds.some(id => selected.has(id)))
  return normalizeDesign(doc)
}
function duplicateSelection(input, ids, { makeId, dx = 3, dy = 3, expandGroups = true } = {}) {
  const doc = normalizeDesign(input)
  const selectedIds = selectionIds(doc, ids, { expandGroups })
  if (!selectedIds.length) return { design: doc, selectedIds: [] }
  if (typeof makeId !== 'function') throw new Error('复制图层需要新的标识生成函数')
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('复制偏移必须为有效数值')
  const selected = new Set(selectedIds)
  const allIds = new Set([...doc.layers.map(layer => layer.id), ...doc.groups.map(group => group.id)])
  const newIds = new Map()
  function fresh(kind) {
    const id = makeId(kind)
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || allIds.has(id)) throw new Error('复制时产生了无效或重复的标识')
    allIds.add(id)
    return id
  }
  const copies = doc.layers.filter(layer => selected.has(layer.id)).map(layer => {
    const id = fresh('layer')
    newIds.set(layer.id, id)
    return { ...layer, id, name: `${layer.name.slice(0, 117)} 副本`, x: Math.round((layer.x + dx) * 1000) / 1000, y: Math.round((layer.y + dy) * 1000) / 1000, locked: false }
  })
  const copiedGroups = doc.groups.filter(group => group.layerIds.every(id => selected.has(id))).map(group => ({ id: fresh('group'), name: `${group.name.slice(0, 117)} 副本`, layerIds: group.layerIds.map(id => newIds.get(id)) }))
  doc.layers.push(...copies)
  doc.groups.push(...copiedGroups)
  return { design: normalizeDesign(doc), selectedIds: copies.map(layer => layer.id) }
}
function removeSelection(input, ids, { expandGroups = true } = {}) {
  const doc = normalizeDesign(input)
  const before = selectionIds(doc, ids, { expandGroups })
  const allowed = new Set(editableSelection(doc, ids))
  const removed = new Set(before.filter(id => allowed.has(id)))
  doc.layers = doc.layers.filter(layer => !removed.has(layer.id))
  // Explicit member deletion leaves the remaining layers grouped until only one remains.
  doc.groups = doc.groups.map(group => ({ ...group, layerIds: group.layerIds.filter(id => !removed.has(id)) })).filter(group => group.layerIds.length >= 2)
  return { design: normalizeDesign(doc), selectedIds: before.filter(id => !removed.has(id)) }
}
function reorderSelection(input, ids, direction) {
  const doc = normalizeDesign(input)
  if (!['up', 'down', 'top', 'bottom'].includes(direction)) throw new Error('图层排序方向无效')
  const selected = new Set(editableSelection(doc, ids))
  const units = []
  for (let i = 0; i < doc.layers.length;) {
    const group = groupForLayer(doc, doc.layers[i].id)
    const count = group ? group.layerIds.length : 1
    units.push(doc.layers.slice(i, i + count))
    i += count
  }
  const chosen = unit => unit.every(layer => selected.has(layer.id))
  let reordered
  if (direction === 'top' || direction === 'bottom') {
    const moved = units.filter(chosen), rest = units.filter(unit => !chosen(unit))
    reordered = direction === 'top' ? [...rest, ...moved] : [...moved, ...rest]
  } else {
    reordered = [...units]
    if (direction === 'up') {
      for (let i = reordered.length - 2; i >= 0; i--) if (chosen(reordered[i]) && !chosen(reordered[i + 1])) [reordered[i], reordered[i + 1]] = [reordered[i + 1], reordered[i]]
    } else {
      for (let i = 1; i < reordered.length; i++) if (chosen(reordered[i]) && !chosen(reordered[i - 1])) [reordered[i], reordered[i - 1]] = [reordered[i - 1], reordered[i]]
    }
  }
  doc.layers = reordered.flat()
  return normalizeDesign(doc)
}

const STYLE_KEYS = Object.freeze({
  image: ['opacity', 'blend', 'stroke', 'strokeWidth', 'shadow', 'adjust'],
  text: ['opacity', 'blend', 'fontFamily', 'fontSize', 'bold', 'color', 'align', 'lineHeight', 'letterSpacing'],
  shape: ['opacity', 'blend', 'fill', 'stroke', 'strokeWidth', 'radius', 'fillPaint', 'shadow'],
  line: ['opacity', 'blend', 'stroke', 'strokeWidth'],
})
// Vue stores the copied style in a reactive ref. Its nested values become Proxies,
// which structuredClone rejects; all style fields are JSON primitives/objects.
const copyStyleValue = value => value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
function styleKind(layer) {
  return layer.type === 'rect' || layer.type === 'ellipse' ? 'shape' : layer.type
}
function copyLayerStyle(input, layerId) {
  const doc = normalizeDesign(input)
  const layer = doc.layers.find(item => item.id === layerId)
  if (!layer) throw new Error('找不到要复制样式的图层')
  const kind = styleKind(layer)
  const values = {}
  for (const key of STYLE_KEYS[kind]) if (Object.hasOwn(layer, key)) values[key] = copyStyleValue(layer[key])
  return { kind, values }
}
function applyLayerStyle(input, ids, style) {
  const doc = normalizeDesign(input)
  if (!style || !Object.hasOwn(STYLE_KEYS, style.kind) || !style.values || typeof style.values !== 'object') throw new Error('复制的样式无效')
  // The layer list permits selecting one member inside a group. Keep that
  // explicit selection; editableSelection still enforces whole-group locks.
  const explicit = new Set(selectionIds(doc, ids, { expandGroups: false }))
  const chosen = new Set(editableSelection(doc, ids).filter(id => explicit.has(id)))
  let applied = 0
  for (const layer of doc.layers) {
    if (!chosen.has(layer.id) || styleKind(layer) !== style.kind) continue
    for (const key of STYLE_KEYS[style.kind]) {
      if (Object.hasOwn(style.values, key)) layer[key] = copyStyleValue(style.values[key])
      else delete layer[key]
    }
    applied++
  }
  if (!applied) throw new Error('没有可应用该样式的未锁定图层')
  return { design: normalizeDesign(doc), applied }
}

const roundGeometry = value => Math.round(value * 1000) / 1000 || 0
/** Apply one uniform scale and/or rotation about the visible group's shared box. */
function transformGroup(input, groupId, { scale = 1, rotation = 0 } = {}) {
  const doc = normalizeDesign(input)
  const group = doc.groups.find(item => item.id === groupId)
  if (!group) throw new Error('找不到图层组')
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 4 || !Number.isFinite(rotation) || Math.abs(rotation) > 360) throw new Error('整组缩放或旋转超出有效范围')
  if (editableSelection(doc, group.layerIds).length !== group.layerIds.length) throw new Error('图层组包含锁定图层，请先解锁')
  const members = doc.layers.filter(layer => group.layerIds.includes(layer.id))
  const corners = members.flatMap(layer => {
    const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2
    const radians = layer.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians)
    return [-1, 1].flatMap(sx => [-1, 1].map(sy => ({
      x: cx + sx * layer.w / 2 * cos - sy * layer.h / 2 * sin,
      y: cy + sx * layer.w / 2 * sin + sy * layer.h / 2 * cos,
    })))
  })
  const pivotX = (Math.min(...corners.map(point => point.x)) + Math.max(...corners.map(point => point.x))) / 2
  const pivotY = (Math.min(...corners.map(point => point.y)) + Math.max(...corners.map(point => point.y))) / 2
  const radians = rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians)
  for (const layer of members) {
    const dx = (layer.x + layer.w / 2 - pivotX) * scale
    const dy = (layer.y + layer.h / 2 - pivotY) * scale
    const centerX = pivotX + dx * cos - dy * sin
    const centerY = pivotY + dx * sin + dy * cos
    layer.w = roundGeometry(layer.w * scale)
    layer.h = roundGeometry(layer.h * scale)
    layer.x = roundGeometry(centerX - layer.w / 2)
    layer.y = roundGeometry(centerY - layer.h / 2)
    layer.rotation = roundGeometry(layer.rotation + rotation)
    if (layer.type === 'text') {
      layer.fontSize = roundGeometry(layer.fontSize * scale)
      layer.letterSpacing = roundGeometry(layer.letterSpacing * scale)
    }
    if (layer.strokeWidth !== undefined) layer.strokeWidth = roundGeometry(layer.strokeWidth * scale)
    if (layer.radius !== undefined) layer.radius = roundGeometry(layer.radius * scale)
    if (layer.shadow) for (const key of ['dxMm', 'dyMm', 'blurMm']) layer.shadow[key] = roundGeometry(layer.shadow[key] * scale)
  }
  return normalizeDesign(doc)
}

module.exports = { groupForLayer, selectionIds, expandSelection, editableSelection, selectLayer, createGroup, ungroupSelection, duplicateSelection, removeSelection, reorderSelection, copyLayerStyle, applyLayerStyle, transformGroup }

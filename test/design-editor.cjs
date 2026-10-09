/** Groups and guides: edit geometry, immutable operations, and durable metadata. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const { normalizeDesign, renderDesign, LIMITS } = require('../electron/design-layout.cjs')
const edit = require('../electron/design-editor.cjs')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-design-editor-'))
process.env.PRINTPRESS_DATA_DIR = tmp
const designs = require('../electron/designs.cjs')
let passed = 0
function check(name, run) { run(); passed++; console.log(`  ok - ${name}`) }
function document() {
  return normalizeDesign({ schemaVersion: 1, name: '分组参考线验收', artboard: { w: 210, h: 148 }, layers: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, type: 'rect', name: id, x: i * 10, y: i * 4, w: 30 + i, h: 20, rotation: 10 * i, visible: true, locked: false })), assets: {} })
}
const layerIds = doc => doc.layers.map(layer => layer.id)
const geometry = doc => Object.fromEntries(doc.layers.map(({ id, x, y, w, h, rotation }) => [id, { x, y, w, h, rotation }]))
function grouped() { return edit.createGroup(document(), ['b', 'c'], { id: 'group-bc', name: '标题与边框' }) }
try {
  check('旧工程保持 schema 1，非空分组或参考线升级到 2；移除功能后不降级', () => {
    const legacy = document()
    assert.equal(legacy.schemaVersion, 1)
    assert.deepEqual(legacy.groups, [])
    assert.deepEqual(legacy.guides, [])
    const groupedDoc = grouped()
    assert.equal(groupedDoc.schemaVersion, 2)
    assert.equal(edit.ungroupSelection(groupedDoc, ['b']).schemaVersion, 2)
    assert.equal(normalizeDesign({ ...legacy, guides: [{ id: 'vertical', axis: 'x', position: 20 }] }).schemaVersion, 2)
    assert.throws(() => normalizeDesign({ ...legacy, schemaVersion: 3 }), /版本/)
  })
  check('非相邻成员连续化保留成员次序及绝对几何，输入保持不变', () => {
    const input = document(), before = JSON.stringify(input)
    const result = edit.createGroup(input, ['d', 'b'], { id: 'group-bd', name: '非相邻组' })
    assert.deepEqual(layerIds(result), ['a', 'c', 'b', 'd', 'e'])
    assert.deepEqual(result.groups[0].layerIds, ['b', 'd'])
    assert.deepEqual(geometry(result), geometry(input))
    assert.equal(JSON.stringify(input), before)
    assert.throws(() => edit.createGroup(input, ['a'], { id: 'single' }), /至少选择两个/)
  })
  check('组合已有组会完整合并，未选择的完整组保留连续顺序', () => {
    let doc = grouped()
    doc = edit.createGroup(doc, ['d', 'e'], { id: 'group-de', name: '另一组' })
    const result = edit.createGroup(doc, ['b', 'a'], { id: 'merged', name: '合并' })
    assert.equal(result.groups.length, 2)
    assert.deepEqual(result.groups.find(group => group.id === 'merged').layerIds, ['a', 'b', 'c'])
    assert.deepEqual(result.groups.find(group => group.id === 'group-de').layerIds, ['d', 'e'])
  })
  check('默认选组、修饰键切换整组，成员编辑可显式保留单层选择', () => {
    const doc = grouped()
    assert.deepEqual(edit.selectLayer(doc, [], 'b'), ['b', 'c'])
    assert.deepEqual(edit.selectLayer(doc, ['a'], 'b', { toggle: true }), ['a', 'b', 'c'])
    assert.deepEqual(edit.selectLayer(doc, ['a', 'b', 'c'], 'c', { toggle: true }), ['a'])
    assert.deepEqual(edit.selectionIds(doc, ['b'], { expandGroups: false }), ['b'])
    assert.deepEqual(edit.expandSelection(doc, ['b', 'missing', 'b']), ['b', 'c'])
    assert.equal(edit.groupForLayer(doc, 'c').id, 'group-bc')
    assert.equal(edit.groupForLayer(doc, 'a'), null)
  })
  check('解散分组不改变几何、绘制次序或原始文档', () => {
    const doc = grouped(), before = JSON.stringify(doc)
    const result = edit.ungroupSelection(doc, ['c'])
    assert.deepEqual(result.groups, [])
    assert.deepEqual(result.layers, doc.layers)
    assert.equal(JSON.stringify(doc), before)
  })
  check('复制完整组生成全新图层与组标识，副本独立且原件不变', () => {
    const doc = grouped(), before = JSON.stringify(doc)
    let nextId = 0
    const result = edit.duplicateSelection(doc, ['c'], { makeId: type => `${type}-copy-${++nextId}` })
    assert.equal(result.design.layers.length, 7)
    assert.deepEqual(result.selectedIds, ['layer-copy-1', 'layer-copy-2'])
    assert.equal(result.design.groups[1].id, 'group-copy-3')
    assert.deepEqual(result.design.groups[1].layerIds, result.selectedIds)
    assert.equal(result.design.layers[5].x, doc.layers[1].x + 3)
    assert.equal(result.design.layers[6].rotation, doc.layers[2].rotation)
    result.design.layers[5].x = 999
    assert.equal(JSON.stringify(doc), before)
    assert.throws(() => edit.duplicateSelection(doc, ['b'], { makeId: () => 'b' }), /重复/)
    const duplicateIds = ['new-layer-1', 'new-layer-2', 'group-bc']
    assert.throws(() => edit.duplicateSelection(doc, ['b'], { makeId: () => duplicateIds.shift() }), /重复/)
    assert.equal(JSON.stringify(doc), before)
  })
  check('显式成员复制仅复制选中层，完整组选中仍复制组；原组不变', () => {
    const doc = grouped(), before = JSON.stringify(doc)
    let counter = 0
    const partial = edit.duplicateSelection(doc, ['c'], { expandGroups: false, makeId: kind => `${kind}-${++counter}` })
    assert.deepEqual(partial.selectedIds, ['layer-1'])
    assert.equal(partial.design.layers.length, 6)
    assert.deepEqual(partial.design.groups, doc.groups)
    assert.equal(edit.groupForLayer(partial.design, 'layer-1'), null)
    const whole = edit.duplicateSelection(doc, ['b', 'c'], { expandGroups: false, makeId: kind => `${kind}-${++counter}` })
    assert.equal(whole.design.groups.length, 2)
    assert.deepEqual(whole.design.groups[1].layerIds, whole.selectedIds)
    assert.equal(JSON.stringify(doc), before)
  })
  check('锁定任一组员保护完整组免于移动、删除和重排', () => {
    const doc = grouped()
    doc.layers.find(layer => layer.id === 'c').locked = true
    assert.deepEqual(edit.editableSelection(doc, ['b', 'a']), ['a'])
    const removed = edit.removeSelection(doc, ['b', 'a'])
    assert.deepEqual(layerIds(removed.design), ['b', 'c', 'd', 'e'])
    assert.deepEqual(removed.selectedIds, ['b', 'c'])
    assert.deepEqual(removed.design.groups, doc.groups)
    assert.deepEqual(edit.reorderSelection(doc, ['b'], 'top'), doc)
    assert.throws(() => edit.createGroup(doc, ['b', 'e'], { id: 'blocked' }), /锁定/)
    let id = 0
    const duplicate = edit.duplicateSelection(doc, ['b'], { makeId: type => `${type}-${++id}` })
    assert.equal(duplicate.design.layers.find(layer => layer.id === 'c').locked, true)
    assert.equal(duplicate.design.layers.slice(-2).some(layer => layer.locked), false)
  })
  check('删除任一组员按完整组执行，不留下悬空成员或删除素材', () => {
    const doc = grouped()
    const result = edit.removeSelection(doc, ['c'])
    assert.deepEqual(layerIds(result.design), ['a', 'd', 'e'])
    assert.deepEqual(result.design.groups, [])
    assert.deepEqual(result.selectedIds, [])
    assert.deepEqual(result.design.assets, doc.assets)
    assert.equal(doc.layers.length, 5)
  })
  check('显式成员删除只删选中层，剩余两层保持组，剩余单层自动解组', () => {
    const doc = edit.createGroup(document(), ['b', 'c', 'd'], { id: 'three', name: '三个成员' })
    const before = JSON.stringify(doc)
    const two = edit.removeSelection(doc, ['c'], { expandGroups: false })
    assert.deepEqual(layerIds(two.design), ['a', 'b', 'd', 'e'])
    assert.deepEqual(two.design.groups[0].layerIds, ['b', 'd'])
    assert.deepEqual(two.selectedIds, [])
    const one = edit.removeSelection(two.design, ['d'], { expandGroups: false })
    assert.deepEqual(layerIds(one.design), ['a', 'b', 'e'])
    assert.deepEqual(one.design.groups, [])
    assert.deepEqual(one.design.layers.find(layer => layer.id === 'b'), doc.layers.find(layer => layer.id === 'b'))
    assert.equal(JSON.stringify(doc), before)
  })
  check('显式成员删除仍保护含锁定成员的组，只删除同次选择中的独立可编辑层', () => {
    const doc = grouped()
    doc.layers.find(layer => layer.id === 'c').locked = true
    const result = edit.removeSelection(doc, ['a', 'b'], { expandGroups: false })
    assert.deepEqual(layerIds(result.design), ['b', 'c', 'd', 'e'])
    assert.deepEqual(result.selectedIds, ['b'])
    assert.deepEqual(result.design.groups, doc.groups)
    assert.deepEqual(result.design.layers.filter(layer => ['b', 'c'].includes(layer.id)), doc.layers.filter(layer => ['b', 'c'].includes(layer.id)))
  })
  check('上移下移跨越完整组，置顶置底保持多组内部次序', () => {
    const doc = grouped()
    assert.deepEqual(layerIds(edit.reorderSelection(doc, ['a'], 'up')), ['b', 'c', 'a', 'd', 'e'])
    assert.deepEqual(layerIds(edit.reorderSelection(doc, ['d'], 'down')), ['a', 'd', 'b', 'c', 'e'])
    assert.deepEqual(layerIds(edit.reorderSelection(doc, ['b'], 'top')), ['a', 'd', 'e', 'b', 'c'])
    assert.deepEqual(layerIds(edit.reorderSelection(doc, ['b', 'e'], 'bottom')), ['b', 'c', 'e', 'a', 'd'])
    const two = edit.createGroup(doc, ['d', 'e'], { id: 'group-de', name: '另一组' })
    const result = edit.reorderSelection(two, ['b'], 'up')
    assert.deepEqual(layerIds(result), ['a', 'd', 'e', 'b', 'c'])
    assert.deepEqual(result.groups.find(group => group.id === 'group-bc').layerIds, ['b', 'c'])
  })
  check('组成员重复、跨组、缺失、非连续及超限输入均被拒绝', () => {
    const doc = document()
    for (const groups of [
      [{ id: 'g', name: 'g', layerIds: ['a', 'a'] }],
      [{ id: 'g', name: 'g', layerIds: ['a', 'missing'] }],
      [{ id: 'g', name: 'g', layerIds: ['a', 'c'] }],
      [{ id: 'g', name: 'g', layerIds: ['a'] }],
      [{ id: 'g', name: 'g', layerIds: ['a', 'b'] }, { id: 'h', name: 'h', layerIds: ['b', 'c'] }],
      [{ id: 'g', name: 'g', layerIds: ['a', 'b'] }, { id: 'g', name: 'h', layerIds: ['c', 'd'] }],
      [{ id: 'a', name: 'g', layerIds: ['a', 'b'] }],
      Array.from({ length: LIMITS.groups + 1 }, () => ({})),
    ]) assert.throws(() => normalizeDesign({ ...doc, groups }), /图层|组|成员/)
  })
  check('参考线验证单位、方向、有限数值和数量，且允许画布尺寸改变后保留线', () => {
    const doc = document()
    const guides = [{ id: 'x1', axis: 'x', position: 20.5 }, { id: 'y1', axis: 'y', position: 999 }]
    assert.deepEqual(normalizeDesign({ ...doc, guides }).guides, guides)
    for (const invalid of [
      [{ id: 'g', axis: 'z', position: 20 }],
      [{ id: 'g', axis: 'x', position: Infinity }],
      [{ id: 'g', axis: 'x', position: '' }],
      [{ id: 'g', axis: 'x', position: 10001 }],
      [{ id: 'g', axis: 'x', position: 1 }, { id: 'g', axis: 'y', position: 2 }],
      Array.from({ length: LIMITS.guides + 1 }, () => ({})),
    ]) assert.throws(() => normalizeDesign({ ...doc, guides: invalid }), /参考线/)
  })
  check('分组与参考线不进入渲染；保存重开和固定历史版完整保留辅助元数据', () => {
    const flat = document()
    const doc = { ...grouped(), guides: [{ id: 'ruler-vertical', axis: 'x', position: 30.25 }] }
    assert.deepEqual(renderDesign(doc), renderDesign(flat))
    const first = designs.saveDesign(doc)
    assert.equal(first.schemaVersion, 2)
    assert.deepEqual(designs.getDesign(first.id), first)
    const second = designs.saveDesign({ ...edit.ungroupSelection(first, ['b']), guides: [] })
    assert.deepEqual(second.groups, [])
    assert.deepEqual(designs.getDesign(first.id, 1).groups, first.groups)
    assert.deepEqual(designs.getDesign(first.id, 1).guides, first.guides)
    const legacy = designs.saveDesign(flat)
    assert.equal(legacy.schemaVersion, 1)
  })
  console.log(`\n${passed} design editor acceptance groups passed`)
} finally {
  const relative = path.relative(__dirname, tmp)
  if (!relative.startsWith('.tmp-design-editor-') || relative.includes(path.sep)) throw new Error('测试目录清理路径不安全')
  rmDeep(tmp)
}

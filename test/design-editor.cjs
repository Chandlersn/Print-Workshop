/** Groups and guides: edit geometry, immutable operations, and durable metadata. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const { normalizeDesign, renderDesign, LIMITS, SCHEMA_VERSIONS } = require('../electron/design-layout.cjs')
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
    // 取「已支持的最大版本 + 1」，别写死数字——写死会在下次抬版本时变成假失败。
    assert.throws(() => normalizeDesign({ ...legacy, schemaVersion: Math.max(...SCHEMA_VERSIONS) + 1 }), /版本/)
  })
  check('版本号取各特性最大值，已是高版本时不被分组倒标成旧格式', () => {
    const legacy = document()
    // 旧实现直接 `schemaVersion = 2`，会把「格式 3 + 恰好有分组」倒标成 2，等于给旧读者开静默降级口子。
    const mixed = normalizeDesign({ ...grouped(), schemaVersion: 3 })
    assert.equal(mixed.schemaVersion, 3)
    assert.equal(normalizeDesign({ ...legacy, schemaVersion: 2 }).schemaVersion, 2)
    assert.equal(normalizeDesign({ ...legacy, schemaVersion: 3 }).schemaVersion, 3)
  })
  check('仅编辑可见的图层升级到格式 3，默认关闭且旧工程不受影响', () => {
    const legacy = document()
    assert.ok(legacy.layers.every(layer => layer.editorOnly === false))
    assert.equal(legacy.schemaVersion, 1)
    const withRef = normalizeDesign({
      ...legacy,
      layers: legacy.layers.map((layer, i) => (i === 0 ? { ...layer, editorOnly: true } : layer)),
    })
    assert.equal(withRef.layers[0].editorOnly, true)
    assert.equal(withRef.schemaVersion, 3)
    assert.throws(() => normalizeDesign({ ...legacy, layers: [{ ...legacy.layers[0], editorOnly: 'yes' }] }), /仅编辑可见/)
  })
  check('仅编辑可见的图层默认不渲染，显式要求时才进画布', () => {
    const doc = normalizeDesign({
      ...document(),
      layers: document().layers.map((layer, i) => (i === 0 ? { ...layer, editorOnly: true, name: '参考框' } : layer)),
    })
    const printed = renderDesign(doc)
    assert.ok(!printed.html.includes('data-design-layer="a"'))
    assert.ok(printed.html.includes('data-design-layer="b"'))
    const editor = renderDesign(doc, { includeEditorOnly: true })
    assert.ok(editor.html.includes('data-design-layer="a"'))
    // 隐藏图层仍然谁都不渲染，两个开关互不越权
    const hidden = normalizeDesign({ ...doc, layers: doc.layers.map((layer, i) => (i === 1 ? { ...layer, visible: false } : layer)) })
    assert.ok(!renderDesign(hidden, { includeEditorOnly: true }).html.includes('data-design-layer="b"'))
  })
  check('参考框引用的上传字体不参与出片，不会因字体缺失阻断打印', () => {
    const doc = normalizeDesign({
      ...document(),
      layers: [
        { id: 'ref', type: 'text', name: '参考框', text: '身份证正面', fontFamily: '仅编辑器字体', x: 0, y: 0, w: 40, h: 10, editorOnly: true },
        { id: 'real', type: 'text', name: '正文', text: '姓名', fontFamily: '打印字体', x: 0, y: 20, w: 40, h: 10 },
      ],
    })
    assert.deepEqual(renderDesign(doc).fontFamilies, ['打印字体'])
    assert.deepEqual(renderDesign(doc, { includeEditorOnly: true }).fontFamilies, ['仅编辑器字体', '打印字体'])
    // 「某字体是否仍被工程引用」保持全量口径：编辑器里还在用的字体不能被当成孤儿清掉
    const { collectFontFamilies } = require('../electron/design-layout.cjs')
    assert.deepEqual(collectFontFamilies(doc), ['仅编辑器字体', '打印字体'])
    assert.deepEqual(collectFontFamilies(doc, { includeEditorOnly: false }), ['打印字体'])
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
  check('主进程写回的素材元数据（EXIF orientation）必须能过规范化，否则带图工程永远显示「未保存」', () => {
    // I-49 起 `readAsset` 每次保存都按受信任原件把 orientation 写回素材记录。
    //  normalizeDesign 若不放行，「保存 → 写回 → 再规范化」就不是不动点：渲染侧
    //  `fingerprint(design)` 与 `fingerprint(已保存文档)` 永远差这一个字段，
    // 界面一保存就仍旧是「未保存」（design-e2e「保存裁切图层」实测到的失败）。
    const assetId = 'asset_photo'
    const asset = { id: assetId, path: `design-assets/${'a'.repeat(64)}.jpg`, width: 800, height: 1200, name: '竖拍照片.jpg', mime: 'image/jpeg', orientation: 6, source: 'ephemeral' }
    const doc = normalizeDesign({
      ...document(),
      layers: [...document().layers, { id: 'photo', type: 'image', name: '照片', assetId, x: 0, y: 0, w: 40, h: 60 }],
      assets: { [assetId]: asset },
    })
    assert.equal(doc.assets[assetId].orientation, 6)
    assert.deepEqual(normalizeDesign(doc), doc)
    // 老工程没有这个字段时保持没有：不凭空给旧数据加字段（I-42 的兜底方向）
    const legacyAsset = { ...asset }
    delete legacyAsset.orientation
    const legacy = normalizeDesign({ ...doc, assets: { [assetId]: legacyAsset } })
    assert.ok(!('orientation' in legacy.assets[assetId]))
    assert.throws(() => normalizeDesign({ ...doc, assets: { [assetId]: { ...asset, orientation: 9 } } }), /EXIF 方向/)
    // 分池后（I-51）临时件原件的 path 是 ephemeral-assets/<hash>.<ext>：主进程按真身
    // 写回的也必须是这个值，否则粘贴图的工程一保存就仍旧显示「未保存」。
    const poolAsset = { ...asset, id: 'asset_poolphoto', path: `ephemeral-assets/${'b'.repeat(64)}.jpg` }
    const poolDoc = normalizeDesign({
      ...document(),
      layers: [...document().layers, { id: 'photo2', type: 'image', name: '临时图', assetId: poolAsset.id, x: 0, y: 0, w: 40, h: 60 }],
      assets: { [poolAsset.id]: poolAsset },
    })
    assert.deepEqual(normalizeDesign(poolDoc), poolDoc, '临时池路径必须同样是不动点')
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
  check('复制图片样式到多张变量照片，保留内容、位置与素材引用，可整体撤销', () => {
    const doc = normalizeDesign({ ...document(), layers: [
      { id: 'source', type: 'image', variable: true, bindColumn: '姓名', x: 4, y: 8, w: 25, h: 35,
        stroke: '#ffffff', strokeWidth: 1, shadow: { dxMm: 1, dyMm: 2, blurMm: 1, color: '#000000', opacity: 0.3 },
        adjust: { brightness: 1.2, contrast: 1.1 }, blend: 'multiply' },
      { id: 'target1', type: 'image', variable: true, bindColumn: '编号', x: 50, y: 20, w: 35, h: 45, stroke: '#ff0000', strokeWidth: 2 },
      { id: 'target2', type: 'image', variable: true, bindColumn: '工号', x: 100, y: 40, w: 25, h: 35 },
    ] })
    const before = JSON.stringify(doc)
    const style = edit.copyLayerStyle(doc, 'source')
    const result = edit.applyLayerStyle(doc, ['target1', 'target2'], style)
    assert.equal(result.applied, 2)
    for (const layer of result.design.layers.slice(1)) {
      assert.equal(layer.strokeWidth, 1)
      assert.deepEqual(layer.shadow, doc.layers[0].shadow)
      assert.deepEqual(layer.adjust, doc.layers[0].adjust)
      assert.equal(layer.blend, 'multiply')
    }
    assert.equal(result.design.layers[1].bindColumn, '编号')
    assert.deepEqual([result.design.layers[1].x, result.design.layers[1].y, result.design.layers[1].w, result.design.layers[1].h], [50, 20, 35, 45])
    result.design.layers[1].shadow.dxMm = 9
    assert.equal(result.design.layers[2].shadow.dxMm, 1)
    assert.equal(JSON.stringify(doc), before)
    assert.deepEqual(normalizeDesign(JSON.parse(before)), doc)
    const reactiveStyle = require('vue').reactive(style)
    assert.equal(edit.applyLayerStyle(doc, ['target1'], reactiveStyle).design.layers[1].shadow.dxMm, 1)
  })
  check('无描边的图片样式会清除目标旧效果，异类和锁定图层不会被涂刷', () => {
    const doc = normalizeDesign({ ...document(), layers: [
      { id: 'plain', type: 'image', variable: true, bindColumn: '姓名' },
      { id: 'styled', type: 'image', variable: true, bindColumn: '编号', stroke: '#ffffff', strokeWidth: 2 },
      { id: 'locked', type: 'image', variable: true, bindColumn: '工号', locked: true, stroke: '#ffffff', strokeWidth: 2 },
      { id: 'text', type: 'text', text: '不改' },
    ] })
    const result = edit.applyLayerStyle(doc, ['styled', 'locked', 'text'], edit.copyLayerStyle(doc, 'plain'))
    assert.equal(result.applied, 1)
    assert.equal(result.design.layers[1].strokeWidth, undefined)
    assert.equal(result.design.layers[2].strokeWidth, 2)
    assert.equal(result.design.layers[3].text, '不改')
    assert.throws(() => edit.applyLayerStyle(doc, ['text'], edit.copyLayerStyle(doc, 'plain')), /同类|样式/)
  })
  check('样式只作用于显式选中的组成员；文字格式复制保留各自内容与位置', () => {
    const doc = normalizeDesign({ ...document(), layers: [
      { id: 'source', type: 'text', text: '源', fontSize: 30, color: '#ff0000', x: 5 },
      { id: 'first', type: 'text', text: '甲', x: 20 },
      { id: 'second', type: 'text', text: '乙', x: 40 },
    ], groups: [{ id: 'words', name: '两行', layerIds: ['first', 'second'] }] })
    const result = edit.applyLayerStyle(doc, ['first'], edit.copyLayerStyle(doc, 'source'))
    assert.equal(result.applied, 1)
    assert.deepEqual(result.design.layers.map(layer => layer.text), ['源', '甲', '乙'])
    assert.deepEqual(result.design.layers.map(layer => layer.x), [5, 20, 40])
    assert.equal(result.design.layers[1].fontSize, 30)
    assert.equal(result.design.layers[2].fontSize, 24)
  })
  check('整组缩放和旋转按共同中心计算，文字及边框同步缩放，出片几何与工程一致', () => {
    const doc = normalizeDesign({ ...document(), layers: [
      { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, strokeWidth: 1 },
      { id: 'b', type: 'text', text: '标题', x: 20, y: 0, w: 10, h: 10, fontSize: 20, letterSpacing: 2 },
    ], groups: [{ id: 'ab', name: '组', layerIds: ['a', 'b'] }] })
    const original = JSON.stringify(doc)
    const scaled = edit.transformGroup(doc, 'ab', { scale: 2 })
    assert.deepEqual(scaled.layers.map(layer => [layer.x, layer.y, layer.w, layer.h]), [[-15, -5, 20, 20], [25, -5, 20, 20]])
    assert.equal(scaled.layers[0].strokeWidth, 2)
    assert.equal(scaled.layers[1].fontSize, 40)
    assert.equal(scaled.layers[1].letterSpacing, 4)
    const rotated = edit.transformGroup(doc, 'ab', { rotation: 180 })
    assert.deepEqual(rotated.layers.map(layer => [layer.x, layer.y, layer.rotation]), [[20, 0, 180], [0, 0, 180]])
    assert.ok(renderDesign(scaled).html.includes('40pt'))
    assert.equal(JSON.stringify(doc), original)
    assert.deepEqual(normalizeDesign(scaled), scaled)
    const locked = normalizeDesign({ ...doc, layers: [{ ...doc.layers[0], locked: true }, doc.layers[1]] })
    assert.throws(() => edit.transformGroup(locked, 'ab', { scale: 2 }), /锁定/)
    assert.throws(() => edit.transformGroup(doc, 'ab', { scale: 0 }), /范围/)
  })
  console.log(`\n${passed} design editor acceptance groups passed`)
} finally {
  const relative = path.relative(__dirname, tmp)
  if (!relative.startsWith('.tmp-design-editor-') || relative.includes(path.sep)) throw new Error('测试目录清理路径不安全')
  rmDeep(tmp)
}

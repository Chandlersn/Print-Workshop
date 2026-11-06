const assert = require('assert/strict')
const { normalizeDesign, renderDesign } = require('../electron/design-layout.cjs')
const { normalizeErasures, cropImageLayer, referenceImageLayer, EDIT_LIMITS } = require('../electron/design-image-edit.cjs')
const { bakeTargets, bakeGeometry, bakeName } = require('../electron/output-dpi.cjs')
const id = 'a'.repeat(64)
const asset = { id, path: `design-assets/${id}.png`, mime: 'image/png', name: 'source.png', width: 400, height: 300 }
const image = { id: 'photo', type: 'image', assetId: id, x: 10, y: 20, w: 80, h: 60, rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }
const doc = layer => ({ schemaVersion: 1, name: '精确图片编辑', artboard: { w: 120, h: 100 }, assets: { [id]: asset }, layers: [layer] })
const erasures = [{ type: 'rect', x: 100, y: 75, w: 20, h: 15 }, { type: 'brush', size: 5, points: [{ x: 200, y: 150 }, { x: 240, y: 180 }] }]
const normalized = normalizeDesign(doc({ ...image, erasures }))
assert.equal(normalized.schemaVersion, 8)
assert.deepEqual(normalizeDesign(normalized), normalized, '重复规范化与保存读取不能丢擦除')
assert.deepEqual(normalized.layers[0].erasures, erasures)
assert.equal(normalizeDesign(doc(image)).schemaVersion, 1)
assert.ok(!('erasures' in normalizeDesign(doc({ ...image, erasures: [] })).layers[0]))
for (const invalid of [null, {}, [{ type: 'rect', x: 399, y: 1, w: 2, h: 2 }], [{ type: 'rect', x: -1, y: 1, w: 2, h: 2 }], [{ type: 'brush', size: 0, points: [{ x: 2, y: 2 }] }], [{ type: 'brush', size: 1, points: [{ x: Infinity, y: 2 }] }], [{ type: 'brush', size: 1, points: [] }], Array(EDIT_LIMITS.strokes + 1).fill(erasures[0]), [{ type: 'brush', size: 1, points: Array(EDIT_LIMITS.points + 1).fill({ x: 1, y: 1 }) }]]) {
  assert.throws(() => normalizeErasures(invalid, 400, 300), /擦除/)
}
console.log('ok - 擦除校验、数量限制、旧工程兼容及新版本持久化')

function sourcePoint(layer, x, y) {
  const dx = ((x - layer.crop.x) / layer.crop.w - 0.5) * layer.w * (layer.flipX ? -1 : 1)
  const dy = ((y - layer.crop.y) / layer.crop.h - 0.5) * layer.h * (layer.flipY ? -1 : 1)
  const a = layer.rotation * Math.PI / 180
  return { x: layer.x + layer.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: layer.y + layer.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) }
}
for (const rotation of [0, 35, 90, -125]) for (const flipX of [false, true]) for (const flipY of [false, true]) {
  const old = { ...image, rotation, flipX, flipY }
  const next = cropImageLayer(old, { x: 0.1, y: 0.25, w: 0.6, h: 0.5 })
  assert.equal(next.w, 48); assert.equal(next.h, 30)
  for (const [x, y] of [[0.1, 0.25], [0.4, 0.5], [0.7, 0.75]]) {
    const p = sourcePoint(old, x, y), q = sourcePoint(next, x, y)
    assert.ok(Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6, '裁剪后保留区域不能缩放或漂移')
  }
  const restored = cropImageLayer(next, old.crop)
  assert.ok(Math.abs(restored.x - old.x) < 1e-6 && Math.abs(restored.y - old.y) < 1e-6)
}
console.log('ok - 裁剪在旋转、翻转、再次裁剪和恢复范围时保持像素比例与位置')

const html = renderDesign(normalized).html
assert.ok(html.includes('mask-image:') && html.includes('data:image/svg+xml'))
assert.ok(!renderDesign(doc(image)).html.includes('mask-image'))
assert.ok(renderDesign(normalized, { geometryOnly: true }).html.includes('mask-image:'), '多页复用的几何层也必须保留擦除')
assert.equal(bakeTargets(normalized).length, 1, '打印擦除层需要烘焙，避免逐页重复栅格化')
const layer = normalized.layers[0], geom = bakeGeometry(layer, normalized.artboard)
const first = bakeName(layer, geom, asset, 300)
assert.notEqual(first, bakeName({ ...layer, erasures: [] }, geom, asset, 300))
assert.notEqual(first, bakeName({ ...layer, erasures: [erasures[0]] }, geom, asset, 300))
console.log('ok - 普通预览、多页几何渲染及打印烘焙缓存都包含擦除')

const variable = { id: 'variable', type: 'image', name: '变量图', variable: true, bindColumn: 'photo', x: 10, y: 20, w: 40, h: 60, fit: 'cover', focal: { x: 0.25, y: 0.75 }, rotation: 30 }
const reference = referenceImageLayer(variable, asset, 'reference')
assert.equal(reference.variable, undefined)
assert.equal(reference.referenceFor, variable.id)
assert.equal(reference.crop.w, 0.5)
assert.equal(reference.crop.x, 0.125)
const referenceDoc = normalizeDesign({ ...doc(variable), layers: [variable, { ...reference, editorOnly: false, erasures }] })
assert.equal(referenceDoc.schemaVersion, 9)
assert.equal(referenceDoc.layers[1].editorOnly, true, '参考样图不能被关闭仅编辑可见')
assert.deepEqual(normalizeDesign(referenceDoc), referenceDoc)
const output = renderDesign(referenceDoc, { photoUrl: () => 'pp://media/batch-photo' }).html
assert.ok(output.includes('batch-photo') && !output.includes('data-design-asset') && !output.includes('mask-image'), '输出仍使用变量图，参考像素与擦除不会进入输出')
const editor = renderDesign(referenceDoc, { includeEditorOnly: true, photoUrl: () => 'pp://media/batch-photo' }).html
assert.ok(editor.includes('data-design-asset') && editor.includes('mask-image') && !editor.includes('batch-photo'), '编辑器显示普通参考图片，不叠加另一份变量照片')
assert.equal(bakeTargets(referenceDoc).length, 0, '参考图片不会进入输出烘焙')
assert.ok(renderDesign({ ...referenceDoc, layers: [variable, { ...reference, visible: false }] }, { includeEditorOnly: true, photoUrl: () => 'batch-photo' }).html.includes('batch-photo'), '隐藏参考样图后可查看真实变量照片')
assert.throws(() => normalizeDesign({ ...doc(variable), layers: [{ ...variable, referenceFor: 'other' }] }), /参考样图/)
assert.throws(() => normalizeDesign(doc({ ...image, referenceFor: image.id })), /自身/)
const contained = referenceImageLayer({ ...variable, fit: 'contain', rotation: 0 }, asset, 'contained')
assert.equal(contained.w, 40); assert.equal(contained.h, 30)
assert.equal(contained.x, 10); assert.equal(contained.y, 42.5)
assert.deepEqual(contained.crop, { x: 0, y: 0, w: 1, h: 1 })
let nextId = 0
const duplicated = require('../electron/design-editor.cjs').duplicateSelection(referenceDoc, ['variable', 'reference'], { makeId: () => `copy_${nextId++}` }).design
assert.equal(duplicated.layers[3].referenceFor, duplicated.layers[2].id, '复制变量框与参考样图时保持副本之间的关联')
assert.equal(duplicated.layers[3].editorOnly, true)
console.log('ok - 参考样图复用普通图片、保留取景、关联复制及持久化；编辑效果与批量输出隔离')

;(async () => {
  const { repairImagePixels } = require('../src/lib/image-repair.cjs')
  const w = 24, h = 18, data = new Uint8ClampedArray(w * h * 4), mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    data.set([100 + 2 * x, 80 + 3 * y, 160, 255], i * 4)
    if (x >= 8 && x < 16 && y >= 5 && y < 12) { data.set([0, 0, 0, 255], i * 4); mask[i] = 255 }
  }
  const repaired = await repairImagePixels(data, mask, w, h, { yield: async () => {} })
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, p = i * 4
    if (!mask[i]) assert.deepEqual(repaired.slice(p, p + 4), data.slice(p, p + 4), '选区外像素保持不变')
    else {
      assert.ok(Math.abs(repaired[p] - (100 + 2 * x)) <= 1, '修复接续横向渐变')
      assert.ok(Math.abs(repaired[p + 1] - (80 + 3 * y)) <= 1, '修复接续纵向渐变')
      assert.equal(repaired[p + 2], 160); assert.equal(repaired[p + 3], 255, '保留背景颜色和不透明度')
    }
  }
  await assert.rejects(repairImagePixels(data, new Uint8Array(w * h).fill(255), w, h, { yield: async () => {} }), /周围背景/)
  await assert.rejects(repairImagePixels(data, new Uint8Array(w * h), w, h, { yield: async () => {} }), /请先/)
  await assert.rejects(repairImagePixels(data, mask, w, h, { yield: async () => {}, canceled: () => true }), /取消/)
  console.log('ok - 背景修复接续平滑渐变，保留未选中的像素及透明度，拒绝无法修复的选区')
})().catch(err => { console.error(err); process.exitCode = 1 })

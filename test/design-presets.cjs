/**
 * 内置底图预设：几何自检 + 「参考框绝不能印出来」。
 *
 * 预设的失败方式是**要印出来才看得见**的：参考框该 `editorOnly` 却没标 → 身份证复印件上
 * 多出一堆红虚线，而且全程不报错。所以这里把「参考框不印」与几何自检一起钉住。
 *
 * 另：内置预设**只有身份证一套**（2026-10-09 收敛，原因见 design-presets.cjs 头注）。
 * 「数量」本身不是安全性质，但「下拉里一堆内置常量会诱导用户反复新建、把工程库堆满」
 * 是真实踩过的坑（一次会话堆出 18 个同名工程），所以数量也一并断言——**加预设时这里会红**，
 * 提醒你确认这真的是有意的。
 */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const DATA = fs.mkdtempSync(path.join(__dirname, '.tmp-design-presets-'))
process.env.PRINTPRESS_DATA_DIR = DATA
const { listPresets, buildPreset, PRESETS } = require('../electron/design-presets.cjs')
const { renderDesign, LIMITS } = require('../electron/design-layout.cjs')
const designs = require('../electron/designs.cjs')

let passed = 0
function check(name, run) { run(); passed++; console.log(`  ok - ${name}`) }

console.log('== 内置预设：参考框一律「仅编辑可见」，出片时一个图层都不印 ==')

const built = PRESETS.map((preset) => ({ preset, doc: buildPreset(preset.id) }))
const boxes = (doc) => doc.layers.filter((layer) => layer.type === 'rect' && layer.editorOnly)
function overlaps(a, b) {
  return a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001 && a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001
}

check('内置预设只有身份证一套（收敛后不再内置练习纸 / 票据）', () => {
  const list = listPresets()
  assert.equal(list.length, 1, '内置预设必须恰好 1 套；要新增请先确认不会把工程库堆满')
  assert.equal(list.length, PRESETS.length)
  assert.equal(list[0].id, 'id-card-a4')
  assert.equal(list[0].name, '身份证正反面复印件')
  for (const item of list) {
    assert.ok(item.id && item.name && item.summary, `预设 ${item.id} 的名称与说明不能为空`)
    assert.equal(typeof item.summary, 'string')
  }
  assert.equal(new Set(list.map((item) => item.id)).size, list.length, '预设标识不能重复')
  // 名称也不能重复：下拉里出现两个同名项，用户根本分不清
  assert.equal(new Set(list.map((item) => item.name)).size, list.length, '预设名称不能重复')
})

check('每套预设的图层都完整落在画布内，且不超图层上限', () => {
  for (const { preset, doc } of built) {
    assert.ok(doc.layers.length > 0, `${preset.id} 不能是空工程`)
    assert.ok(doc.layers.length < LIMITS.layers, `${preset.id} 图层数 ${doc.layers.length} 超出上限`)
    for (const layer of doc.layers) {
      const right = layer.x + layer.w
      const bottom = layer.y + layer.h
      assert.ok(layer.x >= -0.001 && layer.y >= -0.001, `${preset.id} 的「${layer.name}」跑到画布左上角外`)
      assert.ok(right <= doc.artboard.w + 0.001, `${preset.id} 的「${layer.name}」右边越界（${right} > ${doc.artboard.w}）`)
      assert.ok(bottom <= doc.artboard.h + 0.001, `${preset.id} 的「${layer.name}」下边越界（${bottom} > ${doc.artboard.h}）`)
    }
    // 图层 id 在同一份工程内必须唯一，否则编辑器选中/撤销全乱
    assert.equal(new Set(doc.layers.map((layer) => layer.id)).size, doc.layers.length, `${preset.id} 图层 id 重复`)
  }
})

check('参考框全部仅编辑可见：默认出片一个图层都没有，编辑器画布照旧看得见', () => {
  for (const { preset, doc } of built) {
    const list = boxes(doc)
    assert.ok(list.length >= 2, `${preset.id} 至少要有两个参考框`)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        assert.ok(!overlaps(list[i], list[j]), `${preset.id} 的「${list[i].name}」与「${list[j].name}」叠在一起`)
      }
    }
    // 参考框预设除画布底色外**什么都不印**：全是 editorOnly 时默认渲染结果里一个图层都没有
    assert.ok(!renderDesign(doc).html.includes('data-design-layer'), `${preset.id} 出片时不该有任何图层`)
    assert.ok(renderDesign(doc, { includeEditorOnly: true }).html.includes('data-design-layer'), `${preset.id} 编辑器画布必须看得见参考框`)
    // 一个普通图层混进来就会被印出去（参考框旁边多一道红边），必须揪出来
    assert.ok(doc.layers.every((layer) => layer.editorOnly === true), `${preset.id} 不允许存在会打印的图层`)
    assert.equal(doc.schemaVersion, 3, `${preset.id} 含 editorOnly 图层，格式版本必须是 3（否则旧应用会静默印出参考框）`)
  }
})

check('参考框预设的标注不与任何框叠在一起', () => {
  // 标注贴太紧会压在相邻框的边上，肉眼很像「框画歪了」——行距不够时就踩过这个坑
  for (const { preset, doc } of built) {
    const texts = doc.layers.filter((layer) => layer.type === 'text' && layer.editorOnly)
    const frames = boxes(doc)
    assert.ok(texts.length > 0, `${preset.id} 每个框都该有尺寸标注`)
    for (const text of texts) {
      for (const frame of frames) {
        assert.ok(!overlaps(text, frame), `${preset.id} 的「${text.name}」压在「${frame.name}」上`)
      }
    }
  }
})

check('身份证预设的两个卡位就是 ID-1 标准尺寸且水平居中', () => {
  const doc = built.find((item) => item.preset.id === 'id-card-a4').doc
  const list = boxes(doc)
  assert.equal(list.length, 2)
  for (const box of list) {
    assert.equal(box.w, 85.6)
    assert.equal(box.h, 54)
    // 居中：左右留白相等
    assert.ok(Math.abs(box.x - (doc.artboard.w - box.w) / 2) < 0.001, `「${box.name}」没有水平居中`)
  }
})

check('两个卡位之间留足间距，且整组在 A4 上垂直居中', () => {
  // 用户报过「上下间隔太小、在 A4 上显得不协调」。原断言只要求「≥10mm」，
  // 旧的 20mm 也照样通过 —— 等于没钉住。现在按「间距 ≥ 框高的 3/4」+「上下留白相等」两条钉：
  // 只钉间距不够，把两框一起上移（原布局下方空出 129mm）同样显得不协调。
  const doc = built.find((item) => item.preset.id === 'id-card-a4').doc
  const [top, bottom] = boxes(doc)
  const gap = bottom.y - (top.y + top.h)
  assert.ok(gap >= 40, `两个卡位之间至少留 40mm（现 ${gap}mm），太挤在 A4 上不协调`)
  const above = top.y
  const below = doc.artboard.h - (bottom.y + bottom.h)
  assert.ok(Math.abs(above - below) <= 6, `两个卡位要在 A4 上垂直居中（上留白 ${above}mm、下留白 ${below}mm）`)
})

check('未知标识明确报错，空名字退回预设名', () => {
  assert.throws(() => buildPreset('no-such-preset'), /没有这个内置模板/)
  assert.throws(() => buildPreset('tian-zi-ge'), /没有这个内置模板/)
  assert.throws(() => buildPreset(), /没有这个内置模板/)
  assert.equal(buildPreset('id-card-a4', '   ').name, '身份证正反面复印件')
  assert.equal(buildPreset('id-card-a4', ' 我的复印件 ').name, '我的复印件')
  // 造出来的是**未保存**的新工程：不能带 id / revision，否则会被当成覆盖已存在的工程
  const doc = buildPreset('id-card-a4')
  assert.equal(doc.id, undefined)
  assert.equal(doc.revision, 0)
})

check('每次构建都得到独立的一份（改坏预设副本不影响下一次）', () => {
  const first = buildPreset('id-card-a4')
  first.layers[0].x = 999
  first.layers[0].name = '被改坏了'
  const second = buildPreset('id-card-a4')
  assert.notEqual(second.layers[0].x, 999)
  assert.notEqual(second.layers[0].name, '被改坏了')
})

check('预设能真的落库并原样读回来', () => {
  const saved = designs.saveDesign(buildPreset('id-card-a4'))
  assert.equal(saved.revision, 1, '新工程从第 1 版开始')
  assert.ok(saved.id.startsWith('design_'), '落库后才有工程标识')
  const read = designs.getDesign(saved.id, saved.revision)
  assert.equal(read.name, '身份证正反面复印件')
  assert.equal(read.layers.length, saved.layers.length)
  assert.equal(read.schemaVersion, 3)
  assert.ok(read.layers.some((layer) => layer.editorOnly), '参考框的 editorOnly 要活过落库往返')
  const head = designs.listDesigns().find((item) => item.id === saved.id)
  assert.ok(head, '新工程出现在工程库里')
  assert.ok(head.lastUsedAt, '落库即记一次使用（「最近使用」列表靠它排序）')
  designs.deleteDesign(saved.id)
})

console.log(`\n内置底图预设：${passed} 项通过`)
{
  const relative = path.relative(__dirname, DATA)
  if (!relative.startsWith('.tmp-design-presets-') || relative.includes(path.sep)) throw new Error('测试目录清理路径不安全')
  rmDeep(DATA)
}

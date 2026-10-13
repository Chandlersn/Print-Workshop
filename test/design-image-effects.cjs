/**
 * 图片图层的描边与投影（v0.7 §6）验收。
 *
 * 这套守的是一件很容易「看起来能跑、其实会毁掉存量工程」的事：
 * **图片的描边/投影必须是「可选」而不是「有默认」**。
 * 形状的 `stroke` / `strokeWidth` 天生带默认值（每个形状都有一圈描边），图片一旦沿用
 * 这个约定，**所有老工程里的每一张图都会凭空多出一圈线**——而用户根本没要求过，
 * 界面不报错、测试不报错、只有打印出来才看得见。
 *
 * 第二件是渲染方式：投影必须走 CSS `filter: drop-shadow()`（跟图层 alpha 走），
 * 不能用 `box-shadow`（按包围盒投，一张抠过底的签名图会被投出一个方盒）；
 * 描边必须走「**叠层元素** + `inset box-shadow`」（画在框内侧、**不改几何**），
 * 不能用 `border`（会挤掉内容盒 ⇒ 可见源区域比例与帧比例不再相等 ⇒ 把照片拉长），
 * 也**不能用 `outline`**——Chromium 把 outline 画在**定位子元素之下**，图片正好铺满
 * 整个框，于是整圈描边被盖住、只在右/下边缘漏出约 0.2mm（300dpi 下就是 2px）。
 * 这不是推演，是出真图读真像素量出来的，见 `test/design-export-e2e.cjs`。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')

const layout = require('../electron/design-layout.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const ASSET_ID = 'c'.repeat(64)
const ASSET = { id: ASSET_ID, path: `design-assets/${ASSET_ID}.png`, width: 100, height: 100, name: 'p.png', mime: 'image/png' }
const doc = (layer, version = 1) => ({ schemaVersion: version, name: '图片效果验收', artboard: { w: 210, h: 297 }, assets: { [ASSET_ID]: ASSET }, layers: [layer] })
const image = (extra = {}) => ({ id: 'photo', type: 'image', assetId: ASSET_ID, x: 10, y: 10, w: 25, h: 35, ...extra })
const variable = (extra = {}) => ({ id: 'var', type: 'image', variable: true, bindColumn: '姓名', x: 10, y: 10, w: 25, h: 35, ...extra })
const shadow = { dxMm: -2, dyMm: 3, blurMm: 1.5, color: '#112233', opacity: 0.4 }
/** 取出承载该图层的那一个 `.design-layer` 的 style 属性。 */
const layerStyle = (html, id) => (html.match(new RegExp(`data-design-layer="${id}" style="([^"]*)"`)) || [])[1] || ''

console.log('== 1. 可选性：不传就与旧工程逐字节同行为，传了才抬版本 ==')
check('不传 stroke / shadow 时不产出任何新字段，版本也不动', () => {
  const out = layout.normalizeDesign(doc(image()))
  assert.equal(out.schemaVersion, 1, '没加效果就不该抬版本')
  assert.ok(!('stroke' in out.layers[0]), '图片不该凭空多出一个 stroke 字段')
  assert.ok(!('strokeWidth' in out.layers[0]), '图片不该凭空多出一个 strokeWidth 字段')
  assert.ok(!('shadow' in out.layers[0]), '图片不该凭空多出一个 shadow 字段')
  const html = layout.renderDesign(out).html
  assert.ok(!html.includes('outline'), '没开描边就不该出现 outline')
  assert.ok(!html.includes('drop-shadow'), '没开投影就不该出现 drop-shadow')
})
check('形状的默认描边不受影响（图片的「可选」不能顺手把形状也改成可选）', () => {
  const out = layout.normalizeDesign(doc({ id: 'box', type: 'rect', x: 0, y: 0, w: 10, h: 10 }))
  assert.equal(out.layers[0].strokeWidth, 0.3, '形状仍然天生带一圈描边')
  assert.equal(out.layers[0].stroke, '#333333')
})
check('传了图片描边/投影 ⇒ 版本 7；形状阴影仍停在版本 4', () => {
  assert.equal(layout.normalizeDesign(doc(image({ stroke: '#ffffff', strokeWidth: 1 }))).schemaVersion, 7)
  assert.equal(layout.normalizeDesign(doc(image({ shadow }))).schemaVersion, 7)
  assert.equal(layout.normalizeDesign(doc(variable({ stroke: '#ffffff', strokeWidth: 1 }))).schemaVersion, 7)
  assert.equal(layout.normalizeDesign(doc({ id: 'box', type: 'rect', x: 0, y: 0, w: 10, h: 10, shadow })).schemaVersion, 4,
    '形状阴影是版本 4 的特性，别被图片顺手抬到 7')
  assert.ok(layout.SCHEMA_VERSIONS.includes(7), '版本 7 必须登记在 SCHEMA_VERSIONS')
})
check('只给 strokeWidth 或只给 stroke 都能成立，缺省色是白（衬边的高频用法）', () => {
  const onlyWidth = layout.normalizeDesign(doc(image({ strokeWidth: 2 }))).layers[0]
  assert.equal(onlyWidth.stroke, '#ffffff')
  assert.equal(onlyWidth.strokeWidth, 2)
  const onlyColor = layout.normalizeDesign(doc(image({ stroke: '#ff0000' }))).layers[0]
  assert.equal(onlyColor.stroke, '#ff0000')
  assert.equal(onlyColor.strokeWidth, 0, '只给颜色时宽度取 0 ⇒ 不画线（不猜用户想要多宽）')
})
check('非法值明确拒绝，不静默吞掉', () => {
  assert.throws(() => layout.normalizeDesign(doc(image({ stroke: 'url(#evil)' }))), /颜色/)
  assert.throws(() => layout.normalizeDesign(doc(image({ strokeWidth: 101 }))), /描边宽度/)
  assert.throws(() => layout.normalizeDesign(doc(image({ shadow: { ...shadow, blurMm: 11 } }))), /阴影模糊/)
  assert.throws(() => layout.normalizeDesign(doc(image({ shadow: 'yes' }))), /阴影必须是对象/)
})

console.log('== 2. 渲染：描边画在框内侧不改几何，投影按 alpha 走（不许 box-shadow 投影） ==')
check('描边落成「叠层 + inset box-shadow」，且框的毫米尺寸一个字符都没变', () => {
  const out = layout.normalizeDesign(doc(image({ stroke: '#ffffff', strokeWidth: 1.2 })))
  const html = layout.renderDesign(out).html
  const style = layerStyle(html, 'photo')
  assert.ok(style.includes('width:25mm') && style.includes('height:35mm'), `框的毫米尺寸必须原样：${style}`)
  // border 会挤掉内容盒 ⇒ 可见源区域比例与帧比例不再相等 ⇒ 把照片拉长
  assert.ok(!/(^|;)border:/.test(style), `不许用 border 画描边（会改内容盒 ⇒ 拉长照片）：${style}`)
  // ⚠️ outline 也不行：Chromium 把 outline 画在**定位子元素之下**，图片铺满整个框，
  //    整圈描边会被盖住、只在右/下边缘漏出约 0.2mm（出真图量过）。
  assert.ok(!style.includes('outline'), `不许用 outline 画描边（会被图片盖住）：${style}`)
  const stroke = html.match(/<div data-design-stroke="photo" style="([^"]*)"/)
  assert.ok(stroke, '描边必须是独立的叠层元素')
  assert.ok(stroke[1].includes('box-shadow:inset 0 0 0 1.2mm #ffffff'), `叠层写法不对：${stroke[1]}`)
  assert.ok(stroke[1].includes('position:absolute') && stroke[1].includes('inset:0'), '叠层要铺满整个框')
  assert.ok(html.indexOf('data-design-stroke="photo"') > html.indexOf('data-design-asset='),
    '叠层必须排在图片**之后**（否则又被盖住）')
})
check('投影落成 drop-shadow，颜色与不透明度合成进 alpha', () => {
  const out = layout.normalizeDesign(doc(image({ shadow })))
  const style = layerStyle(layout.renderDesign(out).html, 'photo')
  assert.ok(style.includes('filter:drop-shadow(-2mm 3mm 1.5mm rgba(17,34,51,0.4))'), `投影写法不对：${style}`)
  // 投影用 box-shadow 会按包围盒投：抠过底的 PNG 会被投出一个方盒
  assert.ok(!style.includes('box-shadow'), `投影不许用 box-shadow（按包围盒）：${style}`)
})
check('投影挂在承载图片的那个元素上（不是空壳，也不是内层裁切盒）', () => {
  const html = layout.renderDesign(layout.normalizeDesign(doc(image({ shadow })))).html
  const wrapper = html.match(/<div class="design-layer" data-design-layer="photo"[\s\S]*?>([\s\S]*)<\/div>\s*$/)
  assert.ok(wrapper, '必须找到图层外框')
  assert.ok(layerStyle(html, 'photo').includes('drop-shadow'), '外框带投影')
  assert.ok(/data-design-asset=/.test(wrapper[1]), '外框里确实装着图片本体（否则投影会投在一个空盒子上）')
})
check('描边与投影可以同时开，互不覆盖', () => {
  const html = layout.renderDesign(layout.normalizeDesign(doc(image({ stroke: '#ffffff', strokeWidth: 1, shadow })))).html
  const style = layerStyle(html, 'photo')
  assert.ok(style.includes('drop-shadow(-2mm 3mm 1.5mm rgba(17,34,51,0.4))'), '投影在')
  assert.ok(html.includes('box-shadow:inset 0 0 0 1mm #ffffff'), '描边也在，且没有被投影顶掉')
})
check('withAlpha 的边界：短写、8 位、transparent 都不许吐 NaN', () => {
  const of = (color, opacity) => layerStyle(layout.renderDesign(layout.normalizeDesign(doc(image({ shadow: { ...shadow, color, opacity } })))).html, 'photo')
  assert.ok(of('#f00', 0.5).includes('rgba(255,0,0,0.5)'), '#f00 要展开成 255,0,0')
  assert.ok(of('#11223380', 0.5).includes('rgba(17,34,51,0.251)'), '8 位色的自带 alpha 要乘进 opacity（0x80/255×0.5，三位小数）')
  assert.ok(of('transparent', 0.5).includes('rgba(0,0,0,0)') || of('transparent', 0.5).includes('transparent'),
    'transparent 落到全透明，不许出现 NaN')
  assert.ok(!of('transparent', 0.5).includes('NaN'), '绝不能吐出 NaN（整条 filter 会失效）')
})

console.log('== 3. 变量图：裁剪在内层，外框留圆角给描边，投影不被自身裁掉 ==')
check('变量图的 overflow:hidden 挪到内层，外框保留 border-radius', () => {
  const html = layout.renderDesign(layout.normalizeDesign(doc(variable({ radius: 2, stroke: '#ffffff', strokeWidth: 0.8, shadow })), 5), { photoUrl: () => 'pp://media/x.png' }).html
  const style = layerStyle(html, 'var')
  assert.ok(style.includes('border-radius:2mm'), '外框要留圆角，描边才会跟着圆角走')
  assert.ok(!style.includes('overflow:hidden'), `外框不能自己裁剪（投影有被自身裁掉的风险）：${style}`)
  assert.ok(/inset:0;overflow:hidden;border-radius:2mm/.test(html), '裁剪交给内层')
  const stroke = html.match(/<div data-design-stroke="var" style="([^"]*)"/)
  assert.ok(stroke && stroke[1].includes('box-shadow:inset 0 0 0 0.8mm #ffffff'), '变量图同样支持描边')
  assert.ok(stroke[1].includes('border-radius:2mm'), '叠层也要带同一个圆角，衬边才不会切成直角')
  assert.ok(style.includes('drop-shadow(-2mm 3mm 1.5mm rgba(17,34,51,0.4))'), '变量图同样支持投影')
})
check('变量图缺照片时投影/描边仍不炸（占位块也在同一个外框里）', () => {
  const out = layout.normalizeDesign(doc(variable({ stroke: '#ffffff', strokeWidth: 1, shadow })), 5)
  const html = layout.renderDesign(out, { photoUrl: () => null, showPhotoPlaceholder: true }).html
  assert.ok(layerStyle(html, 'var').includes('drop-shadow'), '占位状态也要能预览投影')
  assert.ok(html.includes('data-design-stroke="var"'), '占位状态也要能预览描边')
})

console.log('== 4. I-44 静态守卫：界面只写一份，关掉要删字段而不是留 0 ==')
check('图片的描边/投影在界面里只写一份（变量图与静态图共用）', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.equal((view.match(/data-testid="design-layer-stroke"/g) || []).length, 1, '描边开关只能有一处')
  assert.equal((view.match(/data-testid="design-layer-shadow"/g) || []).length, 2,
    '投影开关共两处：形状一处 + 图片共用一处（图片那边不许再按静态/变量各写一遍）')
  assert.ok(/<template v-if="single\.type === 'image'">[\s\S]{0,200}design-layer-stroke/.test(view),
    '图片的描边/投影块由 single.type === \'image\' 统管（放在两支图片分支之外）')
})
check('界面不重算颜色：投影颜色/不透明度交给渲染侧合成', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const body = view.slice(view.indexOf('function setStroke('), view.indexOf('function adoptTemplateSize('))
  assert.ok(/layer\.stroke = '#ffffff'/.test(body) && /layer\.strokeWidth = 1/.test(body), '开启时给一份白色衬边默认值')
  assert.ok(/delete layer\.stroke/.test(body) && /delete layer\.strokeWidth/.test(body),
    '关闭时必须删字段——留一个 strokeWidth:0 会把工程标成版本 7，却不给用户任何视觉差别')
  assert.ok(!/rgba\(/.test(body), '界面不做颜色合成，交给 design-layout.cjs')
})
check('setShadow 放行图片图层（否则界面开关点了没反应）', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const body = view.slice(view.indexOf('function setShadow('), view.indexOf('function setStroke('))
  assert.ok(/\['rect', 'ellipse', 'image'\]\.includes\(layer\.type\)/.test(body), 'setShadow 必须放行 image')
})

console.log(`\n图片描边与投影：${passed} 项通过`)

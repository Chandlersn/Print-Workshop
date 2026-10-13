/**
 * 裁切比例预设与成品尺寸（v0.7 P1）验收。
 *
 * 这套守的是一件很容易「看起来对、其实错」的事：**「选 1 寸」必须是「改尺寸 + 改裁切」的
 * 同一个动作**。只改图层尺寸、不动 `crop`，打印出来的比例由
 * `(原图宽 × crop.w) : (原图高 × crop.h)` 决定，与图层毫米尺寸无关——于是用户选完 1 寸
 * 得到一张被横向拉长的脸，而每一行代码都没报错。
 *
 * 纯函数套件：`fitCropToRatio` 的数学 + `normalizeDesign` 集成 + 前端静态核查。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

// 数据目录必须在 require 领域模块之前定好：templates.cjs 在模块加载期就 path.join 它，
// 晚一步就是 ERR_INVALID_ARG_TYPE（收到 undefined）。
const DATA = path.join(__dirname, '.tmp-crop-presets')
process.env.PRINTPRESS_DATA_DIR = DATA
rmDeep(DATA)
fs.mkdirSync(DATA, { recursive: true })

const layout = require('../electron/design-layout.cjs')
const templates = require('../electron/templates.cjs')
const api = require('../electron/api.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const ASSET_ID = 'b'.repeat(64)
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance
/** 裁切框对应的「打印比例」：可见源区域是 (原图宽×crop.w) × (原图高×crop.h) 像素。 */
const printedAspect = (crop, assetW, assetH) => (assetW * crop.w) / (assetH * crop.h)
const inside = (crop) => crop.x >= 0 && crop.y >= 0 && crop.w > 0 && crop.h > 0 && crop.x + crop.w <= 1.00000001 && crop.y + crop.h <= 1.00000001

console.log('== 1. 比例预设只放比例，物理规格仍归 templates.ITEM_SIZES ==')
check('CROP_RATIOS 是纯比例清单，且都落在合理范围', () => {
  assert.ok(layout.CROP_RATIOS.length >= 5)
  for (const ratio of layout.CROP_RATIOS) {
    assert.ok(ratio.w > 0 && ratio.h > 0, `${ratio.id} 比例必须为正`)
    assert.ok(ratio.w <= 300 && ratio.h <= 300, `${ratio.id} 不该出现物理规格量级的数值`)
    assert.ok(typeof ratio.name === 'string' && ratio.name, `${ratio.id} 要有可读名字`)
  }
  // 尺寸类预设的 id 是 photo-*/card-*；比例类不许混进来，否则就是抄了第二份规格
  for (const ratio of layout.CROP_RATIOS) assert.ok(!/^(photo|card)-/.test(ratio.id), `${ratio.id} 不是比例预设`)
})
check('证件照尺寸的唯一权威源是 templates.ITEM_SIZES，且 app:env 下发的就是同一份', () => {
  const one = templates.ITEM_SIZES.find(size => size.id === 'photo-1')
  assert.deepEqual({ w: one?.w, h: one?.h }, { w: 25, h: 35 }, '1 寸 = 25×35 mm 仍在权威清单里')
  assert.ok(templates.ITEM_SIZES.some(size => size.id === 'photo-2s' && size.w === 35 && size.h === 45), '小 2 寸 35×45 也在')
  const env = api.call('app:env', {}, { app: { version: '0.0.0' } })
  assert.equal(env.itemSizes, templates.ITEM_SIZES, 'app:env 下发的必须是同一个数组（引用相等），不是拷贝')
})

console.log('== 2. fitCropToRatio：打印比例精确、裁切不越界、取景尽量保住 ==')
check('宽高比精确命中，且裁切始终落在原图内', () => {
  const cases = [
    [25, 35, 4000, 3000], [35, 49, 3000, 4000], [1, 1, 4000, 3000], [3, 4, 1000, 1000],
    [9, 16, 6000, 2000], [210, 297, 800, 6000], [22, 32, 3000, 3000],
  ]
  for (const [ratioW, ratioH, assetW, assetH] of cases) {
    const crop = layout.fitCropToRatio({ x: 0, y: 0, w: 1, h: 1 }, ratioW, ratioH, assetW, assetH)
    assert.ok(inside(crop), `${ratioW}×${ratioH} on ${assetW}×${assetH} 越界：${JSON.stringify(crop)}`)
    assert.ok(near(printedAspect(crop, assetW, assetH), ratioW / ratioH, 1e-4),
      `${ratioW}×${ratioH} on ${assetW}×${assetH} 打印比例不匹配：${printedAspect(crop, assetW, assetH)}`)
  }
})
check('取「放得下的最大同比例矩形」：一条边顶满，面积不再能更大', () => {
  for (const [ratioW, ratioH, assetW, assetH] of [[25, 35, 4000, 3000], [16, 9, 1000, 1000], [9, 16, 1000, 1000]]) {
    const crop = layout.fitCropToRatio({ x: 0, y: 0, w: 1, h: 1 }, ratioW, ratioH, assetW, assetH)
    assert.ok(near(Math.max(crop.w, crop.h), 1), `${ratioW}×${ratioH} 应有一条边顶满：${JSON.stringify(crop)}`)
  }
})
check('以原裁切中心为锚点：能放下就不挪取景', () => {
  const crop = layout.fitCropToRatio({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1, 1, 1000, 1000)
  assert.ok(near(crop.x + crop.w / 2, 0.5, 1e-6) && near(crop.y + crop.h / 2, 0.5, 1e-6), '中心不变')
  assert.ok(near(crop.w, 1) && near(crop.h, 1), '正方形原图 + 1:1 ⇒ 用满整图')
})
check('贴边时向内侧收拢，不越界也不留下非法小数', () => {
  const crop = layout.fitCropToRatio({ x: 0, y: 0, w: 0.2, h: 0.2 }, 16, 9, 1000, 1000)
  assert.ok(inside(crop), `越界：${JSON.stringify(crop)}`)
  assert.ok(near(crop.x, 0) && near(crop.y, 0), '原本贴左上角，收拢后仍贴左上角')
  // 浮点尾巴是最实际的坑：x + w 落在 1.0000000001 上会被 normalizeDesign 判成「裁切区域超出原图」
  assert.ok(crop.x + crop.w <= 1, `x + w 必须 <= 1，实际 ${crop.x + crop.w}`)
})
check('参数不合法时原样返回，绝不写出一份非法裁切', () => {
  const current = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
  for (const args of [[0, 35, 100, 100], [25, 0, 100, 100], [25, 35, 0, 100], [25, 35, 100, 0], [25, 35, NaN, 100]]) {
    assert.deepEqual(layout.fitCropToRatio(current, ...args), current)
  }
  assert.deepEqual(layout.fitCropToRatio(undefined, 25, 35, 0, 100), { x: 0, y: 0, w: 1, h: 1 })
})

console.log('== 3. 集成：套用预设后的工程必须能通过 normalizeDesign，且不失真 ==')
check('每个尺寸预设 × 各种原图长宽比，结果都能被 normalizeDesign 接受', () => {
  const sources = [[4000, 3000], [3000, 4000], [1000, 1000], [6000, 2000], [800, 6000]]
  for (const size of templates.ITEM_SIZES) {
    for (const [assetW, assetH] of sources) {
      // 复刻界面里的套用动作：尺寸两轴都定死，裁切跟着同一长宽比走
      const crop = layout.fitCropToRatio({ x: 0, y: 0, w: 1, h: 1 }, size.w, size.h, assetW, assetH)
      const doc = layout.normalizeDesign({
        schemaVersion: 1, name: '预设验收', artboard: { w: 210, h: 297 },
        assets: { [ASSET_ID]: { id: ASSET_ID, path: `design-assets/${ASSET_ID}.png`, width: assetW, height: assetH, name: 'p.png', mime: 'image/png' } },
        layers: [{ id: 'photo', type: 'image', assetId: ASSET_ID, x: 10, y: 10, w: size.w, h: size.h, crop }],
      })
      const layer = doc.layers[0]
      assert.ok(inside(layer.crop), `${size.name} on ${assetW}×${assetH}：裁切越界`)
      assert.ok(near(layer.w, size.w) && near(layer.h, size.h), `${size.name} 图层尺寸应为毫米成品`)
      // 成品不失真的判据：可见源区域的像素长宽比 == 帧的毫米长宽比
      assert.ok(near(printedAspect(layer.crop, assetW, assetH), layer.w / layer.h, 1e-4),
        `${size.name} on ${assetW}×${assetH} 会被拉伸`)
    }
  }
})
check('比例预设只改高度、宽度不动，且同样不失真', () => {
  for (const ratio of layout.CROP_RATIOS) {
    for (const [assetW, assetH] of [[4000, 3000], [800, 6000]]) {
      const width = 40
      const height = Math.round(width * ratio.h / ratio.w * 1000) / 1000
      const crop = layout.fitCropToRatio({ x: 0, y: 0, w: 1, h: 1 }, width, height, assetW, assetH)
      const doc = layout.normalizeDesign({
        schemaVersion: 1, name: '比例验收', artboard: { w: 210, h: 297 },
        assets: { [ASSET_ID]: { id: ASSET_ID, path: `design-assets/${ASSET_ID}.png`, width: assetW, height: assetH, name: 'p.png', mime: 'image/png' } },
        layers: [{ id: 'photo', type: 'image', assetId: ASSET_ID, x: 0, y: 0, w: width, h: height, crop }],
      })
      const layer = doc.layers[0]
      assert.ok(near(layer.w, width), `${ratio.name} 宽度必须保持`)
      assert.ok(near(printedAspect(layer.crop, assetW, assetH), layer.w / layer.h, 1e-4), `${ratio.name} 会被拉伸`)
    }
  }
})
check('变量图不参与裁切换算（取景由 cover + 焦点决定），帧尺寸即成品尺寸', () => {
  const doc = layout.normalizeDesign({
    schemaVersion: 5, name: '变量图验收', artboard: { w: 210, h: 297 }, assets: {},
    layers: [{ id: 'var', type: 'image', variable: true, bindColumn: '姓名', x: 0, y: 0, w: 25, h: 35 }],
  })
  assert.equal(doc.layers[0].crop, undefined, '变量图本来就没有 crop 字段')
  assert.ok(near(doc.layers[0].w, 25) && near(doc.layers[0].h, 35), '帧尺寸就是成品毫米尺寸')
})

console.log('== 4. I-43 静态守卫：改尺寸必须连带改裁切，规格不许抄第二份 ==')
check('界面把「尺寸 + 裁切」放在同一个动作里，不允许只改一边', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const body = view.slice(view.indexOf('function applySizePreset('), view.indexOf('// 选完立刻回位到「自定义」'))
  assert.ok(/layer\.w = round\(width\)/.test(body) && /layer\.h = round\(height\)/.test(body), '先定成品毫米尺寸')
  assert.ok(/fitCropToRatio\(layer\.crop, layer\.w, layer\.h/.test(body),
    '静态图片必须连带把裁切调成同一长宽比——这一步没了就是「选完 1 寸脸被拉长」')
  assert.ok(/!layer\.variable/.test(body), '变量图不走裁切换算（它没有 crop）')
  assert.ok(/type !== 'image'/.test(body), '非图片图层不该出现这个预设')
})
check('比例预设与裁切数学只有一处权威实现，界面不重算', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/import \{[^}]*CROP_RATIOS[^}]*fitCropToRatio[^}]*\} from '\.\.\/\.\.\/electron\/design-layout\.cjs'/.test(view),
    '界面从权威模块导入比例清单与裁切换算')
  assert.ok(!/const CROP_RATIOS\s*=/.test(view), '界面不许再定义一份比例清单')
  const layoutSource = read('electron/design-layout.cjs')
  assert.equal((layoutSource.match(/const CROP_RATIOS = Object\.freeze\(\[/g) || []).length, 1, 'CROP_RATIOS 只定义一次')
})
check('证件照规格由主进程下发（与多联拼版同一份），界面不写死清单', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/v-for="size in itemSizes"/.test(view), '尺寸选项由 itemSizes 生成')
  assert.ok(/itemSizes\.value = env\.itemSizes \|\| \[\]/.test(view), '尺寸清单来自 app:env')
  // 「选完回位」不是美化：不回位同一个预设点第二次不触发 change，用户会以为功能坏了
  assert.ok(/watch\(sizePreset, \(value\) => \{[\s\S]{0,120}sizePreset\.value = ''/.test(view),
    '选完立刻回位成「自定义」，同一个预设能连点两次')
})
check('比例 id 自带冒号也不能被切坏：ratio:1:1 必须解析成 kind=ratio + id=1:1', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const body = view.slice(view.indexOf('function applySizePreset('), view.indexOf('// 选完立刻回位到「自定义」'))
    .split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
  // 这个坑真实存在：比例清单里 5/6 个 id 都含冒号
  assert.ok(layout.CROP_RATIOS.some((ratio) => ratio.id.includes(':')), '比例 id 确实含冒号（否则这条守卫没意义）')
  assert.ok(!/\.split\(':'\)/.test(body),
    '不许「按冒号全切再解构」——`ratio:1:1` 会被读成 id `1`，找不到预设后**静默无操作**（点了一点反应都没有）')
  assert.ok(/indexOf\(':'\)/.test(body) && /slice\(sep \+ 1\)/.test(body), '必须只按**第一个**冒号切分')
  // 用与界面同一套规则把每个预设值解析一遍，必须都能命中自己
  const parse = (value) => { const sep = value.indexOf(':'); return [value.slice(0, sep), value.slice(sep + 1)] }
  for (const ratio of layout.CROP_RATIOS) {
    const [kind, id] = parse(`ratio:${ratio.id}`)
    assert.ok(kind === 'ratio' && layout.CROP_RATIOS.some((item) => item.id === id), `ratio:${ratio.id} 必须能解析回自己（实得 id ${id}）`)
  }
  for (const size of templates.ITEM_SIZES) {
    const [kind, id] = parse(`size:${size.id}`)
    assert.ok(kind === 'size' && templates.ITEM_SIZES.some((item) => item.id === id), `size:${size.id} 必须能解析回自己（实得 id ${id}）`)
  }
})

console.log(`\n裁切比例预设：${passed} 项通过`)

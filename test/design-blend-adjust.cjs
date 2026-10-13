/**
 * 混合模式 / 图片颜色调整 / 组透明度（v0.7 第一批）验收。
 *
 * 纯函数套件：schema 归一 + renderDesign 输出 + 前端「预览→确认」的源码静态核查。
 * 这三个能力都必须**一次实现、四处同源**——编辑器画布（DesignSurface）、
 * PNG 导出（design-export）、打印与 PDF（render-engine）都走同一个 renderDesign，
 * 所以断言直接打在 renderDesign 的输出上，而不是各页面各自的实现里。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')

const { normalizeDesign, renderDesign, BLEND_MODES, SCHEMA_VERSIONS } = require('../electron/design-layout.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

const ASSET_ID = 'a'.repeat(64)
const asset = {
  id: ASSET_ID, path: `design-assets/${ASSET_ID}.png`, width: 1000, height: 800,
  name: '测试图', mime: 'image/png', source: 'managed',
}
function designDoc(layers, extra = {}) {
  return {
    schemaVersion: 1, revision: 0, name: '混合与调色', artboard: { w: 100, h: 80, background: '#ffffff' },
    assets: { [ASSET_ID]: asset }, layers, ...extra,
  }
}
const imageLayer = (patch = {}) => ({ id: 'img1', type: 'image', assetId: ASSET_ID, x: 5, y: 5, w: 40, h: 30, ...patch })
const variableLayer = (patch = {}) => ({ id: 'var1', type: 'image', variable: true, bindColumn: '姓名', x: 5, y: 5, w: 35, h: 45, ...patch })
const renderHtml = (doc, options = {}) => renderDesign(normalizeDesign(doc), {
  assetUrl: () => 'pp://media/design-assets/test.png', ...options,
}).html

console.log('== 1. 混合模式白名单：只收 CSS 原生，宁缺毋滥 ==')
check('白名单恰为 16 项（normal + 15 种叠色），且不含 CSS 无对应的 PS 专有模式', () => {
  assert.equal(BLEND_MODES.length, 16)
  for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']) {
    assert.ok(BLEND_MODES.includes(mode), `缺少 ${mode}`)
  }
  // 这些是 Photoshop 有、CSS mix-blend-mode 没有的——收了就等于给用户一个「预览与成品不一致」的坑
  for (const mode of ['linear-burn', 'linear-light', 'vivid-light', 'pin-light', 'darker-color', 'lighter-color', 'subtract', 'divide']) {
    assert.ok(!BLEND_MODES.includes(mode), `不该收录 ${mode}`)
  }
})

console.log('== 2. schema 默认值与白名单校验 ==')
check('不传 blend 默认 normal；不传 adjust 时图层没有该字段；不传组透明度默认 1', () => {
  const doc = normalizeDesign(designDoc([imageLayer()]))
  assert.equal(doc.layers[0].blend, 'normal')
  assert.equal(doc.layers[0].adjust, undefined)
  const withGroup = normalizeDesign(designDoc(
    [imageLayer({ id: 'g1' }), imageLayer({ id: 'g2' })],
    { groups: [{ id: 'grp', name: '组', layerIds: ['g1', 'g2'] }] }))
  assert.equal(withGroup.groups[0].opacity, 1)
})
check('未知混合模式抛错（不做静默降级）', () => {
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ blend: 'vivid-light' })])), /不支持的混合模式/)
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ blend: 'MULTIPLY' })])), /不支持的混合模式/)
})
check('颜色调整越界抛错，边界值放行', () => {
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ adjust: { brightness: 4 } })])), /亮度超出有效范围/)
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ adjust: { grayscale: 2 } })])), /去色超出有效范围/)
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ adjust: { invert: -0.1 } })])), /反相超出有效范围/)
  const doc = normalizeDesign(designDoc([imageLayer({ adjust: { brightness: 3, grayscale: 1 } })]))
  assert.deepEqual(doc.layers[0].adjust, { brightness: 3, contrast: 1, saturate: 1, grayscale: 1, invert: 0 })
})
check('组透明度越界抛错', () => {
  assert.throws(() => normalizeDesign(designDoc(
    [imageLayer({ id: 'g1' }), imageLayer({ id: 'g2' })],
    { groups: [{ id: 'grp', name: '组', layerIds: ['g1', 'g2'], opacity: 1.5 }] })), /图层组透明度超出有效范围/)
})

console.log('== 3. 版本号：新字段抬到 6，且只升不降 ==')
check('混合模式 / 颜色调整 / 组透明度各自都会把版本抬到 6', () => {
  assert.equal(normalizeDesign(designDoc([imageLayer({ blend: 'multiply' })])).schemaVersion, 6)
  assert.equal(normalizeDesign(designDoc([imageLayer({ adjust: { grayscale: 1 } })])).schemaVersion, 6)
  assert.equal(normalizeDesign(designDoc(
    [imageLayer({ id: 'g1' }), imageLayer({ id: 'g2' })],
    { groups: [{ id: 'grp', name: '组', layerIds: ['g1', 'g2'], opacity: 0.5 }] })).schemaVersion, 6)
})
check('未使用新字段的工程版本不被抬高（存量工程不被动升级）', () => {
  assert.equal(normalizeDesign(designDoc([imageLayer()])).schemaVersion, 1)
  assert.equal(normalizeDesign(designDoc([variableLayer()])).schemaVersion, 5)
})
check('已是 6 的工程不回退（Math.max 语义）', () => {
  const doc = designDoc([imageLayer()], { schemaVersion: 6 })
  assert.equal(normalizeDesign(doc).schemaVersion, 6)
})
check('可读版本清单是唯一权威源，6 已登记且校验不写死数字', () => {
  // 这条守住上面两个套件的「更高版本被拒」探针：它们取 Math.max(...SCHEMA_VERSIONS) + 1。
  // 清单漏登 6，或校验退回写死数组，都会在这里先红，而不是等到假失败。
  assert.ok(SCHEMA_VERSIONS.includes(6), '版本 6 必须登记在 SCHEMA_VERSIONS')
  // 只断言「不小于 6」而不是「等于 6」：清单**只增不减**，写死最大值会在下次抬版本时变假红
  // （v7 落地时就撞过一次）。要守的是「6 没被漏登」，不是「6 恰好是最大的」。
  assert.ok(Math.max(...SCHEMA_VERSIONS) >= 6, '版本 6 已登记，且清单只增不减')
  const layout = read('electron/design-layout.cjs')
  assert.ok(/!SCHEMA_VERSIONS\.includes\(doc\.schemaVersion\)/.test(layout), '版本校验读清单，不写死')
  assert.ok(!/\[1, 2, 3, 4, 5, 6\]\.includes/.test(layout), '不许留下写死的版本数组')
})

console.log('== 4. 渲染：颜色调整落成 CSS filter，恒等时不产生一个字符 ==')
check('非恒等调整输出 filter，且只含改动项', () => {
  const html = renderHtml(designDoc([imageLayer({ adjust: { brightness: 1.2, contrast: 0.9 } })]))
  assert.ok(html.includes('filter:brightness(1.2) contrast(0.9)'), html.slice(0, 400))
  assert.ok(!html.includes('grayscale(') && !html.includes('invert('))
})
check('去色与反相按 0~1 原样输出', () => {
  const html = renderHtml(designDoc([imageLayer({ adjust: { grayscale: 1, invert: 0.5 } })]))
  assert.ok(html.includes('filter:grayscale(1) invert(0.5)'))
})
check('恒等调整不产生 filter（与升级前逐字节一致）', () => {
  const identity = renderHtml(designDoc([imageLayer({ adjust: { brightness: 1, contrast: 1, saturate: 1, grayscale: 0, invert: 0 } })]))
  const none = renderHtml(designDoc([imageLayer()]))
  assert.ok(!identity.includes('filter:'))
  assert.equal(identity, none)
})
check('变量图的调整落在 <img> 上（不是外框 div）', () => {
  const html = renderHtml(designDoc([variableLayer({ adjust: { grayscale: 1 } })]), { photoUrl: () => 'pp://media/photo.png' })
  assert.ok(/<img[^>]*style="[^"]*filter:grayscale\(1\)[^"]*"/.test(html), html.slice(0, 500))
})

console.log('== 5. 渲染：混合模式与组透明度 ==')
check('非 normal 输出 mix-blend-mode，normal 不输出', () => {
  const blended = renderHtml(designDoc([imageLayer({ blend: 'multiply' })]))
  assert.ok(blended.includes('mix-blend-mode:multiply'))
  assert.ok(!renderHtml(designDoc([imageLayer()])).includes('mix-blend-mode'))
})
check('组透明度乘算到组内图层，组外图层不受影响', () => {
  const html = renderHtml(designDoc(
    [imageLayer({ id: 'g1', opacity: 0.5 }), imageLayer({ id: 'g2', opacity: 1 }), imageLayer({ id: 'free', opacity: 0.4 })],
    { groups: [{ id: 'grp', name: '组', layerIds: ['g1', 'g2'], opacity: 0.5 }] }))
  assert.ok(html.includes('opacity:0.25'), '组内 0.5 × 0.5 = 0.25')
  assert.ok(html.includes('opacity:0.5'), '组内 1 × 0.5 = 0.5')
  assert.ok(html.includes('opacity:0.4'), '组外图层保持自身透明度')
})
check('组透明度为 1 时输出与没有组时一致（不多一个字符）', () => {
  const grouped = renderHtml(designDoc([imageLayer({ id: 'g1' }), imageLayer({ id: 'g2' })],
    { groups: [{ id: 'grp', name: '组', layerIds: ['g1', 'g2'], opacity: 1 }] }))
  const plain = renderHtml(designDoc([imageLayer({ id: 'g1' }), imageLayer({ id: 'g2' })]))
  assert.equal(grouped, plain)
})

console.log('== 6. I-40 静态守卫：一份实现、四处同源、界面不得绕过撤销语义 ==')
check('白名单与渲染只有一处权威实现（design-layout.cjs），前端不手抄模式清单', () => {
  const layout = read('electron/design-layout.cjs')
  assert.ok(/const BLEND_MODES = Object\.freeze\(\[/.test(layout), 'BLEND_MODES 是唯一清单')
  assert.equal((layout.match(/filterOf\(l\.adjust\)/g) || []).length, 2, '静态图与变量图各挂一次 filter')
  assert.ok(/Math\.max\(version, 6\)/.test(layout), '版本 6 已登记')
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/import \{[^}]*BLEND_MODES[^}]*\} from '\.\.\/\.\.\/electron\/design-layout\.cjs'/.test(view),
    '编辑器从权威源导入清单，不许手抄一份')
})
check('四个出片面共用 renderDesign（新字段能到画布/PNG/打印/PDF）', () => {
  assert.ok(/renderDesign\(/.test(read('electron/design-export.cjs')), 'PNG 导出走 renderDesign')
  assert.ok(/renderDesign\(/.test(read('electron/render-engine.cjs')), '打印/PDF 走 renderDesign')
  assert.ok(/renderDesign\(/.test(read('src/components/DesignSurface.vue')), '编辑器画布走 renderDesign')
})
check('调整滑杆与组透明度滑杆都是「预览→确认」：input 只预览，change 才记一条撤销', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/function adjustInput\(/.test(view) && /adjustDraft/.test(view), '有调整手势快照')
  assert.ok(/function adjustChange\(/.test(view) && /record\(draft\.before\)/.test(view), '松手才落一条撤销')
  assert.ok(/@input="adjustInput\(/.test(view) && /@change="adjustChange\(\)"/.test(view), '滑杆事件绑定成对')
  assert.ok(/function groupOpacityInput\(/.test(view) && /groupOpacityDraft/.test(view), '组透明度同款手势')
  assert.ok(/@input="groupOpacityInput\(/.test(view) && /@change="groupOpacityChange\(\)"/.test(view), '组透明度事件绑定成对')
  // 预览期间不许直接 commit：commit() 会立刻进撤销栈，拖一次滑杆就塞满历史
  const inputBody = view.slice(view.indexOf('function adjustInput('), view.indexOf('function adjustChange('))
  assert.ok(!/commit\(/.test(inputBody), '拖动过程中不 commit')
})
check('恢复原始颜色是真删除 adjust（渲染侧少一个 filter）', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const resetBody = view.slice(view.indexOf('function resetAdjust('), view.indexOf('const groupOpacityDraft'))
  assert.ok(/delete layer\.adjust/.test(resetBody), '重置走 delete，而不是写入一组恒等值')
})

console.log('\n== 7. I-47 静态守卫：滑杆的百分比换算必须与 schema 的取值口径成对 ==')
check('行为证明：schema 只收 0~1 且越界**抛错**——界面发 0~100 时整条滑杆都用不了', () => {
  const doc = normalizeDesign(designDoc([imageLayer({ adjust: { grayscale: 0.5, invert: 0.25 } })]))
  assert.equal(doc.layers[0].adjust.grayscale, 0.5, '0.5 原样保留 ⇒ 中间档位是合法的')
  assert.equal(doc.layers[0].adjust.invert, 0.25)
  assert.ok(renderHtml(designDoc([imageLayer({ adjust: { grayscale: 0.5 } })])).includes('grayscale(0.5)'),
    'CSS filter 按 0~1 输出，中间档位真的会渲染成半灰')
  // 反证：界面曾经把百分比直接当 schema 值发出去（0~100）。`number()` 对越界是**抛错**而不是夹取，
  // 于是画布渲染与松手提交都会抛 ⇒ 滑杆被整体回滚并报「去色超出有效范围（0–1）」，
  // 而滑杆 step=1 意味着 0 以外全是整数 ⇒ **除 0（恒等）之外没有任何档位可用**。
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ adjust: { grayscale: 50 } })])), /去色超出有效范围/,
    '发 0~100 会被判非法：这就是「拖了没反应 / 画布闪空 / 弹回去报错」的机制')
  assert.throws(() => normalizeDesign(designDoc([imageLayer({ adjust: { invert: 30 } })])), /反相超出有效范围/)
})
check('界面字段表的「上限 ÷ 100」与「恒等值 ÷ 100」必须等于 schema 的 max 与默认值', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const tableSrc = view.slice(view.indexOf('const ADJUST_FIELDS'), view.indexOf('const ADJUST_PERCENT ='))
  const rows = [...tableSrc.matchAll(/\['(\w+)',\s*'([^']+)',\s*(\d+),\s*(\d+)\]/g)]
    .map((m) => ({ key: m[1], label: m[2], max: Number(m[3]), identity: Number(m[4]) }))
  assert.equal(rows.length, 5, `字段表应有 5 行（亮度/对比度/饱和度/去色/反相），实得 ${rows.length}`)
  const percent = Number((view.match(/const ADJUST_PERCENT = (\d+)/) || [])[1])
  assert.equal(percent, 100, '界面百分比 → schema 一律 ÷100，且只有这一处定义')

  const layout = read('electron/design-layout.cjs')
  for (const row of rows) {
    // schema 的权威写法：`<key>: number(adj.<key>, <默认值>, <min>, <max>, '<标签>')`
    const m = layout.match(new RegExp(`\\b${row.key}: number\\(adj\\.${row.key}, ([\\d.]+), ([\\d.]+), ([\\d.]+),`))
    assert.ok(m, `schema 的 imageAdjust 里必须能查到 ${row.key}`)
    const [def, min, max] = m.slice(1).map(Number)
    assert.equal(min, 0, `${row.key} 的 schema 下限是 0，滑杆 min=0 才成立`)
    assert.equal(row.max / percent, max,
      `${row.key}：滑杆上限 ${row.max}% ÷100 应等于 schema 上限 ${max}（实得 ${row.max / percent}）——口径不一致时中间档位会被静默夹掉`)
    assert.equal(row.identity / percent, def,
      `${row.key}：恒等值 ${row.identity}% ÷100 应等于 schema 默认值 ${def}（实得 ${row.identity / percent}）`)
  }
  // 去色/反相的恒等值是 0（不是 100）：写成 100 会让面板一打开就整张图变灰/反相
  assert.equal(rows.find((r) => r.key === 'grayscale').identity, 0, '去色的恒等值是 0%')
  assert.equal(rows.find((r) => r.key === 'invert').identity, 0, '反相的恒等值是 0%')
  assert.equal(rows.find((r) => r.key === 'brightness').identity, 100, '亮度（乘数类）的恒等值是 100%')
  assert.ok(rows.every((r) => r.identity === 0 || r.identity === 100), '恒等值只允许 0%（比例类）或 100%（乘数类）')
})
check('换算只有一处：不许再有按字段分叉的除数，上限由字段表传进来', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(!/ADJUST_PERCENT_DIVISOR/.test(view), '按字段配除数的表必须删掉（去色/反相曾被配成 ÷1）')
  const body = view.slice(view.indexOf('function adjustInput('), view.indexOf('function adjustChange('))
  assert.ok(!/grayscale|invert|brightness/.test(body), '换算函数里不许再按字段名分叉——上限与恒等值都来自字段表')
  assert.ok(/Number\(max\)/.test(body) && /ADJUST_PERCENT/.test(body), '上限与除数都从参数/常量取')
  assert.ok(/@input="adjustInput\(key, \$event\.target\.value, max\)"/.test(view),
    '模板必须把字段表的上限传给换算函数（漏传会让上限变成 NaN，滑杆彻底不能拖）')
  assert.ok(/:max="max"/.test(view), '滑杆自身的 max 也来自同一张表')
  assert.ok(/adjustPercent\(key, identity\)/.test(view), '恒等值同样由字段表传进 adjustPercent')
})
check('滑杆旁回显当前百分比，能看清调到哪一档', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/design-adjust-\$\{key\}-value/.test(view), '每条滑杆都要有数值回显（与导出质量滑杆同一套做法）')
  assert.ok(/<output[^>]*design-adjust-\$\{key\}-value[^>]*>\{\{ adjustPercent\(key, identity\) \}\}%<\/output>/.test(view),
    '回显的就是滑杆当前值')
})

console.log(`\n混合模式与颜色调整：${passed} 项通过`)

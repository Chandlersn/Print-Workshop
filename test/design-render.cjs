/** Integration: committed artwork × physical layouts × print resources. */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const vm = require('vm')
const Module = require('module')
const { rmDeep } = require('./helpers/rm.cjs')
const DATA = path.join(__dirname, '.tmp-design-render')
process.env.PRINTPRESS_DATA_DIR = DATA
rmDeep(DATA)
fs.mkdirSync(DATA, { recursive: true })
const designs = require('../electron/designs.cjs')
const engine = require('../electron/render-engine.cjs')
const templates = require('../electron/templates.cjs')
const printDomain = require('../electron/print.cjs')
const { saveJson } = require('../electron/store.cjs')

let passed = 0
function check(label, run) { run(); passed++; console.log(`  ok - ${label}`) }
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
  const payload = Buffer.concat([Buffer.from(type), bytes])
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload))
  return Buffer.concat([size, payload, crc])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
const original = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 128]))), chunk('IEND', Buffer.alloc(0)),
])
const asset = designs.importImageBytes({ name: '原始透明图.png', base64: original.toString('base64') })
fs.mkdirSync(path.join(DATA, 'print-fonts'))
fs.writeFileSync(path.join(DATA, 'print-fonts', "测试'楷体.ttf"), 'FONT_BYTES')
fs.writeFileSync(path.join(DATA, 'print-fonts', 'unused.ttf'), 'UNUSED_FONT_BYTES')
const text = '证书 <script>alert("x")</script> & 标题'
const baseDoc = {
  schemaVersion: 1, revision: 0, name: '集成底图', artboard: { w: 85, h: 54, background: '#ffffff' },
  assets: { [asset.id]: asset },
  layers: [
    { id: 'photo', type: 'image', assetId: asset.id, x: 0, y: 0, w: 40, h: 20, rotation: 10, opacity: 0.8, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } },
    { id: 'repeat', type: 'image', assetId: asset.id, x: 45, y: 2, w: 30, h: 15 },
    { id: 'title', type: 'text', text, x: 10, y: 25, w: 70, h: 20, fontFamily: "测试'楷体", fontSize: 12 },
    { id: 'line', type: 'line', x: 0, y: 20, w: 80, h: 1, strokeWidth: 0.2, stroke: '#123456' },
  ],
}
const v1 = designs.saveDesign(baseDoc)
const ref = { id: v1.id, revision: v1.revision }
const template = {
  name: '模板', datasetId: 'ds_design', pageSize: { id: 'custom', w: 85, h: 54 },
  backgroundDesign: ref, fields: [{ column: '姓名', x: 50, y: 75, fontSize: 12, align: 'center' }],
}
saveJson('datasets', [{ id: 'ds_design', name: '名单', columns: [{ key: '姓名', printOn: true }], rows: [{ 姓名: '张三' }] }])
const rows = Array.from({ length: 21 }, (_, i) => ({ 姓名: `姓名 ${i}` }))
const html = engine.buildHtml(template, rows, { withToolbar: false })

check('保存模板引用固定工程版本，列表标记有底图', () => {
  const saved = templates.saveTemplate(structuredClone(template))
  assert.deepEqual(saved.backgroundDesign, ref)
  assert.equal(templates.listTemplates()[0].hasBackground, true)
})
check('打印预览提供固定版本图层统计与裁切后的最低有效dpi', () => {
  const templateId = templates.listTemplates()[0].id
  const built = printDomain.buildBatchHtml('ds_design', templateId)
  assert.deepEqual(built.designInfo, { name: '集成底图', revision: 1, layerCount: 4, minDpi: Math.min(2 * 0.5 / 40, 1 / 20) * 25.4 })
  assert.equal(built.bgDpi, null)
  assert.ok(built.html.includes(original.toString('base64')))
  assert.ok(built.snapshotHtml.includes(original.toString('base64')))
})
check('21页复用同一原图，未重编码且只内联一次', () => {
  const urls = html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g)
  assert.equal(urls.length, 1)
  assert.deepEqual(Buffer.from(urls[0].split(',')[1], 'base64'), original)
  assert.equal((html.match(/class="print-design-root"/g) || []).length, 21)
  assert.equal((html.match(/class="pf"/g) || []).length, 21)
})
check('静态文字字体单独内联，并排除未使用上传字体', () => {
  assert.ok(html.includes("font-family:'测试楷体'"))
  assert.ok(html.includes('data:font/ttf;base64,' + Buffer.from('FONT_BYTES').toString('base64')))
  assert.ok(!html.includes(Buffer.from('UNUSED_FONT_BYTES').toString('base64')))
  assert.equal((html.match(/@font-face/g) || []).length, 1)
})
check('图层文字转义，形状保留SVG且毫米位置不变', () => {
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('<svg'))
  assert.ok(html.includes('left:10mm;top:25mm;width:70mm;height:20mm'))
  assert.ok(html.includes('width:85mm;height:54mm'))
})
check('底图在变量字段之前，变量字段保持原有百分比锚点', () => {
  assert.ok(html.indexOf('<div class="print-design-root">') < html.indexOf('<div class="pf"'))
  assert.ok(html.includes('left:50%;top:75%;transform:translateX(-50%);'))
})
check('变量字段字体名中的HTML实体字符保持字面值', () => {
  assert.ok(engine.fieldStyle({ fontFamily: 'Font&copy' }).includes("font-family:'Font&amp;copy';"))
})
check('工程新版本不改变已保存模板版本的内容', () => {
  const next = structuredClone(v1)
  next.layers[2].text = '更新后的标题'
  const v2 = designs.saveDesign(next)
  assert.equal(v2.revision, 2)
  const old = engine.buildHtml(template, rows.slice(0, 1))
  assert.ok(old.includes('&lt;script&gt;'))
  assert.ok(!old.includes('更新后的标题'))
  const latest = engine.buildHtml({ ...template, backgroundDesign: { id: v2.id, revision: 2 } }, rows.slice(0, 1))
  assert.ok(latest.includes('更新后的标题'))
})
check('多联仅渲染21个实际成品，3页，图层资源仍只有一份', () => {
  const grid = engine.buildHtml({ ...template, pageSize: 'a4-portrait', layout: { mode: 'grid', itemW: 85, itemH: 54 } }, rows)
  assert.equal((grid.match(/class="page"/g) || []).length, 3)
  assert.equal((grid.match(/class="print-design-root"/g) || []).length, 21)
  assert.equal((grid.match(/data:image\/png;base64,/g) || []).length, 1)
  assert.ok(grid.includes('outline: 0.2mm'))
  assert.ok(!grid.includes('.cell.cut { border:'))
})
check('对折上下两联使用半页工程，上联旋转180度', () => {
  const fold = engine.buildHtml({ ...template, pageSize: { id: 'custom', w: 85, h: 108 }, layout: { mode: 'fold' } }, rows.slice(0, 2))
  assert.equal((fold.match(/class="print-design-root"/g) || []).length, 4)
  assert.equal((fold.match(/class="fold-half flip"/g) || []).length, 2)
  assert.ok(fold.includes('transform: rotate(180deg)'))
})
check('尺寸不符、无固定版本、旧底图混用均明确拒绝', () => {
  assert.throws(() => engine.buildHtml({ ...template, pageSize: 'a4-portrait' }, rows), /尺寸.*不一致/)
  assert.throws(() => templates.saveTemplate({ ...template, pageSize: 'a4-portrait' }), /尺寸.*不一致/)
  assert.throws(() => engine.buildHtml({ ...template, backgroundDesign: { id: v1.id } }, rows), /固定版本/)
  assert.throws(() => engine.buildHtml({ ...template, background: 'print-bg/old.png' }, rows), /同时使用/)
  assert.throws(() => engine.buildHtml({ ...template, layout: { mode: 'grid', itemW: 85, itemH: 54 } }, rows), /多联/)
})
check('删除实际素材后拒绝渲染而非空白底图', () => {
  const abs = path.join(DATA, asset.path)
  fs.unlinkSync(abs)
  assert.throws(() => engine.buildHtml(template, rows), /ENOENT|素材/)
  fs.writeFileSync(abs, original)
})
check('已引用的上传字体被外部删除时阻断打印，避免静默替换字形', () => {
  const abs = path.join(DATA, 'print-fonts', "测试'楷体.ttf")
  const bytes = fs.readFileSync(abs)
  fs.unlinkSync(abs)
  assert.throws(() => engine.buildHtml(template, rows), /字体/)
  fs.writeFileSync(abs, bytes)
})
check('纯矢量工程没有图片dpi，隐藏图片不拉低报告', () => {
  const vector = designs.saveDesign({ ...baseDoc, layers: baseDoc.layers.filter(layer => layer.type !== 'image') })
  const vectorInfo = engine.prepareTemplateDesign({ ...template, backgroundDesign: { id: vector.id, revision: 1 } }).info
  assert.equal(vectorInfo.minDpi, null)
  const hidden = structuredClone(baseDoc)
  hidden.layers[0].visible = false
  const saved = designs.saveDesign(hidden)
  const info = engine.prepareTemplateDesign({ ...template, backgroundDesign: { id: saved.id, revision: 1 } }).info
  assert.equal(info.minDpi, Math.min(2 / 30, 1 / 15) * 25.4)
})
check('旧单图仍内联原字节，并且没有工程包装', () => {
  fs.mkdirSync(path.join(DATA, 'print-bg'))
  fs.writeFileSync(path.join(DATA, 'print-bg', 'legacy.png'), original)
  const legacy = engine.buildHtml({ ...template, backgroundDesign: undefined, background: 'print-bg/legacy.png' }, rows)
  assert.ok(legacy.includes(original.toString('base64')))
  assert.ok(!legacy.includes('print-design-root'))
})
check('旧图转工程后删除旧文件或模板不影响工程原素材', () => {
  const legacyPath = 'print-bg/legacy.png'
  const legacy = templates.saveTemplate({ ...template, backgroundDesign: undefined, background: legacyPath })
  const copied = designs.saveDesign(designs.importLegacyBackground({ background: legacyPath, w: 85, h: 54, name: '旧底图转换' }))
  const switched = templates.saveTemplate({ ...legacy, background: '', backgroundDesign: { id: copied.id, revision: copied.revision } })
  assert.equal(fs.existsSync(path.join(DATA, legacyPath)), true)
  templates.discardBackground(legacyPath)
  assert.equal(fs.existsSync(path.join(DATA, legacyPath)), false)
  assert.ok(engine.buildHtml(switched, rows).includes(original.toString('base64')))
  templates.deleteTemplate(switched.id)
  assert.ok(designs.getDesign(copied.id, copied.revision).layers.length)
  assert.equal(templates.discardBackground(asset.path).removed, false)
  assert.equal(fs.existsSync(path.join(DATA, asset.path)), true)
})

// Evaluate the same browser function without Electron. Decode completion/failure and
// timeout are observable results, and the real Electron suite covers the PDF product.
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: function () {} }
  return originalLoad.call(this, request, parent, isMain)
}
let waitPrintResources
try { ({ waitPrintResources } = require('../electron/printer.cjs')) } finally { Module._load = originalLoad }
function resourceContext({ failImage = false, fontError = false, hang = false } = {}) {
  const decoded = []
  class Image {
    constructor() { this.naturalWidth = 2; this.naturalHeight = 1 }
    async decode() {
      if (hang) return new Promise(() => {})
      if (failImage) throw new Error('test image decode failed')
      await new Promise(resolve => setTimeout(resolve, 4))
      decoded.push(this.src)
    }
  }
  const fonts = [{ family: 'Example', status: fontError ? 'error' : 'loaded' }]
  fonts.ready = Promise.resolve(fonts)
  return {
    decoded, Image, setTimeout, clearTimeout,
    document: {
      styleSheets: [{ cssRules: [{ style: { backgroundImage: 'url("data:image/png;base64,AAAA")' } }, { style: { backgroundImage: 'url("data:image/png;base64,AAAA")' } }] }],
      querySelectorAll: () => [], images: [], fonts, body: { getBoundingClientRect: () => ({}) },
    },
  }
}
async function runResources() {
  const evaluate = context => vm.runInNewContext(`(${waitPrintResources.toString()})(35)`, context)
  const ready = resourceContext()
  await evaluate(ready)
  check('打印等待CSS背景实际解码完成，共用URL只解码一次', () => assert.equal(ready.decoded.length, 1))
  await assert.rejects(evaluate(resourceContext({ failImage: true })), /decode failed/)
  passed++; console.log('  ok - 图片解码失败阻断打印')
  await assert.rejects(evaluate(resourceContext({ fontError: true })), /字体加载失败/)
  passed++; console.log('  ok - 字体加载失败阻断打印')
  await assert.rejects(evaluate(resourceContext({ hang: true })), /超时/)
  passed++; console.log('  ok - 卡住的图片解码超时退出')
  console.log(`\n图层打印集成：${passed} 项通过`)
}
runResources().catch(err => { console.error(err); process.exitCode = 1 })

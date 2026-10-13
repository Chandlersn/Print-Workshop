/** 出图（PNG / JPEG / WebP）的尺寸计算、格式表、快照校验、写盘闸门与原子提交行为。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const DATA = path.join(__dirname, '.tmp-design-export')
process.env.PRINTPRESS_DATA_DIR = DATA
rmDeep(DATA)
fs.mkdirSync(DATA, { recursive: true })
const exporter = require('../electron/design-export.cjs')
const api = require('../electron/api.cjs')
const designs = require('../electron/designs.cjs')
const imageBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.png'))
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf-8')
const base = { schemaVersion: 2, revision: 0, name: 'PNG测试', artboard: { w: 210, h: 297, background: '#abcdef' }, assets: {}, layers: [] }
let passed = 0
function check(label, run) { run(); passed++; console.log('  ok -', label) }
check('毫米按指定DPI舍入到精确像素', () => {
  assert.deepEqual(exporter.outputSize(base.artboard, 300), { width: 2480, height: 3508, dpi: 300 })
  assert.deepEqual(exporter.outputSize(base.artboard, 600), { width: 4961, height: 7016, dpi: 600 })
  assert.deepEqual(exporter.outputSize({ w: 25.4, h: 12.7 }, 150), { width: 150, height: 75, dpi: 150 })
})
check('不支持DPI、过长或过多像素明确拒绝，不自动缩小', () => {
  assert.throws(() => exporter.outputSize(base.artboard, 96), /150/)
  assert.throws(() => exporter.outputSize({ w: 2000, h: 10 }, 600), /超出限制/)
  assert.throws(() => exporter.outputSize({ w: 420, h: 297 }, 600), /超出限制/)
})
check('未保存草稿可准备导出且不创建工程或改变输入', () => {
  const before = structuredClone(base)
  const prepared = exporter.prepareExport({ design: base, dpi: 300 })
  assert.equal(prepared.width, 2480)
  assert.ok(prepared.html.includes('background:#abcdef'))
  assert.deepEqual(base, before)
  assert.equal(designs.listDesigns().length, 0)
})
check('透明背景选项只改变导出快照，不修改作品背景', () => {
  const prepared = exporter.prepareExport({ design: base, transparent: true })
  assert.ok(!prepared.html.includes('#abcdef'))
  assert.ok(prepared.html.includes('background:transparent'))
  assert.equal(base.artboard.background, '#abcdef')
  const gradient = { ...base, artboard: { ...base.artboard, backgroundPaint: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#fff000', opacity: 1 }, { offset: 1, color: '#000fff', opacity: 1 }] } } }
  assert.ok(exporter.prepareExport({ design: gradient, transparent: true }).html.includes('background:transparent'))
  assert.ok(!exporter.prepareExport({ design: gradient, transparent: true }).html.includes('<linearGradient'))
  assert.throws(() => exporter.prepareExport({ design: base, transparent: 'yes' }), /布尔/)
})
check('高 DPI 大范围阴影按滤镜缓冲区预算拒绝，提示用户降低 DPI', () => {
  const design = { ...base, artboard: { w: 100, h: 100, background: '#ffffff' }, layers: [
    { id: 'large-shadow', type: 'rect', x: -50, y: -50, w: 250, h: 250, fill: '#ffffff', shadow: { dxMm: 5, dyMm: 5, blurMm: 10, color: '#000000', opacity: 0.5 } },
  ] }
  assert.throws(() => exporter.prepareExport({ design, dpi: 600 }), /工作内存.*阴影效果/)
  assert.ok(exporter.prepareExport({ design, dpi: 150 }).html.includes('<filter'))
})
check('原图仅内联一次，准备后不依赖后续素材文件变化', () => {
  const asset = designs.importImageBytes({ name: 'source.png', base64: imageBytes.toString('base64') })
  const doc = { ...base, assets: { [asset.id]: asset }, layers: [{ id: 'image', type: 'image', assetId: asset.id, x: 0, y: 0, w: 10, h: 10 }] }
  const prepared = exporter.prepareExport({ design: doc })
  assert.equal(prepared.html.split(imageBytes.toString('base64')).length - 1, 1)
  fs.unlinkSync(path.join(DATA, asset.path))
  assert.ok(prepared.html.includes(imageBytes.toString('base64')))
  assert.throws(() => exporter.prepareExport({ design: doc }), /ENOENT|素材/)
})
check('PNG写入物理DPI元信息且原像素压缩码流不变', () => {
  const withDpi = exporter.pngWithDpi(imageBytes, 300)
  const pos = withDpi.indexOf(Buffer.from('pHYs'))
  assert.ok(pos > 0)
  assert.equal(withDpi.readUInt32BE(pos + 4), 11811)
  assert.equal(withDpi.readUInt32BE(pos + 8), 11811)
  const idat = imageBytes.indexOf(Buffer.from('IDAT'))
  const data = imageBytes.subarray(idat + 4, idat + 4 + imageBytes.readUInt32BE(idat - 4))
  assert.ok(withDpi.includes(data))
  assert.equal(exporter.pngWithDpi(withDpi, 600).toString('latin1').split('pHYs').length - 1, 1)
})
check('输出路径须为受支持的图片绝对路径且不能覆盖工程原素材', () => {
  assert.throws(() => exporter.outputPath('relative.png'), /绝对/)
  assert.throws(() => exporter.outputPath(path.join(DATA, 'a.txt')), /扩展名/)
  assert.throws(() => exporter.outputPath(path.join(DATA, 'a.png'), 'jpeg'), /不符/)
  assert.throws(() => exporter.outputPath(path.join(DATA, 'design-assets', 'a.png')), /素材目录/)
  // `.jpg` 是 jpeg 的合法扩展名——多格式落地前这里是被拒的，别再改回去
  assert.ok(exporter.outputPath(path.join(DATA, 'a.jpg')).endsWith('a.jpg'))
})
check('目录junction不能绕过原素材保护', () => {
  const directory = path.join(DATA, 'design-assets')
  const alias = path.join(DATA, 'export-alias')
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => exporter.outputPath(path.join(alias, 'overwrite.png')), /素材目录/)
  fs.rmdirSync(alias)
})
console.log('== I-41 静态守卫：格式表单一权威源，透明能力与 DPI 元数据不得各写一份 ==')
check('格式表只在 export-formats.cjs 定义，出图实现与界面都读它', () => {
  const formats = read('electron/export-formats.cjs')
  assert.ok(/const FORMATS = Object\.freeze\(\{/.test(formats), '权威源在这里')
  const implementation = read('electron/design-export.cjs')
  assert.ok(/require\('\.\/export-formats\.cjs'\)/.test(implementation), '出图实现从权威源导入')
  assert.ok(!/const FORMATS = Object\.freeze\(\{/.test(implementation), '出图实现不许再抄一份格式表')
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/import \{[^}]*FORMATS[^}]*\} from '\.\.\/\.\.\/electron\/export-formats\.cjs'/.test(view),
    '导出面板从权威源导入')
  // 界面 import 出图实现会把 fs / path / crypto 打进浏览器包（构建直接失败）——钉住不许走回头路
  assert.ok(!/from '\.\.\/\.\.\/electron\/design-export\.cjs'/.test(view),
    '界面不许 import 出图实现')
})
check('透明能力与 DPI 写入方式由格式表决定，不在各处硬编码格式名', () => {
  const implementation = read('electron/design-export.cjs')
  assert.ok(/FORMATS\[kind\]\.dpi === 'phys'/.test(implementation) && /FORMATS\[kind\]\.dpi === 'jfif'/.test(implementation),
    'DPI 落法按格式表的 dpi 字段分派')
  assert.ok(/wantsTransparent = transparent && FORMATS\[kind\]\.transparent/.test(implementation),
    "能不能透明由格式表说了算，不写 if (format === 'jpeg')")
  assert.ok(/outputPath\(filePath, kind\)/.test(implementation), '写盘前按 format 校验扩展名')
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/exportFormatInfo\.value\.transparent/.test(view), '界面用同一份透明能力判断禁用勾选框')
  assert.ok(/normalizeQuality\(undefined, exportFormat\.value\)/.test(view), '切格式时质量回到该格式的默认值')
})
check('出图格式白名单：扩展名、透明能力、默认质量只定义一处', () => {
  assert.deepEqual(Object.keys(exporter.FORMATS), ['png', 'jpeg', 'webp'])
  assert.equal(exporter.FORMATS.png.quality, null, 'PNG 无损，没有质量参数')
  assert.equal(exporter.FORMATS.png.transparent, true)
  assert.equal(exporter.FORMATS.jpeg.transparent, false, 'JPEG 没有 alpha 通道')
  assert.deepEqual(exporter.FORMATS.jpeg.exts, ['jpg', 'jpeg'])
  assert.equal(exporter.normalizeFormat(undefined), 'png')
  assert.equal(exporter.normalizeFormat('JPG'), 'jpeg', '大小写与 .jpg 别名都归到 jpeg')
  assert.throws(() => exporter.normalizeFormat('bmp'), /不支持的出图格式/)
})
check('质量参数：有损格式有默认值，PNG 忽略，越界与非整数一律拒绝', () => {
  assert.equal(exporter.normalizeQuality(undefined, 'jpeg'), 90)
  assert.equal(exporter.normalizeQuality(undefined, 'webp'), 80)
  assert.equal(exporter.normalizeQuality(70, 'jpeg'), 70)
  assert.equal(exporter.normalizeQuality(70, 'png'), null)
  assert.throws(() => exporter.normalizeQuality(0, 'jpeg'), /1~100/)
  assert.throws(() => exporter.normalizeQuality(101, 'jpeg'), /1~100/)
  assert.throws(() => exporter.normalizeQuality(88.5, 'jpeg'), /1~100/)
})
check('JPEG 不支持透明：勾了透明就铺画布底色，并如实报告 flattened', () => {
  const jpeg = exporter.prepareExport({ design: base, transparent: true, format: 'jpeg' })
  assert.equal(jpeg.format, 'jpeg')
  assert.equal(jpeg.quality, 90)
  assert.equal(jpeg.transparent, false)
  assert.equal(jpeg.flattened, true)
  assert.ok(jpeg.html.includes('background:#abcdef'), '铺的是画布自己的底色，不是硬编码白')
  assert.ok(!jpeg.html.includes('background:transparent'))
  const png = exporter.prepareExport({ design: base, transparent: true, format: 'png' })
  assert.equal(png.transparent, true)
  assert.equal(png.flattened, false)
  assert.equal(png.quality, null)
  // 画布本身就是 transparent 时没有底色可铺，退回白色，不能印出一片黑
  const blank = { ...base, artboard: { ...base.artboard, background: 'transparent' } }
  const flat = exporter.prepareExport({ design: blank, format: 'jpeg' })
  assert.equal(flat.flattened, true)
  assert.ok(flat.html.includes('background:#ffffff'))
})
check('体积估算只给有损格式，且随质量单调上升、WebP 小于同质量 JPEG', () => {
  assert.equal(exporter.estimateOutputBytes({ width: 100, height: 100, format: 'png' }), null,
    'PNG 无损：体积与质量无关，估出来也帮不了用户做决定')
  const at = q => exporter.estimateOutputBytes({ width: 1000, height: 1000, format: 'jpeg', quality: q })
  assert.ok(at(50) < at(80) && at(80) < at(90) && at(90) < at(100), '质量越高估得越大')
  assert.ok(exporter.estimateOutputBytes({ width: 1000, height: 1000, format: 'webp', quality: 90 }) < at(90))
  assert.throws(() => exporter.estimateOutputBytes({ width: 0, height: 10, format: 'jpeg' }), /尺寸无效/)
})
check('JPEG 写 JFIF 密度：无论上游有没有 APP0，结果都恰好一个且密度正确', () => {
  const images = require('../electron/images.cjs')
  const segment = (marker, payload) => {
    const head = Buffer.alloc(4)
    head[0] = 0xff; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2)
    return Buffer.concat([head, payload])
  }
  const jfif = Buffer.alloc(14)
  jfif.write('JFIF\0', 0, 'latin1'); jfif[5] = 1; jfif[6] = 1
  jfif.writeUInt16BE(1, 8); jfif.writeUInt16BE(1, 10)
  const sof = Buffer.alloc(11); sof[0] = 8; sof.writeUInt16BE(20, 1); sof.writeUInt16BE(30, 3)  // SOF 里先存高、再存宽
  // SOS 之后是熵编码数据——它必须被原样保留，不能被当成有长度字段的段
  const tail = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9])
  for (const withJfif of [true, false]) {
    const source = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...(withJfif ? [segment(0xe0, jfif)] : []),
      segment(0xdb, Buffer.alloc(4)),
      segment(0xc0, sof),
      tail,
    ])
    const out = exporter.jpegWithDpi(source, 300)
    assert.equal(out.toString('latin1').split('JFIF').length - 1, 1, '恰好一个 JFIF 标识')
    /*
     * 输出布局：[SOI 2][APP0 头 2][段长 2]['JFIF\0' 5][版本 2][units 1][Xdensity 2][Ydensity 2][缩略图 2]
     * 下标：0-1 SOI、2-3 FFE0、4-5 段长、6-10 标识、11-12 版本、13 units、14-15/16-17 密度。
     */
    assert.ok(out.subarray(0, 4).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))
    assert.equal(out.readUInt16BE(4), 16, 'APP0 段长含长度字段自身')
    assert.equal(out.toString('latin1', 6, 11), 'JFIF\0')
    assert.equal(out[13], 1, 'units=1 表示密度单位为 dpi')
    assert.equal(out.readUInt16BE(14), 300)
    assert.equal(out.readUInt16BE(16), 300)
    assert.ok(out.subarray(-tail.length).equals(tail), '熵编码数据与 EOI 逐字节保留')
    assert.deepEqual(images.imageSizeFromBuffer(out), { width: 30, height: 20 }, '改写后仍能读出尺寸')
  }
  assert.throws(() => exporter.jpegWithDpi(Buffer.from([1, 2, 3, 4]), 300), /JPEG 渲染结果无效/)
})
check('WebP 尺寸解析：VP8X / VP8 / VP8L 三种编码都能读', () => {
  const images = require('../electron/images.cjs')
  const riff = (chunk, payload) => {
    const head = Buffer.alloc(20)
    head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(payload.length + 12, 4)
    head.write('WEBP', 8, 'latin1'); head.write(chunk, 12, 'latin1')
    head.writeUInt32LE(payload.length, 16)
    return Buffer.concat([head, payload])
  }
  const vp8x = Buffer.alloc(10); vp8x.writeUIntLE(399, 4, 3); vp8x.writeUIntLE(299, 7, 3)
  assert.deepEqual(images.imageSizeFromBuffer(riff('VP8X', vp8x)), { width: 400, height: 300 })
  const vp8 = Buffer.alloc(10); vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a
  vp8.writeUInt16LE(640, 6); vp8.writeUInt16LE(480, 8)
  assert.deepEqual(images.imageSizeFromBuffer(riff('VP8 ', vp8)), { width: 640, height: 480 })
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f
  vp8l.writeUInt32LE((199 & 0x3fff) | ((99 & 0x3fff) << 14), 1)
  assert.deepEqual(images.imageSizeFromBuffer(riff('VP8L', vp8l)), { width: 200, height: 100 })
  assert.equal(images.imageSizeFromBuffer(Buffer.from('RIFF0000WEBPxxxx')), null)
  assert.equal(images.sniffImageExt(riff('VP8X', vp8x)), null, '上传入口仍然只收 PNG / JPEG')
})

async function main() {
  const target = path.join(DATA, 'output.png')
  let dialogOptions = null
  const ctx = {
    allowWrite: true,
    printer: { prepareDesignPng: exporter.prepareExport, exportDesignPng: (prepared, filePath) => exporter.exportPng(prepared, filePath, async () => imageBytes) },
    dialog: { saveFile: async () => ({ canceled: true }) },
  }
  assert.throws(() => api.call('design:exportPng', { design: base }, {}), /写权限/)
  assert.throws(() => api.call('design:exportPng', { design: base }, { allowWrite: true }), /无 GUI/)
  passed++; console.log('  ok - API保持写权限与Electron宿主能力边界')
  ctx.dialog.saveFile = async (options) => { dialogOptions = options; return { canceled: true } }
  const canceled = await api.call('design:exportPng', { design: base }, ctx)
  assert.deepEqual(canceled, { canceled: true })
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(dialogOptions.filters, [{ name: 'PNG 图片', extensions: ['png'] }])
  assert.ok(dialogOptions.defaultPath.endsWith('.png'), '默认文件名跟着格式走')
  passed++; console.log('  ok - 保存对话框取消不写文件或创建工程')
  // 选了 JPEG：对话框的过滤器与默认扩展名都要跟着换，质量参数原样透传
  await api.call('design:exportPng', { design: base, format: 'jpeg', quality: 75 }, ctx)
  assert.deepEqual(dialogOptions.filters, [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }])
  assert.ok(dialogOptions.defaultPath.endsWith('.jpg'))
  assert.ok(dialogOptions.title.includes('JPEG'))
  passed++; console.log('  ok - 保存对话框按 format 换过滤器、扩展名与标题')
  // 格式非法必须在弹窗之前就报错，而不是让用户选完位置才发现写不进去
  await assert.rejects(api.call('design:exportPng', { design: base, format: 'bmp' }, ctx), /不支持的出图格式/)
  await assert.rejects(api.call('design:exportPng', { design: base, format: 'jpeg', quality: 0 }, ctx), /1~100/)
  passed++; console.log('  ok - 非法格式与质量在弹窗前就被拒绝')
  ctx.dialog.saveFile = async () => { throw new Error('显式路径不应弹窗') }
  const result = await api.call('design:exportPng', { design: base, dpi: 150, filePath: target }, ctx)
  assert.equal(result.filePath, target)
  assert.equal(result.width, 1240)
  assert.equal(result.format, 'png')
  assert.equal(result.flattened, false)
  assert.equal(result.bytes, imageBytes.length)
  assert.deepEqual(fs.readFileSync(target), imageBytes)
  passed++; console.log('  ok - 注入渲染能力并提供显式路径可导出，不弹对话框')
  // 扩展名与 format 不符时，渲染之前就要拦住
  await assert.rejects(
    api.call('design:exportPng', { design: base, format: 'png', filePath: path.join(DATA, 'wrong.jpg') }, ctx),
    /不符/)
  passed++; console.log('  ok - 显式路径扩展名与 format 不符时在写盘前拒绝')
  const prepared = exporter.prepareExport({ design: base })
  await assert.rejects(exporter.exportPng(prepared, target, async () => { throw new Error('渲染失败') }), /渲染失败/)
  assert.deepEqual(fs.readFileSync(target), imageBytes)
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('模拟提交失败') }
  try { assert.throws(() => exporter.atomicWrite(target, Buffer.from('new')), /模拟提交失败/) } finally { fs.renameSync = rename }
  assert.deepEqual(fs.readFileSync(target), imageBytes)
  assert.ok(!fs.readdirSync(DATA).some(name => name.endsWith('.tmp')))
  passed++; console.log('  ok - 渲染/提交失败保留旧文件，临时文件已清理')
  console.log(`\n出图（PNG / JPEG / WebP）：${passed} 项通过`)
}
main().catch(err => { console.error(err); process.exitCode = 1 })

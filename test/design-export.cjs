/** PNG output sizing, snapshot validation, write gates, and atomic save behavior. */
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
  assert.throws(() => exporter.prepareExport({ design: base, transparent: 'yes' }), /布尔/)
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
check('输出路径须为PNG绝对路径且不能覆盖工程原素材', () => {
  assert.throws(() => exporter.outputPath('relative.png'), /绝对/)
  assert.throws(() => exporter.outputPath(path.join(DATA, 'a.jpg')), /png/)
  assert.throws(() => exporter.outputPath(path.join(DATA, 'design-assets', 'a.png')), /素材目录/)
})
check('目录junction不能绕过原素材保护', () => {
  const directory = path.join(DATA, 'design-assets')
  const alias = path.join(DATA, 'export-alias')
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => exporter.outputPath(path.join(alias, 'overwrite.png')), /素材目录/)
  fs.rmdirSync(alias)
})

async function main() {
  const target = path.join(DATA, 'output.png')
  const ctx = {
    allowWrite: true,
    printer: { prepareDesignPng: exporter.prepareExport, exportDesignPng: (prepared, filePath) => exporter.exportPng(prepared, filePath, async () => imageBytes) },
    dialog: { saveFile: async () => ({ canceled: true }) },
  }
  assert.throws(() => api.call('design:exportPng', { design: base }, {}), /写权限/)
  assert.throws(() => api.call('design:exportPng', { design: base }, { allowWrite: true }), /无 GUI/)
  passed++; console.log('  ok - API保持写权限与Electron宿主能力边界')
  const canceled = await api.call('design:exportPng', { design: base }, ctx)
  assert.deepEqual(canceled, { canceled: true })
  assert.equal(fs.existsSync(target), false)
  passed++; console.log('  ok - 保存对话框取消不写文件或创建工程')
  ctx.dialog.saveFile = async () => { throw new Error('显式路径不应弹窗') }
  const result = await api.call('design:exportPng', { design: base, dpi: 150, filePath: target }, ctx)
  assert.equal(result.filePath, target)
  assert.equal(result.width, 1240)
  assert.deepEqual(fs.readFileSync(target), imageBytes)
  passed++; console.log('  ok - 注入渲染能力并提供显式路径可导出，不弹对话框')
  const prepared = exporter.prepareExport({ design: base })
  await assert.rejects(exporter.exportPng(prepared, target, async () => { throw new Error('渲染失败') }), /渲染失败/)
  assert.deepEqual(fs.readFileSync(target), imageBytes)
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('模拟提交失败') }
  try { assert.throws(() => exporter.atomicWrite(target, Buffer.from('new')), /模拟提交失败/) } finally { fs.renameSync = rename }
  assert.deepEqual(fs.readFileSync(target), imageBytes)
  assert.ok(!fs.readdirSync(DATA).some(name => name.endsWith('.tmp')))
  passed++; console.log('  ok - 渲染/提交失败保留旧文件，临时文件已清理')
  console.log(`\nPNG导出：${passed} 项通过`)
}
main().catch(err => { console.error(err); process.exitCode = 1 })

/**
 * 模板底图并入素材库（I-33）领域验收。
 *
 * 钉的是「模板页上传的底图」并入素材库内容寻址池后的分流性质：
 *   1. 模板上传 → background 为 assetId，原件进 design-assets，列表不展示（source 过滤）；
 *   2. discard 按 source 分流：template 且无引用即时删；library 不删；
 *   3. referencedAssetIds 接过来扫描模板背景 → 清理未引用不误杀；
 *   4. 去重升级：template → library 后 discard 不再即时删；
 *   5. 列表只来源于 library（source==='template' 过滤）；
 *   6. 存量 print-bg 背景 migrateBackgrounds 迁为 assetId；
 *   7. 底图制作页直接加图（粘贴/拖入/对话框）= template 临时件：通道层强制 source，
 *      删图层后 exceptDesignId 跳过未保存的当前工程再同步清理；领域层缺省 library。
 *
 * 缩略图不注入（纯 Node），领域层只在有 makeThumbnail 回调时才缩，没有就降级——与本文件无关。
 */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-template-asset-'))
process.env.PRINTPRESS_DATA_DIR = tmp
const designs = require('../electron/designs.cjs')
const library = require('../electron/asset-library.cjs')
const templates = require('../electron/templates.cjs')
const dataset = require('../electron/dataset.cjs')

let passed = 0
function check(name, run) { run(); passed++; console.log(`  ok - ${name}`) }

const pngA = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png'))
const jpgB = fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg'))

// 独立生成 PNG，避免与共享 fixture（pngA/jpgB）因内容寻址去重而互相污染 source 标记
const zlib = require('zlib')
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
  const payload = Buffer.concat([Buffer.from(type), bytes])
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload))
  return Buffer.concat([size, payload, crc])
}
function makePng(w, h, fill) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4)
    for (let x = 0; x < w; x++) { row[1 + x * 4] = fill[0]; row[2 + x * 4] = fill[1]; row[3 + x * 4] = fill[2]; row[4 + x * 4] = 255 }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ])
}
const assetsDir = path.join(tmp, 'design-assets')
const thumbDir = path.join(tmp, 'design-thumbnails')
const shaOf = (assetId) => assetId.slice('asset_'.length)
function assetFiles(hash) {
  return ['png', 'jpg', 'jpeg', 'json'].map((e) => path.join(assetsDir, `${hash}.${e}`)).filter(fs.existsSync)
}
function thumbFile(hash) { return path.join(thumbDir, `${hash}.png`) }
function existsAny(hash) { return assetFiles(hash).length > 0 || fs.existsSync(thumbFile(hash)) }

// 一个数据集，供需要落库模板的用例使用
const FIXTURES = path.join(tmp, 'fixtures')
fs.mkdirSync(FIXTURES, { recursive: true })
const csvPath = path.join(FIXTURES, 'bind-ds.csv')
fs.writeFileSync(csvPath, '姓名,奖级\n甲,金奖\n乙,银奖\n', 'utf8')
const ds = dataset.importFromFile(csvPath)
dataset.setColumnPrint(ds.id, '姓名', true)

console.log('== I-33 模板底图并入素材库 ==')
// === I-33 模板底图走素材库原件（assetId），discard 按 source 分流，受管理件不即时删 ===

// 1. 模板上传 → assetId + 原件落盘 + source=template + 列表不展示
check('模板上传底图 → background 为 assetId，原件在 design-assets，列表不展示', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'a.png')
  assert.match(r.background, /^asset_[a-f0-9]{64}$/, '返回 assetId')
  const hash = shaOf(r.background)
  assert.ok(fs.existsSync(path.join(assetsDir, `${hash}.png`)), '原件 png 应落盘')
  assert.ok(fs.existsSync(path.join(assetsDir, `${hash}.json`)), '原件元数据应落盘')
  const meta = JSON.parse(fs.readFileSync(path.join(assetsDir, `${hash}.json`), 'utf8'))
  assert.equal(meta.source, 'template', '原件 source 应为 template')
  const list = library.listLibrary({})
  assert.ok(!list.items.some((it) => it.assetId === r.background), '模板底图不应出现在素材库列表')
})

// 2. discard(source template, 无引用) → 删原件
check('discard(source template, 无引用) → 删原件', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'b.png')
  const hash = shaOf(r.background)
  assert.ok(existsAny(hash))
  const res = templates.discardBackground(r.background)
  assert.equal(res.removed, true)
  assert.ok(!existsAny(hash), '原件应被删除')
  assert.ok(!library.referencedAssetIds().has(r.background), '引用扫描不应含它')
})

// 3. discard(source library) → 保留原件（用独立内容 jpgB，避免污染 pngA 的 template 来源）
check('discard(source library) → 保留原件（不即时删）', () => {
  const asset = designs.importImageBytes({ name: 'lib.jpg', base64: jpgB.toString('base64') })
  library.upsert(asset, { source: 'library' })
  designs.setAssetSource(asset.id, 'library')
  const res = library.discardIfEphemeral(asset.id)
  assert.equal(res.removed, false, '受管理件不删')
  assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(asset.id)}.${asset.path.endsWith('.jpg') ? 'jpg' : 'png'}`)), 'library 原件应保留')
})

// 4. referencedAssetIds 接过来扫描模板背景 → 不误杀
check('referencedAssetIds 含在用模板背景 → 不列为孤儿', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'c.png')
  const tpl = templates.saveTemplate({ name: '引用底图', pageSize: { id: 'a4-portrait', w: 210, h: 297 }, fields: [], datasetId: ds.id, background: r.background })
  assert.ok(library.referencedAssetIds().has(r.background), '模板背景应被计入引用')
  const orphans = library.findOrphanOriginals()
  assert.ok(!orphans.some((o) => o.assetId === r.background), '在用模板底图不应是孤儿')
  templates.deleteTemplate(tpl.id) // 清理：template 来源且无引用 → 删原件
})

// 5. 去重升级：模板上传同图 → adopt 升 library → discard 不再即时删
check('去重升级：模板上传 → adopt 升 library → discard 不再即时删', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'd.png')
  assert.equal(designs.assetInfo(r.background).source, 'template', '上传时是 template')
  library.adopt(r.background, { displayName: 'd' })
  assert.equal(designs.assetInfo(r.background).source, 'library', 'adopt 后升为 library')
  const res = templates.discardBackground(r.background)
  assert.equal(res.removed, false, '升为 library 后 discard 不再即时删')
  assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(r.background)}.png`)), '原件保留')
})

// 6. 列表只来源于 library（source==='template' 过滤）——用独立生成的图像，避免共享 fixture 去重污染
check('listLibrary 只展示 library（过滤 source template）', () => {
  const pngT = makePng(8, 8, [10, 20, 200])
  const pngL = makePng(8, 8, [200, 20, 10])
  const assetT = designs.importImageBytes({ name: 'tt.png', base64: pngT.toString('base64'), source: 'template' })
  library.upsert(assetT, { source: 'template' })
  const assetL = designs.importImageBytes({ name: 'll.png', base64: pngL.toString('base64'), source: 'library' })
  library.upsert(assetL, { source: 'library' })
  const ids = library.listLibrary({}).items.map((i) => i.assetId)
  assert.ok(!ids.includes(assetT.id), 'template 来源不应出现在列表')
  assert.ok(ids.includes(assetL.id), 'library 来源应出现在列表')
})

// 7. discardBackground 路由到 discardIfEphemeral（不再直接 fs.unlink 路径）——用独立生成图，避免共享 fixture 去重污染
check('discardBackground 对 assetId 走素材库分流（不直接删路径副本）', () => {
  const pngE = makePng(8, 8, [0, 128, 64])
  const r = templates.uploadBackgroundBytes(pngE, 'e.png')
  const hash = shaOf(r.background)
  // 若错误地走 removeBgFile(assetId)，正则不匹配 → 不删、removed=false、文件仍在。
  // 正确路由到 discardIfEphemeral → template 无引用 → 删原件。
  const res = templates.discardBackground(r.background)
  assert.equal(res.removed, true)
  assert.ok(!existsAny(hash))
})

// 8. 存量 print-bg 背景 migrateBackgrounds 迁为 assetId
check('migrateBackgrounds：旧 print-bg 背景迁为 assetId', () => {
  const bgDir = path.join(tmp, 'print-bg')
  fs.mkdirSync(bgDir, { recursive: true })
  const oldFile = path.join(bgDir, 'old.png')
  fs.writeFileSync(oldFile, pngA)
  const tpl = templates.saveTemplate({ name: 'legacy', pageSize: { id: 'a4-portrait', w: 210, h: 297 }, fields: [], datasetId: ds.id, background: 'print-bg/old.png' })
  const r = templates.migrateBackgrounds()
  assert.ok(r.migrated >= 1, '应迁移至少 1 条')
  const migrated = templates.getTemplate(tpl.id)
  assert.match(migrated.background, /^asset_[a-f0-9]{64}$/, '背景应转成 assetId')
  assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(migrated.background)}.png`)), '迁移后原件在 design-assets')
})

console.log('== I-33 扩展：底图制作页直接加图 = 临时件（与模板页同逻辑） ==')

// 9. 通道语义：design:importBytes 强制 template（调用方传 library 也不行）；领域层缺省仍是 library（安全默认）
check('design:importBytes 通道强制 source=template；领域层缺省 library（漏传只能是「不删」）', () => {
  const api = require('../electron/api.cjs')
  const pngC1 = makePng(8, 8, [1, 2, 3])
  const viaChannel = api.call('design:importBytes', { name: 'paste.png', base64: pngC1.toString('base64'), source: 'library' }, { allowWrite: true })
  assert.equal(designs.assetInfo(viaChannel.id).source, 'template', '通道层强制 template，调用方传什么都不行')
  const pngC2 = makePng(8, 8, [3, 2, 1])
  const direct = designs.importImageBytes({ name: 'direct.png', base64: pngC2.toString('base64') })
  assert.equal(designs.assetInfo(direct.id).source, 'library', '领域层缺省 library：漏传的后果只能是「不删」，不能是「误删」')
})

// 10. 工程文档引用保护 + exceptDesignId（正在编辑未保存的工程，磁盘是旧版，内存态才是权威）
check('工程引用保护：磁盘引用不删；exceptDesignId 跳过当前工程后同步删；adopt 后保留', () => {
  // 粘贴图 A：登记进工程文档（图层 + assets），磁盘上「仍被引用」
  const pngP = makePng(8, 8, [88, 8, 188])
  const pasted = designs.importImageBytes({ name: 'paste-a.png', base64: pngP.toString('base64'), source: 'template' })
  const saved = designs.saveDesign({
    schemaVersion: 1, revision: 0, name: '粘贴工程',
    artboard: { w: 297, h: 210, background: '#ffffff' },
    assets: { [pasted.id]: pasted },
    layers: [{ id: 'img1', type: 'image', assetId: pasted.id, x: 5, y: 5, w: 20, h: 20 }],
  })
  assert.equal(library.discardIfEphemeral(pasted.id).removed, false, '磁盘工程仍引用 → 不删（不传 exceptDesignId 的保守口径）')
  // 视图删图层后：撤引用 + exceptDesignId 跳过当前工程 → 同步删
  const res = library.discardIfEphemeral(pasted.id, { exceptDesignId: saved.id })
  assert.equal(res.removed, true, '当前工程内存态已不引用（视图已撤）→ 同步删')
  assert.ok(!existsAny(shaOf(pasted.id)), '原件应被删除')

  // 粘贴图 B：先「加入素材库」（adopt 升 library）再删图层 → 保留
  const pngQ = makePng(8, 8, [8, 88, 188])
  const adopted = designs.importImageBytes({ name: 'paste-b.png', base64: pngQ.toString('base64'), source: 'template' })
  library.adopt(adopted.id, { displayName: 'paste-b' })
  const res2 = library.discardIfEphemeral(adopted.id, { exceptDesignId: saved.id })
  assert.equal(res2.removed, false, '已加入素材库 → 保留')
  assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(adopted.id)}.png`)), 'library 原件应保留')
})

console.log(`\n通过 ${passed} 项（I-33 模板底图并入素材库）`)
rmDeep(tmp)

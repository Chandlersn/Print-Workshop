/**
 * 模板底图并入素材库（I-33）领域验收。
 *
 * 钉的是「模板页上传的底图」并入素材库内容寻址池后的分流性质：
 *   1. 模板上传 → background 为 assetId，原件进临时池（ephemeral-assets/，I-51），列表不展示（source 过滤）；
 *   2. discard 按 source 分流：ephemeral 且无引用即时删；managed 不删；
 *   3. referencedAssetIds 接过来扫描模板背景 → 清理未引用不误杀；
 *   4. 去重升级：ephemeral → managed 后 discard 不再即时删；
 *   5. 列表只来源于 managed（normalizeSource !== 'ephemeral' 过滤）；
 *   6. 存量 print-bg 背景 migrateBackgrounds 迁为 assetId；
 *   7. 底图制作页直接加图（粘贴/拖入/对话框）= ephemeral 临时件：通道层强制 source，
 *      删图层后 exceptDesignId 跳过未保存的当前工程再同步清理；领域层缺省 managed；
 *   8. 旧值兼容：磁盘上存量 template/library 读时归一为 ephemeral/managed（无需迁移）。
 *
 * 缩略图不注入（纯 Node），领域层只在有 makeThumbnail 回调时才缩，没有就降级——与本文件无关。
 */
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
// 夹具数据目录放系统临时目录：保存锁是「rename 非空目录」，仓库内的 rename 会被
// 沙箱随机 EPERM（memory：test/ 下 200 次里 7 次失败），教训见 designs.e2e 的 DATA 选址。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'printpress-template-asset-'))
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
const ephemeralDir = path.join(tmp, 'ephemeral-assets')
const thumbDir = path.join(tmp, 'design-thumbnails')
const shaOf = (assetId) => assetId.slice('asset_'.length)
function assetFiles(hash) {
  // 两个池子都算（I-51）：受管理件在 design-assets/，临时底图在 ephemeral-assets/
  return ['design-assets', 'ephemeral-assets'].flatMap(dir => ['png', 'jpg', 'jpeg', 'json'].map((e) => path.join(tmp, dir, `${hash}.${e}`))).filter(fs.existsSync)
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

// 1. 模板上传 → assetId + 原件落盘 + source=ephemeral + 列表不展示
check('模板上传底图 → background 为 assetId，原件在 ephemeral-assets（临时池），列表不展示', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'a.png')
  assert.match(r.background, /^asset_[a-f0-9]{64}$/, '返回 assetId')
  const hash = shaOf(r.background)
  assert.ok(fs.existsSync(path.join(ephemeralDir, `${hash}.png`)), '原件 png 应落临时池')
  assert.ok(fs.existsSync(path.join(ephemeralDir, `${hash}.json`)), '原件元数据应落临时池')
  assert.ok(!fs.existsSync(path.join(assetsDir, `${hash}.png`)), '临时底图不进素材库池')
  const meta = JSON.parse(fs.readFileSync(path.join(ephemeralDir, `${hash}.json`), 'utf8'))
  assert.equal(meta.source, 'ephemeral', '原件 source 应为 ephemeral')
  const list = library.listLibrary({})
  assert.ok(!list.items.some((it) => it.assetId === r.background), '模板底图不应出现在素材库列表')
})

// 2. discard(source ephemeral, 无引用) → 删原件
check('discard(source ephemeral, 无引用) → 删原件', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'b.png')
  const hash = shaOf(r.background)
  assert.ok(existsAny(hash))
  const res = templates.discardBackground(r.background)
  assert.equal(res.removed, true)
  assert.ok(!existsAny(hash), '原件应被删除')
  assert.ok(!library.referencedAssetIds().has(r.background), '引用扫描不应含它')
})

// 3. discard(source managed) → 保留原件（用独立内容 jpgB，避免污染 pngA 的 ephemeral 来源）
check('discard(source managed) → 保留原件（不即时删）', () => {
  const asset = designs.importImageBytes({ name: 'lib.jpg', base64: jpgB.toString('base64') })
  library.upsert(asset, { source: 'managed' })
  designs.setAssetSource(asset.id, 'managed')
  const res = library.discardIfEphemeral(asset.id)
  assert.equal(res.removed, false, '受管理件不删')
  assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(asset.id)}.${asset.path.endsWith('.jpg') ? 'jpg' : 'png'}`)), '受管理原件应保留')
})

// 4. referencedAssetIds 接过来扫描模板背景 → 不误杀
check('referencedAssetIds 含在用模板背景 → 不列为孤儿', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'c.png')
  const tpl = templates.saveTemplate({ name: '引用底图', pageSize: { id: 'a4-portrait', w: 210, h: 297 }, fields: [], datasetId: ds.id, background: r.background })
  assert.ok(library.referencedAssetIds().has(r.background), '模板背景应被计入引用')
  const orphans = library.findOrphanOriginals()
  assert.ok(!orphans.some((o) => o.assetId === r.background), '在用模板底图不应是孤儿')
  templates.deleteTemplate(tpl.id) // 清理：ephemeral 来源且无引用 → 删原件
})

// 5. 去重升级：模板上传同图 → adopt 升 managed → discard 不再即时删
check('去重升级：模板上传 → adopt 升 managed（原件搬进素材库池）→ discard 不再即时删', () => {
  const r = templates.uploadBackgroundBytes(pngA, 'd.png')
  assert.equal(designs.assetInfo(r.background).source, 'ephemeral', '上传时是 ephemeral')
  const hash = shaOf(r.background)
  assert.ok(fs.existsSync(path.join(ephemeralDir, `${hash}.png`)), '上传后原件在临时池')
  library.adopt(r.background, { displayName: 'd' })
  assert.equal(designs.assetInfo(r.background).source, 'managed', 'adopt 后升为 managed')
  assert.ok(fs.existsSync(path.join(assetsDir, `${hash}.png`)), 'adopt 后原件搬进素材库池')
  assert.ok(!fs.existsSync(path.join(ephemeralDir, `${hash}.png`)), '临时池里不再留原件')
  const res = templates.discardBackground(r.background)
  assert.equal(res.removed, false, '升为 managed 后 discard 不再即时删')
  assert.ok(fs.existsSync(path.join(assetsDir, `${hash}.png`)), '原件保留')
})

// 6. 列表只来源于 managed（过滤 source ephemeral）——用独立生成的图像，避免共享 fixture 去重污染
check('listLibrary 只展示 managed（过滤 source ephemeral）', () => {
  const pngT = makePng(8, 8, [10, 20, 200])
  const pngL = makePng(8, 8, [200, 20, 10])
  const assetT = designs.importImageBytes({ name: 'tt.png', base64: pngT.toString('base64'), source: 'ephemeral' })
  library.upsert(assetT, { source: 'ephemeral' })
  const assetL = designs.importImageBytes({ name: 'll.png', base64: pngL.toString('base64'), source: 'managed' })
  library.upsert(assetL, { source: 'managed' })
  const ids = library.listLibrary({}).items.map((i) => i.assetId)
  assert.ok(!ids.includes(assetT.id), 'ephemeral 来源不应出现在列表')
  assert.ok(ids.includes(assetL.id), 'managed 来源应出现在列表')
})

// Old builds left temporary items in asset-library.json, sometimes without a
// source field. The original metadata must win so those rows neither show nor
// count as durable references that block immediate cleanup.
check('旧素材库索引中的临时件（缺 source 或误标 managed）会被隐藏并释放', () => {
  const writeStaleEntry = (assetId, source) => {
    const file = path.join(tmp, 'asset-library.json')
    const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
    const entry = { assetId, displayName: '旧版临时图', tags: ['旧临时标签'], favorite: false, archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
    if (source !== undefined) entry.source = source
    fs.writeFileSync(file, JSON.stringify(rows.filter(row => row.assetId !== assetId).concat(entry), null, 2))
  }
  const missingSource = designs.importImageBytes({ name: 'legacy-no-source.png', base64: makePng(8, 8, [31, 81, 131]).toString('base64'), source: 'ephemeral' })
  writeStaleEntry(missingSource.id)
  assert.ok(!library.referencedAssetIds().has(missingSource.id), '缺少 source 的旧索引不能阻止临时原件回收')
  assert.ok(!library.listLibrary({}).items.some(row => row.assetId === missingSource.id), '原件元数据标记 ephemeral 时不显示旧索引行')
  assert.ok(!library.listTags().some(tag => tag.tag === '旧临时标签'), '临时旧索引的标签也不会残留在筛选器')
  assert.throws(() => library.getEntry(missingSource.id), /素材库里没有/, '临时旧索引不会被界面当作已入库素材')
  assert.equal(library.discardIfEphemeral(missingSource.id).removed, true, '旧索引不再阻止粘贴图即时删除')
  assert.ok(!existsAny(shaOf(missingSource.id)), '缺少 source 的旧索引对应原件已删除')

  const wrongSource = designs.importImageBytes({ name: 'legacy-managed-label.png', base64: makePng(8, 8, [32, 82, 132]).toString('base64'), source: 'ephemeral' })
  writeStaleEntry(wrongSource.id, 'managed')
  assert.ok(!library.referencedAssetIds().has(wrongSource.id), '错误标为 managed 的旧索引也不能覆盖原件的 ephemeral 标记')
  assert.ok(!library.listLibrary({}).items.some(row => row.assetId === wrongSource.id), '原件 metadata 优先于冲突的旧索引 source')
  assert.equal(library.discardIfEphemeral(wrongSource.id).removed, true, '错误标记同样不妨碍即时删除')
  assert.ok(!existsAny(shaOf(wrongSource.id)), '错误标记对应的临时原件已删除')
})

check('索引与原件元数据短暂不同步时，不缓存缺失的 source 判断', () => {
  const bytes = makePng(8, 8, [73, 83, 93])
  const asset = designs.importImageBytes({ name: 'metadata-refresh.png', base64: bytes.toString('base64'), source: 'ephemeral' })
  const metadataPath = path.join(ephemeralDir, `${shaOf(asset.id)}.json`)
  const metadata = fs.readFileSync(metadataPath, 'utf8')
  const file = path.join(tmp, 'asset-library.json')
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  rows.push({ assetId: asset.id, displayName: '旧索引', tags: [], favorite: false })
  fs.writeFileSync(file, JSON.stringify(rows, null, 2))
  fs.unlinkSync(metadataPath)
  assert.ok(library.listLibrary({}).items.some(row => row.assetId === asset.id), '元数据缺失时按旧索引的安全默认暂留')
  fs.writeFileSync(metadataPath, metadata)
  assert.ok(!library.listLibrary({}).items.some(row => row.assetId === asset.id), '元数据恢复后立刻按 ephemeral 分流，不受旧缓存影响')
  assert.equal(library.discardIfEphemeral(asset.id).removed, true, '元数据恢复后临时原件可即时删除')
})

// 7. discardBackground 路由到 discardIfEphemeral（不再直接 fs.unlink 路径）——用独立生成图，避免共享 fixture 去重污染
check('discardBackground 对 assetId 走素材库分流（不直接删路径副本）', () => {
  const pngE = makePng(8, 8, [0, 128, 64])
  const r = templates.uploadBackgroundBytes(pngE, 'e.png')
  const hash = shaOf(r.background)
  // 若错误地走 removeBgFile(assetId)，正则不匹配 → 不删、removed=false、文件仍在。
  // 正确路由到 discardIfEphemeral → ephemeral 无引用 → 删原件。
  const res = templates.discardBackground(r.background)
  assert.equal(res.removed, true)
  assert.ok(!existsAny(hash))
})

// 8. 存量 print-bg 背景 migrateBackgrounds 迁为 assetId
check('migrateBackgrounds：旧 print-bg 背景迁为 assetId', () => {
  const bgDir = path.join(tmp, 'print-bg')
  fs.mkdirSync(bgDir, { recursive: true })
  const oldFile = path.join(bgDir, 'old.png')
  // 独立内容： pngA 在前面的用例里已被 adopt 搬进素材库池，共用会被去重成 managed 记录
  fs.writeFileSync(oldFile, makePng(9, 9, [201, 202, 203]))
  const tpl = templates.saveTemplate({ name: 'legacy', pageSize: { id: 'a4-portrait', w: 210, h: 297 }, fields: [], datasetId: ds.id, background: 'print-bg/old.png' })
  const r = templates.migrateBackgrounds()
  assert.ok(r.migrated >= 1, '应迁移至少 1 条')
  const migrated = templates.getTemplate(tpl.id)
  assert.match(migrated.background, /^asset_[a-f0-9]{64}$/, '背景应转成 assetId')
  assert.ok(fs.existsSync(path.join(ephemeralDir, `${shaOf(migrated.background)}.png`)), '迁移后原件在临时池（模板底图是临时件）')
})

console.log('== I-33 扩展：底图制作页直接加图 = 临时件（与模板页同逻辑） ==')

// 9. 通道语义：design:importBytes 强制 ephemeral（调用方传 managed 也不行）；领域层缺省仍是 managed（安全默认）
check('design:importBytes 通道强制 source=ephemeral；领域层缺省 managed（漏传只能是「不删」）', () => {
  const api = require('../electron/api.cjs')
  const pngC1 = makePng(8, 8, [1, 2, 3])
  const viaChannel = api.call('design:importBytes', { name: 'paste.png', base64: pngC1.toString('base64'), source: 'managed' }, { allowWrite: true })
  assert.equal(designs.assetInfo(viaChannel.id).source, 'ephemeral', '通道层强制 ephemeral，调用方传什么都不行')
  const pngC2 = makePng(8, 8, [3, 2, 1])
  const direct = designs.importImageBytes({ name: 'direct.png', base64: pngC2.toString('base64') })
  assert.equal(designs.assetInfo(direct.id).source, 'managed', '领域层缺省 managed：漏传的后果只能是「不删」，不能是「误删」')
  const pasted = designs.importImageBytes({ name: 'pasted-before-library.png', base64: makePng(8, 8, [6, 5, 4]).toString('base64'), source: 'ephemeral' })
  api.call('asset:importBytes', { name: 'saved-to-library.png', base64: makePng(8, 8, [6, 5, 4]).toString('base64') }, { allowWrite: true })
  assert.equal(designs.assetInfo(pasted.id).source, 'managed', '用户明确从素材库导入同一张临时图时会升级为 managed')
  assert.equal(designs.assetInfo(pasted.id).path, `design-assets/${shaOf(pasted.id)}.png`, '升级后原件搬进素材库池')
  assert.ok(library.listLibrary({}).items.some(item => item.assetId === pasted.id), '用户明确保存到素材库的图仍会显示')
})

// 10. 工程文档引用保护 + exceptDesignId（正在编辑未保存的工程，磁盘是旧版，内存态才是权威）
check('工程引用保护：磁盘引用不删；exceptDesignId 跳过当前工程后同步删；adopt 后保留', () => {
  // 粘贴图 A：登记进工程文档（图层 + assets），磁盘上「仍被引用」
  const pngP = makePng(8, 8, [88, 8, 188])
  const pasted = designs.importImageBytes({ name: 'paste-a.png', base64: pngP.toString('base64'), source: 'ephemeral' })
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

  // 粘贴图 B：先「加入素材库」（adopt 升 managed）再删图层 → 保留
  const pngQ = makePng(8, 8, [8, 88, 188])
  const adopted = designs.importImageBytes({ name: 'paste-b.png', base64: pngQ.toString('base64'), source: 'ephemeral' })
  library.adopt(adopted.id, { displayName: 'paste-b' })
  const res2 = library.discardIfEphemeral(adopted.id, { exceptDesignId: saved.id })
  assert.equal(res2.removed, false, '已加入素材库 → 保留')
  assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(adopted.id)}.png`)), '受管理原件应保留')
  // 删除临时图后当前保存版本会暂时含有悬空引用；清理工程索引，避免后续
  // 对其他资源做 fail-closed 引用扫描时把这个刻意构造的损坏夹具带入测试。
  designs.deleteDesign(saved.id)
})

// 11. 旧值兼容：磁盘上仍是 template/library 的原件，读时归一为 ephemeral/managed（无需迁移存量）
check('旧值兼容：磁盘上 template/library 被归一为 ephemeral/managed', () => {
  // 手工把磁盘元数据改回 0.5.0 之前的旧值，模拟存量数据
  const pngR = makePng(8, 8, [9, 9, 9])
  const assetR = designs.importImageBytes({ name: 'legacy-t.png', base64: pngR.toString('base64'), source: 'ephemeral' })
  const metaRPath = path.join(ephemeralDir, `${shaOf(assetR.id)}.json`)
  fs.writeFileSync(metaRPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaRPath, 'utf8')), source: 'template' }))
  assert.equal(designs.assetInfo(assetR.id).source, 'ephemeral', '旧值 template 读作 ephemeral')
  assert.equal(library.discardIfEphemeral(assetR.id).removed, true, '旧值仍按临时件即时删')

  const pngS = makePng(8, 8, [7, 7, 7])
  const assetS = designs.importImageBytes({ name: 'legacy-l.png', base64: pngS.toString('base64'), source: 'managed' })
  const metaSPath = path.join(assetsDir, `${shaOf(assetS.id)}.json`)
  fs.writeFileSync(metaSPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaSPath, 'utf8')), source: 'library' }))
  assert.equal(designs.assetInfo(assetS.id).source, 'managed', '旧值 library 读作 managed')
  assert.equal(library.discardIfEphemeral(assetS.id).removed, false, '旧值仍按受管理件保留')
})

console.log(`\n通过 ${passed} 项（I-33 模板底图并入素材库）`)
{
  const image = makePng(9, 7, [47, 119, 203])
  const uploaded = templates.uploadBackgroundBytes(image, 'template-current.png')
  const libraryIndexPath = path.join(tmp, 'asset-library.json')
  const currentRows = fs.existsSync(libraryIndexPath) ? JSON.parse(fs.readFileSync(libraryIndexPath, 'utf8')) : []
  currentRows.push({ assetId: uploaded.background, displayName: '旧版临时模板底图', tags: [], favorite: false })
  fs.writeFileSync(libraryIndexPath, JSON.stringify(currentRows, null, 2))
  const template = templates.saveTemplate({
    name: 'current-template-cleanup', pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    fields: [], datasetId: ds.id, background: uploaded.background,
  })
  const hash = shaOf(uploaded.background)
  assert.ok(!library.listLibrary({}).items.some(row => row.assetId === uploaded.background), '模板粘贴底图不会因旧索引行显示在素材库')
  assert.equal(templates.discardBackground(uploaded.background).removed, false)
  assert.ok(existsAny(hash), 'a saved template reference must retain its background')
  assert.ok(!JSON.parse(fs.readFileSync(libraryIndexPath, 'utf8')).some(row => row.assetId === uploaded.background), '已引用的临时模板底图会从素材库索引中移除')
  assert.equal(templates.discardBackground(uploaded.background, { exceptTemplateId: template.id }).removed, true)
  assert.ok(!existsAny(hash), 'removing the background from the active template must reclaim the original')
  console.log('  ok - deleting the active template background ignores its stale saved reference')
}
rmDeep(tmp)

/**
 * 素材库领域验收（v0.5.0 M1）。
 *
 * 钉的是三条「用户看不见但一定会踩」的性质：
 *   1. **同一字节内容只存一份原件**——换文件名再导一次不能多出一份字节；
 *   2. **库里的展示信息不改写旧工程**——改名/改标签是「素材库里的叫法」，
 *      不是工程里的名字，历史工程必须照常打开、照常打印；
 *   3. **归档不删原件**——归档只是从常用列表隐藏，引用它的工程不能因此打不开。
 *
 * 缩略图用假的 `makeThumbnail` 注入：本文件验的是「领域层把缓存写到哪、失败怎么降级」，
 * 真正把图缩小是宿主（Electron nativeImage）的事，不在这里。
 */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-asset-library-'))
process.env.PRINTPRESS_DATA_DIR = tmp
const designs = require('../electron/designs.cjs')
const library = require('../electron/asset-library.cjs')

let passed = 0
function check(name, run) { run(); passed++; console.log(`  ok - ${name}`) }

const pngA = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png'))
const jpgB = fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg'))

// 第三张图：独立内容，避免「报错也能用」那条用例和 assetA 撞内容被合并掉。
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
const zlib = require('zlib')
const pngC = makePng(6, 6, [0, 170, 0])

/** 假的缩略图器：只记录被调用情况，返回固定字节（领域层不关心图有没有真被缩小）。 */
let thumbCalls = []
function makeThumbnail({ buffer, maxSide }) {
  thumbCalls.push({ size: buffer.length, maxSide })
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
}
const OPTS = { makeThumbnail }

const assetsDir = path.join(tmp, 'design-assets')
const originals = (ext) => fs.readdirSync(assetsDir).filter((f) => f.endsWith(ext))
const shaOf = (assetId) => assetId.slice('asset_'.length)

function designWith(asset, name) {
  return {
    schemaVersion: 1, revision: 0, name,
    artboard: { w: 210, h: 297, background: '#ffffff' },
    assets: { [asset.id]: asset },
    layers: [{ id: 'pic', type: 'image', name: '图', assetId: asset.id, x: 20, y: 20, w: 60, h: 40 }],
  }
}

let assetA, assetB

try {
  check('入库：展示元数据独立成库，原件仍按内容寻址', () => {
    assetA = designs.importImageBytes({ name: '校徽.png', base64: pngA.toString('base64') })
    const again = designs.importImageBytes({ name: '换个名字再导一次.png', base64: pngA.toString('base64') })
    assert.equal(again.id, assetA.id, '同一字节内容必须是同一个素材标识')

    const entry = library.upsert(assetA, { displayName: '学校校徽', tags: ['学校', '标识'] })
    assert.equal(entry.assetId, assetA.id)
    assert.equal(entry.displayName, '学校校徽')
    assert.deepEqual(entry.tags, ['学校', '标识'])
    assert.equal(entry.archivedAt, null)
    assert.equal(entry.thumbFile, null, '没给缩略图回调时不应生成（纯 Node 下也不该报错）')
    assert.equal(originals('.png').length, 1, '同一内容只能有一份原件')
  })

  check('两个工程引用同一素材，原件不重复，SHA-256 不变', () => {
    const first = designs.saveDesign(designWith(assetA, '工程甲'))
    const second = designs.saveDesign(designWith(assetA, '工程乙'))
    assert.notEqual(first.id, second.id)
    assert.equal(originals('.png').length, 1, '被多少工程引用都不能多存一份字节')
    // 原始字节与哈希都没被素材库动过：这是「原件生死由用户决定」的底线
    const sha = shaOf(assetA.id)
    assert.deepEqual(fs.readFileSync(path.join(assetsDir, `${sha}.png`)), pngA)
    assert.equal(designs.getDesign(first.id).assets[assetA.id].id, assetA.id)
    assert.equal(designs.getDesign(second.id).assets[assetA.id].id, assetA.id)
  })

  check('改库名 / 改标签不改写旧工程（旧工程照常打开、名字不动）', () => {
    const saved = designs.saveDesign(designWith(assetA, '会被改名的工程'))
    const before = designs.getDesign(saved.id, saved.revision)
    const nameBefore = before.assets[assetA.id].name

    library.updateMetadata(assetA.id, { displayName: '库里改成新名字', tags: ['新版'] })
    assert.equal(library.getEntry(assetA.id).displayName, '库里改成新名字')

    const after = designs.getDesign(saved.id, saved.revision)
    assert.equal(after.assets[assetA.id].name, nameBefore, '工程里的素材名不该被素材库改写')
    assert.equal(after.revision, before.revision, '改库信息绝不产生新版本')
    assert.deepEqual(after.layers, before.layers)
  })

  check('归档只是隐藏：原件还在，引用它的历史工程照常打开', () => {
    const saved = designs.saveDesign(designWith(assetA, '归档后仍要能打开'))
    library.archive(assetA.id)
    assert.equal(library.listLibrary({}).total, 0, '归档后不该出现在常用列表')
    assert.equal(library.listLibrary({ includeArchived: true }).total, 1, '但记录还在，可恢复')
    assert.ok(fs.existsSync(path.join(assetsDir, `${shaOf(assetA.id)}.png`)), '归档绝不删原件')
    const still = designs.getDesign(saved.id, saved.revision)
    assert.equal(still.assets[assetA.id].id, assetA.id, '引用它的工程必须还能打开')

    library.restore(assetA.id)
    assert.equal(library.listLibrary({}).total, 1, '恢复后回到常用列表')
  })

  check('同一内容重新导入 = 合并条目并恢复归档，不是新建第二条', () => {
    library.archive(assetA.id)
    const merged = library.upsert(assetA, { displayName: '校徽（找回）' })
    assert.equal(merged.archivedAt, null, '重新导入等于「我要找回来」')
    assert.equal(library.listLibrary({ includeArchived: true }).total, 1, '绝不能多出第二条')
    assert.equal(originals('.png').length, 1, '也不许多一份字节')
  })

  check('缩略图：生成到设计目录内、可重建、生成失败不影响入库', () => {
    assetB = designs.importImageBytes({ name: '人像.jpg', base64: jpgB.toString('base64') })
    thumbCalls = []
    const entry = library.upsert(assetB, { displayName: '人像素材' }, OPTS)
    const expected = `design-thumbnails/${shaOf(assetB.id)}.png`
    assert.equal(entry.thumbFile, expected, '缩略图文件名只由内容哈希推导')
    assert.ok(fs.existsSync(path.join(tmp, 'design-thumbnails', `${shaOf(assetB.id)}.png`)))
    assert.equal(thumbCalls[0].maxSide, library.THUMB_MAX_SIDE)
    assert.equal(thumbCalls[0].size, jpgB.length, '缩略的是原件字节')

    // 缓存被清掉后可重建
    fs.unlinkSync(path.join(tmp, 'design-thumbnails', `${shaOf(assetB.id)}.png`))
    const rebuilt = library.rebuildThumbnail(assetB.id, OPTS)
    assert.equal(rebuilt.thumbFile, expected)
    assert.ok(fs.existsSync(path.join(tmp, 'design-thumbnails', `${shaOf(assetB.id)}.png`)))

    // 缩略图器炸了：条目照常入库，只是没有缩略图（缓存的成败不能影响素材本身）
    const boom = designs.importImageBytes({ name: '炸.png', base64: pngC.toString('base64') })
    const broken = library.upsert(boom, { displayName: '缩略失败也要能用' }, { makeThumbnail: () => { throw new Error('解码失败') } })
    assert.equal(broken.thumbFile, null)
    assert.equal(library.getEntry(boom.id).displayName, '缩略失败也要能用')
  })

  check('搜索、标签（AND）、收藏优先与分页', () => {
    const list = library.listLibrary({})
    assert.equal(list.total, 3, 'assetA、assetB、炸.png 三条在用（assetA 的重复导入已合并）')
    assert.equal(library.listLibrary({ query: '人像' }).items.length, 1, '按展示名搜索命中')
    assert.equal(library.listLibrary({ query: '缩略失败' }).items.length, 1)
    assert.equal(library.listLibrary({ query: '不存在' }).total, 0)

    library.updateMetadata(assetA.id, { tags: ['学校', '标识'], favorite: true })
    assert.equal(library.listLibrary({ tags: ['标识'] }).total, 1)
    assert.equal(library.listLibrary({ tags: ['学校', '标识'] }).total, 1, '多标签是收窄（AND）')
    assert.equal(library.listLibrary({ tags: ['学校', '没有的标签'] }).total, 0)
    assert.equal(library.listLibrary({ favoriteOnly: true }).items[0].assetId, assetA.id, '收藏的排最前')

    const page = library.listLibrary({ pageSize: 1, page: 2 })
    assert.equal(page.items.length, 1)
    assert.equal(page.total, 3, '分页只影响本页条数，不影响总数')
    assert.equal(library.listLibrary({ pageSize: 9999 }).pageSize, library.LIMITS.pageSize, '单页数量有硬上限')
  })

  check('已有工程的图片可「加入素材库」；原件缺失时明确报错', () => {
    const adopted = library.adopt(assetB.id, { displayName: '从工程收录的人像' })
    assert.equal(adopted.assetId, assetB.id)
    assert.equal(adopted.displayName, '从工程收录的人像')
    // 只是一个不存在的素材标识：不能建出「点开就丢图」的条目
    const ghost = `asset_${'0'.repeat(64)}`
    assert.throws(() => library.adopt(ghost, {}), /找不到底图素材|素材标识无效/)
  })

  check('非法输入：素材标识被拒、超长名字与超多标签被裁剪', () => {
    assert.throws(() => library.getEntry('design_123'), /素材标识无效/)
    assert.throws(() => library.upsert({ id: 'nope' }, {}), /素材标识无效/)

    const long = library.updateMetadata(assetA.id, { displayName: '名'.repeat(500), tags: Array.from({ length: 80 }, (_, i) => `标签${i}`) })
    assert.ok(long.displayName.length <= library.LIMITS.displayName)
    assert.ok(long.tags.length <= library.LIMITS.tags, '标签数量要封顶，不能无限膨胀')

    // 缩略图路径绝不含用户输入：文件名只能是 <64位十六进制>.png
    for (const entry of library.listLibrary({ includeArchived: true }).items) {
      if (!entry.thumbFile) continue
      assert.match(entry.thumbFile, /^design-thumbnails\/[a-f0-9]{64}\.png$/)
    }
  })

  check('asset:get 路径返回原件尺寸（UI 入画板按 width/height 等比适配）', () => {
    const entry = library.getEntry(assetA.id)
    const info = designs.assetInfo(assetA.id) // asset:get 的 asset 字段就来自这里
    assert.equal(entry.assetId, assetA.id)
    assert.ok(info.id === assetA.id, '原件描述带素材标识')
    assert.ok(info.width > 0 && info.height > 0, '原件描述带像素尺寸（add 要按它等比缩放）')
    assert.ok(typeof info.name === 'string' && info.name.length, '原件描述带名称（作图层默认名）')
  })

  // I-32 清理未引用原件：删除前必须复核仍孤儿，绝不静默删被引用的图
  check('清理未引用原件：只删真孤儿，工程/库里的都保留，且删除前复核仍孤儿（I-32）', () => {
    // A：被工程引用 → 不是孤儿
    const assetA2 = designs.importImageBytes({ name: '工程引用的图.png', base64: pngA.toString('base64') })
    designs.saveDesign(designWith(assetA2, '引用A的工程'))
    // B：收进素材库（含归档）→ 不是孤儿
    const assetB2 = designs.importImageBytes({ name: '库里的图.png', base64: jpgB.toString('base64') })
    library.upsert(assetB2, { displayName: '库里的图' })
    library.archive(assetB2.id)
    // C、D：谁都不引用 → 孤儿（用独立内容，且不与上面「缩略图失败」用例的 pngC 撞 hash，否则会被误判为引用）
    const pngForC = makePng(6, 6, [123, 200, 77])
    const assetC = designs.importImageBytes({ name: '孤儿C.png', base64: pngForC.toString('base64') })
    const pngD = makePng(7, 7, [200, 30, 30])
    const assetD = designs.importImageBytes({ name: '孤儿D.png', base64: pngD.toString('base64') })
    const hashA = shaOf(assetA2.id), hashB = shaOf(assetB2.id), hashC = shaOf(assetC.id), hashD = shaOf(assetD.id)

    const orphanHashes = library.findOrphanOriginals().map((o) => o.hash)
    assert.ok(orphanHashes.includes(hashC) && orphanHashes.includes(hashD), 'C、D 都是孤儿')
    assert.ok(!orphanHashes.includes(hashA) && !orphanHashes.includes(hashB), 'A(工程引用)、B(在库/归档) 都不算孤儿')

    // 竞态复核：把 D 也收进库 → 再 purge D 应跳过，不删（绝不静默删被引用的图）
    library.upsert(assetD, { displayName: 'D 后来收库' })
    let res = library.purgeOrphanOriginals([hashD])
    assert.equal(res.removed, 0, 'D 已被收库，复核后跳过')
    assert.equal(res.kept, 1)
    assert.ok(fs.existsSync(path.join(assetsDir, `${hashD}.png`)), 'D 文件仍在（复核保护生效）')

    // 真删 C（真孤儿）
    res = library.purgeOrphanOriginals([hashC])
    assert.equal(res.removed, 1); assert.equal(res.kept, 0)
    assert.ok(!fs.existsSync(path.join(assetsDir, `${hashC}.png`)), 'C 原件已删')
    assert.ok(!fs.existsSync(path.join(assetsDir, `${hashC}.json`)), 'C 元数据已删')
    assert.ok(fs.existsSync(path.join(assetsDir, `${hashA}.png`)), 'A 仍被工程引用，原件保留')
    const extB = path.extname(assetB2.path)
    assert.ok(fs.existsSync(path.join(assetsDir, `${hashB}${extB}`)), 'B 在素材库，原件保留')
  })
} finally {
  rmDeep(tmp)
}

console.log(`素材库领域验收：${passed} 通过，0 失败`)

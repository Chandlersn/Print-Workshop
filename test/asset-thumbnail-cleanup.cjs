const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'printpress-thumbnail-cleanup-'))
process.env.PRINTPRESS_DATA_DIR = root
delete process.env.PRINTPRESS_ASSET_DIR
const lock = require('../electron/data-lock.cjs'), cleanup = require('../electron/asset-thumbnail-cleanup.cjs')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const library = entries => fs.writeFileSync(path.join(root, 'asset-library.json'), JSON.stringify(entries))
function fixture(label, options = {}) {
  const bytes = Buffer.from(`original ${label}`), id = hash(bytes)
  const images = path.join(root, 'design-assets'), thumbs = path.join(root, 'design-thumbnails')
  fs.mkdirSync(images, { recursive: true }); fs.mkdirSync(thumbs, { recursive: true })
  if (!options.missing) fs.writeFileSync(path.join(images, `${id}.png`), options.corrupt ? 'changed' : bytes)
  const thumbnail = path.join(thumbs, `${id}.png`)
  fs.writeFileSync(thumbnail, Buffer.from(`thumbnail ${label}`))
  if (!options.recent) { const old = new Date(Date.now() - cleanup.AGE_MS - 100000); fs.utimesSync(thumbnail, old, old) }
  return { id, thumbnail, bytes, original: path.join(images, `${id}.png`) }
}
;(async () => {
  try {
    library([])
    const removable = fixture('removable'), missing = fixture('missing', { missing: true }), corrupt = fixture('corrupt', { corrupt: true }), recent = fixture('recent', { recent: true }), saved = fixture('saved')
    library([{ assetId: `asset_${saved.id}`, archivedAt: '2020-01-01' }])
    assert.equal((await cleanup.run()).phase, 'skipped', '无数据目录锁时不执行')
    assert.ok(fs.existsSync(removable.thumbnail))
    lock.acquireForHost()
    const result = await cleanup.run()
    assert.equal(result.phase, 'completed')
    assert.equal(result.removed, 1)
    assert.equal(result.bytes, Buffer.byteLength('thumbnail removable'))
    assert.equal(fs.existsSync(removable.thumbnail), false)
    assert.deepEqual(fs.readFileSync(removable.original), removable.bytes, '保留原件')
    for (const item of [missing, corrupt, recent, saved]) assert.ok(fs.existsSync(item.thumbnail), '缺失或损坏的原件、新缓存和已入库素材均保留')
    const race = fixture('race')
    const raceResult = await cleanup.run({ beforeCommit: id => { if (id === race.id) library([{ assetId: `asset_${saved.id}` }, { assetId: `asset_${race.id}` }]) } })
    assert.equal(raceResult.removed, 0)
    assert.ok(fs.existsSync(race.thumbnail), '删除前重新检查新增的素材库引用')
    const bad = fixture('bad-index')
    fs.writeFileSync(path.join(root, 'asset-library.json'), '{broken')
    assert.equal((await cleanup.run()).phase, 'skipped')
    assert.ok(fs.existsSync(bad.thumbnail), '索引损坏时不清理')
    assert.equal(fs.readFileSync(path.join(root, 'asset-library.json'), 'utf8'), '{broken', '不自动恢复损坏索引')
    console.log('ok - 启动时安全清理可重建的旧缩略图缓存')
  } finally { lock.release(); fs.rmSync(root, { recursive: true, force: true }) }
})().catch(err => { console.error(err); process.exitCode = 1 })

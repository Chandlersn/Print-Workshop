/** Managed originals can live outside the data directory; temporary backgrounds cannot. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

const root = fs.mkdtempSync(path.join(__dirname, '.tmp-asset-storage-'))
process.env.PRINTPRESS_DATA_DIR = path.join(root, 'data')
process.env.PRINTPRESS_ASSET_DIR = path.join(root, 'repository')
const storage = require('../electron/asset-storage.cjs')
const designs = require('../electron/designs.cjs')
const library = require('../electron/asset-library.cjs')
const png = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png'))
const jpg = fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg'))
const hash = id => id.slice('asset_'.length)

try {
  const managed = designs.importImageBytes({ name: 'managed.png', base64: png.toString('base64'), source: 'managed' })
  const managedImage = path.join(process.env.PRINTPRESS_ASSET_DIR, `${hash(managed.id)}.png`)
  assert.ok(fs.existsSync(managedImage))
  assert.ok(!fs.existsSync(path.join(process.env.PRINTPRESS_DATA_DIR, managed.path)))
  assert.equal(library.originalsDir(), process.env.PRINTPRESS_ASSET_DIR)
  assert.equal(designs.assetBytes(managed.id).buffer.compare(png), 0)
  const exporter = require('../electron/design-export.cjs')
  assert.throws(() => exporter.outputPath(path.join(process.env.PRINTPRESS_ASSET_DIR, 'output.png')), /素材目录/)
  const draft = {
    name: 'repository export', artboard: { w: 100, h: 100, background: '#ffffff' },
    assets: { [managed.id]: managed },
    layers: [{ id: 'pic', type: 'image', name: 'pic', assetId: managed.id, x: 0, y: 0, w: 50, h: 50 }],
  }
  assert.ok(exporter.prepareExport({ design: draft, dpi: 150 }).html.includes(png.toString('base64')))

  const temporary = designs.importImageBytes({ name: 'temporary.jpg', base64: jpg.toString('base64'), source: 'ephemeral' })
  const temporaryImage = path.join(process.env.PRINTPRESS_DATA_DIR, temporary.path)
  assert.ok(fs.existsSync(temporaryImage))
  assert.ok(!fs.existsSync(path.join(process.env.PRINTPRESS_ASSET_DIR, `${hash(temporary.id)}.jpg`)))
  const adopted = library.adopt(temporary.id, {})
  assert.equal(adopted.assetId, temporary.id)
  assert.ok(fs.existsSync(path.join(process.env.PRINTPRESS_ASSET_DIR, `${hash(temporary.id)}.jpg`)))
  assert.ok(!fs.existsSync(temporaryImage))
  assert.equal(designs.assetBytes(temporary.id).buffer.compare(jpg), 0)

  // Simulate a managed original from an older installation before the override.
  const oldDir = storage.legacyManagedDir()
  fs.mkdirSync(oldDir, { recursive: true })
  fs.copyFileSync(managedImage, path.join(oldDir, `${hash(managed.id)}.png`))
  fs.copyFileSync(storage.resolveAssetPath(`${managed.path.slice(0, -4)}.json`), path.join(oldDir, `${hash(managed.id)}.json`))
  fs.unlinkSync(managedImage)
  fs.unlinkSync(storage.resolveAssetPath(`${managed.path.slice(0, -4)}.json`))
  assert.equal(designs.migrateManagedOriginals().migrated, 1)
  assert.equal(designs.migrateManagedOriginals().migrated, 0)
  assert.ok(fs.existsSync(managedImage))
  assert.ok(!fs.existsSync(path.join(oldDir, `${hash(managed.id)}.png`)))
  assert.equal(designs.assetBytes(managed.id).buffer.compare(png), 0)
  assert.throws(() => storage.resolveAssetPath('design-assets/../../secret.png'), /素材存储路径无效/)

  console.log('独立素材目录：导入、临时件、升级、旧数据迁移和读取通过')
} finally {
  rmDeep(root)
}

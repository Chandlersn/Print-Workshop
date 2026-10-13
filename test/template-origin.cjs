/** Regression checks for built-in and user template classification. */
const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..')
process.env.PRINTPRESS_DATA_DIR = path.join(__dirname, '.tmp-template-origin')
const { rmDeep } = require('./helpers/rm.cjs')
rmDeep(process.env.PRINTPRESS_DATA_DIR)
fs.mkdirSync(process.env.PRINTPRESS_DATA_DIR, { recursive: true })

const templates = require('../electron/templates.cjs')
const dataset = require('../electron/dataset.cjs')
const seed = require('../electron/seed-demo.cjs')
const assert = require('node:assert/strict')

const csv = path.join(process.env.PRINTPRESS_DATA_DIR, 'template-origin.csv')
fs.writeFileSync(csv, '姓名\n张三\n', 'utf8')
const ds = dataset.importFromFile(csv, '测试名单')

const userTemplate = templates.saveTemplate({ name: '用户保存模板', datasetId: ds.id, fields: [] })
assert.equal(userTemplate.origin, 'user', 'newly saved templates are classified as user templates')
assert.equal(templates.listTemplates().find((item) => item.id === userTemplate.id).origin, 'user')
templates.saveTemplate({ ...templates.getTemplate(userTemplate.id), name: '用户模板修改' })
assert.equal(templates.getTemplate(userTemplate.id).origin, 'user', 'editing a user template preserves its category')

// Simulate a template record written by an older release before origin was stored.
const templateFile = path.join(process.env.PRINTPRESS_DATA_DIR, 'templates.json')
const legacyTemplate = templates.saveTemplate({ name: '旧版模板', datasetId: ds.id, fields: [] })
const withLegacy = JSON.parse(fs.readFileSync(templateFile, 'utf8'))
delete withLegacy.find((item) => item.id === legacyTemplate.id).origin
fs.writeFileSync(templateFile, JSON.stringify(withLegacy), 'utf8')
assert.equal(templates.markLegacyBuiltinTemplates([legacyTemplate.id]), 1)
assert.equal(templates.getTemplate(legacyTemplate.id).origin, 'builtin')
assert.equal(templates.markLegacyBuiltinTemplates([legacyTemplate.id]), 0, 'origin migration is idempotent')
assert.throws(() => templates.saveTemplate({ ...templates.getTemplate(legacyTemplate.id), name: '旧版模板修改' }),
  /内置模板不能覆盖/, 'a migrated built-in also becomes read-only')
assert.equal(templates.getTemplate(legacyTemplate.id).origin, 'builtin', 'a migrated built-in keeps its category')
fs.writeFileSync(templateFile, JSON.stringify(
  JSON.parse(fs.readFileSync(templateFile, 'utf8')).filter((item) => item.id !== legacyTemplate.id),
), 'utf8')

// A real seed run tags the seven packaged templates; legacy records are tagged at seedVersion 2 too.
const seedDir = path.join(ROOT, 'build', 'seed')
const seeded = seed.seedIfFirstRun(seedDir)
assert.equal(seeded.seeded, true)
const packagedBuiltins = templates.listTemplates().filter((item) => item.origin === 'builtin' && item.name.startsWith('常用·'))
assert.equal(packagedBuiltins.length, 7, 'all seven packaged templates are marked built-in')
assert.equal(templates.listTemplates().find((item) => item.id === userTemplate.id).origin, 'user')

const builtin = templates.getTemplate(packagedBuiltins[0].id)
const builtinSnapshot = JSON.stringify(builtin)
assert.throws(() => templates.saveTemplate({ ...builtin, name: '被覆盖的内置模板' }), /内置模板不能覆盖/,
  'the backend rejects edits that would overwrite a built-in')
assert.throws(() => templates.deleteTemplate(builtin.id), /内置模板不可删除/,
  'the backend rejects deletion of a built-in')
assert.throws(() => templates.rebindDataset(builtin.id, ds.id), /内置模板不可修改/,
  'the backend rejects rebinding a built-in')
assert.equal(JSON.stringify(templates.getTemplate(builtin.id)), builtinSnapshot,
  'rejected operations leave the built-in unchanged')
const userCopy = templates.saveTemplate({ ...builtin, id: undefined, origin: 'builtin', name: '我的奖状副本' })
assert.equal(userCopy.origin, 'user', 'ordinary saves cannot create a built-in even if the caller sends origin=builtin')
assert.equal(templates.getTemplate(builtin.id).name, builtin.name, 'saving a customization as a copy keeps the built-in original')
templates.deleteTemplate(userCopy.id)
assert.equal(templates.getTemplate(builtin.id).name, builtin.name, 'deleting the user copy keeps the built-in original')
const protectedLegacyBg = 'print-bg/builtin-protected.png'
const protectedLegacyBgFile = path.join(process.env.PRINTPRESS_DATA_DIR, protectedLegacyBg)
fs.mkdirSync(path.dirname(protectedLegacyBgFile), { recursive: true })
fs.writeFileSync(protectedLegacyBgFile, 'built-in background')
const withLegacyBackground = JSON.parse(fs.readFileSync(templateFile, 'utf8'))
withLegacyBackground.find((item) => item.id === builtin.id).background = protectedLegacyBg
fs.writeFileSync(templateFile, JSON.stringify(withLegacyBackground), 'utf8')
assert.deepEqual(templates.discardBackground(protectedLegacyBg), { removed: false },
  'editing a built-in cannot discard a legacy image while the original still references it')
assert.equal(fs.existsSync(protectedLegacyBgFile), true, 'the built-in legacy background remains on disk')
const restoredBuiltins = JSON.parse(fs.readFileSync(templateFile, 'utf8'))
restoredBuiltins.find((item) => item.id === builtin.id).background = builtin.background
fs.writeFileSync(templateFile, JSON.stringify(restoredBuiltins), 'utf8')
fs.unlinkSync(protectedLegacyBgFile)

const view = fs.readFileSync(path.join(ROOT, 'src', 'views', 'TemplateView.vue'), 'utf8')
assert.match(view, />内置<\/button>/, 'the template list shows the short built-in label')
assert.match(view, />常用<\/button>/, 'the template list shows the short user-template label')
assert.match(view, /v-for="t in visibleTemplates"/, 'the list renders only the selected category')

// Simulate installations where the sample dataset was renamed and an older build persisted
// the built-in category as "user". The seven fixed names must still be restored on startup.
const datasetFile = path.join(process.env.PRINTPRESS_DATA_DIR, 'datasets.json')
const datasetStore = JSON.parse(fs.readFileSync(datasetFile, 'utf8'))
const builtInDataset = datasetStore.find((item) => item.id === packagedBuiltins[0].datasetId)
assert.ok(builtInDataset, 'seeded dataset is present')
builtInDataset.name = '用户改名后的示例名单'
fs.writeFileSync(datasetFile, JSON.stringify(datasetStore), 'utf8')

const legacyBuiltin = packagedBuiltins[0]
const misclassifiedBuiltin = packagedBuiltins[1]
const seededStore = JSON.parse(fs.readFileSync(templateFile, 'utf8'))
delete seededStore.find((item) => item.id === legacyBuiltin.id).origin
seededStore.find((item) => item.id === misclassifiedBuiltin.id).origin = 'user'
fs.writeFileSync(templateFile, JSON.stringify(seededStore), 'utf8')
assert.equal(templates.listTemplates().find((item) => item.id === legacyBuiltin.id).origin, 'user')
assert.equal(seed.seedIfFirstRun(seedDir).reason, 'already')
assert.equal(templates.listTemplates().find((item) => item.id === legacyBuiltin.id).origin, 'builtin',
  'existing seed templates are recognized without relying on the dataset name')
assert.equal(templates.listTemplates().find((item) => item.id === misclassifiedBuiltin.id).origin, 'builtin',
  'a previously misclassified built-in is restored to the built-in category')
assert.equal(templates.listTemplates().filter((item) => item.origin === 'builtin').length, 7,
  'the built-in category remains exactly seven templates')
assert.equal(templates.listTemplates().find((item) => item.id === userTemplate.id).origin, 'user',
  'new user templates remain in Common')

assert.match(view, /class="field-dock"/, 'field palette and selection properties share a floating panel')
const dockStart = view.indexOf('class="field-dock"')
const dockEnd = view.indexOf('</div>', view.indexOf('</aside>', dockStart))
assert.ok(view.indexOf('class="field-palette"', dockStart) < view.indexOf('class="props"', dockStart)
  && view.indexOf('class="props"', dockStart) < dockEnd, 'field palette and properties are inside the dock')
assert.match(view, /\.field-dock\s*\{[\s\S]*?position:\s*fixed[\s\S]*?top:\s*50%[\s\S]*?right:\s*clamp\([\s\S]*?max-height:\s*calc\(100dvh - 24px\)/,
  'floating panel follows the viewport and adapts to its height')
const saveFn = view.slice(view.indexOf('async function saveTemplate()'), view.indexOf('// ---- 危险操作确认'))
assert.match(saveFn, /const savingBuiltinCopy = activeIsBuiltin\.value/)
assert.match(saveFn, /if \(savingBuiltinCopy\)\s*\{\s*\/\/ 内置模板是只读原件[\s\S]*?delete payload\.id\s*payload\.origin = 'user'/,
  'saving an edited built-in creates a separate user template')
assert.match(saveFn, /if \(savingBuiltinCopy\) templateTab\.value = 'user'/,
  'the new copy is shown in the Common tab after saving')
assert.match(view, /:disabled="activeIsBuiltin"[\s\S]*?内置模板不可删除/,
  'the delete control is unavailable while a built-in is open')

console.log('模板来源回归通过：内置/常用分类、旧数据识别、启动迁移与幂等性')
rmDeep(process.env.PRINTPRESS_DATA_DIR)

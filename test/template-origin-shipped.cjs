/** Verify a staged or installed app.asar contains the template list change. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const root = path.join(__dirname, '..')
const releaseDir = process.env.PP_RELEASE_DIR || 'release'
const archive = path.join(root, releaseDir, 'win-unpacked', 'resources', 'app.asar')
const tempRoot = fs.mkdtempSync(path.join(root, '.workbuddy-ai', 'tmp', 'template-origin-asar-'))

try {
  assert.ok(fs.existsSync(archive), `app.asar exists: ${archive}`)
  asar.extractAll(archive, tempRoot)
  const pkg = JSON.parse(fs.readFileSync(path.join(tempRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.version, require('../package.json').version, 'packaged version matches source')

  const assetsDir = path.join(tempRoot, 'dist', 'assets')
  const js = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8')).join('\n')
  const css = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.css'))
    .map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8')).join('\n')
  assert.ok(js.includes('内置') && js.includes('常用'), 'both category labels are in the frontend bundle')
  assert.ok(js.includes('暂无内置模板') && js.includes('暂无常用模板'), 'category-specific empty states are bundled')
  assert.ok(css.includes('tpl-tabs'), 'tab styling is bundled')
  assert.ok(css.includes('field-dock') && css.includes('translateY(-50%)'), 'responsive right-side field dock is bundled')

  const seed = fs.readFileSync(path.join(tempRoot, 'electron', 'seed-demo.cjs'), 'utf8')
  const templates = fs.readFileSync(path.join(tempRoot, 'electron', 'templates.cjs'), 'utf8')
  assert.ok(seed.includes("origin: 'builtin'") && seed.includes('systemSeed: true'), 'only seed templates are created as built-ins')
  assert.ok(seed.includes('markLegacyBuiltinTemplates'), 'older seed templates are migrated')
  assert.ok(seed.includes("names.has(template.name)"), 'built-in migration does not depend on the dataset display name')
  assert.ok(templates.includes("origin: t.origin === 'builtin' ? 'builtin' : 'user'"), 'template list exposes the origin')
  assert.ok(templates.includes('系统内置模板不可删除') && templates.includes('系统内置模板不能覆盖'), 'backend protects built-ins from deletion and overwrite')

  console.log(`打包核验通过：${pkg.version}，模板分类文案、样式、来源标记和迁移逻辑均在 app.asar 内`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

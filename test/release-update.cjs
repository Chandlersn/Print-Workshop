/** 离线执行发布脚本：已有安装包时也必须补齐清单，拒绝把旧 exe 当新版上传。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const VERSION = '0.7.0'
const EXE = `PrintPress-${VERSION}-Setup.exe`
const installer = Buffer.from('fixture installer bytes')
const source = fs.readFileSync(path.join(ROOT, 'scripts/release-upload.cjs'), 'utf8')
  .replace(/main\(\)\.catch\([^\n]+\)/, 'globalThis.run = main')

async function run({ missingInstaller = false, dry = false, newRelease = false, missingManifest = false } = {}) {
  let id = 1
  const assets = newRelease ? [] : [{ id: id++, name: EXE, size: installer.length, state: 'uploaded' }]
  const uploads = [], operations = []
  let created = !newRelease, draft = false
  const files = new Map([
    [path.join(ROOT, 'latest.json'), JSON.stringify({ version: VERSION })],
    [path.join(ROOT, 'README.md'), `| 当前版本 | v${VERSION} |\n`],
    [path.join(ROOT, 'release', '批印坊 Setup 0.6.0.exe'), installer],
  ])
  if (!missingInstaller) files.set(path.join(ROOT, 'release', `批印坊 Setup ${VERSION}.exe`), installer)
  const release = () => ({ id: 100, html_url: 'https://github.com/example/release', draft, assets: missingManifest ? assets.filter(a => a.name !== 'latest.yml') : assets })
  const context = {
    __dirname: path.join(ROOT, 'scripts'), Buffer,
    console: { log() {}, error() {} },
    process: {
      env: { GH_TOKEN: 'test-token' }, argv: dry ? ['node', 'script', '--dry-run'] : ['node', 'script'],
      exit(code) { throw Object.assign(new Error('script exit'), { exitCode: code }) },
    },
    require(name) {
      if (name === 'fs') return {
        readFileSync: file => { assert.ok(files.has(file), `意外读取 ${file}`); return files.get(file) },
        existsSync: file => files.has(file), statSync: file => ({ size: files.get(file).length }),
      }
      if (name === path.join(ROOT, 'package.json')) return { version: VERSION }
      return require(name)
    },
    async fetch(url, options = {}) {
      const method = options.method || 'GET'
      let data, status = 200
      if (url.startsWith('https://uploads.github.com/')) {
        assert.equal(method, 'POST')
        const name = new URL(url).searchParams.get('name')
        uploads.push({ name, body: options.body })
        operations.push(`upload:${name}`)
        assets.push({ id: id++, name, size: options.body.length, state: 'uploaded' })
        data = {}
      } else if (method === 'DELETE') {
        const assetId = Number(url.split('/').pop())
        assets.splice(assets.findIndex(a => a.id === assetId), 1)
        data = null
      } else if (method === 'POST' && url.endsWith('/releases')) {
        const body = JSON.parse(options.body)
        assert.equal(body.draft, true, '新 Release 必须先作为草稿创建')
        created = true; draft = true; operations.push('create-draft'); data = release()
      } else if (method === 'PATCH' && url.endsWith('/releases/100')) {
        const body = JSON.parse(options.body)
        assert.equal(body.draft, false); draft = false; operations.push('publish'); data = release()
      } else if (url.endsWith('/user')) data = { login: 'test' }
      else if (url.endsWith('/Print-Workshop')) data = { full_name: 'test/repo', permissions: { push: true } }
      else if (url.includes('/git/ref/tags/')) data = { object: { sha: '0123456789' } }
      else if (url.endsWith('/assets')) data = assets
      else if (url.includes('/releases/tags/')) { if (created) data = release(); else { status = 404; data = { message: 'not found' } } }
      else throw new Error(`意外网络请求 ${url}`)
      return { ok: status < 400, status, text: async () => JSON.stringify(data) }
    },
  }
  vm.runInNewContext(source, context)
  let exitCode
  try { await context.run() } catch (e) {
    if (!Number.isInteger(e.exitCode)) throw e
    exitCode = e.exitCode
  }
  return { exitCode, uploads, assets, operations }
}

async function main() {
  const repaired = await run()
  assert.equal(repaired.exitCode, 0)
  assert.ok(repaired.uploads.some(a => a.name === EXE))
  const manifest = repaired.uploads.find(a => a.name === 'latest.yml')
  assert.ok(manifest, '已有同大小安装包时仍会上传缺失的 latest.yml')
  assert.equal(repaired.uploads.at(-1).name, 'latest.yml', '安装包和校验和就绪后才发布清单')
  const info = yaml.load(manifest.body.toString())
  assert.equal(info.version, VERSION)
  assert.equal(info.path, EXE)
  assert.equal(info.files[0].url, EXE)
  assert.equal(info.files[0].size, installer.length)
  assert.equal(info.files[0].sha512, crypto.createHash('sha512').update(installer).digest('base64'))
  assert.equal(info.sha512, info.files[0].sha512)
  const sums = repaired.uploads.find(a => a.name === 'SHA256SUMS.txt').body.toString()
  assert.equal(sums, `${crypto.createHash('sha256').update(installer).digest('hex')}  ${EXE}\n`)

  const missing = await run({ missingInstaller: true })
  assert.equal(missing.exitCode, 1, '当前版本安装包缺失时必须失败')
  assert.equal(missing.uploads.length, 0, '目录里的旧版 exe 不会被当成新版本上传')
  const dry = await run({ dry: true })
  assert.equal(dry.exitCode, 0)
  assert.equal(dry.uploads.length, 0, 'dry-run 无写操作')
  const fresh = await run({ newRelease: true })
  assert.equal(fresh.exitCode, 0)
  assert.equal(fresh.operations[0], 'create-draft')
  assert.equal(fresh.operations.at(-1), 'publish', '安装包及更新清单回读验证成功后才正式发布')
  const incomplete = await run({ newRelease: true, missingManifest: true })
  assert.equal(incomplete.exitCode, 1)
  assert.ok(!incomplete.operations.includes('publish'), '更新清单缺失时保留草稿，不能发布半成品')
  console.log('PASS 发布更新资产：补传清单、真实哈希、发布顺序、拒绝旧包及 dry-run')
}

main().catch(e => { console.error(e); process.exitCode = 1 })

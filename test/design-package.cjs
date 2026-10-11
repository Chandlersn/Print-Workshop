/**
 * 可编辑工程包（.ppdesign）领域验收（v0.5.0 M2）。
 *
 * 钉的是「换台电脑还能接着编辑」这件事里**看不见但一定会踩**的性质：
 *   1. **导出的是固定版本**——导出后继续编辑，包里仍是导出的那一份；
 *   2. **依赖收集不看可见性**——隐藏图层重新显示时不能丢图、丢字体；
 *   3. **导入永远创建副本**——新 ID、版本 1，同名不覆盖，原工程字节不变；
 *   4. **先校验后发布**——越界路径 / 未知条目 / 哈希不符 / 多余条目一律在发布前拒绝，
 *      且**包外不得有任何写入**；
 *   5. **字体冲突走别名**——同名不同内容绝不覆盖本机已有字体；
 *   6. **重复提交幂等、失败要回滚**——点两次不能出现两个工程，中断不能留下半工程。
 *
 * 「两台电脑」用切换 PRINTPRESS_DATA_DIR + 清模块缓存来模拟：数据目录是模块级常量，
 * 换目录必须重新 require（否则 store / designs / fonts 还指着旧目录）。
 * 已 require 出来的实例会一直指向它加载时那个目录，所以 A/B/C 三份可以并存使用。
 */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = fs.mkdtempSync(path.join(__dirname, '.tmp-design-package-'))
const machineA = path.join(root, 'a')
const machineB = path.join(root, 'b')
const machineC = path.join(root, 'c')
for (const dir of [machineA, machineB, machineC]) fs.mkdirSync(dir, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = machineA

let passed = 0
async function check(name, run) { await run(); passed++; console.log(`  ok - ${name}`) }

/** 切换「机器」：改数据目录并丢掉已加载的领域模块缓存 */
function onMachine(dir) {
  process.env.PRINTPRESS_DATA_DIR = dir
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}`)) delete require.cache[key]
  }
  return {
    pkg: require('../electron/design-package.cjs'),
    designs: require('../electron/designs.cjs'),
    fonts: require('../electron/fonts.cjs'),
    codec: require('../electron/package-codec.cjs'),
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
/** 带合法 sfnt 签名的合成字体（仓库里的 测试楷体.ttf 是 15 字节假文件，会被签名校验拒掉） */
const makeFont = (fill) => Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(512, fill)])
const fontA = makeFont(0x41)
const fontA2 = makeFont(0x42) // 同名不同内容：触发别名分支
const ALIAS = `PP_Font_${sha256(fontA)}`

function uploadFont(machineDir, fileName, bytes) {
  const dir = path.join(machineDir, 'print-fonts')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), bytes)
}

async function main() {
  // ───────── A 机：建工程并导出 ─────────
  const A = onMachine(machineA)
  const png = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png'))
  uploadFont(machineA, '测试楷体.ttf', fontA)
  const asset = A.designs.importImageBytes({ base64: png.toString('base64'), name: '徽标.png', source: 'managed' })
  const baseDesign = (name) => ({
    schemaVersion: 1, revision: 0, name,
    artboard: { w: 210, h: 297, background: '#ffffff' },
    assets: { [asset.id]: asset },
    layers: [
      { id: 'pic', type: 'image', name: '徽标', assetId: asset.id, x: 10, y: 12, w: 40, h: 40, visible: false },
      { id: 'txt', type: 'text', name: '标题', text: '批印坊', fontFamily: '测试楷体', fontSize: 28, x: 10, y: 60, w: 100, h: 20 },
    ],
    groups: [{ id: 'g1', name: '整组', layerIds: ['pic', 'txt'] }],
    guides: [{ id: 'gd1', axis: 'x', position: 20 }],
  })
  const saved1 = A.designs.saveDesign(baseDesign('往返底图'))
  const pkgPath = path.join(root, '往返底图.ppdesign')

  console.log('== ① 导出固定版本 ==')
  await check('导出成功，图片与上传字体都进包', () => {
    const out = A.pkg.exportPackage({ id: saved1.id, revision: 1, targetPath: pkgPath })
    assert.ok(fs.existsSync(pkgPath) && out.bytes > 0)
    assert.equal(out.resources.length, 1, '图片原件进包')
    assert.ok(out.fonts.some((f) => f.status === 'embedded'), '上传字体已内嵌')
    assert.equal(out.manifest.source.id, saved1.id, '来源工程 ID 只做记录')
    assert.equal(out.manifest.stats.layerCount, 2)
  })
  await check('隐藏图层的原件也在依赖里（依赖收集不看可见性）', () => {
    const out = A.pkg.exportPackage({ id: saved1.id, revision: 1, targetPath: path.join(root, 'again.ppdesign') })
    assert.equal(out.resources.length, 1)
  })

  await check('取消写包会删除临时文件并保留已有目标文件', () => {
    const target = path.join(root, 'cancel-preserve.ppdesign')
    fs.writeFileSync(target, 'previous package')
    let canceled = false
    assert.throws(() => A.codec.writeArchive(target, [
      { name: 'manifest.json', buffer: Buffer.from('{}'), store: true },
      { name: 'project.json', buffer: Buffer.from('{"layers":[]}'), store: true },
    ], {
      onProgress: () => { canceled = true },
      shouldCancel: () => canceled,
    }), (error) => error.code === 'CANCELLED')
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous package')
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.cancel-preserve.ppdesign.') && name.endsWith('.tmp')), [])
  })
  await check('覆盖旧包的替换步骤失败时能恢复完整旧文件', () => {
    const target = path.join(root, 'replace-failure.ppdesign')
    fs.writeFileSync(target, 'original complete package')
    const originalRename = fs.renameSync
    let calls = 0
    try {
      fs.renameSync = (from, to) => {
        calls++
        if (calls === 1 || calls === 3) {
          const error = new Error('injected rename failure')
          error.code = calls === 1 ? 'EPERM' : 'EIO'
          throw error
        }
        return originalRename(from, to)
      }
      assert.throws(() => A.codec.writeArchive(target, [{ name: 'manifest.json', buffer: Buffer.from('{}') }]), /injected rename failure/)
    } finally { fs.renameSync = originalRename }
    assert.equal(fs.readFileSync(target, 'utf8'), 'original complete package')
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.replace-failure.ppdesign.')), [])
  })
  await check('Windows 覆盖分支成功后清理旧包备份与临时文件', async () => {
    const target = path.join(root, 'replace-success.ppdesign')
    const stage = path.join(root, 'replace-success-stage')
    fs.writeFileSync(target, 'old package')
    const originalRename = fs.renameSync
    let calls = 0
    try {
      fs.renameSync = (from, to) => {
        if (++calls === 1) {
          const error = new Error('Windows target exists')
          error.code = 'EPERM'
          throw error
        }
        return originalRename(from, to)
      }
      A.codec.writeArchive(target, [{ name: 'manifest.json', buffer: Buffer.from('{}') }])
    } finally { fs.renameSync = originalRename }
    assert.ok(calls >= 3)
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.replace-success.ppdesign.')), [])
    assert.equal((await A.codec.extractToDir(target, stage)).entries[0].name, 'manifest.json')
  })
  await check('高度可压缩的工程内容写出后仍能通过自身压缩比限制', async () => {
    const target = path.join(root, 'compressible.ppdesign')
    const stage = path.join(root, 'compressible-stage')
    const repeated = Buffer.from('A'.repeat(1024 * 1024))
    A.codec.writeArchive(target, [
      { name: 'manifest.json', buffer: Buffer.from('{}') },
      { name: 'project.json', buffer: repeated },
    ])
    const result = await A.codec.extractToDir(target, stage)
    assert.equal(result.entries.find(entry => entry.name === 'project.json').bytes, repeated.length)
    assert.deepEqual(fs.readFileSync(path.join(stage, 'project.json')), repeated)
  })
  await check('读包期间可以取消，不必等到下一条目', async () => {
    const target = path.join(root, 'cancel-read.ppdesign')
    const stage = path.join(root, 'cancel-read-stage')
    A.codec.writeArchive(target, [{ name: 'project.json', buffer: crypto.randomBytes(1024 * 1024), store: true }])
    let probes = 0
    await assert.rejects(() => A.codec.extractToDir(target, stage, { shouldCancel: () => ++probes >= 2 }), error => error.code === 'CANCELLED')
    assert.ok(probes >= 2)
  })
  await check('导出后继续编辑保存，包里仍是导出时那一版', async () => {
    A.designs.saveDesign({ ...baseDesign('往返底图改名'), revision: 1, id: saved1.id })
    const B0 = onMachine(machineB)
    const summary = await B0.pkg.inspectPackage(pkgPath)
    assert.equal(summary.name, '往返底图', '包里是导出的名字，不是后来改的')
    assert.equal(summary.stats.layerCount, 2)
  })

  console.log('== ② 导入产生副本（B 机） ==')
  const B = onMachine(machineB)
  const summaryB = await B.pkg.inspectPackage(pkgPath)
  let imported = null
  await check('检查返回摘要与令牌', () => {
    assert.match(summaryB.token, /^[a-f0-9]{24}$/)
    assert.equal(summaryB.artboard.w, 210)
    assert.equal(summaryB.artboard.h, 297)
    assert.deepEqual(summaryB.unresolved, [])
  })
  await check('提交后是新工程、版本 1，分组参考线与字体都完整', () => {
    imported = B.pkg.commitPackage(summaryB.token)
    assert.notEqual(imported.id, saved1.id)
    assert.equal(imported.revision, 1)
    const doc = B.designs.getDesign(imported.id, 1)
    assert.equal(doc.layers.length, 2)
    assert.equal(doc.groups.length, 1, '分组保留')
    assert.equal(doc.guides.length, 1, '参考线保留')
    assert.equal(Object.keys(doc.assets).length, 1, '原件落到本机')
    assert.equal(doc.layers.find((l) => l.type === 'text').fontFamily, '测试楷体')
    assert.equal(doc.layers.find((l) => l.id === 'pic').visible, false, '隐藏属性保留')
    assert.ok(fs.existsSync(path.join(machineB, 'print-fonts', '测试楷体.ttf')), '字体原件已发布')
  })
  await check('重复提交返回同一个结果（不产生第二份副本）', () => {
    const again = B.pkg.commitPackage(summaryB.token)
    assert.equal(again.id, imported.id)
    assert.equal(again.reused, true)
    assert.equal(B.designs.listDesigns().filter((d) => d.id === imported.id).length, 1)
  })
  await check('导入不改动导出方的工程与字体字节', () => {
    const back = onMachine(machineA)
    assert.equal(back.designs.getDesign(saved1.id, 1).revision, 1)
    assert.equal(sha256(fs.readFileSync(path.join(machineA, 'print-fonts', '测试楷体.ttf'))), sha256(fontA))
  })

  console.log('== ③ 字体冲突：同名不同内容走别名 ==')
  await check('本机已有同名异内容字体时用 PP_Font_<sha>，原文件字节不变', async () => {
    const C = onMachine(machineC)
    uploadFont(machineC, '测试楷体.ttf', fontA2)
    const summary = await C.pkg.inspectPackage(pkgPath)
    const plan = summary.fonts.find((f) => f.family === '测试楷体')
    assert.equal(plan.action, 'alias', JSON.stringify(plan))
    assert.equal(plan.targetFamily, ALIAS)
    const committed = C.pkg.commitPackage(summary.token)
    const doc = C.designs.getDesign(committed.id, 1)
    assert.equal(doc.layers.find((l) => l.type === 'text').fontFamily, ALIAS)
    assert.equal(Object.values(doc.fontAssets)[0], `${ALIAS}.ttf`)
    assert.equal(sha256(fs.readFileSync(path.join(machineC, 'print-fonts', '测试楷体.ttf'))), sha256(fontA2), '原字体字节不变')
  })

  console.log('== ④ 缺失字体必须先解决依赖 ==')
  const missingPkg = path.join(root, '缺字体.ppdesign')
  const C1 = onMachine(machineC)
  let pendingToken = null // 「未决策」的那次检查：用户可以直接取消，也可以补齐字体后继续
  await check('本机没有的字体会被报出来，未决策不能提交', async () => {
    const fake = C1.designs.saveDesign({
      schemaVersion: 1, revision: 0, name: '缺字体底图',
      artboard: { w: 100, h: 100, background: '#ffffff' }, assets: {},
      layers: [{ id: 't', type: 'text', name: '字', text: 'x', fontFamily: '根本没这个字体', fontSize: 20, x: 0, y: 0, w: 50, h: 20 }],
    })
    C1.pkg.exportPackage({ id: fake.id, revision: 1, targetPath: missingPkg })
    const summary = await C1.pkg.inspectPackage(missingPkg)
    pendingToken = summary.token
    assert.deepEqual(summary.unresolved, ['根本没这个字体'])
    assert.throws(() => C1.pkg.commitPackage(summary.token), /请先处理缺失的字体/)
  })
  await check('三种补齐方式：替代字体 / 默认字体栈 / 提供字体文件', async () => {
    const one = await C1.pkg.inspectPackage(missingPkg)
    const substituted = C1.pkg.commitPackage(one.token, { fontDecisions: { '根本没这个字体': { action: 'substitute', family: '测试楷体' } } })
    assert.equal(C1.designs.getDesign(substituted.id, 1).layers[0].fontFamily, '测试楷体')

    const two = await C1.pkg.inspectPackage(missingPkg)
    const defaulted = C1.pkg.commitPackage(two.token, { fontDecisions: { '根本没这个字体': { action: 'default' } } })
    assert.equal(C1.designs.getDesign(defaulted.id, 1).layers[0].fontFamily, '')

    const provided = path.join(root, 'provided.ttf')
    fs.writeFileSync(provided, makeFont(0x43))
    const three = await C1.pkg.inspectPackage(missingPkg)
    const withFile = C1.pkg.commitPackage(three.token, { fontDecisions: { '根本没这个字体': { action: 'file', filePath: provided } } })
    assert.equal(C1.designs.getDesign(withFile.id, 1).layers[0].fontFamily, '根本没这个字体')
    assert.ok(fs.existsSync(path.join(machineC, 'print-fonts', '根本没这个字体.ttf')), '提供的字体已发布')
  })

  console.log('== ⑤ 包校验：不合法的一律在发布前拒绝 ==')
  const outside = path.resolve(root, '包外.png')
  const craft = (name, entries) => {
    const target = path.join(root, name)
    A.codec.writeArchive(target, entries)
    return target
  }
  const stubManifest = (extra = {}) => Buffer.from(JSON.stringify({
    packageVersion: 1, resources: [], fonts: [], project: { file: 'project.json' }, ...extra,
  }))
  await check('越界条目被拒，且包外没有任何写入', async () => {
    const target = craft('越界.ppdesign', [
      { name: '../../包外.png', buffer: png, store: true },
      { name: `images/${sha256(png)}.png`, buffer: png, store: true },
    ])
    const C = onMachine(machineC)
    await assert.rejects(() => C.pkg.inspectPackage(target), /越界|未知条目|非法|清单未列出/)
    assert.ok(!fs.existsSync(outside), '包外没有文件被写出')
  })
  await check('清单未列出的多余条目被拒', async () => {
    const target = craft('多余.ppdesign', [
      { name: 'manifest.json', buffer: stubManifest() },
      { name: 'project.json', buffer: Buffer.from(JSON.stringify(baseDesign('x'))) },
      { name: `images/${sha256(png)}.png`, buffer: png, store: true },
    ])
    const C = onMachine(machineC)
    await assert.rejects(() => C.pkg.inspectPackage(target), /清单未列出/)
  })
  await check('清单哈希与实际内容不符被拒', async () => {
    const target = craft('哈希不符.ppdesign', [
      { name: 'manifest.json', buffer: stubManifest({ resources: [{ path: `images/${sha256(png)}.png`, role: 'image', sha256: 'f'.repeat(64), bytes: png.length }] }) },
      { name: 'project.json', buffer: Buffer.from(JSON.stringify(baseDesign('x'))) },
      { name: `images/${sha256(png)}.png`, buffer: png, store: true },
    ])
    const C = onMachine(machineC)
    await assert.rejects(() => C.pkg.inspectPackage(target), /不一致/)
  })
  await check('不支持的包格式版本被拒', async () => {
    const target = craft('版本.ppdesign', [
      { name: 'manifest.json', buffer: stubManifest({ packageVersion: 99 }) },
      { name: 'project.json', buffer: Buffer.from(JSON.stringify(baseDesign('x'))) },
    ])
    const C = onMachine(machineC)
    await assert.rejects(() => C.pkg.inspectPackage(target), /不支持的工程包版本/)
  })
  await check('检查失败不留暂存残留', () => {
    const C = onMachine(machineC)
    C.pkg.cancelPackage(pendingToken) // 未决策的那次由用户取消
    const staging = C.pkg.stagingRoot()
    const left = fs.existsSync(staging) ? fs.readdirSync(staging).filter((n) => /^[a-f0-9]{24}$/.test(n)) : []
    assert.equal(left.length, 0, `暂存区应为空，实为 ${JSON.stringify(left)}`)
  })

  console.log('== ⑥ 事务：失败要回滚，取消/崩溃要收敛 ==')
  await check('暂存快照被改动后提交失败，不留半工程', async () => {
    const C = onMachine(machineC)
    const summary = await C.pkg.inspectPackage(pkgPath)
    // 检查之后把暂存区里的图片原件换掉 → 提交时哈希校验必然失败（令牌绑定的是快照）
    const stagedImage = path.join(C.pkg.stagingRoot(), summary.token, 'content', 'images', `${sha256(png)}.png`)
    assert.ok(fs.existsSync(stagedImage), '暂存快照存在')
    fs.writeFileSync(stagedImage, Buffer.from('not-an-image'))
    const before = C.designs.listDesigns().length
    assert.throws(() => C.pkg.commitPackage(summary.token), /仅支持有效的 PNG|签名损坏|不完整|找不到|无效/)
    assert.equal(C.designs.listDesigns().length, before, '索引里没有多出工程')
  })
  await check('取消检查：暂存区清掉，令牌失效', async () => {
    const C = onMachine(machineC)
    const summary = await C.pkg.inspectPackage(pkgPath)
    assert.equal(C.pkg.cancelPackage(summary.token).canceled, true)
    assert.throws(() => C.pkg.commitPackage(summary.token), /已失效/)
  })
  await check('崩溃残留的事务由恢复程序收敛（回收新建字体、不留半工程）', () => {
    const C = onMachine(machineC)
    const txDir = path.join(machineC, 'package-tx')
    fs.mkdirSync(txDir, { recursive: true })
    const orphanFont = '崩溃残留字体.ttf'
    uploadFont(machineC, orphanFont, makeFont(0x45))
    const fakeId = 'design_' + 'c'.repeat(24)
    fs.mkdirSync(path.join(machineC, 'designs', fakeId), { recursive: true })
    fs.writeFileSync(path.join(txDir, 'tx_' + 'a'.repeat(24) + '.json'), JSON.stringify({
      txId: 'tx_' + 'a'.repeat(24), token: 'b'.repeat(24), status: 'prepared', createdAt: new Date().toISOString(),
      newDesignId: fakeId, images: [],
      fonts: [{ file: orphanFont, staged: path.join(machineC, 'print-fonts', orphanFont), sha256: sha256(makeFont(0x45)) }],
    }))
    const res = C.pkg.recoverPendingTransactions()
    assert.deepEqual(res.rolledBack, [fakeId])
    assert.ok(!fs.existsSync(path.join(machineC, 'print-fonts', orphanFont)), '事务自己建的字体被回收')
    assert.ok(!fs.existsSync(path.join(machineC, 'designs', fakeId)), '没有半截工程目录')
  })

  console.log('== ⑦ I-38 工程包：先校验后发布、路径只来自白名单、导入必是副本（静态守卫） ==')
  const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  await check('包内条目名只认白名单，导出时也过一遍同一份判定', () => {
    const codec = src('electron/package-codec.cjs')
    assert.match(codec, /const ENTRY_PATTERNS = \[/, '白名单是唯一权威定义')
    assert.ok(codec.includes('^images\\/[a-f0-9]{64}'), '图片条目必须由内容哈希命名')
    assert.ok(codec.includes('^fonts\\/[a-f0-9]{64}'), '字体条目必须由内容哈希命名')
    const pkg = src('electron/design-package.cjs')
    assert.match(pkg, /for \(const entry of all\) codec\.entryRole\(entry\.name\)/, '导出的包也必须自己读得回来')
  })
  await check('检查阶段绝不发布任何工程', () => {
    const pkg = src('electron/design-package.cjs')
    const inspect = pkg.slice(pkg.indexOf('async function inspectPackage'), pkg.indexOf('function summarize'))
    assert.ok(!/publishRevisionLocked|saveDesign/.test(inspect), '检查阶段不得写工程索引')
    assert.ok(!/importImageFile/.test(inspect), '检查阶段不得把原件落进设计目录')
  })
  await check('导入固定新 ID + 版本 1，并复用锁内发布（不在锁内再调公共保存）', () => {
    const pkg = src('electron/design-package.cjs')
    assert.match(pkg, /revision: 1, createdAt: nowIso\(\), recordUse: false/)
    assert.match(pkg, /designs\.withDesignLock\(/)
    assert.match(pkg, /designs\.publishRevisionLocked\(/)
    assert.ok(!/designs\.saveDesign\(/.test(pkg), '导入路径不许再调 saveDesign（会二次取锁）')
  })
  await check('提交前先落事务记录，索引最后发布', () => {
    const pkg = src('electron/design-package.cjs')
    assert.ok(pkg.indexOf('const writeTx =') < pkg.indexOf('designs.importImageFile('), '先落恢复记录，再发布资源')
    assert.ok(pkg.indexOf("tx.status = 'resources'") < pkg.indexOf('designs.publishRevisionLocked('), '资源先发布、索引最后')
    assert.ok(pkg.indexOf('designs.publishRevisionLocked(') < pkg.indexOf("tx.status = 'committed'"), '索引发布之后才写提交标记')
  })
  await check('通道与 preload 白名单齐备（渲染层只能调这几条）', () => {
    const apiSrc = src('electron/api.cjs')
    for (const name of ['design:packageExport', 'design:packageInspect', 'design:packageCommit', 'design:packageCancel', 'design:packageCancelExport', 'design:packagePickFont']) {
      assert.ok(apiSrc.includes(`'${name}'`), `注册表缺 ${name}`)
    }
    const preload = src('electron/preload.cjs')
    for (const fn of ['exportDesignPackage', 'cancelExportDesignPackage', 'onDesignPackageProgress', 'inspectDesignPackage', 'commitDesignPackage', 'cancelDesignPackage', 'pickPackageFont']) {
      assert.ok(preload.includes(`${fn}:`), `preload 缺 ${fn}`)
    }
  })

  console.log(`\n工程包领域验收：${passed} 组通过`)
}

main().then(() => {
  try { require('./helpers/rm.cjs').rmDeep(root) } catch { /* 清理失败不影响结果 */ }
  process.exit(0)
}).catch((err) => {
  console.error('\nFAIL', err)
  process.exit(1)
})

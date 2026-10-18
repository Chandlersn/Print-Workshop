/** v0.6 photo preparation: matching, safe import, original bytes, publication and archives. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { rmDeep } = require('./helpers/rm.cjs')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-photos-'))
process.env.PRINTPRESS_DATA_DIR = path.join(tmp, 'data')
const { photoKey, matchPhotos } = require('../electron/photo-match.cjs')
const photos = require('../electron/photo-library.cjs')
const output = require('../electron/photo-output.cjs')
const designs = require('../electron/designs.cjs')
const library = require('../electron/asset-library.cjs')
const dataset = require('../electron/dataset.cjs')
const store = require('../electron/store.cjs')
const api = require('../electron/api.cjs')
const png = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png'))
const jpg = fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg'))
const id = 'asset_' + 'a'.repeat(64)
let passed = 0
async function check(label, run) { await run(); passed++; console.log('  ok -', label) }

async function run() {
  await check('匹配 NFC、大小写、扩展名与子目录；不把不同子目录混为一张图', () => {
    assert.equal(photoKey('  部门\\É.JPG　'), photoKey('部门/e\u0301.jpeg'))
    assert.equal(photoKey('1001'), photoKey('1001.png'))
    assert.equal(photoKey('john.doe'), photoKey('john.doe.png'))
    assert.notEqual(photoKey('一组/1001.jpg'), photoKey('二组/1001.jpg'))
    for (const unsafe of ['../a.jpg', 'x/../a.jpg', 'C:\\a.jpg', '\\\\server\\a.jpg', '/a.jpg',
      'http://a.jpg', 'data:a', 'file:a', 'a//b.jpg', 'a\0.jpg', '\na.jpg', 'x/./a.jpg', 'x /a.jpg', 'con.jpg', '.jpg']) {
      assert.throws(() => photoKey(unsafe), undefined, unsafe)
    }
  })
  await check('冲突、空值、缺图、坏图、非法名称分开统计；补打行号不变', () => {
    const rows = ['001', '002', '', '003', 'bad', '../a.jpg', '001', '\n001'].map(photo => ({ photo }))
    const files = [{ name: '001.jpg', assetId: id }, { name: '002.png', assetId: id },
      { name: '002.jpg', assetId: id }, { name: 'bad.jpg', error: '图片损坏' }]
    const result = matchPhotos(rows, 'photo', files)
    assert.deepEqual(result.counts, { matched: 2, empty: 1, missing: 1, ambiguous: 1, invalid: 2, broken: 1 })
    assert.deepEqual(result.duplicates[0].rowIndexes, [0, 6])
    assert.deepEqual(matchPhotos(rows, 'photo', files, [6, 3]).results.map(r => r.rowIndex), [6, 3])
    for (const range of [[-1], [8], [1, 1], [0.5], '1']) assert.throws(() => matchPhotos(rows, 'photo', files, range))
  })
  const folder = path.join(tmp, 'photos')
  fs.mkdirSync(path.join(folder, '部门'), { recursive: true })
  fs.writeFileSync(path.join(folder, '001.JPG'), jpg)
  fs.writeFileSync(path.join(folder, '部门', 'é.png'), png)
  fs.writeFileSync(path.join(folder, '坏图.jpg'), 'not an image')
  fs.writeFileSync(path.join(folder, '说明.txt'), 'ignored')
  store.saveJson('datasets', [{ id: 'ds_photos', name: '照片名单', columns: [{ key: 'photo', alias: '照片', type: 'text' }],
    rows: ['001.jpeg', '部门/e\u0301', '坏图.jpg', 'missing.png', '001'].map(photo => ({ photo })) }])
  const args = { datasetId: 'ds_photos', column: 'photo' }
  dataset.setPhotoMatchColumn(args.datasetId, 'photo')
  let report
  await check('先按名单筛选：未匹配与同名冲突不写入素材库或缩略图，坏图不入库', async () => {
    const saved = store.loadJson('datasets')
    store.saveJson('datasets', [...saved, { id: 'ds_filter', name: '筛选', photoMatchColumn: 'photo', columns: [{ key: 'photo' }], rows: ['matched', 'dup', 'bad', 'absent'].map(photo => ({ photo })) }])
    const input = path.join(tmp, 'filtered')
    fs.mkdirSync(input)
    for (const [name, bytes] of [['matched.jpg', jpg], ['unmatched.png', png], ['dup.jpg', jpg], ['dup.png', png], ['bad.jpg', Buffer.from('bad image')]]) fs.writeFileSync(path.join(input, name), bytes)
    const importedNames = []
    const original = designs.importImageBuffer
    designs.importImageBuffer = (bytes, name, source) => { importedNames.push(name); return original(bytes, name, source) }
    try {
      const res = await photos.importFolder({ datasetId: 'ds_filter', column: 'photo', folder: input })
      assert.deepEqual(importedNames.sort(), ['bad.jpg', 'matched.jpg'])
      assert.deepEqual(res.results.map(r => r.status), ['matched', 'ambiguous', 'broken', 'missing'])
      assert.deepEqual(res.files.filter(f => f.assetId).map(f => f.name), ['matched.jpg'])
      assert.ok(res.ignored.some(f => f.name === 'unmatched.png'))
      assert.equal(fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).filter(f => /\.(png|jpg)$/.test(f)).length, 1)
      assert.equal(require('../electron/asset-library.cjs').listLibrary({ category: 'photo' }).total, 1)
      assert.equal(require('../electron/asset-library.cjs').listLibrary().total, 0, '名单照片默认不挤占设计素材列表')
      dataset.setPhotoMatchColumn('ds_filter', null)
      await assert.rejects(photos.importFolder({ datasetId: 'ds_filter', column: 'photo', folder: input }), /配图/)
    } finally { designs.importImageBuffer = original; store.saveJson('datasets', saved) }
  })
  await check('配图列唯一、开关持久化、切列仅复用已入库照片，新匹配照片需重新导入', async () => {
    const dsId = 'ds_name_match'
    const rows = [{ name: '张三', code: '001' }, { name: '李四', code: '002' }, { name: '王五', code: '003' }, { name: '', code: '' }]
    store.saveJson('datasets', [...store.loadJson('datasets'), { id: dsId, name: '按姓名配图', columns: [{ key: 'name', alias: '姓名', printOn: true }, { key: 'code', alias: '编号' }], rows }])
    assert.equal(dataset.getDataset(dsId).photoMatchColumn, null)
    dataset.setPhotoMatchColumn(dsId, 'name')
    assert.equal(dataset.getDataset(dsId).photoMatchColumn, 'name')
    const input = path.join(tmp, 'name-photos')
    fs.mkdirSync(input)
    fs.writeFileSync(path.join(input, '张三.jpg'), jpg)
    fs.writeFileSync(path.join(input, '李四.png'), png)
    fs.writeFileSync(path.join(input, '001.jpg'), jpg)
    const imported = await photos.importFolder({ datasetId: dsId, column: 'name', folder: input })
    assert.deepEqual(imported.results.map(r => r.status), ['matched', 'matched', 'missing', 'empty'])
    const sharedPhoto = imported.results[0].assetId
    library.adopt(sharedPhoto)
    assert.ok(library.listLibrary({ category: 'design' }).items.some(item => item.assetId === sharedPhoto))
    assert.ok(library.listLibrary({ category: 'photo' }).items.some(item => item.assetId === sharedPhoto), '同一原件可同时属于设计与名单照片')
    const doc = designs.saveDesign({ name: '跟随配图列', artboard: { w: 90, h: 60 }, layers: [{ id: 'p', type: 'image', variable: true, bindColumn: 'old-column', w: 35, h: 45 }] })
    const tpl = require('../electron/templates.cjs').saveTemplate({ name: '姓名配图', datasetId: dsId, pageSize: { id: 'custom', w: 90, h: 60 }, backgroundDesign: { id: doc.id, revision: 1 }, fields: [] })
    const print = require('../electron/print.cjs')
    let built = print.buildBatchHtml(dsId, tpl.id)
    assert.equal(built.pageCount, 4)
    assert.equal((built.html.match(/data-photo-column=/g) || []).length, 2)
    assert.ok(!built.html.includes('变量图'))
    const fullCheck = await print.photoPreflight(dsId, tpl.id)
    assert.deepEqual(fullCheck.counts, { matched: 2, empty: 1, missing: 1, ambiguous: 0, invalid: 0, broken: 0 })
    assert.equal(fullCheck.canOutput, true, '缺图和空值允许留白出片')
    assert.deepEqual(fullCheck.issues.map(item => item.rowIndex), [2])
    assert.equal(fullCheck.pageCount, 4)
    const selectedCheck = await print.photoPreflight(dsId, tpl.id, [0, 1])
    assert.deepEqual(selectedCheck.counts, { matched: 2, empty: 0, missing: 0, ambiguous: 0, invalid: 0, broken: 0 })
    assert.equal(selectedCheck.photoFrameCount, 2)
    const overrides = require('../electron/photo-overrides.cjs')
    const rowId = dataset.getDataset(dsId).recordIds[0]
    const overrideKey = { datasetId: dsId, templateId: tpl.id, rowId, layerId: 'p' }
    assert.equal(overrides.inspect(overrideKey).state, 'none')
    assert.equal(overrides.set({ ...overrideKey, fit: 'contain', focal: { x: 0.2, y: 0.8 } }).state, 'active')
    assert.match(print.buildBatchHtml(dsId, tpl.id).html, /object-fit:contain;object-position:20% 80%/)
    assert.notEqual((await print.photoPreflight(dsId, tpl.id)).fingerprint, fullCheck.fingerprint, '取景改变使预检快照过期')
    assert.throws(() => overrides.set({ ...overrideKey, fit: 'cover', focal: { x: 2, y: 0.5 } }), /焦点/)
    dataset.updateCell(dsId, 0, 'name', '临时改名')
    assert.equal(overrides.inspect(overrideKey).state, 'stale', '照片匹配值变化后旧取景不误套')
    dataset.updateCell(dsId, 0, 'name', '张三')
    assert.equal(overrides.inspect(overrideKey).state, 'active')
    assert.equal(overrides.clear(overrideKey).removed, true)
    assert.equal(overrides.inspect(overrideKey).state, 'none')
    assert.doesNotMatch(print.buildBatchHtml(dsId, tpl.id).html, /object-fit:contain;object-position:20% 80%/)
    const oldBindings = store.loadJson('photo-bindings')
    const ownBinding = oldBindings.find(item => item.datasetId === dsId)
    try {
      store.saveJson('photo-bindings', oldBindings.map(item => item.datasetId === dsId
        ? { ...item, files: [...item.files, { ...item.files[0], name: '张三.png' }] } : item))
      const conflict = await print.photoPreflight(dsId, tpl.id)
      assert.equal(conflict.counts.ambiguous, 1)
      assert.equal(conflict.canOutput, false)
      assert.equal((await print.photoPreflight(dsId, tpl.id, [1])).canOutput, true, '范围外冲突不阻止补打')
      await assert.rejects(print.assertPhotoPreflight(dsId, tpl.id), /第 1 行照片同名冲突/)
      await assert.rejects(print.assertPhotoPreflight(dsId, tpl.id, [1], selectedCheck.fingerprint), /已变化/)
      store.saveJson('photo-bindings', oldBindings.map(item => item.datasetId === dsId
        ? { ...ownBinding, files: [{ name: '张三.jpg', assetId: id }, ...ownBinding.files.filter(file => file.name !== '张三.jpg')] } : item))
      const broken = await print.photoPreflight(dsId, tpl.id, [0])
      assert.equal(broken.counts.broken, 1)
      assert.equal(broken.canOutput, false)
    } finally { store.saveJson('photo-bindings', oldBindings) }
    dataset.setPhotoMatchColumn(dsId, 'code')
    assert.equal(dataset.getDataset(dsId).photoMatchColumn, 'code')
    assert.equal(dataset.getDataset(dsId).columns[0].printOn, true)
    assert.deepEqual(dataset.getDataset(dsId).rows, rows, '自动匹配不改写姓名或编号')
    assert.equal((await photos.report({ datasetId: dsId, column: 'name' })).counts.matched, 0)
    const reimported = await photos.importFolder({ datasetId: dsId, column: 'code', folder: input })
    assert.equal(reimported.counts.matched, 1)
    assert.deepEqual(reimported.files.map(f => f.name), ['001.jpg'])
    built = print.buildBatchHtml(dsId, tpl.id)
    assert.equal((built.html.match(/data-photo-column=/g) || []).length, 1)
    assert.throws(() => dataset.setPhotoMatchColumn(dsId, '不存在'), /不存在/)
    assert.equal(dataset.getDataset(dsId).photoMatchColumn, 'code')
    assert.throws(() => api.call('dataset:setPhotoMatchColumn', { datasetId: dsId, key: 'name' }, {}), err => err.code === 'WRITE_FORBIDDEN')
    dataset.setPhotoMatchColumn(dsId, null)
    built = print.buildBatchHtml(dsId, tpl.id)
    assert.equal((built.html.match(/data-photo-column=/g) || []).length, 0)
    assert.equal(built.pageCount, 4)
    assert.deepEqual(built.photoAssets, [])
    const disabledCheck = await print.photoPreflight(dsId, tpl.id)
    assert.equal(disabledCheck.photoEnabled, false)
    assert.equal(disabledCheck.counts.empty, 4)
    assert.equal(disabledCheck.canOutput, true)
    assert.equal((await photos.report({ datasetId: dsId, column: 'name' })).counts.matched, 0)
  })
  await check('目录入库保留原图字节；坏图在入库阶段给出原因', async () => {
    const progress = []
    report = await photos.importFolder({ ...args, folder }, { onProgress: p => progress.push(p) })
    assert.equal(progress.length, 4, '包含一次扫描状态和三张匹配候选的处理进度')
    assert.equal(progress[0].stage, 'scanning')
    assert.equal(report.counts.matched, 3)
    assert.equal(report.counts.broken, 1)
    assert.equal(report.counts.missing, 1)
    assert.equal(report.ignored.length, 1)
    assert.deepEqual(designs.assetBytes(report.results[0].assetId).buffer, jpg)
    assert.deepEqual(designs.assetBytes(report.results[1].assetId).buffer, png)
    assert.equal(designs.assetInfo(report.results[0].assetId).source, 'managed')
    assert.ok(!JSON.stringify(store.loadJson('photo-bindings')).includes(tmp))
    const usage = library.resourceUsage()
    const mine = usage.datasets.find(item => item.datasetId === args.datasetId)
    assert.ok(mine && mine.photoCount === 2 && mine.matchedPeople === 3)
    assert.ok(usage.originalBytes >= mine.logicalBytes && usage.uniqueOriginals >= mine.photoCount)
  })
  await check('问题清单导出保留原行号、前导零和公式形态的原始文本', async () => {
    const dsId = 'ds_issue_export'
    store.saveJson('datasets', [...store.loadJson('datasets'), { id: dsId, name: '问题清单', photoMatchColumn: 'photo',
      columns: [{ key: 'code', alias: '编号' }, { key: 'photo', alias: '配图' }],
      rows: [{ code: '00123', photo: 'missing-1' }, { code: '=HYPERLINK("https://example.invalid")', photo: 'missing-2' }] }])
    const file = path.join(tmp, 'photo-issues.xlsx')
    const result = await api.call('photo:exportIssues', { datasetId: dsId, column: 'photo', identifierKey: 'code', rows: [0, 1], savePath: file }, { allowWrite: true })
    assert.equal(result.count, 2)
    const workbook = require('xlsx').readFile(file)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    assert.equal(sheet.A2.v, 1)
    assert.equal(sheet.A3.v, 2)
    assert.equal(sheet.B2.v, '00123')
    assert.equal(sheet.B2.t, 's')
    assert.equal(sheet.B3.v, '=HYPERLINK("https://example.invalid")')
    assert.equal(sheet.B3.t, 's')
    assert.equal(sheet.B3.f, undefined)
    assert.equal((await photos.exportIssues({ datasetId: dsId, column: 'photo', identifierKey: 'code', rows: [0], savePath: path.join(tmp, 'one.xlsx') })).count, 1)
    await assert.rejects(photos.exportIssues({ datasetId: dsId, column: 'photo', identifierKey: 'code', rows: [0, 0], savePath: file }), /范围无效/)
  })
  await check('修改名单后重新匹配；同内容重复导入不增加素材', async () => {
    const before = fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).length
    dataset.updateCell(args.datasetId, 3, 'photo', '001')
    assert.equal((await photos.report(args)).counts.matched, 4)
    await photos.importFolder({ ...args, folder })
    assert.equal(fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).length, before)
  })
  await check('变量图保存、工程包迁移、按行换图、多联、对折与归档', async () => {
    const layout = require('../electron/design-layout.cjs')
    const doc = designs.saveDesign({ name: '变量照片证卡', artboard: { w: 90, h: 60 }, assets: {}, layers: [
      { id: 'under', type: 'rect', fill: '#ffffff' },
      { id: 'portrait', type: 'image', variable: true, bindColumn: 'photo', x: 5, y: 7, w: 35, h: 45, fit: 'contain', focal: { x: 0.2, y: 0.4 }, radius: 3 },
      { id: 'over', type: 'line', y: 50 },
    ] })
    assert.equal(doc.schemaVersion, 5)
    assert.equal(designs.getDesign(doc.id, 1).layers[1].variable, true)
    assert.match(layout.renderDesign(doc, { showPhotoPlaceholder: true }).html, /变量图/)
    assert.throws(() => layout.renderDesign(doc, { requirePhotos: true }), /未关联照片/)
    assert.throws(() => layout.normalizeDesign({ ...doc, layers: [{ ...doc.layers[1], bindColumn: '' }] }), /绑定/)
    assert.throws(() => require('../electron/design-export.cjs').prepareExport({ design: doc }), /变量图/)
    const pk = require('../electron/design-package.cjs')
    const targetPath = path.join(tmp, 'portrait.ppdesign')
    pk.exportPackage({ id: doc.id, revision: 1, targetPath })
    const inspected = await pk.inspectPackage(targetPath)
    const copied = pk.commitPackage(inspected.token)
    assert.ok(copied)
    const print = require('../electron/print.cjs')
    const templates = require('../electron/templates.cjs')
    const base = { name: '人像证卡', datasetId: args.datasetId, pageSize: { id: 'custom', w: 90, h: 60 }, backgroundDesign: { id: doc.id, revision: 1 }, fields: [] }
    const tpl = templates.saveTemplate(base)
    const built = print.buildBatchHtml(args.datasetId, tpl.id, [0, 1, 4])
    assert.equal(built.recordCount, 3)
    assert.equal(built.photoAssets.length, 2)
    assert.equal((built.html.match(/data-photo-column=/g) || []).length, 3)
    assert.match(built.html, /object-fit:contain;object-position:20% 40%/)
    assert.ok(built.html.indexOf('data-design-layer="under"') < built.html.indexOf('data-design-layer="portrait"'))
    assert.ok(built.html.indexOf('data-design-layer="portrait"') < built.html.indexOf('data-design-layer="over"'))
    assert.throws(() => print.buildBatchHtml(args.datasetId, tpl.id), /第 3 行/)
    const grid = templates.saveTemplate({ ...base, name: '拼版', pageSize: 'a4-portrait', layout: { mode: 'grid', itemW: 90, itemH: 60 } })
    assert.equal((print.buildBatchHtml(args.datasetId, grid.id, [0, 1, 4]).html.match(/data-photo-column=/g) || []).length, 3)
    const fold = templates.saveTemplate({ ...base, name: '对折', pageSize: { id: 'custom', w: 90, h: 120 }, layout: { mode: 'fold' } })
    assert.equal((print.buildBatchHtml(args.datasetId, fold.id, [0]).html.match(/data-photo-column=/g) || []).length, 2)
    const archived = path.join(tmp, 'dynamic-archive')
    fs.mkdirSync(archived)
    const html = output.archivePhotos(archived, built.snapshotHtml, built.photoAssets)
    assert.ok(!html.includes('pp://media/'))
    assert.equal(fs.readdirSync(path.join(archived, 'photos')).length, 2)
  })
  await check('符号链接目录不进入扫描结果；受控原件不随目录外照片导入', () => {
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.jpg'), jpg)
    fs.symlinkSync(outside, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const scanned = photos.scanFolder(folder)
      assert.ok(scanned.ignored.some(f => f.name === 'linked'))
      assert.ok(!scanned.files.some(f => f.name.includes('secret')))
      assert.throws(() => photos.scanFolder(path.join(folder, 'linked')))
    } finally { fs.unlinkSync(path.join(folder, 'linked')) }
  })
  await check('读取原件时识别被删/被篡改的照片，不复用旧的匹配成功状态', async () => {
    const asset = designs.assetInfo(report.results[0].assetId)
    const target = path.join(process.env.PRINTPRESS_DATA_DIR, asset.path)
    fs.writeFileSync(target, Buffer.from('changed'))
    assert.equal((await photos.report(args)).results[0].status, 'broken')
    fs.unlinkSync(target)
    assert.equal((await photos.report(args)).results[0].status, 'broken')
    fs.writeFileSync(target, jpg)
    assert.equal((await photos.report(args)).results[0].status, 'matched')
  })
  await check('导入中断或目标数据集消失时不发布新绑定；并发导入明确拒绝', async () => {
    const before = store.loadJson('photo-bindings')
    await assert.rejects(photos.importFolder({ ...args, folder }, { onProgress: () => { throw new Error('test interrupted') } }), /interrupted/)
    assert.deepEqual(store.loadJson('photo-bindings'), before)
    const taskId = crypto.randomUUID()
    await assert.rejects(photos.importFolder({ ...args, folder, taskId }, {
      onCheckpoint: phase => { if (phase === 'after-assets-staged') throw new Error('simulated crash before publish') },
    }), /simulated crash/)
    assert.deepEqual(store.loadJson('photo-bindings'), before, '发布前故障不改变旧绑定')
    assert.equal(photos.listTasks(args.datasetId)[0].state, 'rolled-back', '任务日志记录发布前回滚结果')

    const crashTaskId = crypto.randomUUID()
    const crash = spawnSync(process.execPath, [path.join(__dirname, 'helpers/photo-import-crash.cjs'), args.datasetId, args.column, folder, crashTaskId], {
      env: process.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    assert.equal(crash.status, 73, `子进程在提交前被强制终止：${crash.stderr || crash.error?.message || ''}`)
    assert.ok(fs.existsSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'photo-import-staging', 'active.lock')), '模拟强退留下任务锁供启动恢复识别')
    const crashRecovery = photos.recoverPendingImports()
    assert.ok(crashRecovery.rolledBack.includes(crashTaskId), '下一次启动恢复回滚强退任务')
    assert.deepEqual(store.loadJson('photo-bindings'), before, '进程强退后旧绑定保持完整')
    assert.ok(!fs.existsSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'photo-import-staging', 'active.lock')), '恢复后释放过期任务锁')

    const recoveryTaskId = crypto.randomUUID()
    await assert.rejects(photos.importFolder({ ...args, folder, taskId: recoveryTaskId }, {
      onCheckpoint: phase => { if (phase === 'after-publish') throw new Error('simulated crash after publish') },
    }), /simulated crash/)
    assert.equal(photos.listTasks(args.datasetId)[0].state, 'published-recovery-pending', '提交后的中断留下可恢复任务')
    const recovery = photos.recoverPendingImports()
    assert.ok(recovery.recovered.includes(recoveryTaskId), '启动恢复识别已发布任务并完成素材状态收尾')
    assert.equal(photos.listTasks(args.datasetId)[0].state, 'recovered', '恢复结果可查询')

    const lockPath = path.join(process.env.PRINTPRESS_DATA_DIR, 'photo-import-staging', 'active.lock')
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ taskId: 'other-process-task', pid: process.pid }))
    await assert.rejects(photos.importFolder({ ...args, folder }), /另一进程/)
    assert.ok(fs.existsSync(lockPath), '拒绝并发时不移除另一进程的锁')
    assert.equal(photos.recoverPendingImports().deferred, true, '存在活动导入时不并发执行其他任务的恢复清理')
    fs.unlinkSync(lockPath)

    const pending = photos.importFolder({ ...args, folder })
    await assert.rejects(photos.importFolder({ ...args, folder }), /已有照片/)
    await pending
    const saved = store.loadJson('datasets')
    const beforeDeletion = store.loadJson('photo-bindings')
    await assert.rejects(photos.importFolder({ ...args, folder }, { onProgress: () => store.saveJson('datasets', []) }), /不存在|找不到/)
    assert.deepEqual(store.loadJson('photo-bindings'), beforeDeletion)
    store.saveJson('datasets', saved)
  })
  await check('默认补图保留旧匹配；显式替换才重建照片清单', async () => {
    const replacement = path.join(tmp, 'replacement')
    fs.mkdirSync(replacement)
    fs.writeFileSync(path.join(replacement, '部门照.png'), png)
    const oldReport = await photos.report(args)
    const oldMatched = oldReport.counts.matched
    const old001 = oldReport.results.find(row => row.name === '001.jpeg').assetId
    const rowIndex = dataset.addRow(args.datasetId).rowIndex
    dataset.updateCell(args.datasetId, rowIndex, 'photo', 'new-photo')
    const supplementFolder = path.join(tmp, 'supplement')
    fs.mkdirSync(supplementFolder)
    fs.writeFileSync(path.join(supplementFolder, '001.png'), png) // 同名但内容不同，补充时保留旧图
    fs.writeFileSync(path.join(supplementFolder, 'new-photo.jpg'), jpg)
    const supplemented = await photos.importFolder({ ...args, folder: supplementFolder })
    assert.equal(supplemented.counts.matched, oldMatched + 1, '只为新增缺图记录补入照片')
    assert.equal(supplemented.results[rowIndex].status, 'matched', '新匹配项自动显示为已匹配')
    assert.equal(supplemented.results.find(row => row.name === '001.jpeg').assetId, old001, '同名异内容时保留既有照片')
    assert.ok(supplemented.ignored.some(f => /保留旧图/.test(f.reason)), '补充报告说明冲突文件被保留')
    const afterSupplement = fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).filter(f => /\.(png|jpg)$/.test(f)).length
    await photos.importFolder({ ...args, folder: supplementFolder })
    assert.equal(fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).filter(f => /\.(png|jpg)$/.test(f)).length, afterSupplement,
      '重复补图复用同一原件，不重复增长资源')

    const beforeReplace = await photos.report(args)
    const replacePlan = await photos.previewImport({ ...args, folder: replacement, mode: 'replace' })
    assert.equal(replacePlan.counts.remove, new Set(beforeReplace.files.map(file => require('../electron/photo-match.cjs').photoKey(file.name))).size,
      '替换预览包含将被移除的旧关联')
    const res = await photos.importFolder({ ...args, folder: replacement, mode: 'replace' })
    assert.equal(res.counts.matched, 0)
    assert.equal(res.files.length, 0)
    assert.ok(res.ignored.some(f => f.name === '部门照.png'))
    assert.equal(designs.assetBytes(report.results[0].assetId).buffer.length, jpg.length)
    await photos.importFolder({ ...args, folder })
  })
  await check('归档按内容去重复制原件，并改为可移动的相对 URL', () => {
    const assetId = report.results[0].assetId
    const url = output.photoUrl(assetId)
    const job = path.join(tmp, 'archive-job')
    fs.mkdirSync(job)
    const html = output.archivePhotos(job, `<img src="${url}"><div style="background-image:url('${url}')"></div>`, [assetId, assetId])
    assert.ok(!html.includes('pp://'))
    const name = fs.readdirSync(path.join(job, 'photos'))
    assert.equal(name.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(job, 'photos', name[0])), jpg)
    assert.ok(html.includes('photos/' + name[0]))
    assert.throws(() => output.archivePhotos(job, `<img src="${url}">`, []), /清单不完整/)
    assert.throws(() => output.photoUrl('../file'), /无效/)
    const failed = path.join(tmp, 'archive-failed')
    fs.mkdirSync(failed)
    assert.throws(() => output.archivePhotos(failed, 'test', [assetId, id]))
    assert.ok(!fs.existsSync(path.join(failed, 'photos')))
  })
  await check('API 写权限、目录对话框取消、报告只读与参数边界', async () => {
    assert.throws(() => api.call('photo:importFolder', { ...args, folder }, {}), err => err.code === 'WRITE_FORBIDDEN')
    assert.throws(() => api.call('photo:importDialog', args, { allowWrite: true }), err => err.code === 'GUI_REQUIRED')
    assert.deepEqual(await api.call('photo:importDialog', args, { allowWrite: true, dialog: { openFile: async () => ({ canceled: true }) } }), { canceled: true })
    const beforePreview = fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).filter(f => /\.(png|jpg)$/.test(f)).length
    const selection = await api.call('photo:importDialog', { ...args, mode: 'append' }, {
      allowWrite: true, dialog: { openFile: async () => ({ canceled: false, filePaths: [folder] }) },
    })
    assert.ok(selection.token && selection.preview.mode === 'append' && selection.preview.counts.same > 0, '目录预检返回内容与合并计划')
    assert.equal(fs.readdirSync(path.join(process.env.PRINTPRESS_DATA_DIR, 'design-assets')).filter(f => /\.(png|jpg)$/.test(f)).length, beforePreview,
      '预检阶段不写入照片原件')
    assert.ok((await api.call('photo:cancelSelection', { token: selection.token }, { allowWrite: true })).canceled, '取消预检凭证不入库')
    const selectedAgain = await api.call('photo:importDialog', { ...args, mode: 'append' }, {
      allowWrite: true, dialog: { openFile: async () => ({ canceled: false, filePaths: [folder] }) },
    })
    const selectedResult = await api.call('photo:commitSelection', { token: selectedAgain.token, taskId: crypto.randomUUID() }, { allowWrite: true })
    assert.ok(selectedResult.report.counts.matched > 0, '确认后使用受控凭证执行照片导入')
    await assert.rejects(api.call('photo:commitSelection', { token: selectedAgain.token, taskId: crypto.randomUUID() }, { allowWrite: true }), /过期/)
    assert.equal((await api.call('photo:report', args)).total, 6, '增补名单行后报告使用当前行数')
    assert.deepEqual(api.call('photo:tasks', { datasetId: args.datasetId }, {}), photos.listTasks(args.datasetId), '任务查询接口只读返回持久化状态')
    assert.equal((await photos.report({ ...args, column: 'absent' })).column, 'photo', '当前配图列是权威选择，不使用模板旧字段')
  })
  await check('实际任务留痕写入照片目录，清单缺失不能记录为成功快照', () => {
    const print = require('../electron/print.cjs')
    const assetId = report.results[0].assetId
    const snapshotHtml = `<img src="${output.photoUrl(assetId)}">`
    const job = print.createJob({ status: 'ok', snapshotHtml, photoAssets: [assetId], recordCount: 1 })
    const snapshot = path.join(process.env.PRINTPRESS_DATA_DIR, job.snapshot)
    assert.ok(fs.readFileSync(snapshot, 'utf8').includes('photos/'))
    assert.equal(fs.readdirSync(path.join(path.dirname(snapshot), 'photos')).length, 1)
    assert.equal(print.deleteJob(job.id).archiveRemoved, true)
    assert.ok(!fs.existsSync(path.dirname(snapshot)))
    assert.deepEqual(designs.assetBytes(assetId).buffer, jpg)
    assert.throws(() => print.createJob({ status: 'ok', snapshotHtml, recordCount: 1 }), /清单不完整/)
  })
  await check('照片绑定直接参与引用审计，即使素材库条目被移除也不会误删原件', () => {
    const assetId = report.results.find(item => item.status === 'matched').assetId
    const info = designs.assetInfo(assetId)
    store.saveJson('asset-library', store.loadJson('asset-library').filter(entry => entry.assetId !== assetId))
    const removal = library.removeImportAssetIfUnreferenced(assetId)
    assert.equal(removal.removed, false)
    assert.ok(library.referencedAssetIds().has(assetId))
    assert.ok(fs.existsSync(path.join(process.env.PRINTPRESS_DATA_DIR, info.path)))
  })
  await check('任务历史溢出改归档，不再静默销毁（I-55）', () => {
    // 任务 id 必须是 36 位 [a-f0-9-]（taskPath 会校验），所以种子也用合法形状
    const seedId = (i) => `${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`
    const seed = (n) => Array.from({ length: n }, (_, i) => ({
      taskId: seedId(i), datasetId: 'd', column: '照片', state: 'done',
      createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    const task = (folderName) => ({ datasetId: 'd', column: '照片', state: 'done', binding: { folderName } })
    const archivePath = path.join(process.env.PRINTPRESS_DATA_DIR, `${photos.TASK_HISTORY_ARCHIVE}.json`)
    try { fs.unlinkSync(archivePath) } catch { /* 首次运行本来就没有 */ }

    // 满 100 条时再写一条：被挤出的那条必须进归档，而不是消失
    store.saveJson(photos.TASK_HISTORY, seed(photos.TASK_HISTORY_LIMIT))
    photos.saveTask(first, task('一班'))
    const list = store.loadJson(photos.TASK_HISTORY, { expect: 'array' })
    const archive = store.loadJson(photos.TASK_HISTORY_ARCHIVE, { expect: 'array' })
    assert.equal(list.length, photos.TASK_HISTORY_LIMIT, '界面列表仍只留最近 100 条')
    assert.equal(list[0].taskId, first, '新记录在最前')
    assert.deepEqual(archive.map(item => item.taskId), [seedId(99)], '被挤出的那一条进了归档')
    assert.equal(archive[0].state, 'done', '归档存的是摘要（与列表同一份形状）')

    // 重复写同一个任务不得在归档里堆重复；归档自身也有上限
    photos.saveTask(first, task('一班'))
    assert.equal(store.loadJson(photos.TASK_HISTORY_ARCHIVE, { expect: 'array' }).length, 1, '同一 taskId 不重复归档')
    store.saveJson(photos.TASK_HISTORY_ARCHIVE, seed(photos.TASK_HISTORY_ARCHIVE_LIMIT + 50))
    store.saveJson(photos.TASK_HISTORY, seed(photos.TASK_HISTORY_LIMIT))
    photos.saveTask(second, task(''))
    assert.equal(store.loadJson(photos.TASK_HISTORY_ARCHIVE, { expect: 'array' }).length,
      photos.TASK_HISTORY_ARCHIVE_LIMIT, '归档保留上限，不无上限增长')
  })
  console.log(`${passed} photo acceptance groups passed`)
}
run().catch(err => { console.error(err); process.exitCode = 1 }).finally(() => rmDeep(tmp))

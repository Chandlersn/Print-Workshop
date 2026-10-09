/** Domain acceptance: original bytes, revisions, write failures, and hostile input. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { rmDeep } = require('./helpers/rm.cjs')
const root = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-designs-'))
process.env.PRINTPRESS_DATA_DIR = tmp
const designs = require('../electron/designs.cjs')
const layout = require('../electron/design-layout.cjs')
const store = require('../electron/store.cjs')
const fonts = require('../electron/fonts.cjs')
const api = require('../electron/api.cjs')
let passed = 0
function check(name, run) { run(); passed++; console.log(`  ok - ${name}`) }
const png = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png'))
let asset, first, second
function draft() {
  return { schemaVersion: 1, revision: 0, name: '证书底图', artboard: { w: 297, h: 210, background: '#ffffff' }, assets: { [asset.id]: asset }, layers: [
    { id: 'image1', type: 'image', assetId: asset.id, x: 5, y: 10, w: 50, h: 40, rotation: 12, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, flipX: true },
    { id: 'text1', type: 'text', text: '结业证书\n<script>alert(1)</script>', fontFamily: '底图专用测试字体', x: 10, y: 10, w: 120, h: 20 },
    { id: 'shape1', type: 'rect', x: 1, y: 1, w: 295, h: 208, fill: 'transparent', stroke: '#112233', strokeWidth: 0.2 },
  ] }
}
try {
  check('素材保留原始字节，按内容去重，扩展名以内容为准', () => {
    asset = designs.importImageBytes({ name: '改名.jpg', base64: png.toString('base64') })
    assert.equal(asset.mime, 'image/png')
    assert.deepEqual(fs.readFileSync(path.join(tmp, asset.path)), png)
    assert.equal(designs.importImageBytes({ name: '重复.png', base64: png.toString('base64') }).id, asset.id)
  })
  check('无数据集也能保存；重开保留完整图层属性', () => {
    fs.writeFileSync(path.join(fonts.fontUploadDir(), '底图专用测试字体.ttf'), 'fixture')
    const input = draft()
    first = designs.saveDesign(input)
    assert.equal(input.revision, 0)
    assert.equal(input.id, undefined)
    assert.equal(first.revision, 1)
    assert.deepEqual(first.fontAssets, { '底图专用测试字体': '底图专用测试字体.ttf' })
    assert.deepEqual(designs.getDesign(first.id), first)
    assert.equal(first.layers[0].crop.x, 0.1)
    assert.equal(designs.listDesigns()[0].layerCount, 3)
  })
  check('已退出进程留下的保存锁自动恢复，活进程锁不会被删除', () => {
    const lock = path.join(tmp, 'designs.write.lock')
    const crash = spawnSync(process.execPath, ['-e', "const fs=require('fs'),p=require('path'); const d=p.join(process.env.PRINTPRESS_DATA_DIR,'designs.write.lock');fs.mkdirSync(d);fs.writeFileSync(p.join(d,process.pid+'-aabbcc.json'),JSON.stringify({pid:process.pid,createdAt:Date.now()}));process.exit(0)"], { env: process.env, encoding: 'utf8' })
    assert.equal(crash.status, 0, crash.stderr)
    assert.ok(designs.saveDesign(draft()).id)
    assert.equal(fs.existsSync(lock), false)
    fs.mkdirSync(lock)
    const owner = path.join(lock, `${process.pid}-aabbcc.json`)
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    try {
      assert.throws(() => designs.saveDesign(draft()), /另一个进程/)
      assert.equal(fs.existsSync(owner), true)
    } finally { fs.unlinkSync(owner); fs.rmdirSync(lock) }
  })
  check('JPEG EXIF 方向 5–8 使用转置后的宽高，方向 3 保持宽高且原字节不变', () => {
    const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg'))
    const base = designs.importImageBytes({ name: 'base.jpg', base64: jpeg.toString('base64') })
    assert.equal(base.width, 2)
    assert.equal(base.height, 3)
    for (const orientation of [3, 5, 6, 7, 8]) {
      // Real 2x3 JPEG plus a standard little-endian TIFF IFD0 orientation tag.
      const exif = Buffer.from('45786966000049492a0008000000010012010300010000000100000000000000', 'hex')
      exif.writeUInt16LE(orientation, 24)
      const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(exif.length + 2, 2)
      const oriented = Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)])
      const uploaded = designs.importImageBytes({ name: `rotate-${orientation}.jpg`, base64: oriented.toString('base64') })
      assert.equal(uploaded.width, orientation >= 5 ? 3 : 2)
      assert.equal(uploaded.height, orientation >= 5 ? 2 : 3)
      assert.deepEqual(fs.readFileSync(path.join(tmp, uploaded.path)), oriented)
      assert.ok(Math.abs(layout.imageDpi({ w: uploaded.width * 25.4, h: uploaded.height * 25.4 }, uploaded) - 1) < 1e-9)
    }
  })
  check('新版本不可改变模板固定的旧版本，旧编辑器保存产生冲突', () => {
    second = designs.saveDesign({ ...first, name: '第二版', layers: first.layers.filter(l => l.type !== 'text') })
    assert.equal(second.revision, 2)
    assert.equal(designs.resolveDesign({ id: first.id, revision: 1 }).name, '证书底图')
    assert.equal(designs.getDesign(first.id).name, '第二版')
    assert.throws(() => designs.saveDesign(first), err => err.code === 'DESIGN_CONFLICT')
    assert.throws(() => designs.resolveDesign({ id: first.id }), /版本/)
    assert.throws(() => designs.getDesign(first.id, 3), /版本/)
  })
  check('索引写入失败时旧工程仍完整可读，重试可成功', () => {
    const rename = fs.renameSync
    fs.renameSync = function (from, to) {
      if (to === path.join(tmp, 'designs.json')) throw new Error('模拟磁盘故障')
      return rename.apply(this, arguments)
    }
    try { assert.throws(() => designs.saveDesign({ ...second, name: '失败版本' }), /模拟磁盘故障/) } finally { fs.renameSync = rename }
    assert.deepEqual(designs.getDesign(first.id), second)
    assert.equal(fs.existsSync(path.join(tmp, 'designs', first.id, '3.json')), false)
    second = designs.saveDesign({ ...second, name: '重试成功' })
    assert.equal(second.revision, 3)
  })
  check('路径、缺少素材、伪造素材元信息、无效数值与内容都会被检查', () => {
    assert.throws(() => designs.getDesign('../templates'), /标识/)
    assert.throws(() => designs.saveDesign({ ...draft(), assets: { [asset.id]: { ...asset, path: '../secret.png' } } }), /路径/)
    assert.throws(() => designs.saveDesign({ ...draft(), assets: {} }), /缺少素材/)
    assert.equal(designs.saveDesign({ ...draft(), assets: { [asset.id]: { ...asset, width: 9999 } } }).assets[asset.id].width, asset.width)
    assert.throws(() => layout.normalizeDesign({ ...draft(), artboard: { w: Infinity, h: 210 } }), /范围/)
    assert.throws(() => layout.normalizeDesign({ ...draft(), artboard: { w: '', h: 210 } }), /范围/)
    assert.throws(() => layout.normalizeDesign({ ...draft(), layers: [{ ...draft().layers[0], crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }] }), /裁切/)
    assert.throws(() => layout.normalizeDesign({ ...draft(), schemaVersion: 99 }), /版本/)
    assert.throws(() => designs.importImageBytes({ base64: png.subarray(0, 30).toString('base64') }), /PNG/)
    assert.throws(() => designs.importImageBytes({ base64: '%%%%' }), /base64/)
    const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1
    assert.throws(() => designs.importImageBytes({ base64: corrupt.toString('base64') }), /校验/)
  })
  check('版本目录符号链接不能跨出数据目录读取工程', () => {
    const projectDir = path.join(tmp, 'designs', first.id)
    const backup = projectDir + '.original'
    const outside = fs.mkdtempSync(path.join(__dirname, '.tmp-designs-external-'))
    fs.renameSync(projectDir, backup)
    try {
      fs.copyFileSync(path.join(backup, '1.json'), path.join(outside, '1.json'))
      fs.symlinkSync(outside, projectDir, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => designs.getDesign(first.id, 1), /越界/)
    } finally {
      if (fs.existsSync(projectDir)) fs.unlinkSync(projectDir)
      fs.renameSync(backup, projectDir)
      assert.equal(path.dirname(outside), __dirname)
      assert.ok(path.basename(outside).startsWith('.tmp-designs-external-'))
      rmDeep(outside)
    }
  })
  check('素材和版本根目录 junction 出界时读写均拒绝，外部目录不产生文件', () => {
    for (const directory of ['design-assets', 'designs']) {
      const linkedRoot = path.join(tmp, directory)
      const backup = linkedRoot + '.original'
      const outside = fs.mkdtempSync(path.join(__dirname, '.tmp-designs-external-'))
      fs.renameSync(linkedRoot, backup)
      try {
        if (directory === 'design-assets') {
          const hash = asset.id.slice('asset_'.length)
          fs.copyFileSync(path.join(backup, `${hash}.json`), path.join(outside, `${hash}.json`))
          fs.copyFileSync(path.join(backup, path.basename(asset.path)), path.join(outside, path.basename(asset.path)))
        } else {
          fs.mkdirSync(path.join(outside, first.id))
          fs.copyFileSync(path.join(backup, first.id, '1.json'), path.join(outside, first.id, '1.json'))
        }
        fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
        assert.throws(() => designs.getDesign(first.id, 1), /越界/)
        const before = fs.readdirSync(outside).sort()
        if (directory === 'design-assets') {
          const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg'))
          assert.throws(() => designs.importImageBytes({ name: 'outside.jpg', base64: jpeg.toString('base64') }), /越界/)
        } else {
          assert.throws(() => designs.saveDesign({ name: '不得写出目录', artboard: { w: 100, h: 100 }, layers: [], assets: {} }), /越界/)
        }
        assert.deepEqual(fs.readdirSync(outside).sort(), before)
      } finally {
        if (fs.existsSync(linkedRoot)) fs.unlinkSync(linkedRoot)
        fs.renameSync(backup, linkedRoot)
        assert.equal(path.dirname(outside), __dirname)
        assert.ok(path.basename(outside).startsWith('.tmp-designs-external-'))
        rmDeep(outside)
      }
    }
  })
  check('原始素材被改动或缺失时拒绝静默生成空底图', () => {
    const file = path.join(tmp, asset.path)
    fs.writeFileSync(file, Buffer.concat([png, Buffer.from('changed')]))
    assert.throws(() => designs.getDesign(first.id), /原件已改变/)
    fs.writeFileSync(file, png)
    fs.renameSync(file, file + '.hidden')
    try { assert.throws(() => designs.getDesign(first.id), /ENOENT/) } finally { fs.renameSync(file + '.hidden', file) }
  })
  check('图片链接只写入 CSS 一次，文本安全转义且坐标为毫米', () => {
    const d = draft()
    d.layers.push({ ...d.layers[0], id: 'duplicate-image' })
    const result = layout.renderDesign(d, { assetUrl: () => 'data:image/png;base64,' + png.toString('base64'), classPrefix: 'fixture' })
    assert.equal(result.css.split('data:image/png').length - 1, 1)
    assert.equal(result.html.includes('data:image/png'), false)
    assert.equal(result.html.includes('<script>'), false)
    assert.match(result.html, /&lt;script&gt;/)
    assert.match(result.html, /left:5mm/)
    assert.match(result.html, /<svg /)
    assert.match(result.html, /scale\(-1,1\)/)
    assert.deepEqual(result.fontFamilies, ['底图专用测试字体'])
    assert.ok(Math.abs(layout.imageDpi({ w: 25.4, h: 25.4, crop: { w: 0.5, h: 1 } }, { width: 600, height: 600 }) - 300) < 0.001)
    const hostile = layout.renderDesign(d, { assetUrl: () => '</style><script>bad</script>' })
    assert.equal(hostile.css.includes('</style>'), false)
  })
  check('转换旧底图复制原件，旧文件删除不破坏新工程', () => {
    fs.mkdirSync(path.join(tmp, 'print-bg'))
    fs.writeFileSync(path.join(tmp, 'print-bg/legacy.png'), png)
    const converted = designs.importLegacyBackground({ background: 'print-bg/legacy.png', w: 200, h: 100, name: '旧模板' })
    assert.equal(converted.layers[0].locked, true)
    assert.equal(converted.revision, 0)
    fs.unlinkSync(path.join(tmp, 'print-bg/legacy.png'))
    assert.equal(designs.saveDesign(converted).layers[0].w, 200)
    assert.throws(() => designs.importLegacyBackground({ background: '../x.png', w: 100, h: 100 }), /路径/)
  })
  check('已保存历史版本仍保护上传字体，删除引用工程前不可删除字体', () => {
    fs.mkdirSync(fonts.fontUploadDir(), { recursive: true })
    fs.writeFileSync(path.join(fonts.fontUploadDir(), '底图专用测试字体.ttf'), 'fixture')
    assert.ok(designs.fontUsedBy('底图专用测试字体').some(name => name.includes('版本 1')))
    assert.throws(() => fonts.deleteFont('底图专用测试字体.ttf'), /底图工程/)
  })
  check('上传字体被外部删除时，旧版本读取和新保存都明确拒绝回退', () => {
    const copy = designs.saveDesign({ ...first, id: undefined, revision: 0 })
    const file = path.join(fonts.fontUploadDir(), '底图专用测试字体.ttf')
    fs.renameSync(file, file + '.hidden')
    try {
      assert.throws(() => designs.getDesign(first.id, 1), /上传字体缺失/)
      const latest = designs.getDesign(first.id)
      assert.equal(latest.layers.some(layer => layer.type === 'text'), false)
      assert.throws(() => designs.saveDesign({ ...first, id: undefined, revision: 0 }), /上传字体缺失/)
      assert.throws(() => designs.saveDesign({ ...copy, fontAssets: {} }), /上传字体缺失/)
    } finally { fs.renameSync(file + '.hidden', file) }
  })
  check('另存副本更换字体时更新元信息，移除文字仅移除新版本字体引用', () => {
    fs.writeFileSync(path.join(fonts.fontUploadDir(), '另一字体.ttf'), 'fixture')
    const changed = { ...first, id: undefined, revision: 0, layers: first.layers.map(layer => layer.type === 'text' ? { ...layer, fontFamily: '另一字体' } : layer) }
    const copy = designs.saveDesign(changed)
    assert.deepEqual(copy.fontAssets, { '另一字体': '另一字体.ttf' })
    const noText = designs.saveDesign({ ...copy, layers: copy.layers.filter(layer => layer.type !== 'text') })
    assert.deepEqual(noText.fontAssets, {})
    assert.deepEqual(designs.getDesign(copy.id, 1).fontAssets, { '另一字体': '另一字体.ttf' })
    assert.throws(() => fonts.deleteFont('另一字体.ttf'), /底图工程/)
  })
  check('模板引用阻止删除，移除引用后可删除且素材仍保留', () => {
    store.saveJson('templates', [{ id: 'fixture', name: '验收模板', backgroundDesign: { id: first.id, revision: 1 } }])
    assert.throws(() => designs.deleteDesign(first.id), /验收模板/)
    store.saveJson('templates', [])
    designs.deleteDesign(first.id)
    assert.throws(() => designs.getDesign(first.id), /不存在/)
    assert.equal(fs.existsSync(path.join(tmp, asset.path)), true)
  })
  check('API 在纯 Node 中可用，并执行写入权限与 IPC 参数映射', () => {
    assert.throws(() => api.call('design:save', { design: draft() }), /写权限/)
    const saved = api.call('design:save', { design: draft() }, { allowWrite: true })
    assert.equal(api.call('design:get', { id: saved.id, revision: 1 }).id, saved.id)
    const mapping = api.ipcTable().find(op => op.name === 'design:get').fromIpc
    assert.deepEqual(mapping(saved.id, 1), { id: saved.id, revision: 1 })
    const child = spawnSync(process.execPath, ['-e', "const d=require('./electron/designs.cjs'); const docs=d.listDesigns(); if(!docs.length || !d.getDesign(docs[0].id).layers.length)process.exit(2)"], { cwd: root, env: process.env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
  })
  console.log(`\n${passed} design domain acceptance groups passed`)
} finally {
  const relative = path.relative(__dirname, tmp)
  if (!relative.startsWith('.tmp-designs-') || relative.includes(path.sep)) throw new Error('测试目录清理路径不安全')
  rmDeep(tmp)
}

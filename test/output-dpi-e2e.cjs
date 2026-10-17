/**
 * 出片分辨率的**像素级**证明（契约 I-49）——要真 Electron 与 nativeImage。
 *
 * 分工：
 * - `test/output-dpi.cjs`（纯模块）证明「算得对」：档位、毫米换算、EXIF 换轴、命名、静态接线。
 * - 本套件证明「真的有用、且没转错」：同样一张照片，按原图出片 vs 按 300dpi 出片，
 *   **真实 PDF 字节数**差多少；以及 O=6 竖拍原件降采样后的**存储尺寸与 EXIF 方向**。
 *
 * 为什么不挂在 photo-e2e 里：那边要先走完一长串界面流程（且它在本机环境的
 * `moved-archive` 一步会稳定失败），本套件刻意做成**自包含**——只用领域 API 造数据，
 * 不依赖任何界面状态，因此能在任何环境下独立跑、独立定位问题。
 *
 * 运行：node test/helpers/electron-runner.cjs test/output-dpi-e2e.cjs
 */
const { app, protocol, net, nativeImage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
// 临时数据目录放**系统临时区**而不是仓库内：本机沙箱对「非系统临时区」的 rename/unlink
// 有代理拦截（designs 的写锁靠 renameSync 原子获取），放仓库里会让导入阶段直接 EPERM。
// 顺带的好处是这个夹具与仓库解耦，清理由系统回收。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-output-dpi-e2e-'))
const data = path.join(tmp, 'data')
const artifacts = path.join(ROOT, '.workbuddy-ai', 'tmp', 'output-dpi-e2e')
fs.mkdirSync(artifacts, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = data
app.setPath('userData', path.join(tmp, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-breakpad')
app.on('window-all-closed', () => {})
protocol.registerSchemesAsPrivileged([{
  scheme: 'pp',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])
const watchdog = setTimeout(() => { console.error('OUTPUT_DPI_E2E_TIMEOUT'); app.exit(1) }, 240000)

let checks = 0
const ok = (condition, label) => { assert.ok(condition, label); checks++; console.log('  ok -', label) }

/** 确定性伪随机噪点：噪点让 Flate 压不动，PDF 体积才真的随像素数走（用纯色会掩盖差异） */
function noiseJpeg(w, h, quality = 92) {
  const px = Buffer.alloc(w * h * 4)
  let seed = 20261016
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < px.length; i += 4) {
    px[i] = (rnd() * 255) | 0
    px[i + 1] = (rnd() * 255) | 0
    px[i + 2] = (rnd() * 255) | 0
    px[i + 3] = 255
  }
  return nativeImage.createFromBitmap(px, { width: w, height: h }).toJPEG(quality)
}

/** 一张 34×50mm 的纸，铺满一张照片——与 S1 压测用的图框同规格 */
const page = (url) => '<!doctype html><html><head><meta charset="utf-8"><style>'
  + '@page{size:34mm 50mm;margin:0}html,body{margin:0;padding:0}'
  + `img{width:34mm;height:50mm;object-fit:cover;display:block}</style></head><body><img src="${url}"></body></html>`

app.whenReady().then(async () => {
  const designs = require('../electron/designs.cjs')
  const dataset = require('../electron/dataset.cjs')
  const photoLibrary = require('../electron/photo-library.cjs')
  const output = require('../electron/output-dpi.cjs')
  const photoOutput = require('../electron/photo-output.cjs')
  const printer = require('../electron/printer.cjs')

  protocol.handle('pp', async request => {
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname.slice(1))
      return net.fetch(pathToFileURL(path.join(data, rel)).href)
    } catch { return new Response('not found', { status: 404 }) }
  })

  // ---- 造数据：一张 3000×3000 的大图 + 一张存储 1200×800 但 EXIF O=6 的竖拍图 ----
  const folder = path.join(tmp, 'photos')
  fs.mkdirSync(folder, { recursive: true })
  const bigBytes = noiseJpeg(3000, 3000)
  const o6Bytes = output.withOrientation(noiseJpeg(1200, 800), 6)
  fs.writeFileSync(path.join(folder, 'big.jpg'), bigBytes)
  fs.writeFileSync(path.join(folder, 'o6.jpg'), o6Bytes)
  const csv = path.join(tmp, 'people.csv')
  fs.writeFileSync(csv, '\ufeff姓名,照片\n甲,big.jpg\n乙,o6.jpg\n')
  const ds = dataset.importFromFile(csv)
  const detail = dataset.getDataset(ds.id)
  const photoColumn = detail.columns[1].key
  dataset.setPhotoMatchColumn(ds.id, photoColumn)
  await photoLibrary.importFolder({ datasetId: ds.id, column: photoColumn, folder })
  console.log(`  夹具：3000×3000 原件 ${(bigBytes.length / 1048576).toFixed(2)} MB · 存储 1200×800 / O=6 竖拍原件`)

  // records 是**行对象**（与 print.cjs 的 resolveScope 一致），不是匹配列的取值
  const records = detail.rows
  const photos = photoLibrary.prepareRows(ds.id, [photoColumn], records)
  ok(photos.assets.length === 2, '两张照片都完成匹配与入库')

  console.log('== 1. prepareRows 顺手量到的几何：必须是「显示坐标」 ==')
  {
    ok(photos.geometry instanceof Map && photos.geometry.size === 2,
      'prepareRows 返回 geometry（出片分辨率的规划靠它，零额外 I/O）')
    const bigGeo = photos.geometry.get(photos.byRecord.get(records[0])[photoColumn])
    const o6Geo = photos.geometry.get(photos.byRecord.get(records[1])[photoColumn])
    assert.deepEqual({ w: bigGeo.width, h: bigGeo.height, o: bigGeo.orientation }, { w: 3000, h: 3000, o: 1 })
    // 存储是 1200×800，显示是 800×1200 —— 这一条是整个换轴逻辑的上游依据
    assert.deepEqual({ w: o6Geo.width, h: o6Geo.height, o: o6Geo.orientation }, { w: 800, h: 1200, o: 6 })
    ok(true, 'O=6 原件的几何是显示坐标 800×1200（存储 1200×800），orientation=6 一并带出')
  }

  console.log('== 2. 派生件：尺寸与方向都不能错 ==')
  const design = { layers: [{ id: 'l1', variable: true, visible: true, bindColumn: photoColumn, w: 34, h: 50 }] }
  const prepared = output.prepareDerivatives({ design, photos, dpi: 300 })
  {
    ok(prepared.stats.encoded === true && prepared.stats.optimized === 2 && prepared.stats.failed === 0,
      '两张都真的编码了，没有失败降级')
    const relOf = (record) => {
      const url = prepared.urlFor(photos.byRecord.get(records[record === 'big.jpg' ? 0 : 1])[photoColumn])
      assert.ok(url.startsWith('pp://media/photo-out/'), `${record} 应命中派生件`)
      return decodeURIComponent(url.replace('pp://media/', ''))
    }
    const bigSize = nativeImage.createFromBuffer(fs.readFileSync(path.join(data, relOf('big.jpg')))).getSize()
    assert.deepEqual(bigSize, { width: 591, height: 591 })
    ok(true, `3000×3000 → 591×591 存储像素（34×50mm@300dpi 需 402×591，cover 后短边盖住框）`)

    const o6File = relOf('o6.jpg')
    const o6Out = fs.readFileSync(path.join(data, o6File))
    assert.deepEqual(nativeImage.createFromBuffer(o6Out).getSize(), { width: 603, height: 402 })
    ok(true, 'O=6 竖拍原件 → 存储 603×402（显示 402×603），不是把显示坐标当存储坐标算出的 591×887')
    assert.equal(designs.jpegOrientation(o6Out), 6)
    ok(true, '降采样后 EXIF 方向原样保留（丢了会把竖拍照片转错 90°，且界面不会报错）')
    ok(designs.jpegOrientation(fs.readFileSync(path.join(data, relOf('big.jpg')))) === 1,
      'O=1 的原件不写多余的方向标记')
  }

  console.log('== 3. 真实 PDF：降到 300dpi 到底省了多少 ==')
  {
    const bigId = photos.byRecord.get(records[0])[photoColumn]
    const origUrl = `pp://media/${bigId}`
    const derUrl = prepared.urlFor(bigId)
    const pdfOrig = await printer.printToPdfBuffer(page(origUrl), { partition: 'temp:dpi-e2e-orig' })
    const pdfDer = await printer.printToPdfBuffer(page(derUrl), { partition: 'temp:dpi-e2e-300' })
    fs.writeFileSync(path.join(artifacts, 'one-photo-original.pdf'), pdfOrig)
    fs.writeFileSync(path.join(artifacts, 'one-photo-300dpi.pdf'), pdfDer)
    assert.equal((pdfOrig.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1)
    assert.equal((pdfDer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1)
    ok(pdfDer.length < pdfOrig.length, `同一张照片：PDF ${pdfOrig.length} → ${pdfDer.length} 字节（降到 300dpi 后更小）`)
    ok(pdfOrig.length / pdfDer.length > 10,
      `体积差至少一个量级（实测 ${(pdfOrig.length / pdfDer.length).toFixed(1)}×）——这正是「8.5 GB → 0.2 GB」的来源`)
  }

  console.log('== 4. 归档只认原件 URL：所以归档快照必须用原图准备 ==')
  {
    const bigId = photos.byRecord.get(records[0])[photoColumn]
    const archiveDir = path.join(tmp, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    const snapshot = photoOutput.archivePhotos(archiveDir, `<img src="pp://media/${bigId}"><img src="${prepared.urlFor(bigId)}">`, [bigId])
    assert.ok(/photos\/[a-f0-9]{64}\.jpg/.test(snapshot), '原件 URL 被改写成归档内的相对照片文件')
    ok(fs.readdirSync(path.join(archiveDir, 'photos')).length === 1, '归档只收下了原件这一张')
    ok(snapshot.includes('pp://media/photo-out/'),
      '派生件 URL 不在归档的白名单里（photo-output 只认 pp://media/asset_<sha>）——'
      + '所以 print.cjs 必须显式按 outputDpi:null 再准备一份归档工程')
  }

  const result = { checks, artifactDir: artifacts }
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
  console.log('OUTPUT_DPI_E2E_OK', JSON.stringify(result))
}).catch(err => {
  console.error('OUTPUT_DPI_E2E_FAIL', err)
  process.exitCode = 1
}).finally(() => {
  clearTimeout(watchdog)
  app.exit(process.exitCode || 0)
})

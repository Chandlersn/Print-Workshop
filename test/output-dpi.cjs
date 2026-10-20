/**
 * 出片分辨率（按目标 DPI 预降采样照片）验收 —— 契约 I-49。
 *
 * 这套守的是一件「看起来对、其实错得很安静」的事：把照片缩到图框需要的像素。
 * 三处错法都不报错、界面也看不出来，只有拿真图量体积/看方向才发现：
 *
 * 1. **cover 的缩放比算在存储坐标里**。EXIF orientation ≥ 5 时源图宽高是反的，
 *    目标尺寸会被算大（实测：1200×800 / O=6 / 34×50mm 算出 887×591，正确 603×402）——
 *    后果是白白少压一半体积，而每一行代码都「没报错」。
 * 2. **重编码后不写回 EXIF 方向**。nativeImage 忽略方向且丢标记，竖拍照片会被
 *    Chromium 当横图直接画出来（转错 90°），断言不看方向就永远发现不了。
 * 3. **原件被动过**。派生件必须是新文件；归档快照仍要用原件，否则「原件保真」失效。
 *
 * 纯函数套件：像素解算 + EXIF 往返 + 静态核查。真实缩放的像素级证明在
 * `test/output-dpi-e2e.cjs`（要 Electron 与 nativeImage），界面接线在 `test/about-cache-e2e.cjs`。
 *
 * 第 10 节是**契约 I-50 的静态守卫**：降采样范围为什么只覆盖批量照片（固定图片靠 Chromium
 * 去重，不随页数增长），以及那条边界的 tripwire 套件在位。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

// 数据目录必须在 require 领域模块之前定好（store.cjs 在模块加载期 path.join 它）
const DATA = path.join(__dirname, '.tmp-output-dpi')
process.env.PRINTPRESS_DATA_DIR = DATA
rmDeep(DATA)
fs.mkdirSync(DATA, { recursive: true })

const dpi = require('../electron/output-dpi.cjs')
const formats = require('../electron/export-formats.cjs')
const designs = require('../electron/designs.cjs')
const layout = require('../electron/design-layout.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('== I-49 出片分辨率：照片按图框需要的像素预降采样，原件字节一律不动 ==')
console.log('== 1. 档位只有一份权威，且「原图」是一个能表达的档位 ==')
check('出片分辨率档位与画布导出共用同一份 OUTPUT_DPI_VALUES', () => {
  assert.deepEqual([...formats.OUTPUT_DPI_VALUES], [150, 300, 600])
  const exportSource = read('electron/design-export.cjs')
  assert.ok(!/const DPI_VALUES = \[/.test(exportSource), 'design-export 不许再自己定义一份档位')
  assert.ok(/const DPI_VALUES = OUTPUT_DPI_VALUES/.test(exportSource), 'design-export 的档位必须来自权威源')
})
check('normalizeOutputDpi：未指定取默认 300，「原图」用 null 表示', () => {
  assert.equal(formats.DEFAULT_OUTPUT_DPI, 300)
  assert.equal(formats.normalizeOutputDpi(undefined), 300, '未指定 → 默认')
  assert.equal(formats.normalizeOutputDpi(''), 300)
  assert.equal(formats.normalizeOutputDpi(null), null, 'null 恒等于原图')
  assert.equal(formats.normalizeOutputDpi('original'), null)
  assert.equal(formats.normalizeOutputDpi(150), 150)
  assert.equal(formats.normalizeOutputDpi(600), 600)
})
check('非法档位报错，不静默回退（选了 200 被当成 300 是看不见的错）', () => {
  assert.throws(() => formats.normalizeOutputDpi(200), /出片分辨率/)
  assert.throws(() => formats.normalizeOutputDpi(72), /出片分辨率/)
  assert.throws(() => formats.normalizeOutputDpi('huge'), /出片分辨率/)
})

console.log('== 2. 目标像素：图框毫米 → 像素 ==')
check('34×50mm @300dpi = 402×591px（S1 压测用的就是 34×50 图框）', () => {
  assert.deepEqual(dpi.targetPixels(34, 50, 300), { w: 402, h: 591 })
})
check('同一图框换档位按比例走', () => {
  assert.deepEqual(dpi.targetPixels(34, 50, 150), { w: 201, h: 295 })
  assert.deepEqual(dpi.targetPixels(34, 50, 600), { w: 803, h: 1181 })
})
check('极小图框不会算出 0 像素', () => {
  const t = dpi.targetPixels(0.5, 0.5, 150)
  assert.ok(t.w >= 1 && t.h >= 1, '至少 1 像素')
})

console.log('== 3. 降采样决策（最容易算错的地方）==')
const frame = { frameWmm: 34, frameHmm: 50, dpi: 300 }

check('大图该缩，且目标尺寸是「存储坐标」', () => {
  const plan = dpi.planFor({ srcW: 3000, srcH: 3000, orientation: 1, ...frame })
  assert.equal(plan.action, 'resize')
  // 显示坐标 3000×3000，cover 需 402×591 ⇒ scale = max(402/3000, 591/3000) = 0.197
  assert.deepEqual(plan.target, { w: 591, h: 591 }, '方形源图缩到盖住框')
})
check('EXIF O=6（顺时针 90°）：缩放比必须在显示坐标里算，目标再换回存储坐标', () => {
  // 存储 1200×800，显示 800×1200（竖拍）
  const plan = dpi.planFor({ srcW: 1200, srcH: 800, orientation: 6, ...frame })
  assert.equal(plan.action, 'resize')
  // 显示坐标 cover：scale = max(402/800, 591/1200) = 0.5025 ⇒ 显示目标 402×603
  // 换回存储坐标 ⇒ 603×402
  assert.deepEqual(plan.target, { w: 603, h: 402 },
    '用存储坐标算会得到 591×887（算大了一半），这是实测踩过的坑')
})
check('EXIF O=8（逆时针 90°）与 O=6 同样要换轴', () => {
  const plan = dpi.planFor({ srcW: 1200, srcH: 800, orientation: 8, ...frame })
  assert.deepEqual(plan.target, { w: 603, h: 402 })
})
check('EXIF O=1（无方向）：不换轴', () => {
  const plan = dpi.planFor({ srcW: 1200, srcH: 800, orientation: 1, ...frame })
  // 显示 1200×800，cover scale = max(402/1200, 591/800) = 0.7388 ⇒ 887×591
  assert.deepEqual(plan.target, { w: 887, h: 591 })
})
check('只缩不放：源图比目标还小时原样透传（插值放大是假细节）', () => {
  const plan = dpi.planFor({ srcW: 200, srcH: 300, orientation: 1, ...frame })
  assert.equal(plan.action, 'skip')
  assert.equal(plan.reason, 'source-not-larger')
})
check('源图刚好等于目标时不缩（不做无意义的重编码）', () => {
  const plan = dpi.planFor({ srcW: 402, srcH: 591, orientation: 1, ...frame })
  assert.equal(plan.action, 'skip')
})
check('「原图」档位恒不缩', () => {
  const plan = dpi.planFor({ srcW: 6000, srcH: 6000, orientation: 1, frameWmm: 34, frameHmm: 50, dpi: null })
  assert.equal(plan.action, 'skip')
  assert.equal(plan.reason, 'original')
})
check('几何信息缺失时跳过而不是猜', () => {
  assert.equal(dpi.planFor({ srcW: 0, srcH: 3000, ...frame }).reason, 'unknown-geometry')
  assert.equal(dpi.planFor({ srcW: 3000, srcH: 3000, frameWmm: 0, frameHmm: 50, dpi: 300 }).reason, 'unknown-geometry')
})
check('档位越高目标越大（600 比 300 缩得少）', () => {
  const a = dpi.planFor({ srcW: 3000, srcH: 3000, orientation: 1, frameWmm: 34, frameHmm: 50, dpi: 300 })
  const b = dpi.planFor({ srcW: 3000, srcH: 3000, orientation: 1, frameWmm: 34, frameHmm: 50, dpi: 600 })
  assert.ok(b.target.w > a.target.w, '600dpi 的目标像素必须更大')
})

console.log('== 3b. 坐标空间：显示 vs 存储（实测踩过 2.2 倍的坑）==')
check('storageSize：O≥5 换轴，O<5 原样', () => {
  assert.deepEqual(dpi.storageSize(800, 1200, 6), { w: 1200, h: 800 })
  assert.deepEqual(dpi.storageSize(800, 1200, 8), { w: 1200, h: 800 })
  assert.deepEqual(dpi.storageSize(1200, 800, 1), { w: 1200, h: 800 })
  assert.deepEqual(dpi.storageSize(1200, 800, 3), { w: 1200, h: 800 })
})
check('上游事实：designs 记录的宽高是「显示坐标」（导入时已按 EXIF 归正）', () => {
  const src = read('electron/designs.cjs')
  assert.ok(/orientation >= 5 \? \{ width: size\.height, height: size\.width \}/.test(src),
    'designs.validateImage 一旦不再归正 EXIF，本模块的换轴就会变成反向错误——必须同步')
})
check('把 assetInfo 的显示尺寸直接喂给 planFor 会算出 2.2 倍大的目标', () => {
  // 存储 1200×800 / O=6 ⇒ 显示 800×1200。错法：拿 800×1200 当存储坐标喂进去
  const wrong = dpi.planFor({ srcW: 800, srcH: 1200, orientation: 6, ...frame })
  const right = dpi.planFor({ srcW: 1200, srcH: 800, orientation: 6, ...frame })
  assert.deepEqual(right.target, { w: 603, h: 402 }, '正确：603×402')
  assert.deepEqual(wrong.target, { w: 591, h: 887 }, '错法：591×887（纵向还是插值放大）')
  const px = (p) => p.target.w * p.target.h
  assert.ok(px(wrong) / px(right) > 2, '错法的像素数超过正确值的 2 倍，体积收益直接砍半')
})
check('规划时把几何的显示尺寸换成存储尺寸后再调 planFor', () => {
  const src = read('electron/output-dpi.cjs')
  assert.ok(/storageSize\(geo\.width, geo\.height, orientation\)/.test(src),
    '要用 storageSize 显式转换，而不是直接拿 geometry 的宽高当存储尺寸')
  assert.ok(/srcW: storage\.w, srcH: storage\.h/.test(src), 'planFor 要拿到转换后的存储尺寸')
  assert.ok(!/srcW: geo\.width/.test(src), '不许把显示坐标直接当存储坐标传进 planFor')
})

console.log('== 4. 派生件命名与 URL ==')
check('内容寻址：同输入恒同名，尺寸/质量/版本任一变化即换名', () => {
  const id = 'asset_' + 'a'.repeat(64)
  const base = dpi.derivativeName(id, 402, 591)
  assert.equal(base, dpi.derivativeName(id, 402, 591), '确定性')
  assert.notEqual(base, dpi.derivativeName(id, 403, 591))
  assert.notEqual(base, dpi.derivativeName(id, 402, 592))
  assert.notEqual(base, dpi.derivativeName(id, 402, 591, 70), '换质量必须换名')
  assert.ok(/^[a-f0-9]{40}\.jpg$/.test(base), '文件名是定长摘要，不含路径与用户内容')
})
check('派生件落在数据目录内的 photo-out/，且 URL 走 pp://media', () => {
  const rel = dpi.derivativeRel(dpi.derivativeName('asset_' + 'a'.repeat(64), 402, 591))
  assert.ok(rel.startsWith('photo-out/'), '派生件必须在 photo-out/ 下，便于统计与清理')
  const url = dpi.derivativeUrl(rel)
  assert.ok(url.startsWith('pp://media/photo-out/'), '走既有媒体协议，不新增协议')
})
check('原件 URL 仍是 pp://media/asset_<sha>（归档只认这个形式）', () => {
  const id = 'asset_' + 'b'.repeat(64)
  const url = dpi.derivativeUrl(id)
  assert.equal(url, `pp://media/${id}`)
  assert.ok(/^pp:\/\/media\/asset_[a-f0-9]{64}$/.test(url), 'photo-output.archivePhotos 靠这个正则收原件')
})

console.log('== 5. EXIF 方向写回（丢标记 = 竖拍照片转错 90°，且不报错）==')
const minimalJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
check('写回的方向能被 designs.jpegOrientation 读出来（EXIF 解析只有一处权威）', () => {
  assert.equal(designs.jpegOrientation(minimalJpeg), 1, '无 EXIF 时按 1')
  for (const o of [2, 3, 4, 5, 6, 7, 8]) {
    const tagged = dpi.withOrientation(minimalJpeg, o)
    assert.equal(designs.jpegOrientation(tagged), o, `Orientation=${o} 必须原样读回`)
    assert.equal(tagged[0], 0xff, '仍以 SOI 开头')
    assert.equal(tagged[1], 0xd8)
  }
})
check('写回的方向标记插在 SOI 之后、图像数据之前（APP1 位置）', () => {
  const tagged = dpi.withOrientation(minimalJpeg, 6)
  assert.equal(tagged.readUInt16BE(2), 0xffe1, '第三个字节起是 APP1')
  assert.equal(tagged.toString('ascii', 6, 12), 'Exif\0\0')
})

console.log('== 6. 体积模型与支持范围 ==')
check('体积模型是「约」：只保证量级，且导出后会用真实字节覆盖', () => {
  const est = dpi.estimatePdfBytes(402 * 591 * 500)
  assert.ok(est > 0)
  assert.equal(dpi.estimatePdfBytes(0), null)
  assert.equal(dpi.estimatePdfBytes(NaN), null)
  const src = read('electron/photo-output.cjs')
  assert.ok(!/estimatePdfBytes/.test(src), '归档路径不该做体积估算——它只负责原件保真')
})
check('派生件只收 nativeImage 真能解的容器（Electron 28 不解 WebP）', () => {
  assert.deepEqual([...dpi.SUPPORTED_EXTS], ['.jpg', '.jpeg', '.png'])
  assert.ok(!dpi.SUPPORTED_EXTS.includes('.webp'), 'WebP 会解码失败，必须走「保留原件」而不是抛错')
})

console.log('== 6b. 规划与编码分离（预览要零额外 I/O）==')
check('planDerivatives 不读任何原件字节——它只靠 photos.geometry', () => {
  const src = read('electron/output-dpi.cjs')
  const from = src.indexOf('function planDerivatives')
  const body = src.slice(from, src.indexOf('function prepareDerivatives'))
  assert.ok(body.length > 200, '必须能定位到规划函数')
  assert.ok(!/assetBytes|readFileSync|writeDerivative|renderDerivative/.test(body),
    '规划一旦读字节，每次预览就要为 500 张多读 1.85 GB')
})
check('规划报 encoded:false（数字是「预计」），编码后才置 true（「实际」）', () => {
  const src = read('electron/output-dpi.cjs')
  assert.ok(/encoded: false/.test(src), '默认是「未编码」')
  assert.ok(/stats\.encoded = true/.test(src), '编码完成后要翻过来')
})
check('api.cjs：只有预览传 encodeDerivatives:false，出片走默认（真编码）', () => {
  const src = read('electron/api.cjs')
  const hits = src.match(/^\s*encodeDerivatives:\s*false,?\s*$/gm) || []
  assert.equal(hits.length, 1, '只该有一处：预览')
  const gen = src.slice(src.indexOf("'print:generate'"), src.indexOf("'print:exportPdf'"))
  assert.ok(/encodeDerivatives:\s*false/.test(gen), '那一处必须在 print:generate 里')
  assert.ok(/outputDpi:\s*p\.outputDpi/.test(gen), '预览也要收档位（用于体积预估）')
  const exp = src.slice(src.indexOf("'print:exportPdf'"), src.indexOf("'print:send'"))
  assert.ok(/outputDpi:\s*p\.outputDpi/.test(exp), '出片必须把档位传下去')
  assert.ok(!/encodeDerivatives/.test(exp), '出片走默认（真编码）')
})

console.log('== 7. 静态核查：原件保真与架构约束 ==')
check('归档快照必须用原件：snapshotHtml 走的是按「原图」准备的工程', () => {
  const src = read('electron/print.cjs')
  // 归档要留原件表征，所以必须真的存在一份按 outputDpi: null 准备的工程
  assert.ok(/prepareTemplateDesign\(tpl,\s*photos,\s*\{\s*outputDpi:\s*null/.test(src),
    '必须有一份按 outputDpi: null 准备的工程（归档用）')
  const snapshot = /snapshotHtml:\s*renderEngine\.buildHtml\(([\s\S]*?)\),\s*\n/.exec(src)
  assert.ok(snapshot, '必须能定位到 snapshotHtml 的构建处')
  assert.ok(/preparedDesign:\s*archiveDesign/.test(snapshot[1]),
    '归档快照要用按原图准备的那份工程，不能复用出片用的 preparedDesign')
  // 反向确认：出片用的 html 不能被换到归档那份上，否则「降采样」白做
  const outHtml = /html:\s*renderEngine\.buildHtml\(([\s\S]*?)\),\s*\n/.exec(src)
  assert.ok(outHtml, '必须能定位到出片 html 的构建处')
  assert.ok(/preparedDesign/.test(outHtml[1]) && !/archiveDesign/.test(outHtml[1]),
    '出片 html 要用按出片分辨率准备的那份工程，不能换成归档的原件工程')
})
check('output-dpi 不在模块顶层 require electron（领域层要能在纯 Node 下单测）', () => {
  const src = read('electron/output-dpi.cjs')
  // 只看**顶格**声明：函数内缩进的惰性 require 是允许的（与 design-export 同一做法）
  const head = src.split('\n').filter(line => /^(const|let|var)\s/.test(line)).join('\n')
  assert.ok(!/require\(['"]electron['"]\)/.test(head), '顶层不许 require electron')
  assert.ok(/require\(['"]electron['"]\)/.test(src), '但要在缩放时才惰性 require')
})
check('缩放失败必须降级到原件，不能让一张坏图毁掉整批', () => {
  const src = read('electron/output-dpi.cjs')
  assert.ok(/catch/.test(src) && /failed \+= 1/.test(src), '失败要计数')
  assert.ok(/return resolved\.get\(assetId\) \|\| originalUrl\(assetId\)/.test(src), '取不到派生件即回原件')
})
check('同一时刻只持有一张原件的字节（500 张同时驻留就是 1.85 GB）', () => {
  const src = read('electron/output-dpi.cjs')
  const body = src.slice(src.indexOf('function prepareDerivatives'))
  assert.ok(!/buffer\s*\}\s*=\s*new Map|\.set\([^)]*buffer/.test(body), '不许把 buffer 存进集合')
  assert.ok(/assetBytes\(assetId\)/.test(body), '逐张读取')
})

console.log('== 8. 界面接线：档位可关、读数带「约」、导出后用真实字节覆盖 ==')
const view = () => read('src/views/PrintCenterView.vue')
check('打印中心有档位控件，「原图」必须是可选项（可关是契约要求，不是可选功能）', () => {
  const src = view()
  assert.ok(/const outputDpiOptions = \[/.test(src), '档位选项要定义')
  assert.ok(/value: 'original'/.test(src), '「原图」必须能选——「可关」是 I-49 的要求')
  for (const v of ['150', '300', '600']) {
    assert.ok(new RegExp(`value: '${v}'`).test(src), `${v} 档要在选项里`)
  }
  assert.ok(/const outputDpi = ref\('300'\)/.test(src), '默认 300dpi')
})
check('档位进 payload；换档位要重算读数', () => {
  const src = view()
  assert.ok(/outputDpi: outputDpi\.value === 'original' \? 'original' : Number\(outputDpi\.value\)/.test(src),
    'payload 必须带上档位（字符串档位要转成后端认的数字/原图）')
  assert.ok(/watch\(outputDpi, \(\) => rebuildPreview\(\)\)/.test(src), '换档位要刷新体积读数')
})
check('界面读数必须带「约」字（体积是模型不是预言）', () => {
  const src = view()
  const from = src.indexOf('const outputHint')
  const hint = src.slice(from, src.indexOf('function outputResultText'))
  assert.ok(from > 0 && hint.length > 200, '必须能定位到读数实现')
  assert.ok(/约 \$\{formatBytes\(/.test(hint), '估算必须标「约」，否则是在给用户下保证')
  assert.ok(/data-testid="print-output-dpi"/.test(src), '读数要有稳定测试锚点')
  assert.ok(/原图出片/.test(hint), '「原图」档位也要有读数，否则用户不知道当前没压缩')
})
check('读数要短（与页数、缩放挤一行），完整说法放 title', () => {
  const src = view()
  const from = src.indexOf('const outputHint')
  const hint = src.slice(from, src.indexOf('function outputResultText'))
  // 可见文案只用短词；「所选范围照片预计约」这类长句只许出现在 title 里
  assert.ok(/待降采样|已降采样/.test(hint), '降采样进度用短词表达')
  assert.ok(!/text: `[^`]*所选范围照片预计约/.test(hint), '长句不许进可见文案（会把缩放控件顶出去）')
  assert.ok(!/text: `[^`]*暂不提供整批体积预估/.test(hint), '长句不许进可见文案')
  assert.ok(/title:/.test(hint), '短文案必须把完整说法留在 title 里，不能把信息删掉')
  // 底图读数同样是「短文案 + title」
  assert.ok(/data-testid="print-design-dpi"/.test(src), '底图读数要有稳定测试锚点')
  const design = src.slice(src.indexOf('const designHint'), src.indexOf('const outputHint'))
  assert.ok(/最低 \$\{dpi\} dpi/.test(design), '底图读数只报最低 dpi')
  assert.ok(/第 \$\{d\.revision\} 版/.test(design), '「第 N 版」的完整说法留在 title')
})
check('导出完成后用真实字节数覆盖估算，并如实报出降采样结果', () => {
  const src = view()
  assert.ok(/formatBytes\(r\.bytes\)/.test(src), '成功提示里要报真实体积')
  assert.ok(/outputResultText\(r\.output\)/.test(src), '要如实报出本次降采样结果')
})
check('体积显示只有一份实现且支持 GB（只到 MB 会把 7.9GB 显示成 8089.6MB）', () => {
  const fmt = require(path.join(ROOT, 'src/lib/format-bytes.cjs')).formatBytes
  assert.equal(fmt(900), '900 B')
  assert.equal(fmt(2048), '2 KB')
  assert.equal(fmt(1024 * 1024 * 3), '3.0 MB')
  assert.equal(fmt(Math.round(1024 ** 3 * 7.9)), '7.90 GB')
  assert.equal(fmt(Infinity), '', '拿不到数就不显示，别显示 NaN')
  for (const f of ['src/views/PrintCenterView.vue', 'src/views/BackgroundDesignerView.vue']) {
    assert.ok(/from '\.\.\/lib\/format-bytes\.cjs'/.test(read(f)), `${f} 要用共享实现`)
    assert.ok(!/function formatBytes/.test(read(f)), `${f} 不许自己再写一份`)
  }
})

console.log('== 9. 派生件是缓存，就必须能被统计与回收（不许是死导出）==')
check('统计与清理接口真的被主进程用上了', () => {
  const src = read('electron/api.cjs')
  assert.ok(/require\('\.\/output-dpi\.cjs'\)/.test(src), 'api.cjs 要引用出片派生件模块')
  assert.ok(/derivativeStats\(\)/.test(src), 'app:cacheInfo 要报出派生件体积')
  assert.ok(/clearDerivatives\(\)/.test(src), 'app:clearCache 要能回收派生件')
})
check('正在出片时不许删派生件（出片中的页面正按这些 URL 加载图片）', () => {
  const src = read('electron/api.cjs')
  const from = src.indexOf("'app:clearCache'")
  const clear = src.slice(from, src.indexOf("'app:changeDataDir'"))
  assert.ok(from > 0 && clear.length > 100, '必须能定位到 app:clearCache')
  assert.ok(/printTasks\.size/.test(clear), '要检查是否有出片任务在跑')
  assert.ok(/skipped: true/.test(clear), '要如实标记「跳过了」，而不是假装清干净了')
  assert.ok(/clearDerivatives\(\)/.test(clear), '不在出片时才真的删')
})
check('界面把派生件体积算进「能收回多少」，并如实报出清理结果', () => {
  const app = read('src/App.vue')
  assert.ok(/reclaimableSize/.test(app), '按钮显示的是系统缓存 + 派生件的合计')
  assert.ok(/derivatives\.bytes/.test(app), '读的是主进程给的派生件体积，不是自己猜')
  assert.ok(/个出片派生件/.test(app), '清掉了几个要如实说')
  assert.ok(/d\.skipped/.test(app), '主进程跳过清理时要把原因照原话报出来')
})
check('应用内说明与使用说明同步写了这一条（两份都不许漏）', () => {
  for (const f of ['src/components/GuideDialog.vue', 'docs/使用说明.md']) {
    assert.ok(/一键做三件事/.test(read(f)), `${f} 要同步说明派生件回收`)
    assert.ok(/派生件/.test(read(f)), `${f} 要提到派生件`)
  }
})
// 结果文案可能很长（「…被系统占用，将在下次启动时清理；清理了 3 个出片派生件（2.0 MB）」），
// 标签列一旦允许收缩，中文会退化成逐字换行的竖排。这里钉住样式；
// 几何层面的证明在 `test/about-cache-e2e.cjs`（要真渲染才看得出来）。
check('长结果文案下标签列不许被压成竖排', () => {
  const app = read('src/App.vue')
  const rule = app.match(/\.ar-label\s*\{[^}]*\}/)
  assert.ok(rule, '找得到 .ar-label 规则')
  assert.ok(/flex:\s*0\s+0\s+auto/.test(rule[0]), '.ar-label 要 flex: 0 0 auto，不许被值列挤窄')
  assert.ok(/white-space:\s*nowrap/.test(rule[0]), '.ar-label 要 white-space: nowrap')
  // 反面：不许靠把值列撑成 flex:1 来「解决」——那会让短值（如 MIT）不再贴右边缘
  const val = app.match(/\.ar-value\s*\{[^}]*\}/)
  assert.ok(val && !/flex:\s*1/.test(val[0]), '.ar-value 不许改成 flex:1（短值会失去右对齐）')
})

console.log('== 10. I-50 固定图片：不带效果靠 Chromium 去重，带颜色调整/投影要烘成单份（静态核查）==')
// 这一节只做静态核查（默认套件要能离线快跑）。**实测数字在
// `test/fixed-image-dedupe-e2e.cjs`**（`npm run test:fixed-image-dedupe-e2e`）。
check('降采样范围只覆盖按列绑定的批量照片，且写明了为什么排除固定图片', () => {
  const src = read('electron/output-dpi.cjs')
  const idx = src.indexOf('function activeLayers(design)')
  assert.ok(idx > 0, '找得到 activeLayers')
  // 取函数**连同上方注释**：理由写在注释里，只看函数体会漏掉
  const win = src.slice(Math.max(0, idx - 1600), idx + 400)
  const body = win.match(/function activeLayers\(design\)\s*\{[\s\S]*?\n\}/)
  assert.ok(body && /l\.variable && l\.visible && !l\.editorOnly && l\.bindColumn/.test(body[0]),
    '范围必须严格是 variable && bindColumn（多一个条件就会去动固定图片）')
  assert.ok(/I-50/.test(win), 'activeLayers 的注释要指向 I-50，说明固定图片为什么不在范围内')
  assert.ok(/不随页数增长/.test(win), '要写明依据：固定图片的成本不随页数增长')
  assert.ok(/每页各栅格化一份/.test(win), '要写明前提被破坏后的后果（带 filter / drop-shadow 会逐页各栅格化）')
})
check('烘焙件替换层必须转义 style 且自带定位——少一个就是「断言全过、一张图都没出」', () => {
  // 实测踩过：`cssString` 返回**带双引号**的 `"pp://…"`，直接拼进 `style="…"` 会让属性在
  // `url(` 之后提前闭合，`background-image` 整条作废。此时 `data-design-baked` 还在、
  // CSS filter 也不残留 ⇒ 上面所有断言照过，而 PDF 里 0 个图片对象、还不报错。
  // 另一个坑是定位：`geometryOnly` 模式**不输出任何 CSS**，靠 `-image` 类名定位会退化成零面积块。
  const src = read('electron/design-layout.cjs')
  const idx = src.indexOf('data-design-baked=')
  assert.ok(idx > 0, '渲染器里有烘焙层的替换分支')
  const win = src.slice(Math.max(0, idx - 1400), idx + 600)
  assert.ok(/escapeHtml\(bakedStyle\)|escapeHtml\(`[^`]*background-image/.test(win),
    '整条 style 必须过 escapeHtml（cssString 自带双引号，不转义会把属性切断）')
  assert.ok(/position:absolute;inset:0/.test(win),
    '定位必须内联写死：geometryOnly 模式不输出 CSS，靠类名会变成零面积块')
  assert.ok(/background-size:100% 100%/.test(win), '必须写明铺满（不能靠类名里的那条规则）')
})
check('I-50 在契约文档里有条目，记清了「已修（乙）」、实测倍数与已排除的错路', () => {
  const doc = read('docs/不变量契约.md')
  assert.ok(/^### I-50 /m.test(doc), '契约里要有 I-50 条目')
  const from = doc.indexOf('### I-50 ')
  const body = doc.slice(from, from + 8000)
  assert.ok(/已修/.test(body) && /乙/.test(body), '修好了就要写清楚走的是哪条路（乙）')
  assert.ok(/20\.77×|20\.77/.test(body), '要留下实测的倍数（只写「会变大」等于没记）')
  assert.ok(/9\.8 GB/.test(body), '要留下 A4 数量级，否则看不出严重性')
  assert.ok(/换效果机制没用/.test(body), '要把「换 SVG 滤镜也没用」这条已排除的错路记下来')
  assert.ok(/甲/.test(body) && /未采用|不划算/.test(body), '甲（自己复算烘焙）要留档并写明为什么不采用')
  assert.ok(/切成两片|裁到画布/.test(body), '要把「烘焙画布溢出画布会被切成两片」这条实测记下来')
})
check('烘焙的守卫套件在位，且钉的是修好后的行为（不是 tripwire）', () => {
  const e2e = read('test/fixed-image-dedupe-e2e.cjs')
  assert.ok(/baked === 1/.test(e2e), '要断言那一层真的被烘了')
  assert.ok(/data-design-baked="bg"/.test(e2e), '要断言出片 HTML 里真的替换了')
  assert.ok(/ratio < 1\.2/.test(e2e), '修好后比值必须收紧到 < 1.2（修法前是 20.8×）')
  // 比值会被常量开销干扰 ⇒ 必须有「边际成本」这条不受常量影响的判据
  assert.ok(/marginal < 16 \* 1024/.test(e2e), '必须有边际成本判据（页数翻倍体积不该跟着涨）')
  // 方法灵敏度对照：没有它，「去重了」的结论分不出真假
  assert.ok(/真不相同的多张小图/.test(e2e) && /imagesOf\(pdfDiff\) >= ROWS - 1/.test(e2e),
    '必须有方法灵敏度对照，否则度量分不出「复用/不复用」')
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.scripts['test:fixed-image-dedupe-e2e'], 'package.json 要有这条命令')
  assert.ok(/test:fixed-image-dedupe-e2e/.test(read('README.md')), 'README 要登记这条命令')
})

console.log('== 11. 组合场景行为回归（2026-10-16）==')
check('同图大小框共用：任一框需要原图时，两种图层顺序都保持原图', () => {
  const id = 'asset_' + 'a'.repeat(64)
  const layer = { variable: true, visible: true, bindColumn: 'name', w: 20, h: 20 }
  const big = { ...layer, w: 100, h: 100 }
  const photos = { byRecord: new Map([[{}, { name: id }]]), geometry: new Map([[id, { width: 1000, height: 1000 }]]) }
  for (const layers of [[layer, big], [big, layer]]) {
    const planned = dpi.planDerivatives({ design: { layers }, photos, dpi: 300 })
    assert.equal(planned.plans.get(id).action, 'skip')
    assert.equal(planned.stats.keptOriginal, 1)
    assert.equal(planned.stats.optimized, 0)
    assert.equal(planned.stats.embeddedPixels, 2000000)
  }
  const smaller = dpi.planDerivatives({ design: { layers: [layer, { ...layer, w: 40, h: 40 }] }, photos, dpi: 300 })
  assert.deepEqual(smaller.plans.get(id).target, { w: 472, h: 472 }, '全部可缩时取较大框')
})
check('对称旋转的外接框相同，缓存名必须不同；仅改透明度仍可复用', () => {
  const id = 'asset_' + 'b'.repeat(64)
  const layer = { id: 'image', type: 'image', assetId: id, visible: true, x: 60, y: 60, w: 40, h: 20, rotation: 30,
    adjust: { brightness: 1.2, contrast: 1, saturate: 1, grayscale: 0, invert: 0 } }
  const design = { artboard: { w: 200, h: 200 }, assets: { [id]: { path: `design-assets/${'b'.repeat(64)}.jpg` } } }
  const plan = (l) => dpi.planFixedBakes({ design: { ...design, layers: [l] }, dpi: 300 }).plans.get('image')
  const positive = plan(layer), negative = plan({ ...layer, rotation: -30 })
  assert.deepEqual(positive.geom, negative.geom)
  assert.notEqual(positive.name, negative.name)
  assert.equal(positive.name, plan({ ...layer, opacity: 0.5 }).name)
})
check('整批预估不随翻页改变，部分选择只算选定范围；其他页不重复读原图', () => {
  const store = require('../electron/store.cjs')
  const templates = require('../electron/templates.cjs')
  const printing = require('../electron/print.cjs')
  const a = designs.importImageBuffer(fs.readFileSync(path.join(__dirname, 'fixtures/design-portrait.jpg')), 'a.jpg')
  const b = designs.importImageBuffer(fs.readFileSync(path.join(__dirname, 'fixtures/tiny.png')), 'b.png')
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `person${i}` }))
  store.saveJson('datasets', [{ id: 'dpi_review', name: 'review', columns: [{ key: 'name', printOn: true }], rows, photoMatchColumn: 'name' }])
  store.saveJson('photo-bindings', [{ datasetId: 'dpi_review', files: rows.map((r, i) => ({ name: `${r.name}.jpg`, assetId: i % 2 ? b.id : a.id })) }])
  const doc = designs.saveDesign({ name: 'review', artboard: { w: 90, h: 60 }, layers: [{ id: 'p', type: 'image', variable: true, bindColumn: 'name', w: 34, h: 50 }] })
  const tpl = templates.saveTemplate({ name: 'review', datasetId: 'dpi_review', pageSize: { id: 'custom', w: 90, h: 60 }, backgroundDesign: { id: doc.id, revision: doc.revision }, fields: [] })
  const build = (selection, page) => printing.buildBatchHtml('dpi_review', tpl.id, selection, { previewPage: page, outputDpi: 300, encodeDerivatives: false })
  const full = build(null), first = build(null, 0), last = build(null, 9)
  assert.equal(first.pageCount, 10)
  assert.equal(first.renderedPageCount, 1)
  assert.equal(first.output.encoded, false)
  assert.equal(first.outputEstimateBytes, full.outputEstimateBytes)
  assert.equal(last.outputEstimateBytes, full.outputEstimateBytes)
  assert.equal(build([1, 4, 9], 1).outputEstimateBytes, build([1, 4, 9]).outputEstimateBytes)
  const readFile = fs.readFileSync
  let otherImageReads = 0
  try {
    fs.readFileSync = function(file, ...args) {
      if (String(file).endsWith(path.basename(b.path))) otherImageReads++
      return readFile.call(this, file, ...args)
    }
    build(null, 0)
  } finally { fs.readFileSync = readFile }
  assert.equal(otherImageReads, 0, '其他页只读尺寸元数据，不读照片字节')
  const meta = path.join(DATA, 'design-assets', b.id.slice(6) + '.json')
  const original = fs.readFileSync(meta)
  try {
    fs.writeFileSync(meta, '{}')
    const incomplete = build(null, 0)
    assert.equal(incomplete.outputEstimateIncomplete, true)
    assert.equal(incomplete.outputEstimateBytes, null)
    assert.equal(incomplete.outputOriginalEstimateBytes, null)
    assert.equal(incomplete.renderedPageCount, 1, '其他页无法估算，不阻止当前页预览')
  } finally { fs.writeFileSync(meta, original) }
})
check('部分缓存被占用：只统计真正释放的文件，保留失败文件并可重试', () => {
  const dir = path.join(DATA, dpi.DERIVED_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const held = path.join(dir, 'held.jpg'), free = path.join(dir, 'free.png')
  fs.writeFileSync(held, Buffer.alloc(1024)); fs.writeFileSync(free, Buffer.alloc(2048))
  const unlink = fs.unlinkSync
  let result
  try {
    fs.unlinkSync = function(file) { if (file === held) throw Object.assign(new Error('occupied'), { code: 'EPERM' }); return unlink.call(this, file) }
    result = dpi.clearDerivatives()
  } finally { fs.unlinkSync = unlink }
  assert.equal(result.count, 1); assert.equal(result.bytes, 2048)
  assert.equal(result.failed, 1); assert.equal(result.remainingBytes, 1024)
  assert.equal(fs.existsSync(held), true); assert.equal(fs.existsSync(free), false)
  const retry = dpi.clearDerivatives()
  assert.equal(retry.count, 1); assert.equal(retry.bytes, 1024); assert.equal(retry.failed, 0)
  assert.equal(dpi.clearDerivatives().count, 0, '不存在的目录是成功空操作')
})

console.log(`\n出片分辨率（I-49）与固定图片烘焙（I-50）验收：${passed} 项通过`)

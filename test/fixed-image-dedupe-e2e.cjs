/**
 * 固定图片（底图 / 固定配图）在批量出片里的**膨胀性**与**烘焙修法**实测（契约 I-50）。
 *
 * ## 问题（实测）
 *
 * 固定图片本来只嵌一份：Chromium 复用同一份图片 XObject，成本**不随页数增长**
 * （3000×3000 底图，21 页 PDF 仍只有单页的 1.00×）。所以 I-49 的降采样只覆盖
 * `variable && bindColumn` 的批量照片是**正确**的。
 *
 * 但前提是「这一层只做绘制」。一旦给它加上 CSS `filter`（颜色调整）或 `filter:drop-shadow()`
 * （投影），Chromium 会**每页各栅格化一份**，成本按「印刷面积 × 页数」线性增长：
 * 34×50mm 0.63 MB/页、A4 满版 19.67 MB/页 ⇒ A4 500 页约 9.8 GB。
 *
 * 已排除的错路：换成 SVG 滤镜（feComponentTransfer / feDropShadow，含形状那套
 * `<image filter="url(#id)">`）**完全没用**，CSS 与 SVG 两侧都是 20.98×。
 *
 * ## 修法（借 Chromium 自己烘，契约 I-50 已实现）
 *
 * 出片前把带效果的那一层连同旋转/裁切/翻转/调整/投影/描边渲染成一张 PNG，
 * 再用它顶替该图层（`outputDpi.prepareFixedBakes` + `renderDesign` 的 `bakedLayer` 覆盖）。
 * 效果由 Chromium 原样算出 ⇒ 保真按构造成立；替换后的图层是全素轴对齐图片 ⇒ 回到 1.00×。
 *
 * 烘焙画布**裁到画布之内**（`bakeGeometry(layer, artboard)`）：渲染根 `overflow:hidden`，
 * 越界部分本来就看不见；不裁的话 Chromium 会**按页边界把这张图切成两片**、两片都嵌进 PDF
 * （实测常量 2×：单页 0.501 MB/2 个图片对象 → 21 页 1.009 MB/6 个）。
 *
 * ## 本套件守什么
 *
 * 1. 朴素 / 仅 opacity / 仅 blend：**必须**复用（这是 I-49 范围决策的依据，不能被改坏）。
 * 2. 带 `adjust` / `shadow`：烘焙后**必须**也复用（修法真的生效了）。
 * 3. **边际成本**：页数从 21 翻到 42，每多一页只许涨几十字节——这才是「与页数无关」的
 *    直接证据（比值会被常量开销干扰，单页 0.5 MB 里多一份常量就是 2×）。
 * 4. 烘焙件里的像素**真的带上了效果**——只看体积会漏掉「效果被悄悄丢了」这种坏法：
 *    `brightness(1.2)` 烘出来的亮度必须约为源图的 1.2 倍；投影必须投到图层框**之外**、
 *    且偏在右下（用一个完全在画布内的图层，投影才真的落在成品上）。
 * 5. 烘焙件落在 `photo-out/`，被 `derivativeStats()` 统计 ⇒ 走 I-49 同一套回收链路。
 * 6. 数量级：A4 满版带滤镜底图烘焙后**每多一页只涨不到 1 MB**（修法前 19.67 MB/页）。
 * 7. **方法灵敏度对照**：多张真不相同的图必须涨——否则说明度量分不出「复用/不复用」，
 *    前面所有结论都不能采信。
 *
 * 运行：node test/helpers/electron-runner.cjs test/fixed-image-dedupe-e2e.cjs
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-fixed-image-'))
const data = path.join(tmp, 'data')
const artifacts = path.join(ROOT, '.workbuddy-ai', 'tmp', 'fixed-image-dedupe-e2e')
fs.mkdirSync(data, { recursive: true })
fs.mkdirSync(artifacts, { recursive: true })
// printer.cjs 经 media-protocol 注册 pp:// 时要数据目录已初始化（store 在模块加载时读环境变量）
process.env.PRINTPRESS_DATA_DIR = data
app.setPath('userData', path.join(tmp, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-breakpad')
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => { console.error('FIXED_IMAGE_E2E_TIMEOUT'); app.exit(1) }, 900000)

let checks = 0
const ok = (c, label) => { if (!c) throw new Error(label); checks++; console.log('  ok -', label) }
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'
const imagesOf = (b) => (b.toString('latin1').match(/\/Subtype\s*\/Image\b/g) || []).length
const pagesOf = (b) => (b.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length

/** 确定性伪随机噪点：噪点让 Flate 压不动，体积才真的随像素数走（纯色会掩盖差异） */
function noiseJpeg(w, h, quality = 88, seed0 = 20261016) {
  const px = Buffer.alloc(w * h * 4)
  let seed = seed0
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < px.length; i += 4) {
    px[i] = (rnd() * 255) | 0
    px[i + 1] = (rnd() * 255) | 0
    px[i + 2] = (rnd() * 255) | 0
    px[i + 3] = 255
  }
  return nativeImage.createFromBitmap(px, { width: w, height: h }).toJPEG(quality)
}

/** BGRA 位图（nativeImage.toBitmap 的口径）的通道均值，可限定区域 */
function channelMeans(bitmap, w, h, rect) {
  const x0 = rect ? rect.x : 0
  const y0 = rect ? rect.y : 0
  const x1 = rect ? rect.x + rect.w : w
  const y1 = rect ? rect.y + rect.h : h
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      b += bitmap[i]; g += bitmap[i + 1]; r += bitmap[i + 2]; n++
    }
  }
  return { r: r / n, g: g / n, b: b / n, n }
}

const ROWS = 21
/** 数据集行数上限：比 ROWS 多，好让「页数翻倍」那条判据有数据可印 */
const MAX_ROWS = 42
const SHADOW = { dxMm: 1, dyMm: 1, blurMm: 2, color: '#000000', opacity: 0.4 }
const BRIGHT = { brightness: 1.2 }

/** 手写多页 HTML：每页铺满一张图（只给灵敏度对照用，不走产品渲染） */
const pagesHtml = (urls) => '<!doctype html><html><head><meta charset="utf-8"><style>'
  + '@page{size:34mm 50mm;margin:0}html,body{margin:0;padding:0}'
  + 'img{width:34mm;height:50mm;object-fit:cover;display:block;page-break-after:always}'
  + '</style></head><body>' + urls.map((u) => `<img src="${u}">`).join('') + '</body></html>'

app.whenReady().then(async () => {
  const designs = require(path.join(ROOT, 'electron/designs.cjs'))
  const templates = require(path.join(ROOT, 'electron/templates.cjs'))
  const printDomain = require(path.join(ROOT, 'electron/print.cjs'))
  const printer = require(path.join(ROOT, 'electron/printer.cjs'))
  const outputDpi = require(path.join(ROOT, 'electron/output-dpi.cjs'))
  // §4 要拿产品自己算的规划（几何 + 内容寻址名），不手搭图层——手搭必然漏掉 normalizeDesign 的兜底
  const renderEngine = require(path.join(ROOT, 'electron/render-engine.cjs'))
  const { saveJson } = require(path.join(ROOT, 'electron/store.cjs'))

  console.log('== 0. 夹具 ==')
  const bigBytes = noiseJpeg(3000, 3000, 88)
  const asset = designs.importImageBytes({ name: '大底图.jpg', base64: bigBytes.toString('base64') })
  const srcImg = nativeImage.createFromBuffer(bigBytes)
  const srcSize = srcImg.getSize()
  const srcMean = channelMeans(srcImg.toBitmap(), srcSize.width, srcSize.height)
  console.log(`  固定底图原件 ${mb(bigBytes.length)}（3000×3000，通道均值 ${srcMean.r.toFixed(1)}）· 名单 ${MAX_ROWS} 行 · 纸 34×50mm`)

  /** 造一份「固定底图 + 一列可变文字」的模板，返回真实 PDF 与 HTML */
  const measure = async (tag, layer, page = { w: 34, h: 50 }, pages = null) => {
    const doc = designs.saveDesign({
      schemaVersion: 1, revision: 0, name: `底图-${tag}`,
      artboard: { w: page.w, h: page.h, background: '#ffffff' },
      assets: { [asset.id]: asset },
      layers: [{ id: 'bg', type: 'image', name: '底图', assetId: asset.id, x: 0, y: 0, w: page.w, h: page.h, ...layer }],
    })
    const dsId = `ds_${tag}`
    // 数据集先落库：saveTemplate 会校验 datasetId 存在。
    // 行数给到 MAX_ROWS（比默认页数多）——「页数翻倍体积不翻倍」那条判据要 42 页才测得出来，
    // 而它才是「成本不随页数增长」的直接证据（比值会被常量开销干扰）。
    saveJson('datasets', [{
      id: dsId, name: `名单-${tag}`,
      columns: [{ key: '姓名', printOn: true }],
      rows: Array.from({ length: MAX_ROWS }, (_, i) => ({ 姓名: `姓名 ${i}` })),
    }])
    const tpl = templates.saveTemplate({
      name: `模板-${tag}`, datasetId: dsId,
      pageSize: { id: 'custom', w: page.w, h: page.h },
      backgroundDesign: { id: doc.id, revision: doc.revision },
      fields: [{ column: '姓名', x: 3, y: 88, fontSize: 3, align: 'left' }],
    })
    const n = pages || (page.w > 100 ? 3 : ROWS)
    // 出片前预热烘焙（异步）——这一步就是产品里 api.cjs 在 buildBatchHtml 之前做的事
    const warm = await printDomain.warmBatchBakes(tpl.id, 300)
    const b1 = printDomain.buildBatchHtml(dsId, tpl.id, [0])
    const bN = printDomain.buildBatchHtml(dsId, tpl.id, Array.from({ length: n }, (_, i) => i))
    const p1 = await printer.printToPdfBuffer(b1.html, { partition: `temp:fixed-${tag}-1` })
    const pN = await printer.printToPdfBuffer(bN.html, { partition: `temp:fixed-${tag}-n` })
    fs.writeFileSync(path.join(artifacts, `${tag}-1page.pdf`), p1)
    fs.writeFileSync(path.join(artifacts, `${tag}-${n}page.pdf`), pN)
    if (pagesOf(p1) !== 1 || pagesOf(pN) !== n) throw new Error(`${tag}：页数不对（${pagesOf(p1)} / ${pagesOf(pN)}）`)
    return {
      tag, html: bN.html, one: p1.length, many: pN.length, pages: n,
      ratio: pN.length / p1.length, imgsOne: imagesOf(p1), imgsMany: imagesOf(pN),
      bake: (warm && warm.stats) || null, layerId: 'bg', tplId: tpl.id,
    }
  }
  const show = (r) => {
    console.log(`  单页 ${mb(r.one)} · 图片对象 ${r.imgsOne}`)
    console.log(`  ${r.pages} 页 ${mb(r.many)} · 图片对象 ${r.imgsMany} · 相对单页 ${r.ratio.toFixed(2)}×`
      + (r.bake && r.bake.requested ? ` · 烘焙 ${r.bake.baked}/${r.bake.requested}` : ''))
  }

  /** 默认纸：34×50mm。§4 的几何断言也要用，所以提到最前面声明 */
  const PAGE = { w: 34, h: 50 }

  console.log('\n== 1. 朴素固定底图：必须复用同一份（I-49 范围决策的依据）==')
  const plain = await measure('plain', {})
  show(plain)
  ok((plain.html.match(/data:image\/jpeg;base64,/g) || []).length === 1, '底图在 HTML 里只内联一份')
  ok(plain.imgsMany <= 2, `${ROWS} 页里图片对象只有 ${plain.imgsMany} 个 —— 复用同一份 XObject`)
  ok(plain.ratio < 2, `${ROWS} 页只有单页的 ${plain.ratio.toFixed(2)}× —— 不随页数膨胀`)
  ok(!plain.bake || plain.bake.requested === 0, '朴素底图不该产生烘焙件（没有效果要烘）')
  ok(!/data-design-baked/.test(plain.html), '朴素底图不该走烘焙替换')

  console.log('\n== 2. 只加 opacity / blend：仍然复用，且不该被烘 ==')
  const opacity = await measure('opacity', { opacity: 0.85 })
  show(opacity)
  ok(/opacity:0\.85/.test(opacity.html), '透明度真的进了渲染结果')
  ok(opacity.ratio < 2, `仅透明度 ${ROWS} 页只有单页的 ${opacity.ratio.toFixed(2)}× —— 仍复用`)
  ok(!opacity.bake || opacity.bake.requested === 0, 'opacity 不破坏复用，不该白烘一遍')
  const blend = await measure('blend', { blend: 'multiply' })
  show(blend)
  ok(/mix-blend-mode:multiply/.test(blend.html), '混合模式真的进了渲染结果')
  ok(blend.ratio < 2, `仅混合模式 ${ROWS} 页只有单页的 ${blend.ratio.toFixed(2)}× —— 仍复用`)
  ok(!blend.bake || blend.bake.requested === 0, 'blend 不破坏复用，不该白烘一遍')

  console.log('\n== 3. 带 adjust / shadow：烘焙之后必须也复用（修法生效）==')
  const bright = await measure('bright', { adjust: BRIGHT })
  show(bright)
  ok(bright.bake && bright.bake.baked === 1 && bright.bake.failed === 0, '颜色调整那一层被烘成 1 张图')
  ok(/data-design-baked="bg"/.test(bright.html), '出片 HTML 里该图层确实被替换成烘焙件')
  ok(!/filter:brightness/.test(bright.html), '替换后不该再残留 CSS filter（残留就还会逐页栅格化）')
  ok(bright.imgsMany <= 2, `${ROWS} 页里图片对象只有 ${bright.imgsMany} 个`)
  ok(bright.ratio < 1.2, `烘焙后 ${ROWS} 页只有单页的 ${bright.ratio.toFixed(2)}×（修法前是 20.8×）`)

  const shadow = await measure('shadow', { shadow: SHADOW })
  show(shadow)
  ok(shadow.bake && shadow.bake.baked === 1 && shadow.bake.failed === 0, '投影那一层被烘成 1 张图')
  ok(/data-design-baked="bg"/.test(shadow.html), '出片 HTML 里该图层确实被替换成烘焙件')
  ok(!/drop-shadow/.test(shadow.html), '替换后不该再残留 drop-shadow')
  ok(shadow.imgsMany <= 2, `${ROWS} 页里图片对象只有 ${shadow.imgsMany} 个`)
  ok(shadow.ratio < 1.2, `烘焙后 ${ROWS} 页只有单页的 ${shadow.ratio.toFixed(2)}×（修法前是 20.8×）`)

  // 比值会被「常量开销」干扰（单页 0.5 MB 里图片占九成，多一份常量就是 2×）。
  // 真正要钉的是**边际成本**：页数翻倍，体积不该跟着涨。这一条不受常量影响。
  const shadow42 = await measure('shadow42', { shadow: SHADOW }, PAGE, MAX_ROWS)
  show(shadow42)
  const marginal = (shadow42.many - shadow.many) / (MAX_ROWS - ROWS)
  console.log(`  每多印一页只涨 ${marginal.toFixed(0)} 字节（修法前每页 0.66 MB）`)
  ok(marginal < 16 * 1024, `${ROWS} → ${MAX_ROWS} 页每页只涨 ${marginal.toFixed(0)} 字节 ⇒ 成本与页数无关`)

  console.log('\n== 4. 烘焙件里的像素**真的带上了效果**（只看体积会漏掉「效果被丢了」）==')
  {
    // 4a 颜色调整：烘焙后图层框内的亮度必须约为源图的 1.2 倍
    const st = outputDpi.derivativeStats()
    const bakeFiles = fs.readdirSync(path.join(data, 'photo-out')).filter(f => f.startsWith('bake_'))
    ok(bakeFiles.length >= 2, `photo-out/ 里有 ${bakeFiles.length} 个烘焙件（${st.count} 个派生件总计入缓存统计）`)

    /**
     * 取产品**自己**算出来的那份规划（几何 + 内容寻址名），而不是在测试里手搭一个图层。
     * 手搭必然漏掉 `normalizeDesign` 的兜底（比如 `adjust` 会被补成五个通道齐全），
     * 于是哈希对不上、测试报「文件不存在」——那是测试的错，不是产品的错。
     * 独立性靠下面「拿规划里的图层再复算一遍几何」来保证。
     */
    const planOf = (tplId, layerId = 'bg') => {
      const design = renderEngine.resolveTemplateDesign(templates.getTemplate(tplId))
      const { plans } = outputDpi.planFixedBakes({ design, dpi: 300 })
      return { design, layer: design.layers.find(l => l.id === layerId), plan: plans.get(layerId) }
    }

    const { design: dDesign, layer: dLayer, plan: dPlan } = planOf(bright.tplId)
    ok(!!dPlan, '产品为「带颜色调整的固定图层」规划出了烘焙件')
    // 独立复算：规划里的几何必须与「拿它的图层重算一次」一致
    const gB = outputDpi.bakeGeometry(dLayer, dDesign.artboard)
    ok(['bakeW', 'bakeH', 'layerX', 'layerY', 'outX', 'outY', 'outW', 'outH'].every(k => Math.abs(gB[k] - dPlan.geom[k]) < 1e-9),
      `规划的几何与独立复算一致（${gB.bakeW.toFixed(2)}×${gB.bakeH.toFixed(2)}mm）`)
    ok(Math.abs(gB.bakeW - PAGE.w) < 1e-9 && Math.abs(gB.bakeH - PAGE.h) < 1e-9,
      `无投影时烘焙画布就是图层框（${gB.bakeW}×${gB.bakeH}mm）`)
    const fileB = path.join(data, 'photo-out', dPlan.name)
    ok(fs.existsSync(fileB), `烘焙件按内容寻址落盘：${dPlan.name}`)
    const imgB = nativeImage.createFromBuffer(fs.readFileSync(fileB))
    const sizeB = imgB.getSize()
    ok(sizeB.width === Math.round(gB.bakeW * 300 / 25.4) && sizeB.height === Math.round(gB.bakeH * 300 / 25.4),
      `烘焙件像素 = 成品毫米 × 300dpi（${sizeB.width}×${sizeB.height}）`)
    const meanB = channelMeans(imgB.toBitmap(), sizeB.width, sizeB.height)
    const ratio = meanB.r / srcMean.r
    ok(ratio > 1.10 && ratio < 1.30,
      `brightness(1.2) 真的进了像素：亮度均值 ${srcMean.r.toFixed(1)} → ${meanB.r.toFixed(1)}（${ratio.toFixed(3)}×，期望≈1.2）`)

    // 4b 几何：满版图层加投影后外接框撑出画布 ⇒ **必须被裁回画布**。
    // 不裁的后果实测过：Chromium 按页边界把这张图切成两片、两片都嵌进 PDF（常量 2×）。
    const { layer: sLayer, plan: sPlan } = planOf(shadow.tplId)
    const gRaw = outputDpi.bakeGeometry(sLayer)
    ok(gRaw.outW > PAGE.w && gRaw.outH > PAGE.h && gRaw.outX < 0 && gRaw.outY < 0,
      `未裁时外接框确实撑出画布：${gRaw.outW.toFixed(2)}×${gRaw.outH.toFixed(2)}mm，起点 ${gRaw.outX.toFixed(2)},${gRaw.outY.toFixed(2)}`)
    ok(Math.abs(sPlan.geom.outX) < 1e-9 && Math.abs(sPlan.geom.outY) < 1e-9
      && Math.abs(sPlan.geom.outW - PAGE.w) < 1e-9 && Math.abs(sPlan.geom.outH - PAGE.h) < 1e-9,
      `产品规划出的几何已裁到画布：${sPlan.geom.outW.toFixed(2)}×${sPlan.geom.outH.toFixed(2)}mm @ ${sPlan.geom.outX.toFixed(2)},${sPlan.geom.outY.toFixed(2)}`)
    const sBakeSize = nativeImage.createFromBuffer(fs.readFileSync(path.join(data, 'photo-out', sPlan.name))).getSize()
    ok(sBakeSize.width === Math.round(sPlan.geom.bakeW * 300 / 25.4) && sBakeSize.height === Math.round(sPlan.geom.bakeH * 300 / 25.4),
      `裁过的烘焙件像素 = 裁后毫米 × 300dpi（${sBakeSize.width}×${sBakeSize.height}，未裁时会是 608×797）`)

    // 4c 投影：烘焙件的 alpha 必须出现在图层框**之外**（否则就是被裁掉了）。
    // 用一个**完全在画布之内**的图层，投影才真的落在成品上——满版底图的投影会落到画布外，
    // 本来就看不见，拿它断言等于在验一个用户看不到的东西。
    const inner = await measure('inner-shadow', { x: 7, y: 15, w: 20, h: 20, shadow: SHADOW }, PAGE, 3)
    show(inner)
    ok(inner.bake && inner.bake.baked === 1, '小图层的投影也被烘了')
    const { layer: iLayer, plan: iPlan } = planOf(inner.tplId)
    const gS = outputDpi.bakeGeometry(iLayer, PAGE)
    ok(gS.outX >= 0 && gS.outY >= 0 && gS.outX + gS.outW <= PAGE.w + 1e-9 && gS.outY + gS.outH <= PAGE.h + 1e-9,
      `小图层的投影完整落在画布内：${gS.outW.toFixed(2)}×${gS.outH.toFixed(2)}mm @ ${gS.outX.toFixed(2)},${gS.outY.toFixed(2)}`)
    const imgS = nativeImage.createFromBuffer(fs.readFileSync(path.join(data, 'photo-out', iPlan.name)))
    const sizeS = imgS.getSize()
    const bmpS = imgS.toBitmap()
    const pxPerMm = 300 / 25.4
    const inBox = { x: Math.round(gS.layerX * pxPerMm), y: Math.round(gS.layerY * pxPerMm), w: Math.round(20 * pxPerMm), h: Math.round(20 * pxPerMm) }
    let alphaOutside = 0
    let alphaOutsideBottomRight = 0
    for (let y = 0; y < sizeS.height; y++) {
      for (let x = 0; x < sizeS.width; x++) {
        const inside = x >= inBox.x && x < inBox.x + inBox.w && y >= inBox.y && y < inBox.y + inBox.h
        if (inside) continue
        if (bmpS[(y * sizeS.width + x) * 4 + 3] > 0) {
          alphaOutside += 1
          // 投影偏移是 +1,+1mm ⇒ 右下侧应当明显多于左上侧
          if (x > inBox.x + inBox.w && y > inBox.y + inBox.h) alphaOutsideBottomRight += 1
        }
      }
    }
    ok(alphaOutside > 0, `投影确实被烘进了像素：图层框之外有 ${alphaOutside} 个非透明像素（没被裁掉）`)
    ok(alphaOutsideBottomRight > 0, `投影方向正确：右下角外侧有 ${alphaOutsideBottomRight} 个非透明像素（dx/dy 都是 +1mm）`)
  }

  console.log('\n== 5. 数量级：A4 满版带滤镜底图，烘焙后成本塌回「一份」==')
  const a4 = await measure('a4-bright', { adjust: BRIGHT }, { w: 210, h: 297 }, 3)
  show(a4)
  // A4 满版的**单份**像素本来就大（210×297mm @300dpi = 2480×3508 ≈ 12 MB 噪点 PNG）——
  // 那是「整页铺一张照片」的固有成本，不是膨胀。修法要解决的是它**乘页数**，所以判据是
  // 「边际成本」与「比值」，不是绝对值。（绝对值在修法前也是 19.67 MB/页，同一量级。）
  const perPage = a4.many / a4.pages
  const a4Marginal = (a4.many - a4.one) / (a4.pages - 1)
  console.log(`  每页均摊 ${mb(perPage)} · 每多一页只涨 ${mb(a4Marginal)}（修法前每多一页 19.67 MB ⇒ 500 页约 9.8 GB）`)
  ok(a4.bake && a4.bake.baked === 1, 'A4 那一层也被烘了')
  ok(a4.ratio < 1.2, `A4 ${a4.pages} 页只有单页的 ${a4.ratio.toFixed(2)}×（修法前是 3.00×）`)
  ok(a4Marginal < 1024 * 1024, `每多一页只涨 ${mb(a4Marginal)}（修法前 19.67 MB/页）`)

  console.log('\n== 6. 方法灵敏度对照：同一张小图 vs 真不相同的多张小图 ==')
  // 这一组用来证明上面的度量分得清「复用」与「不复用」——否则前面的结论不能采信。
  // 第一版对照组用 `88 + (i % 3)` 造差异，实际只有 3 张不同的图，Chromium 只嵌了 3 个对象，
  // 对照组自己就不成立（这反而证明了它是按内容去重的）。
  const sameUrl = `data:image/jpeg;base64,${noiseJpeg(1200, 1200, 88).toString('base64')}`
  const distinct = Array.from({ length: ROWS }, (_, i) => `data:image/jpeg;base64,${noiseJpeg(1200, 1200, 88, 20261016 + i * 7919).toString('base64')}`)
  ok(new Set(distinct).size === ROWS, `对照组确实是 ${ROWS} 张互不相同的图`)
  const pdfSame = await printer.printToPdfBuffer(pagesHtml(Array.from({ length: ROWS }, () => sameUrl)), { partition: 'temp:fixed-same' })
  const pdfDiff = await printer.printToPdfBuffer(pagesHtml(distinct), { partition: 'temp:fixed-diff' })
  console.log(`  ${ROWS} 页同一张：${mb(pdfSame.length)} · 图片对象 ${imagesOf(pdfSame)}`)
  console.log(`  ${ROWS} 页不同张：${mb(pdfDiff.length)} · 图片对象 ${imagesOf(pdfDiff)}`)
  ok(imagesOf(pdfDiff) >= ROWS - 1, `不同图 → 图片对象 ${imagesOf(pdfDiff)} 个（度量确实能看出「不复用」）`)
  ok(pdfDiff.length > pdfSame.length * 3, `不同图比同一张大了 ${(pdfDiff.length / pdfSame.length).toFixed(1)}× ⇒ 度量对「复用/不复用」敏感`)

  console.log('\n== 7. 对称旋转必须生成不同的实际缓存像素 ==')
  {
    const doc = designs.saveDesign({ name: '旋转缓存回归', artboard: { w: 200, h: 200 }, assets: { [asset.id]: asset },
      layers: [{ id: 'rotation', type: 'image', assetId: asset.id, x: 60, y: 60, w: 40, h: 20, rotation: 30, adjust: BRIGHT }] })
    const negativeDoc = { ...doc, layers: doc.layers.map(l => ({ ...l, rotation: -30 })) }
    const positive = await outputDpi.prepareFixedBakes({ design: doc, dpi: 300 })
    const negative = await outputDpi.prepareFixedBakes({ design: negativeDoc, dpi: 300 })
    ok(positive.stats.baked === 1 && negative.stats.baked === 1, '两种方向都实际烘焙成功')
    const plusUrl = positive.overrides.get('rotation').url, minusUrl = negative.overrides.get('rotation').url
    ok(plusUrl !== minusUrl, '相同外接框的 +30° / -30° 不共用缓存 URL')
    const bytes = (url) => fs.readFileSync(path.join(data, decodeURIComponent(new URL(url).pathname).replace(/^\//, '')))
    const plusBytes = bytes(plusUrl)
    ok(!plusBytes.equals(bytes(minusUrl)), '实际烘焙像素随旋转方向变化')
    const reused = await outputDpi.prepareFixedBakes({ design: doc, dpi: 300 })
    ok(reused.stats.reused === 1 && bytes(reused.overrides.get('rotation').url).equals(plusBytes), '相同角度再次导出仍复用正确缓存')
  }

  const result = {
    checks,
    plain: { ratio: Number(plain.ratio.toFixed(3)), imgsMany: plain.imgsMany },
    opacity: { ratio: Number(opacity.ratio.toFixed(3)) },
    blend: { ratio: Number(blend.ratio.toFixed(3)) },
    bright: { ratio: Number(bright.ratio.toFixed(2)), baked: bright.bake.baked },
    shadow: { ratio: Number(shadow.ratio.toFixed(2)), baked: shadow.bake.baked, marginalBytes: marginal },
    a4: { ratio: Number(a4.ratio.toFixed(2)), perPage, marginalBytes: a4Marginal },
    artifactDir: artifacts,
  }
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`\n固定图片膨胀性与烘焙（I-50）验收：${checks} 项通过`)
  console.log('FIXED_IMAGE_E2E_OK', JSON.stringify(result))
}).catch(err => {
  console.error('FIXED_IMAGE_E2E_FAIL', err)
  process.exitCode = 1
}).finally(() => {
  clearTimeout(watchdog)
  app.exit(process.exitCode || 0)
})

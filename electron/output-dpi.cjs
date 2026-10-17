/**
 * 出片分辨率：把照片按「图框毫米尺寸 × 目标 DPI」预降采样后再交给 Chromium。
 *
 * ## 为什么需要（实测，2026-10-16）
 *
 * PDF 体积 ≈ **嵌入照片的像素数** × Chromium Flate 重编码的每像素字节数，**与原件 JPEG
 * 体积无关**。同一图框（34×50mm）的实测：
 *
 * | 源图 | 源 JPEG | PDF 用原件 | PDF 降采样后 | 体积比 |
 * | --- | --- | --- | --- | --- |
 * | 3000×3000 | 3.66 MB | 16.27 MB | 0.40 MB | 40.6× |
 * | 2400×3600 | 3.51 MB | 22.60 MB | 0.39 MB | 58.2× |
 * | 4096×2731 | 4.55 MB | 13.49 MB | 0.41 MB | 32.7× |
 *
 * 外推 500 页 = 8.52 GB；S1 验收报告实测 500 页 = 7.90 GB（模型误差 8%）。
 * 而 34×50mm 在 300dpi 下只需要 402×591px —— 约 40 倍像素冗余。
 *
 * ## 边界（契约 I-49）
 *
 * - **原件字节一律不动**。派生件是新文件；归档快照仍用原件——`photo-output.archivePhotos`
 *   只认 `pp://media/asset_<sha>`，本模块产出的 URL 不会被它卷进归档。
 * - **只改出片表征**（PDF / 直打）。预览与归档不受影响。
 * - **只缩不放**：目标像素不小于源图时原样透传（插值放大是假细节）。
 * - **不静默**：界面显示本次出片分辨率与结果，可关（选「原图」）。
 * - **失败降级到原图**，并把条数报给界面——不静默丢照片，也不让一张坏图毁掉整批。
 *
 * ## 为什么用 nativeImage 而不是 Chromium canvas（实测）
 *
 * - canvas `drawImage` + `imageSmoothingQuality:'high'` 在 5× 缩小时**有可见同心摩尔纹**，
 *   且 2.5 s/张（软件渲染）⇒ 500 张要 21 分钟。**否掉**。
 * - `nativeImage` **分步对半** resize 与 LANCZOS 参照一致（无环纹），单张约 50 ms；
 *   **一步到位会留下淡环纹**，所以必须分步——这一点与参照仓库 Compositor 的
 *   `DownsampleCache.swift` 同源（它用「链式对半」解决 Core Graphics 单步重采样发虚）。
 * - 代价：`nativeImage` **忽略 EXIF 方向且重编码丢标记**（实测确认：1200×800 + Orientation=6
 *   读出来仍是 1200×800，输出的 JPEG 没有 APP1）。所以本模块自己做三件事：
 *   ① 用 `designs.jpegOrientation` 读方向（EXIF 解析的单一权威）；
 *   ② **在显示坐标里算目标像素**，再换回存储坐标（O≥5 时宽高互换）；
 *   ③ 把方向写回输出的 APP1，让 Chromium 渲染 `<img>` 时照旧应用一次。
 *   ②③ 缺一不可：少了②目标尺寸算大，少了③竖拍照片会转错 90° 且不报错。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { resolveInsideDataDir } = require('./store.cjs')
const { normalizeOutputDpi, OUTPUT_DPI_VALUES } = require('./export-formats.cjs')

/** 派生件目录（数据目录内相对路径）。内容寻址 ⇒ 永不失效，也永不与原件混淆。 */
const DERIVED_DIR = 'photo-out'
/** JPEG 派生件质量。88 与原件 85~90 同档，肉眼无差而体积可控。 */
const DERIVED_QUALITY = 88
/** 缓存键的版本位：改降采样算法/质量口径时抬它，旧派生件自然失效。 */
const DERIVED_VERSION = 1
/** 派生件只支持这两种容器（nativeImage 在 Electron 28 不解 WebP，也不该把 PNG 转成有损 JPEG）。 */
const SUPPORTED_EXTS = Object.freeze(['.jpg', '.jpeg', '.png'])

/**
 * 出片体积模型——**是模型，不是预言**（与 export-formats.estimateOutputBytes 同一纪律）。
 *
 * 实测 1.2~2.6 字节/像素（内容复杂度决定，差 2 倍）。取中值只保证量级对得上：
 * 「8.5 GB → 0.2 GB」这种 40 倍量级的判断不受 2 倍误差影响。
 * 导出完成后一律用**真实字节数**覆盖它。
 */
const PDF_BYTES_PER_PIXEL = 1.6

/** 图框毫米 → 目标像素 */
function targetPixels(frameWmm, frameHmm, dpi) {
  return {
    w: Math.max(1, Math.round(frameWmm / 25.4 * dpi)),
    h: Math.max(1, Math.round(frameHmm / 25.4 * dpi)),
  }
}

/**
 * 显示坐标 → 存储坐标。
 *
 * **`designs.assetInfo` 记录的宽高是显示坐标**：`validateImage` 在导入时已按 EXIF 归正
 * （`orientation >= 5 ? { width: size.height, height: size.width } : size`，见 designs.cjs）。
 * 而 `nativeImage` 与 `resize` 吃的是**存储坐标**（未旋转的像素）。这一层转换必须显式做。
 *
 * 漏掉它**不会报错**，只会把竖拍照片的目标尺寸算成 2.2 倍大——实测 1200×800 / O=6 /
 * 34×50mm 会算出 591×887（纵向还是插值放大），正确是 603×402。后果是体积收益砍掉一半，
 * 且往出片里塞了假细节。
 */
function storageSize(displayW, displayH, orientation) {
  return orientation >= 5 ? { w: displayH, h: displayW } : { w: displayW, h: displayH }
}

/**
 * 单张照片的降采样决策。纯函数，可脱离 Electron 单测。
 *
 * 关键：**srcW/srcH 是文件里的存储像素**（`nativeImage.createFromBuffer().getSize()` 给什么
 * 就是什么），不是 `assetInfo` 的显示尺寸——两者在 O≥5 时是反的，用错了不报错只算错。
 * 调用方从显示坐标过来时先过 `storageSize()`。
 *
 * 内部仍必须**在显示坐标里算 cover 缩放比**，算完再换回存储坐标——因为「盖住图框」这件事
 * 只在显示方向上有意义。
 *
 * @returns {{action:'skip'|'resize', reason:string, need?:object, scale?:number, target?:object}}
 *   `target` 恒为**存储坐标**（nativeImage 拿到的是未旋转的像素）。
 */
function planFor({ srcW, srcH, orientation = 1, frameWmm, frameHmm, dpi }) {
  const target = normalizeOutputDpi(dpi)
  if (target === null) return { action: 'skip', reason: 'original' }
  if (!(srcW > 0) || !(srcH > 0) || !(frameWmm > 0) || !(frameHmm > 0)) {
    return { action: 'skip', reason: 'unknown-geometry' }
  }
  const swap = orientation >= 5
  const dispW = swap ? srcH : srcW
  const dispH = swap ? srcW : srcH
  const need = targetPixels(frameWmm, frameHmm, target)
  // cover：短边盖住图框，长边溢出（与 CSS object-fit:cover 同口径）
  const scale = Math.max(need.w / dispW, need.h / dispH)
  if (!(scale < 1)) return { action: 'skip', reason: 'source-not-larger', need, scale }
  const dispTargetW = Math.min(dispW, Math.max(need.w, Math.round(dispW * scale)))
  const dispTargetH = Math.min(dispH, Math.max(need.h, Math.round(dispH * scale)))
  if (dispTargetW >= dispW && dispTargetH >= dispH) {
    return { action: 'skip', reason: 'source-not-larger', need, scale }
  }
  return {
    action: 'resize',
    reason: 'downscale',
    need,
    scale,
    target: { w: swap ? dispTargetH : dispTargetW, h: swap ? dispTargetW : dispTargetH },
  }
}

/**
 * 派生件文件名。内容寻址：assetId 本身就是原件内容的 sha256，再加目标尺寸、质量与版本位，
 * 在原件未变且编码实现与版本一致时复用同名缓存；调整算法时必须升级版本位。
 */
function derivativeName(assetId, w, h, quality = DERIVED_QUALITY) {
  const digest = crypto.createHash('sha256')
    .update(`${assetId}|${w}x${h}|q${quality}|v${DERIVED_VERSION}`)
    .digest('hex')
  return `${digest.slice(0, 40)}.jpg`
}

function derivativeRel(name) {
  return `${DERIVED_DIR}/${name}`
}

/** 数据目录内的相对路径 → pp:// URL（与 render-engine.mediaUrl 同一格式，供 media-protocol 直接服务） */
function derivativeUrl(rel) {
  return 'pp://media/' + String(rel).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

/**
 * 分步对半降采样。
 *
 * **不能一步 resize**：实测一步到位的 5.1× 缩小会留下淡同心环纹，分步对半则与 LANCZOS
 * 参照一致（该区域标准差 10.10 vs 参照 10.08，一步 10.09 但肉眼可见环纹）。
 */
function halvingResize(img, targetW, targetH) {
  let cur = img
  let w = img.getSize().width
  let h = img.getSize().height
  while (w / 2 >= targetW && h / 2 >= targetH) {
    w = Math.max(targetW, Math.round(w / 2))
    h = Math.max(targetH, Math.round(h / 2))
    cur = cur.resize({ width: w, height: h, quality: 'good' })
  }
  return (w === targetW && h === targetH) ? cur : cur.resize({ width: targetW, height: targetH, quality: 'good' })
}

/**
 * 把 EXIF Orientation 写进 JPEG 的 APP1 段。
 *
 * `nativeImage` 重编码后不保留任何元数据，方向标记会丢；丢标记的后果是**竖拍照片被
 * Chromium 当横图直接画出来**（转错 90°），界面与测试都不会报错。所以必须自己写回。
 *
 * 用的是最小 TIFF 头（只含 Orientation 一项）：顺带把 GPS / 机身序列号这类
 * 与出片无关的隐私元数据一并丢掉，这对「数据不出本机」的定位是加分而非损失。
 */
function withOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'ascii')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12)
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff])
  const app1 = Buffer.alloc(4 + exif.length)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(exif.length + 2, 2)
  exif.copy(app1, 4)
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

/** 按目标尺寸重新编码一张照片。返回派生件的字节。 */
function renderDerivative(buffer, ext, target, orientation, quality = DERIVED_QUALITY) {
  // 惰性 require：本模块的纯函数部分要能在纯 Node 下单测（同 design-export 的做法）
  const { nativeImage } = require('electron')
  const img = nativeImage.createFromBuffer(buffer)
  if (img.isEmpty()) throw new Error('照片无法解码')
  const small = halvingResize(img, target.w, target.h)
  const isPng = ext === '.png'
  // PNG 保持 PNG：转 JPEG 会把透明像素压成黑，出片时衬底会变成黑块
  const out = isPng ? small.toPNG() : small.toJPEG(quality)
  if (!out || !out.length) throw new Error('照片缩放失败')
  return (isPng || orientation < 2) ? out : withOrientation(out, orientation)
}

/** 写入派生件（原子写：临时文件 + rename，避免并发读到半个文件）。返回数据目录内相对路径。 */
function writeDerivative(rel, bytes) {
  const abs = resolveInsideDataDir(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  try {
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, abs)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败留待人工检查 */ }
    throw err
  }
  return rel
}

/** 原件 URL（assetId 本身就是 `asset_<sha256>`，pp://media 直接服务它） */
function originalUrl(assetId) {
  return derivativeUrl(assetId)
}

/** 参与出片的照片图层：变量图、可见、非编辑器专用、且绑定了列 */
/**
 * 参与降采样的图层：只挑**按列绑定的批量照片**（`variable && bindColumn`）。
 *
 * 固定图片（底图、固定配图、logo）**故意不在范围内**——实测（契约 I-50）：
 * 这类图层在 HTML 里只内联一份、Chromium 复用同一份图片 XObject，成本不随页数增长
 * （3000×3000 底图，500 页整份 PDF 仍只有 6.7 MB）。给它们做降采样不会省体积，
 * 只会白白多出一份派生件。
 *
 * ⚠️ 这个结论有前提：该图层**只做绘制**（`opacity` 属于绘制参数，安全）。
 * 一旦带上 CSS `filter`（颜色调整）或 `drop-shadow`（投影），Chromium 会**每页各栅格化一份**，
 * 成本按「印刷面积 × 页数」线性增长（A4 满版 19.67 MB/页 ⇒ 500 页约 9.8 GB）。
 * 那种情况需要的是「把效果烘进像素」，不是这里的降采样——详见 I-50 与
 * `test/fixed-image-dedupe-e2e.cjs`。
 */
function activeLayers(design) {
  return (design?.layers || []).filter(l => l.variable && l.visible && !l.editorOnly && l.bindColumn)
}

function emptyStats(dpi) {
  return {
    dpi,
    /** 是否真的生成过派生件。false = 只做了规划（预览），数字是「预计」 */
    encoded: false,
    requested: 0,
    optimized: 0,
    keptOriginal: 0,
    failed: 0,
    sourceBytes: 0,
    derivedBytes: 0,
    sourcePixels: 0,
    derivedPixels: 0,
    /** 本次出片实际嵌入的照片像素（按放置次数累计）。估算体积的唯一输入。 */
    embeddedPixels: 0,
    /**
     * **若按原图出片**会嵌入的像素。界面拿它做对照：「原图约 8.5 GB → 300dpi 约 0.21 GB」。
     * 少了这个基线，「省了多少」是一句没有参照物的话，用户无法判断值不值得关掉。
     */
    originalEmbeddedPixels: 0,
  }
}

/**
 * 按放置次数累计嵌入像素。
 *
 * 同一张照片被多个记录复用时，每页都要嵌一份——所以必须按「放置」计数，不能按素材去重。
 * 拿不到尺寸的按 0 计：估算宁可偏低，也不要凭猜测虚报。
 */
function countEmbeddedPixels(layers, photos, sizeOf) {
  let total = 0
  for (const perColumn of photos?.byRecord?.values() || []) {
    for (const layer of layers) {
      const size = sizeOf(perColumn[layer.bindColumn])
      if (size) total += size.w * size.h
    }
  }
  return total
}

/**
 * **只做规划**：算每张照片该降到什么尺寸，不读字节、不落盘、不编码。
 *
 * 预览走这条路：几何信息来自 `photo-library.prepareRows` 顺手量到的 `photos.geometry`
 * （那份读取本来就要做，用于「照片缺失要立刻报错」），所以规划是**零额外 I/O** 的。
 * 于是界面能在用户点「出片」之前就报出「这次大约多大」。
 *
 * 量不到几何的素材不缩（`failed`）——宁可不缩，也不猜。
 *
 * @returns `{ dpi, layers, plans: Map(assetId → plan), stats }`
 *   plan = `{ action:'resize', target:{w,h}, orientation }` 或 `{ action:'skip', reason, orientation }`
 */
function planDerivatives({ design, photos, dpi }) {
  const target = normalizeOutputDpi(dpi)
  const layers = activeLayers(design)
  const stats = emptyStats(target)
  const plans = new Map()
  if (!layers.length) return { dpi: target, layers, plans, stats }

  // 归集 assetId → 用到它的图框集合（同一素材可能被多个图层/多行复用）
  const framesByAsset = new Map()
  for (const perColumn of photos?.byRecord?.values() || []) {
    for (const layer of layers) {
      const assetId = perColumn[layer.bindColumn]
      if (typeof assetId !== 'string') continue
      let frames = framesByAsset.get(assetId)
      if (!frames) { frames = new Map(); framesByAsset.set(assetId, frames) }
      frames.set(`${layer.w}x${layer.h}`, layer)
    }
  }

  for (const [assetId, frames] of framesByAsset) {
    stats.requested += 1
    const geo = photos?.geometry?.get?.(assetId)
    if (!geo || !(geo.width > 0) || !(geo.height > 0)) {
      // 几何缺失：不缩，但也不谎报成「已优化」
      stats.failed += 1
      plans.set(assetId, { action: 'skip', reason: 'unknown-geometry', orientation: 1 })
      continue
    }
    const orientation = geo.orientation || 1
    const storage = storageSize(geo.width, geo.height, orientation)
    if (target === null) {
      plans.set(assetId, { action: 'skip', reason: 'original', orientation, storage })
      stats.keptOriginal += 1
      continue
    }
    // 同一素材取「最吃像素」的那个图框作为派生尺寸——它同时满足其余更小的图框
    let best = null
    let keepOriginal = false
    for (const layer of frames.values()) {
      const plan = planFor({
        srcW: storage.w, srcH: storage.h, orientation,
        frameWmm: layer.w, frameHmm: layer.h, dpi: target,
      })
      if (plan.action !== 'resize') { keepOriginal = true; break }
      if (!best || plan.target.w * plan.target.h > best.target.w * best.target.h) best = plan
    }
    if (keepOriginal || !best) {
      plans.set(assetId, { action: 'skip', reason: 'source-not-larger', orientation, storage })
      stats.keptOriginal += 1
      continue
    }
    plans.set(assetId, { action: 'resize', target: best.target, orientation, storage })
    stats.optimized += 1
  }

  // 估算用的嵌入像素：能缩的按派生尺寸算，不缩的按原件像素算
  stats.embeddedPixels = countEmbeddedPixels(layers, photos, (assetId) => {
    const plan = plans.get(assetId)
    if (!plan) return null
    if (plan.action === 'resize') return plan.target
    if (plan.storage) return { w: plan.storage.w, h: plan.storage.h }
    const geo = photos?.geometry?.get?.(assetId)
    return geo ? { w: geo.width, h: geo.height } : null
  })
  // 对照基线：全部按原件嵌入会是多少像素
  stats.originalEmbeddedPixels = countEmbeddedPixels(layers, photos, (assetId) => {
    const geo = photos?.geometry?.get?.(assetId)
    return geo ? { w: geo.width, h: geo.height } : null
  })
  return { dpi: target, layers, plans, stats }
}

/**
 * 为一个出片任务准备全部派生件（**会真的编码与落盘**）。
 *
 * **同一时刻只持有一张原件的字节**——先规划出「谁要缩、缩到多少」（零 I/O），再逐个处理，
 * 处理完立刻释放。500 张 × 3.7 MB 同时驻留就是 1.85 GB，正是 S1 压测里踩过的坑。
 *
 * 同一 assetId 只生成一份派生件，尺寸取「用到它的最大图框」——它同时满足其余更小的图框。
 * 文件名内容寻址，所以重复出片直接命中已有文件，不重复编码。
 *
 * @param design 已归一化的底图工程（含 layers）
 * @param photos `photo-library.prepareRows` 的产物 `{ byRecord, assets, geometry }`
 * @param dpi    归一化后的出片分辨率（number | null）；null = 原图，urlFor 恒回原件
 * @returns `{ urlFor(assetId, layer), stats }`——`urlFor` **恒**返回可用 URL，任何异常回原件
 */
function prepareDerivatives({ design, photos, dpi }) {
  const { plans, stats } = planDerivatives({ design, photos, dpi })
  const resolved = new Map()
  const designs = require('./designs.cjs')

  for (const [assetId, plan] of plans) {
    if (plan.action !== 'resize') continue
    try {
      const { asset, buffer } = designs.assetBytes(assetId)
      const ext = path.extname(asset.path || '').toLowerCase()
      // 防御位：readAsset 已保证 mime ∈ {png, jpeg}，理论上到不了这里
      if (!SUPPORTED_EXTS.includes(ext)) { stats.optimized -= 1; stats.keptOriginal += 1; continue }
      const rel = derivativeRel(derivativeName(assetId, plan.target.w, plan.target.h))
      const abs = resolveInsideDataDir(rel)
      if (!fs.existsSync(abs)) writeDerivative(rel, renderDerivative(buffer, ext, plan.target, plan.orientation))
      resolved.set(assetId, derivativeUrl(rel))
      stats.sourceBytes += buffer.length
      stats.derivedBytes += fs.statSync(abs).size
      stats.sourcePixels += asset.width * asset.height
      stats.derivedPixels += plan.target.w * plan.target.h
    } catch {
      // 读不到原件 / 解不出尺寸 / 写不进派生件：降级到原件，由界面如实报告条数
      stats.optimized -= 1
      stats.failed += 1
    }
  }
  stats.encoded = true
  return {
    stats,
    /** 该素材该用哪个 URL；未优化或失败的素材一律回原件，绝不阻断出片。 */
    urlFor(assetId) {
      return resolved.get(assetId) || originalUrl(assetId)
    },
  }
}

/** 由嵌入像素数估算 PDF 体积。模型口径见文件顶部 `PDF_BYTES_PER_PIXEL`。 */
function estimatePdfBytes(pixels) {
  const n = Number(pixels)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * PDF_BYTES_PER_PIXEL)
}

/* ============================ 固定图片烘焙（契约 I-50） ============================
 *
 * 问题：固定图片（底图 / 固定配图 / logo）本来只嵌一份，Chromium 复用同一份 XObject，
 * 成本**不随页数增长**。但一旦这一层带上 CSS `filter`（颜色调整）或 `filter:drop-shadow()`
 * （投影），Chromium 会**每页各栅格化一份**，成本按「印刷面积 × 页数」线性增长：
 * 实测 34×50mm 0.63 MB/页、A4 满版 19.67 MB/页 ⇒ A4 500 页约 9.8 GB。
 *
 * 已排除的错路（实测，别再试）：把效果换成 SVG 滤镜（feComponentTransfer / feDropShadow，
 * 含形状那套 `<image filter="url(#id)">`）**完全没用**，CSS 与 SVG 两侧都是 20.98×——
 * Skia 的 PDF 后端表达不了滤镜，只能栅格化，换写法不改变这一点。
 *
 * 解法（本段）：**借 Chromium 自己把这一层烘成一张图**。把该图层连同它的
 * 旋转 / 裁切 / 翻转 / 颜色调整 / 投影 / 描边，按「它印出来需要多少像素」渲染成一张 PNG，
 * 再用这张 PNG 顶替该图层。效果由 Chromium 计算；一致性仍需像素与几何回归验证，不必自己复算滤镜
 * （自己复算 `shadow` 需要一层模糊，观感对不齐的风险很实在）。
 *
 * 替换后的图层是「全素的轴对齐图片」——最容易被复用的形态，于是回到 1.00×。
 *
 * 几条刻意的边界：
 * - **`opacity` 与 `blend` 不烘进像素，留在替换层上**。两者都已被实测证明不破坏复用
 *   （1.00×），留在外层既省一次乘算，也避免「组透明度 × 图层透明度」被算两遍
 *   （烘焙时归 1、替换层上按原值生效，只有一处生效）。
 * - **归档快照不烘焙**（`encode:false` 时不产出覆盖），与 I-49「归档用原件」同一条纪律。
 * - **「原图」档也要烘**：这是「效果」问题，不是「照片分辨率」问题；烘焙分辨率退回
 *   默认 300dpi（Chromium 自己按 ~384dpi 栅格化，300 已够且可控）。
 * - 产出落在 `photo-out/`，与 I-49 的派生件同一处、同一套统计与回收，不新增目录。
 */

/** 烘焙缓存键的版本位：改烘焙口径（尺寸/舍入/是否含某属性）时抬它，旧件自然失效。 */
const BAKE_VERSION = 2
/** 「原图」档下的烘焙分辨率。见上：烘焙问的是效果，不是照片分辨率。 */
const BAKE_DPI_FALLBACK = 300

/**
 * 需要烘焙的固定图片图层：带了「要算新像素」的效果。
 *
 * 判据与渲染侧**同一份实现**（`filterOf`），不在这里另写一套「有没有调过色」的判断——
 * 那种平行实现迟早与渲染侧漂移，而漂移的表现是「明明调过色却没烘」这种安静失效。
 */
function bakeTargets(design) {
  const { filterOf } = require('./design-layout.cjs')
  return (design?.layers || []).filter(layer =>
    layer.type === 'image' && !layer.variable && layer.visible && !layer.editorOnly
    && (filterOf(layer.adjust) !== '' || !!layer.shadow))
}

/**
 * 烘焙几何：把图层（连同投影扩张）旋转后取轴对齐外接框。
 *
 * 投影的扩张区域用渲染侧的 `shadowRegion`——**同一份实现**。它按 `4×blur + 0.25mm` 留边，
 * 自己另算一个「大概够」的留边会在某些模糊半径下把投影切掉，而切掉的部分只在出片上可见。
 *
 * `artboard`（画布尺寸）给了就**把外接框裁到画布之内**，这是无损的：渲染根 `.print-design-root`
 * 带 `overflow:hidden`，越出画布的部分本来就看不见。不裁的代价是实打实的——实测（34×50mm
 * 画布上的满版底图 + 投影，外接框 51.5×67.5mm）Chromium 会**按页边界把这张图切成两片**，
 * 两片都嵌进 PDF：单页 0.501 MB / 2 个图片对象 → 21 页 1.009 MB / 6 个对象。
 * 多出来的是**常量**（42 页也只 1.021 MB），不是每页一份，所以它不是膨胀；但它让
 * 「页数比值」停在 2.01× 上，且烘了三分之一根本印不出来的像素。裁掉即回到 1.0×。
 * 纵向溢出才会触发这个切分（横向溢出 1.25mm 实测仍是 2 个对象）。
 *
 * @param artboard `{ w, h }`；不给就按未裁的外接框（测试要单独核对几何时用得上）
 * @returns `{ bakeW, bakeH, layerX, layerY, outX, outY, outW, outH }`
 *   - `bakeW/H`：烘焙画布尺寸（= 旋转后的外接框，已裁到画布内）
 *   - `layerX/Y`：图层在烘焙画布里的左上角（让图层中心落在「画布中心 − 旋转后的偏移」）
 *   - `outX/Y/W/H`：替换回原画布时的位置与尺寸
 */
function bakeGeometry(layer, artboard = null) {
  const { shadowRegion } = require('./design-layout.cjs')
  const region = layer.shadow
    ? shadowRegion(layer.w, layer.h, layer.shadow)
    : { x: 0, y: 0, width: layer.w, height: layer.h }
  const rad = (layer.rotation || 0) * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // 区域中心相对图层中心的偏移（图层本地坐标）→ 旋转到画布坐标
  const rx = region.x + region.width / 2 - layer.w / 2
  const ry = region.y + region.height / 2 - layer.h / 2
  const ox = rx * cos - ry * sin
  const oy = rx * sin + ry * cos
  // 区域旋转后的轴对齐外接框
  const halfW = (Math.abs(region.width * cos) + Math.abs(region.height * sin)) / 2
  const halfH = (Math.abs(region.width * sin) + Math.abs(region.height * cos)) / 2
  const cx = layer.x + layer.w / 2 + ox
  const cy = layer.y + layer.h / 2 + oy
  const box = {
    bakeW: 2 * halfW, bakeH: 2 * halfH,
    layerX: halfW - ox - layer.w / 2, layerY: halfH - oy - layer.h / 2,
    outX: cx - halfW, outY: cy - halfH, outW: 2 * halfW, outH: 2 * halfH,
  }
  if (!artboard) return box
  // 裁到画布之内。交集为空（整层都在画布外，用户看不见）时**退回未裁的外接框**，
  // 不返回 null：那样调用方就得决定「跳过烘焙」，而跳过的后果是 CSS 效果留在原地、
  // 继续逐页栅格化——为了一个退化情形把主线判据搞复杂不值得。
  const x0 = Math.max(0, box.outX)
  const y0 = Math.max(0, box.outY)
  const x1 = Math.min(artboard.w, box.outX + box.outW)
  const y1 = Math.min(artboard.h, box.outY + box.outH)
  if (!(x1 > x0) || !(y1 > y0)) return box
  if (x0 === box.outX && y0 === box.outY && x1 === box.outX + box.outW && y1 === box.outY + box.outH) return box
  const dx = x0 - box.outX
  const dy = y0 - box.outY
  return {
    bakeW: x1 - x0, bakeH: y1 - y0,
    layerX: box.layerX - dx, layerY: box.layerY - dy,
    outX: x0, outY: y0, outW: x1 - x0, outH: y1 - y0,
  }
}

/**
 * 内容寻址的烘焙件名。
 *
 * `asset.path` 本身已是内容寻址（`<pool>/<sha64>.png`，两个原件池之一），所以键里带上它就等于带上了
 * 图片字节；其余是**会影响渲染结果**的全部字段。少写一个字段的后果是「改了却没重新烘」，
 * 而画面看起来只是没生效——所以这里宁可多列，也不要图省事只哈希 layer.id。
 *
 * 同时记录图层尺寸、角度与裁到画布后的几何：外接框相同不代表内容相同，
 * 例如 +30° 与 -30° 的无投影图片外接框相同，旋转方向却相反。
 *
 * `layer.opacity` / `layer.blend` **刻意不在键里**：两者都不烘进像素（留在替换元素上，
 * 见 design-layout 的烘焙分支），所以「只调了透明度」不该触发重烘。
 */
function bakeName(layer, geom, asset, dpi) {
  const crop = layer.crop || { x: 0, y: 0, w: 1, h: 1 }
  const adj = layer.adjust || {}
  const sh = layer.shadow || {}
  const key = [
    'bake', BAKE_VERSION, dpi, asset.path,
    layer.w, layer.h, layer.rotation || 0,
    geom.bakeW, geom.bakeH, geom.layerX, geom.layerY, geom.outX, geom.outY, geom.outW, geom.outH,
    crop.x, crop.y, crop.w, crop.h,
    layer.flipX ? 1 : 0, layer.flipY ? 1 : 0,
    adj.brightness, adj.contrast, adj.saturate, adj.grayscale, adj.invert,
    sh.dxMm, sh.dyMm, sh.blurMm, sh.color, sh.opacity,
    layer.strokeWidth || 0, layer.stroke || '',
  ].join('|')
  return `bake_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}.png`
}

/** 烘焙件的 URL（走 pp:// 外链，不把大图内联进 HTML——与 I-49 派生件同一条纪律）。 */
function bakeUrl(rel) {
  return `pp://media/${rel.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * 规划烘焙（**零 I/O**，预览也能报出「有几个带效果的底图会被烘」）。
 *
 * @returns `{ dpi, plans: Map(layerId → plan), stats }`
 *   plan = `{ layer, asset, name, pixels, geom }`
 */
function planFixedBakes({ design, dpi } = {}) {
  const target = normalizeOutputDpi(dpi)
  const bakeDpi = target === null ? BAKE_DPI_FALLBACK : target
  const layers = bakeTargets(design)
  const plans = new Map()
  const stats = { dpi: bakeDpi, requested: layers.length, baked: 0, failed: 0, pixels: 0, reused: 0 }
  for (const layer of layers) {
    const asset = design?.assets?.[layer.assetId]
    // 素材缺失由渲染侧统一报错（那里有图层名，能给出可读消息）；这里只是没得烘
    if (!asset) { stats.failed += 1; continue }
    const geom = bakeGeometry(layer, design?.artboard)
    const px = {
      w: Math.max(1, Math.round(geom.bakeW * bakeDpi / 25.4)),
      h: Math.max(1, Math.round(geom.bakeH * bakeDpi / 25.4)),
    }
    plans.set(layer.id, { layer, asset, name: bakeName(layer, geom, asset, bakeDpi), pixels: px.w * px.h, geom })
  }
  return { dpi: bakeDpi, plans, stats }
}

/**
 * 真的把图层烘成 PNG 并落盘（**异步**：要拉起离屏窗口截图）。
 *
 * 为什么是异步、以及为什么不能直接在渲染链路里调：`renderDesign` 那条链路是**同步**的
 * （`buildBatchHtml` 被预览、CLI、二十来个测试同步调用，改签名会波及一大片），
 * 而截图必须等事件循环。所以异步边界放在**出片动作**上：
 * 出片前先 `await prepareFixedBakes(...)` 把要烘的层烘好，随后同步的渲染链路
 * 只用 `readFixedBakes` 读缓存命中。**命中不到就不烘**（该图层照旧按原样渲染），
 * 绝不为了烘焙把同步链路改成异步。
 *
 * @returns `{ stats, overrides }`——任何失败都从 `overrides` 里缺席，绝不阻断出片。
 */
async function prepareFixedBakes({ design, dpi } = {}) {
  const { dpi: bakeDpi, plans, stats } = planFixedBakes({ design, dpi })
  const overrides = new Map()
  if (!plans.size) return { stats, overrides }

  // 懒 require：本模块顶层不许碰 electron（api.cjs 的分层守卫钉着这一条）。
  // 放在 try 里：CLI / 无窗口环境拿不到离屏渲染能力时，只能是「不烘」，
  // 绝不能让一件优化把出片本身打断。
  let designExport = null
  try {
    designExport = require('./design-export.cjs')
  } catch {
    stats.failed += plans.size
    return { stats, overrides }
  }
  for (const [layerId, plan] of plans) {
    const { layer, name, geom } = plan
    const rel = `${DERIVED_DIR}/${name}`
    const abs = resolveInsideDataDir(rel)
    try {
      if (fs.existsSync(abs)) {
        stats.reused += 1
      } else {
        // 烘焙画布只放这一层，且把 opacity/blend 归位（见上：两者不烘进像素）
        const bakeDesign = {
          schemaVersion: 3, revision: 0, name: `${design.name || '底图'} · 烘焙 ${layer.name || layerId}`,
          artboard: { w: geom.bakeW, h: geom.bakeH, background: 'transparent' },
          assets: design.assets,
          layers: [{
            ...layer,
            x: geom.layerX, y: geom.layerY,
            opacity: 1, blend: 'normal', visible: true, locked: false,
          }],
        }
        const prepared = designExport.prepareExport({ design: bakeDesign, dpi: bakeDpi, transparent: true, format: 'png' })
        const bytes = await designExport.renderImage(prepared)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, bytes)
      }
      overrides.set(layerId, { url: bakeUrl(rel), x: geom.outX, y: geom.outY, w: geom.outW, h: geom.outH })
      stats.baked += 1
      stats.pixels += plan.pixels
    } catch {
      // 尺寸超限 / 渲染超时 / 写不进盘：降级成「不烘」，由界面如实报告条数
      stats.failed += 1
    }
  }
  return { stats, overrides }
}

/**
 * 同步读取**已经烘好**的覆盖（不渲染、不起窗口）。
 *
 * 这是同步渲染链路唯一能用的一半：命中就替换、未命中就按原样渲染。
 * 由 `prepareFixedBakes` 在出片前预跑，两者共用同一份 `planFixedBakes` 与命名，
 * 所以「预跑时写哪个文件名、这里读哪个文件名」不可能漂移。
 */
function readFixedBakes({ design, dpi } = {}) {
  const { dpi: bakeDpi, plans, stats } = planFixedBakes({ design, dpi })
  const overrides = new Map()
  for (const [layerId, plan] of plans) {
    const rel = `${DERIVED_DIR}/${plan.name}`
    if (!fs.existsSync(resolveInsideDataDir(rel))) continue
    const g = plan.geom
    overrides.set(layerId, { url: bakeUrl(rel), x: g.outX, y: g.outY, w: g.outW, h: g.outH })
    stats.baked += 1
    stats.pixels += plan.pixels
  }
  stats.dpi = bakeDpi
  return { stats, overrides }
}

/** 派生件占用统计（供资源管理与「清缓存」显示） */
function derivativeStats() {
  const abs = resolveInsideDataDir(DERIVED_DIR)
  let count = 0
  let bytes = 0
  try {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      count += 1
      bytes += fs.statSync(path.join(abs, entry.name)).size
    }
  } catch { /* 目录不存在即 0 */ }
  return { count, bytes, dir: DERIVED_DIR }
}

/** 清空派生件。派生件是纯缓存（内容寻址、可重建），删除不影响任何原件与归档。 */
function clearDerivatives() {
  const abs = resolveInsideDataDir(DERIVED_DIR)
  const result = { count: 0, bytes: 0, failed: 0, remainingBytes: 0, dir: DERIVED_DIR }
  let entries
  try {
    const root = fs.lstatSync(abs)
    if (root.isSymbolicLink() || !root.isDirectory()) { result.failed = 1; return result }
    entries = fs.readdirSync(abs, { withFileTypes: true })
  }
  catch (err) {
    if (err.code !== 'ENOENT') result.failed = 1
    return result
  }
  // 逐文件统计实际释放量；被占用的文件保留，其他文件仍可清理。不跟随目录或链接。
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(abs, entry.name)
    let bytes = 0
    try {
      bytes = fs.lstatSync(file).size
      fs.unlinkSync(file)
      result.count++
      result.bytes += bytes
    } catch (err) {
      if (err.code !== 'ENOENT') { result.failed++; result.remainingBytes += bytes }
    }
  }
  try { fs.rmdirSync(abs) } catch { /* 保留含未删除文件或未知条目的目录 */ }
  return result
}

module.exports = {
  DERIVED_DIR, DERIVED_QUALITY, SUPPORTED_EXTS, PDF_BYTES_PER_PIXEL,
  OUTPUT_DPI_VALUES,
  targetPixels, planFor, storageSize, derivativeName, derivativeRel, derivativeUrl,
  halvingResize, withOrientation, renderDerivative, writeDerivative,
  planDerivatives, prepareDerivatives, estimatePdfBytes, derivativeStats, clearDerivatives,
  // 固定图片烘焙（I-50）
  BAKE_VERSION, BAKE_DPI_FALLBACK,
  bakeTargets, bakeGeometry, bakeName, bakeUrl, planFixedBakes, prepareFixedBakes, readFixedBakes,
}

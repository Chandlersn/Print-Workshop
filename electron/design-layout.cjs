/** Shared by Vue and Node. Physical units are mm; text size and tracking are pt. */
const TYPES = new Set(['image', 'text', 'rect', 'ellipse', 'line'])
const LIMITS = Object.freeze({ layers: 300, assets: 300, artboard: 2000, text: 20000, groups: 150, guides: 100 })

/**
 * 图层混合模式白名单——**只收 Canvas 2D `mix-blend-mode` 原生支持的 15 种**。
 *
 * Photoshop 全套 27 种里剩下的（linear-burn / vivid-light / pin-light / darker-color /
 * lighter-color / subtract / divide…）CSS 没有对应值，硬上要么逐像素补、要么落到
 * 不同公式的近似值。打印对色准敏感：宁可少给 12 种，也不给「画布与 PS 不一致」的
 * 假模式。要扩清单时先见 docs/v0.7功能建议-参照Compositor.md 的混合模式一节。
 */
const BLEND_MODES = Object.freeze(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'])

/**
 * 已实现的工程格式版本——**唯一的可读版本清单**，校验与测试都从这里取值。
 *
 * 测试要验「更高版本被拒」时必须用 `Math.max(...SCHEMA_VERSIONS) + 1`，不要写死数字：
 * 写死会在下次抬版本时变成假失败（v6 落地时 design-editor/design-effects 就各中过一次）。
 */
const SCHEMA_VERSIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7])

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value
}
function number(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${label}超出有效范围（${min}–${max}）`)
  return n
}
function string(value, fallback, max, label) {
  const s = value === undefined ? fallback : value
  if (typeof s !== 'string' || s.length > max || s.includes('\0')) throw new Error(`${label}不是有效文本或过长`)
  return s
}
function bool(value, fallback, label) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label}必须为布尔值`)
  return value
}
function token(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error(`${label}无效`)
  return value
}
function color(value, fallback) {
  const s = value === undefined ? fallback : value
  if (s === 'transparent' || s === 'none') return 'transparent'
  if (typeof s !== 'string' || !/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(s)) throw new Error('颜色必须是十六进制颜色或 transparent')
  return s
}
function linearPaint(value, label) {
  if (value === undefined) return undefined
  const paint = object(value, label)
  if (paint.type !== 'linear') throw new Error(`${label}类型无效`)
  const angle = number(paint.angle, 90, -360, 360, `${label}方向`)
  if (!Array.isArray(paint.stops) || paint.stops.length < 2 || paint.stops.length > 8) throw new Error(`${label}色标数量必须为 2～8`)
  const stops = paint.stops.map((raw, index) => {
    const stop = object(raw, `${label}色标`)
    return { offset: number(stop.offset, NaN, 0, 1, '色标位置'), color: color(stop.color), opacity: number(stop.opacity, 1, 0, 1, '色标透明度'), index }
  }).sort((a, b) => a.offset - b.offset || a.index - b.index)
  if (stops[0].offset !== 0 || stops.at(-1).offset !== 1) throw new Error(`${label}首尾色标必须覆盖 0 和 1`)
  return { type: 'linear', angle, stops: stops.map(({ offset, color, opacity }) => ({ offset, color, opacity })) }
}
function shapeShadow(value) {
  const shadow = object(value, '阴影')
  return {
    dxMm: number(shadow.dxMm, 1, -50, 50, '阴影水平偏移'),
    dyMm: number(shadow.dyMm, 1.5, -50, 50, '阴影垂直偏移'),
    blurMm: number(shadow.blurMm, 1, 0, 10, '阴影模糊'),
    color: color(shadow.color, '#000000'),
    opacity: number(shadow.opacity, 0.2, 0, 1, '阴影透明度'),
  }
}
/**
 * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → `rgba(r,g,b,a)`。
 *
 * 图片投影走 CSS `filter: drop-shadow()`，它只收 `<color>` 而不能像 SVG `feFlood` 那样
 * 把颜色和不透明度分成两个属性——所以必须在这里把 `shadow.opacity` 乘进 alpha。
 * 非十六进制（`color()` 允许的 `transparent`）一律落到全透明，别让 `parseInt` 吐出 NaN。
 */
function withAlpha(value, alpha) {
  if (typeof value !== 'string' || !value.startsWith('#')) return 'transparent'
  const hex = value.slice(1)
  const full = hex.length <= 4 ? hex.split('').map((ch) => ch + ch).join('') : hex
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16)
  const base = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1
  return `rgba(${r},${g},${b},${Math.round(alpha * base * 1000) / 1000})`
}
/**
 * 图片图层的描边与投影（v0.7 §6）：证件照衬边 + 照片卡立体感。
 *
 * **两个字段都是「可选」而非「有默认」**。形状的 `stroke` / `strokeWidth` 天生带默认值
 * （每个形状都有一圈描边），图片不能沿用这个约定——一旦给图片补上默认描边，**所有存量
 * 工程里的每一张图都会凭空多出一圈线**，而没有任何人要求过。
 * 所以只在调用方真的传了才产出字段；不传 ⇒ 与旧工程逐字节同行为。
 *
 * 投影沿用与形状**同一个** `shadow` 结构（dx/dy/blur/color/opacity），只是渲染方式不同：
 * 形状走 SVG `feGaussianBlur`+`feFlood`，图片走 CSS `filter: drop-shadow()`（跟 alpha 走）。
 */
function imageEffects(l) {
  const out = {}
  if (l.strokeWidth !== undefined || l.stroke !== undefined) {
    out.stroke = color(l.stroke, '#ffffff')
    out.strokeWidth = number(l.strokeWidth, 0, 0, 100, '描边宽度')
  }
  if (l.shadow !== undefined) out.shadow = shapeShadow(l.shadow)
  return out
}
/**
 * 裁切比例预设——**只放「纯比例」的**，一个绝对毫米尺寸都不放。
 *
 * 为什么这样切：带物理尺寸的预设（1 寸 = 25×35 mm）是**产品规格**，权威源是
 * `templates.cjs` 的 `ITEM_SIZES`（多联拼版的「成品尺寸」用的是同一份，经 `app:env`
 * 下发给界面）。在这里再抄一份 1 寸/2 寸，就等于给同一个规格留了两个定义，
 * 改一处必漏另一处——I-27/I-39 那类漂移都是这么来的。
 *
 * `w`/`h` 是**毫米语义下的宽高比**，不是像素比：证件照按物理尺寸出图，
 * 用像素比会在不同原图上得到不同的物理长宽比（同一份 3:4 在竖图和横图上结果相反）。
 */
const CROP_RATIOS = Object.freeze([
  { id: '1:1', name: '正方形 1:1', w: 1, h: 1 },
  { id: '3:4', name: '竖版 3:4', w: 3, h: 4 },
  { id: '4:3', name: '横版 4:3', w: 4, h: 3 },
  { id: '9:16', name: '竖版 9:16', w: 9, h: 16 },
  { id: '16:9', name: '横版 16:9', w: 16, h: 9 },
  { id: 'a4', name: 'A4 比例（210×297）', w: 210, h: 297 },
])

/** 裁切百分比统一保留 6 位小数：既够精度，又能让 `x + w <= 1` 稳稳成立（见下）。 */
const cropRound = (value) => Math.round(value * 1e6) / 1e6

/**
 * 把裁切框调成指定的物理长宽比——**尽量保住用户原来的取景**。
 *
 * 为什么必须有这一步：静态图片图层的 `crop` 存的是「原图百分比」，而**打印出来的比例**
 * 取决于 `(原图宽 × crop.w) : (原图高 × crop.h)`。只把图层尺寸改成 25×35 mm 却不动 crop，
 * 换来的就是一张**被横向拉长的脸**——用户看到的是「选了 1 寸结果变形」，而代码里
 * 每一行都没报错。所以「选尺寸」和「改裁切」必须是同一个动作。
 *
 * 取「原图内放得下的最大同比例矩形」，并以原裁切框**中心**为锚点贴边收拢：
 * 面积最大 ⇒ 不白白丢像素；锚点不变 ⇒ 刚调好的取景不会跳到别处。
 *
 * @param crop   {x,y,w,h} 原裁切（0~1 的原图百分比），缺省为整图
 * @param ratioW 目标物理宽度（mm）
 * @param ratioH 目标物理高度（mm）
 * @param assetW 原图像素宽（「百分比 → 物理比例」的换算依据）
 * @param assetH 原图像素高
 */
function fitCropToRatio(crop, ratioW, ratioH, assetW, assetH) {
  const current = crop || { x: 0, y: 0, w: 1, h: 1 }
  const usable = (value) => Number.isFinite(value) && value > 0
  // 参数不全时原样返回：宁可不动，也不要算出一个越界的裁切把工程写成非法状态
  if (!usable(ratioW) || !usable(ratioH) || !usable(assetW) || !usable(assetH)) return { ...current }
  // 要让「打印比例 = ratioW : ratioH」，百分比空间的宽高比须为
  //   crop.w / crop.h = (ratioW × assetH) / (ratioH × assetW)
  const k = (ratioW * assetH) / (ratioH * assetW)
  if (!usable(k)) return { ...current }
  const w = cropRound(Math.min(1, k))
  const h = cropRound(Math.min(1, 1 / k))
  const cx = current.x + current.w / 2
  const cy = current.y + current.h / 2
  // 先减后夹，且夹的上界与 w/h 用同一种取整——否则 x + w 可能落在 1.0000000001 上，
  // 被 normalizeDesign 的「裁切区域超出原图」拦下（用户在界面上点一下预设就报错）。
  const clamp = (value, limit) => Math.min(Math.max(cropRound(value), 0), Math.max(0, cropRound(limit)))
  return { x: clamp(cx - w / 2, 1 - w), y: clamp(cy - h / 2, 1 - h), w, h }
}

/**
 * 图片颜色调整——**全字段恒等值为默认**（brightness/contrast/saturate=1，grayscale/invert=0），
 * 老工程不传 `adjust` 时行为与升级前逐字节一致。渲染侧见 renderDesign 的 filterOf。
 */
function imageAdjust(value) {
  const adj = object(value, '图片颜色调整')
  return {
    brightness: number(adj.brightness, 1, 0, 3, '亮度'),
    contrast: number(adj.contrast, 1, 0, 3, '对比度'),
    saturate: number(adj.saturate, 1, 0, 3, '饱和度'),
    grayscale: number(adj.grayscale, 0, 0, 1, '去色'),
    invert: number(adj.invert, 0, 0, 1, '反相'),
  }
}

/**
 * family 名规范化：**唯一权威实现**（画布 / 编辑器 / PDF / 打印 / PNG 导出共用）。
 *
 * 上传文件名里可能带引号等 CSS 语法字符（`测试'楷体.ttf`），而模板与图层里存的
 * 往往是用户手输的原名。@font-face 声明与引用方必须归一到同一个字符串，否则
 * 字体声明存在却匹配不上（表现为「字体没生效」）。
 * 剔除集：引号、反斜杠、分号、大括号、圆括号——它们在 CSS 字符串内有语法意义。
 *
 * 为什么落在这里而不是 fonts.cjs：本模块被 Vue 与 Node 共用且零依赖，而
 * fonts.cjs 会 require('child_process') 并在模块加载时读 process.env，
 * 渲染进程 import 它会直接崩。fontFamily 空串表示「默认字体」，按原样返回。
 */
function normalizeFamily(name) {
  return String(name == null ? '' : name).replace(/['"\\;{}()]/g, '').trim()
}

/**
 * 图层 fontFamily 为空（编辑器里的「默认字体」）时使用的字体栈。
 *
 * 必须与 App 画布继承的字体栈逐字一致（`src/styles/theme.css` 的 `html, body`），
 * 否则同一个「默认字体」在画布与出片上会落到不同字形——本机可能恰好相同，
 * 换台机器就是「画布 ≠ 出片」的静默裂缝。两处成对，改一处必须同时改另一处，
 * `test/canvas-align.cjs` §6 会断言两者相等。
 */
const DEFAULT_FONT_STACK = '"Microsoft YaHei","PingFang SC",sans-serif'

/**
 * 素材生命周期策略归一——**唯一权威实现**（Vue / 主进程 / 测试共用）。
 *
 * 名字说的是「策略」，不是「来源」：同一个「临时件」语义同时覆盖模板页上传与底图制作页
 * 直接加图（粘贴 / 拖入 / 对话框），用 `template` 当名字会让人以为只跟模板有关。
 *
 * - `ephemeral`（临时件）：删掉最后一个引用它的图层 / 模板 / 工程后，原件由素材库即时回收；
 * - `managed`（受管理）：一旦进过素材库即受 I-31 保护，任何自动流程都不删原件。
 *
 * 兼容 0.5.0 之前写入的旧值：`template` → `ephemeral`、`library` → `managed`（存量磁盘数据
 * 无需迁移，读时归一即可）。缺省一律 `managed`——**漏传字段的后果只能是「多占一块盘」，
 * 绝不能是「删了用户的图」**。
 */
function normalizeSource(value) {
  return value === 'ephemeral' || value === 'template' ? 'ephemeral' : 'managed'
}

function normalizeDesign(input) {
  const doc = object(input, '底图工程')
  if (doc.schemaVersion !== undefined && !SCHEMA_VERSIONS.includes(doc.schemaVersion)) throw new Error('不支持的底图工程版本')
  const board = object(doc.artboard, '画布')
  const layers = doc.layers === undefined ? [] : doc.layers
  if (!Array.isArray(layers) || layers.length > LIMITS.layers) throw new Error(`最多支持 ${LIMITS.layers} 个图层`)
  const rawAssets = object(doc.assets === undefined ? {} : doc.assets, '素材表')
  if (Object.keys(rawAssets).length > LIMITS.assets) throw new Error(`最多支持 ${LIMITS.assets} 个素材`)
  const assets = {}
  for (const [id, raw] of Object.entries(rawAssets)) {
    token(id, '素材标识')
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') throw new Error('素材标识无效')
    const asset = object(raw, '素材')
    if (asset.id !== id) throw new Error('素材标识与索引不一致')
    const assetPath = string(asset.path, '', 200, '素材路径')
    // 两个原件池都合法（I-51）：design-assets/ 素材库、ephemeral-assets/ 临时底图。
    // 主进程每次保存都按 readAsset 的真身把 path 改写一遍，所以两个值都是不动点。
    if (!/^(design-assets|ephemeral-assets)\/[a-f0-9]{64}\.(png|jpg)$/.test(assetPath)) throw new Error('素材路径不在底图素材目录内')
    assets[id] = { id, path: assetPath, width: number(asset.width, 1, 1, 24000, '图片宽度'), height: number(asset.height, 1, 1, 24000, '图片高度'), name: string(asset.name, '图片', 200, '素材名称'), mime: asset.mime, source: normalizeSource(asset.source) }
    if (!['image/png', 'image/jpeg'].includes(asset.mime)) throw new Error('素材格式无效')
    /*
     * EXIF 方向（I-49 出片分辨率）：主进程 `readAsset` 每次保存都按**受信任的原件**把
     * `orientation` 重新量一遍写回素材记录（≥5 时上面的 width/height 已是显示坐标，
     * 存储尺寸要靠它换算，见 output-dpi.storageSize）。
     *
     * 规范化这里必须放行：否则「保存 → 主进程写回 → 再规范化」不是不动点，
     * 渲染侧 `fingerprint(design)` 与 `fingerprint(已保存文档)` 永远差这一个字段——
     * 带图工程一保存就仍旧显示「未保存」，且保存按钮看着像没生效。
     * 老工程没这个字段时保持没有，不凭空给旧数据加字段。
     */
    if (asset.orientation !== undefined) assets[id].orientation = number(asset.orientation, 1, 1, 8, 'EXIF 方向')
  }
  const ids = new Set()
  const result = {
    schemaVersion: doc.schemaVersion || 1, revision: number(doc.revision, 0, 0, Number.MAX_SAFE_INTEGER, '工程版本'),
    name: string(doc.name, '未命名底图', 120, '工程名称').trim(),
    artboard: { w: number(board.w, 297, 1, LIMITS.artboard, '画布宽度'), h: number(board.h, 210, 1, LIMITS.artboard, '画布高度'), background: color(board.background, '#ffffff'), ...(board.backgroundPaint === undefined ? {} : { backgroundPaint: linearPaint(board.backgroundPaint, '画布渐变') }) },
    assets,
    layers: layers.map((raw, index) => {
      const l = object(raw, '图层')
      const id = token(l.id, '图层标识')
      if (ids.has(id)) throw new Error('图层标识重复')
      ids.add(id)
      if (!TYPES.has(l.type)) throw new Error('不支持的图层类型')
      const out = {
        id, type: l.type, name: string(l.name, `图层 ${index + 1}`, 120, '图层名称'),
        x: number(l.x, 0, -10000, 10000, '图层 X'), y: number(l.y, 0, -10000, 10000, '图层 Y'),
        w: number(l.w, 30, 0.01, 10000, '图层宽度'), h: number(l.h, 20, 0.01, 10000, '图层高度'),
        rotation: number(l.rotation, 0, -36000, 36000, '旋转'), opacity: number(l.opacity, 1, 0, 1, '透明度'),
        visible: bool(l.visible, true, '可见性'), locked: bool(l.locked, false, '锁定'),
        // 混合模式：与下方内容的叠色方式。默认 normal（不混合），存量工程不传即旧行为。
        // 白名单见 BLEND_MODES——只收 CSS 原生 15 种，理由写在常量注释里。
        blend: l.blend === undefined ? 'normal' : l.blend,
        // 仅编辑器可见：参考框这类「给用户对齐用、绝不能印出去」的图层。默认 false，
        // 旧工程与所有不传新选项的调用方行为完全不变。渲染侧见 renderDesign。
        editorOnly: bool(l.editorOnly, false, '仅编辑可见'),
      }
      if (!BLEND_MODES.includes(out.blend)) throw new Error('不支持的混合模式')
      if (l.type === 'image' && l.variable === true) {
        out.variable = true
        out.bindColumn = string(l.bindColumn, '', 200, '照片绑定列').trim()
        if (!out.bindColumn) throw new Error('变量图需要绑定照片文件名列')
        out.fit = l.fit === undefined ? 'cover' : l.fit
        if (!['cover', 'contain'].includes(out.fit)) throw new Error('照片适应方式无效')
        const focal = l.focal === undefined ? {} : object(l.focal, '照片焦点')
        out.focal = { x: number(focal.x, 0.5, 0, 1, '照片水平焦点'), y: number(focal.y, 0.5, 0, 1, '照片垂直焦点') }
        out.radius = number(l.radius, 0, 0, 1000, '照片圆角')
        if (l.adjust !== undefined) out.adjust = imageAdjust(l.adjust)
        Object.assign(out, imageEffects(l))
      } else if (l.type === 'image') {
        out.assetId = token(l.assetId, '图层素材标识')
        if (!Object.hasOwn(assets, out.assetId)) throw new Error(`图片图层缺少素材：${out.name}`)
        const crop = l.crop === undefined ? {} : object(l.crop, '裁切区域')
        out.crop = { x: number(crop.x, 0, 0, 1, '裁切 X'), y: number(crop.y, 0, 0, 1, '裁切 Y'), w: number(crop.w, 1, 0.0001, 1, '裁切宽度'), h: number(crop.h, 1, 0.0001, 1, '裁切高度') }
        if (out.crop.x + out.crop.w > 1.00000001 || out.crop.y + out.crop.h > 1.00000001) throw new Error('裁切区域超出原图')
        out.flipX = bool(l.flipX, false, '水平翻转')
        out.flipY = bool(l.flipY, false, '垂直翻转')
        if (l.adjust !== undefined) out.adjust = imageAdjust(l.adjust)
        Object.assign(out, imageEffects(l))
      } else if (l.type === 'text') {
        Object.assign(out, {
          text: string(l.text, '文字', LIMITS.text, '图层文字'), fontFamily: string(l.fontFamily, '微软雅黑', 150, '字体名称'),
          fontSize: number(l.fontSize, 24, 1, 1000, '字号'), bold: bool(l.bold, false, '粗体'), color: color(l.color, '#222222'),
          align: l.align === undefined ? 'left' : l.align, lineHeight: number(l.lineHeight, 1.2, 0.5, 5, '行距'), letterSpacing: number(l.letterSpacing, 0, -100, 200, '字距'),
        })
        if (!['left', 'center', 'right'].includes(out.align)) throw new Error('文字对齐方式无效')
      } else {
        Object.assign(out, { fill: color(l.fill, l.type === 'line' ? 'transparent' : '#eeeeee'), stroke: color(l.stroke, '#333333'), strokeWidth: number(l.strokeWidth, 0.3, 0, 100, '描边宽度'), radius: number(l.radius, 0, 0, 1000, '圆角') })
        if (l.fillPaint !== undefined) {
          if (!['rect', 'ellipse'].includes(l.type)) throw new Error('渐变仅支持矩形和椭圆')
          out.fillPaint = linearPaint(l.fillPaint, '图形渐变')
        }
        if (l.shadow !== undefined) {
          if (!['rect', 'ellipse'].includes(l.type)) throw new Error('阴影仅支持矩形和椭圆')
          out.shadow = shapeShadow(l.shadow)
        }
      }
      return out
    }),
  }
  const groups = doc.groups === undefined ? [] : doc.groups
  if (!Array.isArray(groups) || groups.length > LIMITS.groups) throw new Error(`最多支持 ${LIMITS.groups} 个图层组`)
  const groupIds = new Set()
  const membership = new Set()
  const positions = new Map(result.layers.map((layer, index) => [layer.id, index]))
  result.groups = groups.map((raw, index) => {
    const group = object(raw, '图层组')
    const id = token(group.id, '图层组标识')
    if (groupIds.has(id) || ids.has(id)) throw new Error('图层组标识重复')
    groupIds.add(id)
    if (!Array.isArray(group.layerIds) || group.layerIds.length < 2 || group.layerIds.length > LIMITS.layers) throw new Error('图层组至少包含两个图层')
    const layerIds = group.layerIds.map(layerId => {
      token(layerId, '组成员标识')
      if (!positions.has(layerId)) throw new Error('图层组引用了不存在的图层')
      if (membership.has(layerId)) throw new Error('每个图层最多属于一个组，组内成员不能重复')
      membership.add(layerId)
      return layerId
    }).sort((a, b) => positions.get(a) - positions.get(b))
    const first = positions.get(layerIds[0])
    if (layerIds.some((layerId, offset) => positions.get(layerId) !== first + offset)) throw new Error('图层组成员必须在层级中连续排列')
    const name = string(group.name, `图层组 ${index + 1}`, 120, '图层组名称').trim()
    if (!name) throw new Error('图层组名称不能为空')
    // 组透明度：乘算到组内每一个图层（与 Compositor v8 的文件夹透明度同语义）。
    // 默认 1 ⇒ 存量工程与不传该字段的调用方行为不变。
    return { id, name, layerIds, opacity: number(group.opacity, 1, 0, 1, '图层组透明度') }
  })
  const guides = doc.guides === undefined ? [] : doc.guides
  if (!Array.isArray(guides) || guides.length > LIMITS.guides) throw new Error(`最多支持 ${LIMITS.guides} 条参考线`)
  const guideIds = new Set()
  result.guides = guides.map(raw => {
    const guide = object(raw, '参考线')
    const id = token(guide.id, '参考线标识')
    if (guideIds.has(id)) throw new Error('参考线标识重复')
    guideIds.add(id)
    if (guide.axis !== 'x' && guide.axis !== 'y') throw new Error('参考线方向必须为 x 或 y')
    return { id, axis: guide.axis, position: number(guide.position, 0, -10000, 10000, '参考线位置') }
  })
  // Older readers must refuse the new metadata instead of stripping it during a save.
  // 版本号只能升不能降，且必须取各特性的最大值：早先直接赋值 2，会让「已是更高
  // 版本 + 恰好有分组」的工程被倒标成旧格式，等于给旧读者开了静默降级的口子。
  // 版本 3 = 图层级 editorOnly（参考框）；旧应用会明确报「不支持的底图工程版本」，
  // 而不是把参考框当普通图层印出去。
  // 版本 4 = 图形渐变 fillPaint / 阴影 shadow。
  // 版本 5 = 变量图（按名单配图列逐行换照片）。
  // 版本 6 = 混合模式 blend / 图片颜色调整 adjust / 组透明度 groups.opacity。
  // 版本 7 = 图片图层的描边 stroke/strokeWidth 与投影 shadow（按 alpha 的 drop-shadow）。
  //   旧应用读到它必须明确报「不支持的底图工程版本」——否则描边/投影会被静默剥掉，
  //   用户拿到的是一张**缺了白边**的证件照，而两边都不报错。
  let version = doc.schemaVersion || 1
  if (result.groups.length || result.guides.length) version = Math.max(version, 2)
  if (result.layers.some(layer => layer.editorOnly)) version = Math.max(version, 3)
  if (result.artboard.backgroundPaint || result.layers.some(layer => layer.fillPaint || (layer.shadow && layer.type !== 'image'))) version = Math.max(version, 4)
  if (result.layers.some(layer => layer.variable)) version = Math.max(version, 5)
  if (result.layers.some(layer => layer.blend !== 'normal' || layer.adjust !== undefined) || result.groups.some(group => group.opacity !== 1)) version = Math.max(version, 6)
  if (result.layers.some(layer => layer.type === 'image' && (layer.shadow !== undefined || layer.strokeWidth !== undefined))) version = Math.max(version, 7)
  result.schemaVersion = version
  // Record uploaded fonts so a missing file cannot silently become a system fallback.
  const fontAssets = object(doc.fontAssets === undefined ? {} : doc.fontAssets, '字体素材表')
  if (Object.keys(fontAssets).length > LIMITS.layers) throw new Error('字体素材数量超限')
  result.fontAssets = {}
  for (const [family, file] of Object.entries(fontAssets)) {
    string(family, '', 150, '字体名称')
    if (['__proto__', 'constructor', 'prototype'].includes(family) || typeof file !== 'string' || file.length > 200 || !/^[^/\\\x00-\x1f]+\.(ttf|otf|ttc|woff2?)$/i.test(file)) throw new Error('字体素材路径无效')
    result.fontAssets[family] = file
  }
  if (!result.name) throw new Error('工程名称不能为空')
  if (!Number.isInteger(result.revision)) throw new Error('工程版本必须是整数')
  if (doc.id !== undefined && doc.id !== '') result.id = token(doc.id, '工程标识')
  for (const key of ['createdAt', 'updatedAt']) if (doc[key] !== undefined) result[key] = string(doc[key], '', 40, key)
  return result
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// Safe both in a style element and an HTML style attribute after escapeHtml.
function cssString(value) {
  return '"' + String(value).replace(/[\\"<>\r\n\f]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ') + '"'
}
/**
 * 工程里用到的字体族。
 *
 * 默认**全量**口径（包含 `editorOnly` 图层）：`designs.cjs` 靠它判断「这个字体还有
 * 没有工程在用」，收窄了就会把编辑器里仍在用的字体当孤儿清掉。
 * 只有渲染器传 `includeEditorOnly: false` 时才收窄成「本次真的会印出来的字体」——
 * 否则参考框引用的上传字体一旦被删，会以「字体加载失败」阻断整批出片，而它根本
 * 不会出现在成品上。
 */
function collectFontFamilies(doc, options = {}) {
  const includeEditorOnly = options.includeEditorOnly !== false
  return [...new Set((doc.layers || []).filter(l => l.type === 'text' && l.fontFamily && (includeEditorOnly || !l.editorOnly)).map(l => l.fontFamily))]
}
function imageDpi(layer, asset) {
  if (!asset || !layer || !(layer.w > 0) || !(layer.h > 0)) return 0
  const crop = layer.crop || { w: 1, h: 1 }
  return Math.min(asset.width * crop.w / layer.w, asset.height * crop.h / layer.h) * 25.4
}
/**
 * 图片颜色调整 → CSS filter 串。
 *
 * 只输出**非恒等**的那几项：全默认时返回空串，DOM 里一个字符都不多——存量工程
 * 与关闭调整时的渲染结果与升级前逐字节一致。Chromium 的 print 管线同样支持
 * filter，所以画布 / PDF / PNG 导出 / 打印四处同源。
 */
function filterOf(adjust) {
  if (!adjust) return ''
  const parts = []
  if (adjust.brightness !== 1) parts.push(`brightness(${adjust.brightness})`)
  if (adjust.contrast !== 1) parts.push(`contrast(${adjust.contrast})`)
  if (adjust.saturate !== 1) parts.push(`saturate(${adjust.saturate})`)
  if (adjust.grayscale > 0) parts.push(`grayscale(${adjust.grayscale})`)
  if (adjust.invert > 0) parts.push(`invert(${adjust.invert})`)
  return parts.length ? `filter:${parts.join(' ')}` : ''
}

/**
 * 渲染底图工程。
 *
 * `includeEditorOnly` 默认 false ⇒ 出片（打印 / PDF）、PNG 导出、归档快照一律不含
 * `editorOnly` 图层。只有编辑器画布显式传 true，才能看见并对齐参考框。默认值就是
 * 安全值：漏传选项的后果是「参考框不显示」，而不是「参考框被印出去」。
 */
function renderDesign(input, options = {}) {
  const doc = normalizeDesign(input)
  const prefix = token(options.classPrefix || 'design', '样式前缀')
  const includeEditorOnly = options.includeEditorOnly === true
  const geometryOnly = options.geometryOnly === true
  const assetUrl = options.assetUrl || (asset => `pp://media/${asset.path}`)
  const family = options.fontFamily || (name => name)
  const css = [`.${prefix}-root{position:relative;box-sizing:border-box;overflow:hidden;width:${doc.artboard.w}mm;height:${doc.artboard.h}mm;background:${doc.artboard.background};isolation:isolate}`, `.${prefix}-layer{position:absolute;box-sizing:border-box;margin:0;padding:0;transform-origin:center center}`, `.${prefix}-image{position:absolute;background-size:100% 100%;background-repeat:no-repeat}`]
  const scope = `pp_effect_${++renderScope}`
  let effectIndex = 0
  const nextEffectId = () => `${scope}_${effectIndex++}`
  const boardBackground = doc.artboard.backgroundPaint ? (() => {
    const id = nextEffectId(), p = doc.artboard.backgroundPaint, e = linearEndpoints(doc.artboard.w, doc.artboard.h, p.angle)
    return `<svg class="${prefix}-board-paint" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.artboard.w} ${doc.artboard.h}" preserveAspectRatio="none"><defs>${gradientMarkup(id, p, e)}</defs><rect width="${doc.artboard.w}" height="${doc.artboard.h}" fill="url(#${id})"/></svg>`
  })() : ''
  // 组透明度乘算：组在本 schema 里是单层扁平结构（每个图层至多属于一个组），
  // 所以「组透明度 × 图层透明度」一次乘法即可，不需要递归求祖先链。
  // 渲染侧在图层样式里直接乘出结果，组元数据本身不产生 DOM 包裹层。
  const groupOpacity = new Map()
  for (const g of doc.groups || []) for (const id of g.layerIds) groupOpacity.set(id, g.opacity)
  const assetClasses = new Map()
  const fragments = doc.layers.filter(l => l.visible && (includeEditorOnly || !l.editorOnly)).map(l => {
    let body = ''
    const effectiveOpacity = Math.min(1, Math.max(0, l.opacity * (groupOpacity.get(l.id) ?? 1)))
    /*
     * 烘焙覆盖（契约 I-50）：带 CSS `filter` 或 `drop-shadow` 的固定图片会让 Chromium
     * **每页各栅格化一份**（A4 满版 19.67 MB/页 ⇒ 500 页约 9.8 GB）。出片前那一层已经被
     * 烘成一张 PNG（连旋转/裁切/翻转/调整/投影/描边一起），这里就把它当**全素的轴对齐图片**画，
     * 于是回到「复用同一份 XObject」。
     *
     * `opacity` 与 `blend` **不烘进像素**、留在替换层上——两者都被实测证明不破坏复用，
     * 而且留在外层才能让「组透明度 × 图层透明度」只生效一次（烘进去再乘一遍会变暗）。
     * 这是渲染期覆盖，不动存盘 schema（与变量图的 `photoUrl` 同一个模式）。
     */
    const baked = (l.type === 'image' && !l.variable) ? options.bakedLayer?.(l) : null
    const style = baked
      ? [`left:${baked.x}mm`, `top:${baked.y}mm`, `width:${baked.w}mm`, `height:${baked.h}mm`, `opacity:${effectiveOpacity}`]
      : [`left:${l.x}mm`, `top:${l.y}mm`, `width:${l.w}mm`, `height:${l.h}mm`, `transform:rotate(${l.rotation}deg)`, `opacity:${effectiveOpacity}`]
    if (l.blend && l.blend !== 'normal') style.push(`mix-blend-mode:${l.blend}`)
    // 图片图层的描边与投影（v0.7 §6）。两条都**不碰几何**，这是刻意的：
    // - 描边走一个**叠层元素** + `inset box-shadow`，画在框的内侧。
    //   ⚠️ 别图省事用 `outline`：**Chromium 把 outline 画在定位子元素之下**，图片正好铺满
    //   整个框，于是整圈描边被盖住、只在右/下边缘漏出约 0.2mm（实测 300dpi 下就是 2px）。
    //   这不是理论推演，是出真图读真像素量出来的——`test/design-export-e2e.cjs` 里有断言。
    //   也别用 `border`：会挤掉内容盒，可见源区域的比例与帧比例不再相等 ⇒ 等于把照片拉长。
    // - 投影走 `filter: drop-shadow()`，**按图层 alpha 走**。别图省事用 `box-shadow`：
    //   后者按包围盒投，一张抠过底的签名图会被投出一个方盒。
    if (l.type === 'image' && !baked) {
      if (l.shadow) style.push(`filter:drop-shadow(${l.shadow.dxMm}mm ${l.shadow.dyMm}mm ${l.shadow.blurMm}mm ${withAlpha(l.shadow.color, l.shadow.opacity)})`)
    }
    // 变量图：`border-radius` 留在图层外框上（描边的 `outline` 要跟着圆角走），
    // 但**裁剪交给内层**——外框一旦自己也 `overflow:hidden`，投影就有被自身裁掉的风险，
    // 而「描边 + 投影」正是证件照衬边最常见的组合，不能赌浏览器的裁剪语义。
    if (l.type === 'image' && l.variable) {
      const url = options.photoUrl?.(l)
      const photoStyle = options.photoStyle?.(l)
      const fit = photoStyle?.fit || l.fit
      const focal = photoStyle?.focal || l.focal
      style.push(`border-radius:${l.radius}mm`)
      const clip = `position:absolute;inset:0;overflow:hidden;border-radius:${l.radius}mm`
      const filter = filterOf(l.adjust)
      if (url) body = `<div style="${clip}"><img data-photo-column="${escapeHtml(l.bindColumn)}" data-photo-layer-id="${escapeHtml(l.id)}" src="${escapeHtml(url)}" style="display:block;width:100%;height:100%;object-fit:${fit};object-position:${focal.x * 100}% ${focal.y * 100}%${filter ? `;${filter}` : ''}"></div>`
      else if (url !== null && options.showPhotoPlaceholder) body = `<div style="${clip}"><div style="box-sizing:border-box;width:100%;height:100%;border:0.3mm dashed #987b57;background:#eee7d9;display:flex;align-items:center;justify-content:center;text-align:center;color:#725a3c;font:10pt sans-serif;overflow:hidden">变量图<br>按名单配图列匹配</div></div>`
      else if (url !== null && options.requirePhotos) throw new Error(`变量图未关联照片：${l.bindColumn}`)
    } else if (l.type === 'image') {
      if (baked) {
        /*
         * 烘焙层：效果已在像素里，这里只把那张 PNG 铺满外框（外框已是烘焙后的轴对齐外接框）。
         *
         * ⚠️ 两个必须写全、否则「看着替换成功、其实整张图丢了」的点：
         * ① `escapeHtml` 包住整个 style 值——`cssString` 返回的是**带双引号**的 `"pp://…"`，
         *    直接拼进 `style="…"` 会让属性在 url( 之后就提前闭合，`background-image` 变成
         *    非法声明被整条丢掉，而 `data-design-baked` 还在、filter 也不残留 ⇒ 断言全过、
         *    PDF 里一张图都没有。实测就是这么安静地丢的（0 个图片对象、还不报错）。
         * ② `position:absolute;inset:0` 必须内联写死，不能指望 `-image` 那个类：
         *    `geometryOnly` 模式**不输出任何 CSS**（css 为空串），靠类名定位的层会退化成
         *    「auto 尺寸的零面积块」⇒ 同样是一张图都不出。
         */
        const bakedStyle = `position:absolute;inset:0;background-image:url(${cssString(baked.url)});background-size:100% 100%;background-repeat:no-repeat`
        body = `<div class="${prefix}-image" data-design-baked="${escapeHtml(l.id)}" style="${escapeHtml(bakedStyle)}"></div>`
      } else {
        let cls = assetClasses.get(l.assetId)
        if (!cls) {
          cls = `${prefix}-asset-${assetClasses.size}`
          assetClasses.set(l.assetId, cls)
          if (!geometryOnly) css.push(`.${cls}{background-image:url(${cssString(assetUrl(doc.assets[l.assetId]))})}`)
        }
        const c = l.crop
        const filter = filterOf(l.adjust)
        body = `<div style="position:absolute;inset:0;overflow:hidden;transform:scale(${l.flipX ? -1 : 1},${l.flipY ? -1 : 1})"><div class="${prefix}-image ${cls}" data-design-asset="${escapeHtml(l.assetId)}" style="left:${-c.x / c.w * 100}%;top:${-c.y / c.h * 100}%;width:${100 / c.w}%;height:${100 / c.h}%${filter ? `;${filter}` : ''}"></div></div>`
      }
    } else if (l.type === 'text') {
      const fam = family(l.fontFamily)
      style.push(`font-family:${fam ? `${cssString(fam)},sans-serif` : DEFAULT_FONT_STACK}`, `font-size:${l.fontSize}pt`, `font-weight:${l.bold ? 700 : 400}`, `line-height:${l.lineHeight}`, `letter-spacing:${l.letterSpacing}pt`, `color:${l.color}`, `text-align:${l.align}`, 'white-space:pre-wrap', 'overflow-wrap:anywhere', 'overflow:hidden')
      body = escapeHtml(l.text)
    } else {
      const sw = Math.min(l.strokeWidth, l.w, l.h)
      const s = sw / 2
      const paintId = l.fillPaint ? nextEffectId() : null
      const shadowId = l.shadow ? nextEffectId() : null
      const fillValue = paintId ? `url(#${paintId})` : l.fill
      const common = `fill="${fillValue}" stroke="${l.stroke}" stroke-width="${sw}"`
      const shape = l.type === 'ellipse'
        ? `<ellipse cx="${l.w / 2}" cy="${l.h / 2}" rx="${(l.w - sw) / 2}" ry="${(l.h - sw) / 2}" ${common}/>`
        : l.type === 'line'
          ? `<line x1="0" y1="${l.h / 2}" x2="${l.w}" y2="${l.h / 2}" ${common}/>`
          : `<rect x="${s}" y="${s}" width="${l.w - sw}" height="${l.h - sw}" rx="${Math.min(l.radius, l.w / 2, l.h / 2)}" ${common}/>`
      const defs = [
        paintId ? gradientMarkup(paintId, l.fillPaint, linearEndpoints(l.w, l.h, l.fillPaint.angle)) : '',
        shadowId ? shadowMarkup(shadowId, l.w, l.h, l.shadow) : '',
      ].join('')
      const shadowShape = shadowId ? shape.replace(/\/>$/, ` filter="url(#${shadowId})"/>`) : ''
      body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${l.w} ${l.h}" width="100%" height="100%" style="display:block;overflow:${shadowId ? 'visible' : 'hidden'}">${defs ? `<defs>${defs}</defs>` : ''}${shadowShape}${shape}</svg>`
    }
    // 图片描边：叠层元素 + `inset box-shadow`（必须压在图片之上，见上面那段注释）。
    // 变量图的圆角在外框上，叠层也要带上同一个 `border-radius`，衬边才会跟着圆角走。
    if (l.type === 'image' && !baked && l.strokeWidth > 0) {
      const radius = l.variable ? `;border-radius:${l.radius}mm` : ''
      body += `<div data-design-stroke="${escapeHtml(l.id)}" style="position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 ${l.strokeWidth}mm ${l.stroke}${radius}"></div>`
    }
    return `<div class="${prefix}-layer" data-design-layer="${escapeHtml(l.id)}" style="${escapeHtml(style.join(';'))}">${body}</div>`
  })
  if (boardBackground && !geometryOnly) css.push(`.${prefix}-board-paint{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}`)
  return { html: `<div class="${prefix}-root">${boardBackground}${fragments.join('')}</div>`, css: geometryOnly ? '' : css.join('\n'), fontFamilies: geometryOnly ? [] : collectFontFamilies(doc, { includeEditorOnly }) }
}

let renderScope = 0
function linearEndpoints(w, h, angle) {
  const rad = angle * Math.PI / 180, dx = Math.cos(rad), dy = Math.sin(rad)
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2
  return { x1: w / 2 - dx * half, y1: h / 2 - dy * half, x2: w / 2 + dx * half, y2: h / 2 + dy * half }
}
function gradientMarkup(id, paint, endpoints) {
  const stops = paint.stops.map(s => `<stop offset="${s.offset}" stop-color="${s.color}" stop-opacity="${s.opacity}"/>`).join('')
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" color-interpolation="sRGB" x1="${endpoints.x1}" y1="${endpoints.y1}" x2="${endpoints.x2}" y2="${endpoints.y2}">${stops}</linearGradient>`
}
function shadowRegion(w, h, shadow) {
  const pad = 4 * shadow.blurMm + 0.25
  return {
    x: Math.min(0, shadow.dxMm) - pad,
    y: Math.min(0, shadow.dyMm) - pad,
    width: w + Math.abs(shadow.dxMm) + 2 * pad,
    height: h + Math.abs(shadow.dyMm) + 2 * pad,
  }
}
function shadowMarkup(id, w, h, shadow) {
  const r = shadowRegion(w, h, shadow)
  return `<filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${shadow.blurMm}" result="blur"/>` +
    `<feOffset in="blur" dx="${shadow.dxMm}" dy="${shadow.dyMm}" result="shift"/>` +
    `<feFlood flood-color="${shadow.color}" flood-opacity="${shadow.opacity}" result="color"/>` +
    '<feComposite in="color" in2="shift" operator="in"/></filter>'
}

module.exports = { normalizeDesign, renderDesign, collectFontFamilies, imageDpi, normalizeFamily, normalizeSource, linearEndpoints, shadowRegion, fitCropToRatio, filterOf, DEFAULT_FONT_STACK, LIMITS, BLEND_MODES, SCHEMA_VERSIONS, CROP_RATIOS }

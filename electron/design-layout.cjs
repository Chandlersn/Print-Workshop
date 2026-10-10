/** Shared by Vue and Node. Physical units are mm; text size and tracking are pt. */
const TYPES = new Set(['image', 'text', 'rect', 'ellipse', 'line'])
const LIMITS = Object.freeze({ layers: 300, assets: 300, artboard: 2000, text: 20000, groups: 150, guides: 100 })

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

function normalizeDesign(input) {
  const doc = object(input, '底图工程')
  if (doc.schemaVersion !== undefined && ![1, 2, 3].includes(doc.schemaVersion)) throw new Error('不支持的底图工程版本')
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
    if (!/^design-assets\/[a-f0-9]{64}\.(png|jpg)$/.test(assetPath)) throw new Error('素材路径不在底图素材目录内')
    assets[id] = { id, path: assetPath, width: number(asset.width, 1, 1, 24000, '图片宽度'), height: number(asset.height, 1, 1, 24000, '图片高度'), name: string(asset.name, '图片', 200, '素材名称'), mime: asset.mime }
    if (!['image/png', 'image/jpeg'].includes(asset.mime)) throw new Error('素材格式无效')
  }
  const ids = new Set()
  const result = {
    schemaVersion: doc.schemaVersion || 1, revision: number(doc.revision, 0, 0, Number.MAX_SAFE_INTEGER, '工程版本'),
    name: string(doc.name, '未命名底图', 120, '工程名称').trim(),
    artboard: { w: number(board.w, 297, 1, LIMITS.artboard, '画布宽度'), h: number(board.h, 210, 1, LIMITS.artboard, '画布高度'), background: color(board.background, '#ffffff') },
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
        // 仅编辑器可见：参考框这类「给用户对齐用、绝不能印出去」的图层。默认 false，
        // 旧工程与所有不传新选项的调用方行为完全不变。渲染侧见 renderDesign。
        editorOnly: bool(l.editorOnly, false, '仅编辑可见'),
      }
      if (l.type === 'image') {
        out.assetId = token(l.assetId, '图层素材标识')
        if (!Object.hasOwn(assets, out.assetId)) throw new Error(`图片图层缺少素材：${out.name}`)
        const crop = l.crop === undefined ? {} : object(l.crop, '裁切区域')
        out.crop = { x: number(crop.x, 0, 0, 1, '裁切 X'), y: number(crop.y, 0, 0, 1, '裁切 Y'), w: number(crop.w, 1, 0.0001, 1, '裁切宽度'), h: number(crop.h, 1, 0.0001, 1, '裁切高度') }
        if (out.crop.x + out.crop.w > 1.00000001 || out.crop.y + out.crop.h > 1.00000001) throw new Error('裁切区域超出原图')
        out.flipX = bool(l.flipX, false, '水平翻转')
        out.flipY = bool(l.flipY, false, '垂直翻转')
      } else if (l.type === 'text') {
        Object.assign(out, {
          text: string(l.text, '文字', LIMITS.text, '图层文字'), fontFamily: string(l.fontFamily, '微软雅黑', 150, '字体名称'),
          fontSize: number(l.fontSize, 24, 1, 1000, '字号'), bold: bool(l.bold, false, '粗体'), color: color(l.color, '#222222'),
          align: l.align === undefined ? 'left' : l.align, lineHeight: number(l.lineHeight, 1.2, 0.5, 5, '行距'), letterSpacing: number(l.letterSpacing, 0, -100, 200, '字距'),
        })
        if (!['left', 'center', 'right'].includes(out.align)) throw new Error('文字对齐方式无效')
      } else {
        Object.assign(out, { fill: color(l.fill, l.type === 'line' ? 'transparent' : '#eeeeee'), stroke: color(l.stroke, '#333333'), strokeWidth: number(l.strokeWidth, 0.3, 0, 100, '描边宽度'), radius: number(l.radius, 0, 0, 1000, '圆角') })
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
    return { id, name, layerIds }
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
  let version = doc.schemaVersion || 1
  if (result.groups.length || result.guides.length) version = Math.max(version, 2)
  if (result.layers.some(layer => layer.editorOnly)) version = Math.max(version, 3)
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
  const assetUrl = options.assetUrl || (asset => `pp://media/${asset.path}`)
  const family = options.fontFamily || (name => name)
  const css = [`.${prefix}-root{position:relative;box-sizing:border-box;overflow:hidden;width:${doc.artboard.w}mm;height:${doc.artboard.h}mm;background:${doc.artboard.background};isolation:isolate}`, `.${prefix}-layer{position:absolute;box-sizing:border-box;margin:0;padding:0;transform-origin:center center}`, `.${prefix}-image{position:absolute;background-size:100% 100%;background-repeat:no-repeat}`]
  const assetClasses = new Map()
  const fragments = doc.layers.filter(l => l.visible && (includeEditorOnly || !l.editorOnly)).map(l => {
    let body = ''
    const style = [`left:${l.x}mm`, `top:${l.y}mm`, `width:${l.w}mm`, `height:${l.h}mm`, `transform:rotate(${l.rotation}deg)`, `opacity:${l.opacity}`]
    if (l.type === 'image') {
      let cls = assetClasses.get(l.assetId)
      if (!cls) {
        cls = `${prefix}-asset-${assetClasses.size}`
        assetClasses.set(l.assetId, cls)
        css.push(`.${cls}{background-image:url(${cssString(assetUrl(doc.assets[l.assetId]))})}`)
      }
      const c = l.crop
      body = `<div style="position:absolute;inset:0;overflow:hidden;transform:scale(${l.flipX ? -1 : 1},${l.flipY ? -1 : 1})"><div class="${prefix}-image ${cls}" data-design-asset="${escapeHtml(l.assetId)}" style="left:${-c.x / c.w * 100}%;top:${-c.y / c.h * 100}%;width:${100 / c.w}%;height:${100 / c.h}%"></div></div>`
    } else if (l.type === 'text') {
      const fam = family(l.fontFamily)
      style.push(`font-family:${fam ? `${cssString(fam)},sans-serif` : DEFAULT_FONT_STACK}`, `font-size:${l.fontSize}pt`, `font-weight:${l.bold ? 700 : 400}`, `line-height:${l.lineHeight}`, `letter-spacing:${l.letterSpacing}pt`, `color:${l.color}`, `text-align:${l.align}`, 'white-space:pre-wrap', 'overflow-wrap:anywhere', 'overflow:hidden')
      body = escapeHtml(l.text)
    } else {
      const sw = Math.min(l.strokeWidth, l.w, l.h)
      const s = sw / 2
      const common = `fill="${l.fill}" stroke="${l.stroke}" stroke-width="${sw}"`
      const shape = l.type === 'ellipse'
        ? `<ellipse cx="${l.w / 2}" cy="${l.h / 2}" rx="${(l.w - sw) / 2}" ry="${(l.h - sw) / 2}" ${common}/>`
        : l.type === 'line'
          ? `<line x1="0" y1="${l.h / 2}" x2="${l.w}" y2="${l.h / 2}" ${common}/>`
          : `<rect x="${s}" y="${s}" width="${l.w - sw}" height="${l.h - sw}" rx="${Math.min(l.radius, l.w / 2, l.h / 2)}" ${common}/>`
      body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${l.w} ${l.h}" width="100%" height="100%" style="display:block">${shape}</svg>`
    }
    return `<div class="${prefix}-layer" data-design-layer="${escapeHtml(l.id)}" style="${escapeHtml(style.join(';'))}">${body}</div>`
  })
  return { html: `<div class="${prefix}-root">${fragments.join('')}</div>`, css: css.join('\n'), fontFamilies: collectFontFamilies(doc, { includeEditorOnly }) }
}

module.exports = { normalizeDesign, renderDesign, collectFontFamilies, imageDpi, normalizeFamily, DEFAULT_FONT_STACK, LIMITS }

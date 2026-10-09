/**
 * 渲染引擎：模板 × 记录 → 可打印 HTML（一记录一页）。
 *
 * 从 workbench server/print/routes.py 的 build_html 移植，输出语义保持一致：
 * - 字段百分比坐标 + translateX 对齐修正（不指定宽度也能居中/右对齐准确）
 * - 字号单位 pt，@page 毫米尺寸，page-break-after 分页
 * 与源项目的差异点：底图/上传字体走 pp:// 协议读本地数据目录（无 HTTP 服务器）。
 */
const fs = require('fs')
const fonts = require('./fonts.cjs')
const { resolveInsideDataDir } = require('./store.cjs')
const { PAGE_SIZES } = require('./templates.cjs')

// 媒体根目录（主进程启动即设定；测试也会注入）。文件缺失时回退到 pp://。
const DATA_DIR = process.env.PRINTPRESS_DATA_DIR

/**
 * 媒体文件相对路径 → base64 data URI，内联进 HTML。
 *
 * 为什么要内联（而非继续用 pp://media/...）：
 * - 渲染产物（直打 HTML / PDF / 归档快照）会在三种上下文被消费：
 *   ① 打印/导出用的隐藏窗口，以 `data:text/html` 加载 → 从该 opaque origin
 *      请求 pp:// 资源会被浏览器拦截，底图直接丢；
 *   ② 归档快照经 `shell.openPath` 在**系统默认浏览器**打开，pp:// 在浏览器里
 *      是无意义协议，底图、字体全失；
 *   ③ 内联后产物完全自包含，上述上下文一律正常，且快照可长期独立留存。
 * 文件不存在（被手动删/测试夹具未建）时回退 pp://，保持历史口径、缺图不崩。
 */
function mimeFor(rel) {
  const ext = String(rel).split('.').pop().toLowerCase()
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection',
    woff: 'font/woff', woff2: 'font/woff2',
  }
  return map[ext] || 'application/octet-stream'
}

function readMediaFile(rel) {
  if (!DATA_DIR || !rel) return null
  try {
    const abs = resolveInsideDataDir(String(rel).replace(/\\/g, '/'))
    if (!fs.existsSync(abs)) return null
    return fs.readFileSync(abs)
  } catch {
    return null
  }
}

/** 媒体相对路径 → 内联 data URI；文件缺失回退 pp:// */
function inlineUrl(rel) {
  const buf = readMediaFile(rel)
  if (!buf) return mediaUrl(rel)
  return `data:${mimeFor(rel)};base64,${buf.toString('base64')}`
}

// 扩展名 → @font-face format（与 workbench _FONT_FORMAT 一致，补 ttc）
const FONT_FORMATS = {
  ttf: 'truetype',
  otf: 'opentype',
  ttc: 'collection',
  woff: 'woff',
  woff2: 'woff2',
}

function escapeHtml(v) {
  const s = v === null || v === undefined ? '' : String(v)
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 数据目录相对路径 → pp:// URL。文件名分段编码，中文文件名可用 */
function mediaUrl(rel) {
  return 'pp://media/' + String(rel).replace(/\\/g, '/').split('/')
    .map(encodeURIComponent).join('/')
}

/**
 * 数值钳制：坐标/字号都来自可被手工编辑的 JSON，越界会让版式计算失真
 * （实测 itemW=0.001 时 perPage 达 6.2e10）或让 Chromium 排版卡死。
 * 渲染层 UI 已有同样的范围限制（颜色/字号输入框），这里是主进程侧的兜底。
 */
function clampNum(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/** 颜色白名单：渲染层本就是 <input type="color">，只会产出 #rgb/#rrggbb */
function safeColor(v) {
  const s = String(v == null ? '' : v).trim()
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : ''
}

/**
 * 字段定位样式（与 workbench _field_style 语义一致）。
 * 居中/右对齐用 translate 修正，因此不需要指定宽度。
 *
 * 安全：这里拼的是 `style="..."` 属性值，而模板 JSON 是用户可触达的文件。
 * 属性值里出现一个 `"` 就能闭合属性、注入任意标签，且该 HTML 会被预览 iframe
 * 与打印窗口渲染——所以每个拼进去的值都必须先钳制/转义，不能裸拼。
 */
function fieldStyle(f) {
  const x = clampNum(f.x, 0, 100, 0)
  const y = clampNum(f.y, 0, 100, 0)
  const rawAlign = f.align || 'center'
  const align = ['left', 'center', 'right'].includes(rawAlign) ? rawAlign : 'center'
  const parts = [`left:${x}%;`, `top:${y}%;`]
  if (align === 'center') parts.push('transform:translateX(-50%);')
  else if (align === 'right') parts.push('transform:translateX(-100%);')
  const fontSize = clampNum(f.fontSize, 1, 500, 12)
  if (fontSize) parts.push(`font-size:${fontSize}pt;`)
  if (f.bold) parts.push('font-weight:bold;')
  const color = safeColor(f.color)
  if (color) parts.push(`color:${color};`)
  if (f.fontFamily) {
    // 用与 @font-face 声明相同的规范化，保证字段引用的名字能被匹配上
    const fam = normalizeFamily(f.fontFamily)
    if (fam) parts.push(`font-family:'${fam}';`)
  }
  parts.push(`text-align:${align};`)
  // 此返回值写进 HTML 属性；字体名中的 &copy 等合法文件名片段不能被当成实体解码。
  return escapeHtml(parts.join(''))
}

/**
 * family 名规范化：上传文件名里可能带引号等 CSS 语法字符（`测试'楷体.ttf`），
 * 而模板里存的往往也是用户手输的原名。@font-face 声明与字段引用必须归一到
 * 同一个字符串，否则字体声明存在却匹配不上（表现为「字体没生效」）。
 * 剔除集：引号、反斜杠、分号、大括号、圆括号——它们在 CSS 字符串内有语法意义。
 */
const normalizeFamily = fonts.normalizeFamily

/**
 * 为已上传字体生成 @font-face（family 名 = 去扩展名文件名，画布与渲染共用）。
 * @param {string[]} [onlyFamilies] 只输出这些 family —— 传入模板实际用到的字体集合，
 *   避免把用户上传的每一个字体都 base64 内联进每份 HTML（实测 4 个 3MB 字体
 *   会让单份 HTML 膨胀到 16MB，且出片要构建 preview + snapshot 两份）。
 */
function fontFaceCss(onlyFamilies) {
  const want = Array.isArray(onlyFamilies)
    ? new Set(onlyFamilies.map(normalizeFamily).filter(Boolean))
    : null
  const rules = []
  for (const f of fonts.uploadedFonts()) {
    const fam = normalizeFamily(f.family)
    if (!fam) continue
    if (want && !want.has(fam)) continue
    const ext = f.file.split('.').pop().toLowerCase()
    const fmt = FONT_FORMATS[ext]
    if (!fmt) continue
    rules.push(`@font-face { font-family:'${fam}'; src:url('${inlineUrl('print-fonts/' + f.file)}') format('${fmt}'); }`)
  }
  return rules.join('\n')
}

/** 固定版本的底图必须与实际成品同尺寸，禁止在拼版回退时悄悄拉伸。 */
function resolveTemplateDesign(template) {
  if (!template.backgroundDesign) return null
  if (template.background) throw new Error('模板不能同时使用图片底图和图层工程底图')
  const ref = template.backgroundDesign
  if (!ref.id || !Number.isInteger(ref.revision) || ref.revision < 1) {
    throw new Error('底图工程必须引用已保存的固定版本')
  }
  const doc = require('./designs.cjs').resolveDesign(ref)
  const spec = pageSpec(template.pageSize)
  const layout = resolveLayout(template.layout, spec)
  if (template.layout?.mode === 'grid' && !layout.enabled) {
    throw new Error('底图工程无法应用：当前纸张放不下有效多联版式，请调整纸张或成品尺寸')
  }
  const w = layout.enabled ? layout.itemW : spec.w
  const h = layout.enabled ? layout.itemH : spec.h
  if (Math.abs(doc.artboard.w - w) > 0.01 || Math.abs(doc.artboard.h - h) > 0.01) {
    throw new Error(`底图工程尺寸 ${doc.artboard.w}×${doc.artboard.h}mm 与成品 ${w}×${h}mm 不一致，请调整工程或成品尺寸`)
  }
  return doc
}

/** 一次批量任务共用经过校验的静态工程资源，预览与归档不重复读取大图。 */
function prepareTemplateDesign(template) {
  const design = resolveTemplateDesign(template)
  if (!design) return { html: '', css: '', fontFamilies: [], info: null }
  const { renderDesign, imageDpi } = require('./design-layout.cjs')
  const rendered = renderDesign(design, {
    classPrefix: 'print-design',
    fontFamily: normalizeFamily,
    assetUrl: (asset) => {
      const bytes = readMediaFile(asset.path)
      if (!bytes) throw new Error(`底图素材缺失或无法读取：${asset.name || asset.path}`)
      return `data:${mimeFor(asset.path)};base64,${bytes.toString('base64')}`
    },
  })
  const dpi = design.layers.filter((layer) => layer.visible && layer.opacity > 0 && layer.type === 'image')
    .map((layer) => imageDpi(layer, design.assets[layer.assetId]))
  return { ...rendered, info: { name: design.name, revision: design.revision, layerCount: design.layers.length, minDpi: dpi.length ? Math.min(...dpi) : null } }
}

// 未知纸张的回退默认显式命名，不依赖数组顺序（顺序只管下拉展示）
const DEFAULT_PAGE_ID = 'a4-landscape'

/**
 * 纸张规格解析。**兼容两种存法**：
 * - 字符串 id（早期调用 / 单元测试）
 * - 对象 `{ id, w, h }`——模板里存的就是对象，且上传非标准比例底图时会存 `id: 'custom'`
 *
 * 早期只按字符串比对，导致传对象时永远匹配不上、静默回退成 A4 横版：
 * 竖版模板与自定义纸张都会被渲染成 297×210。此处按对象优先取真实尺寸。
 */
function pageSpec(pageSize) {
  if (pageSize && typeof pageSize === 'object') {
    const hit = PAGE_SIZES.find((p) => p.id === pageSize.id)
    if (hit) return hit
    const w = Number(pageSize.w)
    const h = Number(pageSize.h)
    if (w > 0 && h > 0) {
      return { id: pageSize.id || 'custom', name: pageSize.name || '自定义', w, h }
    }
  }
  return PAGE_SIZES.find((p) => p.id === pageSize)
    || PAGE_SIZES.find((p) => p.id === DEFAULT_PAGE_ID)
    || PAGE_SIZES[0]
}

/**
 * 版式解析（纯函数，模板页 / 渲染引擎 / 打印中心共用同一口径）。
 *
 * 三种版式：
 * - single：一记录一页，字段坐标相对整页。
 * - grid：底图在多联模式下代表「单个成品图」，用户给出成品尺寸（mm），
 *   系统按纸张算出能放几列几行，并把网格在纸张上居中（四周留边）。
 *   放不下 2 个成品时退回单页（enabled=false，附 reason 供 UI 提示）。
 * - fold（对折桌牌）：一页 = 一条记录 × 上下两个镜像半页，沿水平中线对折即成
 *   双面台签——不依赖打印机双面功能。半页即成品（宽=纸宽，高=纸高一半），
 *   无需成品尺寸输入；字段坐标相对半页，上联自动旋转 180°。
 */
function resolveLayout(layout, spec) {
  if (!layout || layout.mode === 'single') return { enabled: false }
  if (layout.mode === 'fold') {
    return {
      enabled: true,
      fold: true,
      cols: 1,
      rows: 2,
      itemW: spec.w, // 半页宽 = 纸宽（validateBatch 超宽估算的容器口径与渲染一致）
      itemH: spec.h / 2,
      offsetX: 0,
      offsetY: 0,
      perPage: 1, // 一页一条记录（上下联同内容互为镜像，不是两条记录）
      showCutMarks: false, // 只有折线，没有裁切线
    }
  }
  if (layout.mode !== 'grid') return { enabled: false }
  const itemW = Number(layout.itemW)
  const itemH = Number(layout.itemH)
  if (!(itemW > 0) || !(itemH > 0)) return { enabled: false, reason: '成品尺寸未填写' }
  const cols = Math.floor(spec.w / itemW)
  const rows = Math.floor(spec.h / itemH)
  if (cols < 1 || rows < 1 || cols * rows < 2) {
    return {
      enabled: false,
      // 回退必须带 reason：上层要把这句话透传到打印中心界面，
      // 否则「配了多联却按单页出片」对用户完全静默（纸张改小/成品改大就会触发）
      reason: `纸张 ${spec.w}×${spec.h}mm 放不下 2 个 ${Math.round(itemW)}×${Math.round(itemH)}mm 的成品，已按单页出片`,
    }
  }
  // 每页格数上限：成品尺寸被改到极小值时 cols*rows 会爆到 1e10 量级，
  // 页数报告与渲染循环都会失真（实测 itemW=0.001 → perPage 62370000000）
  const MAX_PER_PAGE = 400
  if (cols * rows > MAX_PER_PAGE) {
    return { enabled: false, reason: `每页将排 ${cols * rows} 个成品（上限 ${MAX_PER_PAGE}），成品尺寸可能过小，已按单页出片` }
  }
  return {
    enabled: true,
    cols,
    rows,
    itemW,
    itemH,
    offsetX: (spec.w - cols * itemW) / 2,
    offsetY: (spec.h - rows * itemH) / 2,
    perPage: cols * rows,
    showCutMarks: layout.showCutMarks !== false,
  }
}

/**
 * 底图 + 字段叠加 → 一份含 N 页的可打印 HTML。
 * withToolbar=true 时带浏览器打印工具条（供归档快照在浏览器里回看）；
 * Electron 内部打印/PDF 通道应传 false。
 *
 * 单页模式（默认）：一记录一页，字段坐标相对整页。
 * 多联模式：一页 M×N 格，一格一条记录；**字段坐标相对格子**，底图铺满每格，
 *           故同一套排版在每格重复——输出契约（页数 × 纸张）不变。
 * 对折模式（fold）：一记录一页，页内上下两个镜像半页，字段坐标相对半页。
 */
function buildHtml(template, records, { withToolbar = true, preparedDesign } = {}) {
  const spec = pageSpec(template.pageSize)
  const widthMm = spec.w
  const heightMm = spec.h
  const bg = template.background ? inlineUrl(template.background) : ''
  const fields = (template.fields || [])
    .filter((f) => f.column || f.key) // column 为权威属性，key 是旧版 UI 的存法（兼容读取）
  const layout = resolveLayout(template.layout, spec)
  const designOutput = preparedDesign || prepareTemplateDesign(template)

  const fieldsHtml = (rec) => designOutput.html + fields
    .map((f) => `<div class="pf" style="${fieldStyle(f)}">${escapeHtml(rec[f.column || f.key])}</div>`)
    .join('')

  let pages
  if (layout.enabled && layout.fold) {
    // 对折桌牌：上联旋转 180°（对折后从背面读是正的），下联正排，中线画折线。
    // 上下联同一条记录——打印后沿折线对折，两面都能读
    pages = records.map((rec) => {
      const inner = fieldsHtml(rec)
      return `<div class="page">`
        + `<div class="fold-half flip">${inner}</div>`
        + `<div class="fold-half">${inner}</div>`
        + `<div class="fold-line"></div>`
        + `</div>`
    })
  } else if (layout.enabled) {
    const chunks = []
    for (let i = 0; i < records.length; i += layout.perPage) {
      chunks.push(records.slice(i, i + layout.perPage))
    }
    // 只渲染「有记录」的格子：空格子若铺上底图会印出空白卡片；
    // 每格位置仍由自身序号推出，所以末页不满时位置依然正确
    pages = chunks.map((chunk) => {
      const cells = chunk.map((rec, k) => {
        const cx = layout.offsetX + (k % layout.cols) * layout.itemW
        const cy = layout.offsetY + Math.floor(k / layout.cols) * layout.itemH
        return `<div class="cell${layout.showCutMarks ? ' cut' : ''}" style="`
          + `left:${cx}mm;top:${cy}mm;width:${layout.itemW}mm;height:${layout.itemH}mm;`
          + `">${fieldsHtml(rec)}</div>`
      })
      return `<div class="page">${cells.join('')}</div>`
    })
  } else {
    pages = records.map((rec) => `<div class="page">${fieldsHtml(rec)}</div>`)
  }

  // 只内联本模板实际用到的字体：全部内联会让单份 HTML 随字体库无限膨胀（实测 16MB/份）
  const usedFamilies = [...new Set([...fields.map((f) => f.fontFamily), ...designOutput.fontFamilies].filter(Boolean))]
  const fontCss = fontFaceCss(usedFamilies)
  return [
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n',
    `<title>${escapeHtml(template.name || '打印预览')}</title>\n<style>\n`,
    fontCss ? fontCss + '\n' : '',
    designOutput.css ? designOutput.css + '\n' : '',
    `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }\n`,
    '* { box-sizing: border-box; }\n',
    'body { margin: 0; background: #f0f0f0; }\n',
    // 无工具条 = Electron 预览/打印路径：关闭内部滚动。毫米换算的亚像素累加会先触发
    // 竖向滚动条 → 吃宽度 → 触发横向滚动条 → 互锁裁边；预览滚动由外层容器负责
    withToolbar ? '' : 'html { overflow: hidden; }\n',
    '.page { position: relative; ',
    `width: ${widthMm}mm; height: ${heightMm}mm; `,
    // 多联时底图归每格所有，整页不再铺底图
    !layout.enabled && bg ? `background-image: url('${bg}'); background-size: 100% 100%; ` : '',
    'background-repeat: no-repeat; page-break-after: always; overflow: hidden; }\n',
    '.page:last-child { page-break-after: auto; }\n',
    // 多联格子：底图铺满一格，字段以格子为定位参照系（.cell 是 absolute，成为 .pf 的包含块）。
    // 底图放在 .cell 类里（只写一次），而非逐格内联，避免大图在多页多格时重复膨胀 HTML。
    '.cell { position: absolute; overflow: hidden; background-repeat: no-repeat; '
      + 'background-size: 100% 100%;'
      + (layout.enabled && bg ? ` background-image: url('${bg}');` : '')
      + ' }\n',
    // 裁切线：格边虚线，仅供手工裁切对位（0.2mm 极细，裁掉即不可见）
    '.cell.cut { outline: 0.2mm dashed rgba(0,0,0,0.35); outline-offset: -0.2mm; }\n',
    // 对折桌牌：上下两个半页，上联倒置；fold-line 为折线（对折参考，不裁切）
    '.fold-half { position: absolute; left: 0; width: 100%; height: 50%; overflow: hidden; '
      + 'background-repeat: no-repeat; background-size: 100% 100%;'
      + (layout.enabled && layout.fold && bg ? ` background-image: url('${bg}');` : '')
      + ' }\n',
    '.fold-half.flip { top: 0; transform: rotate(180deg); }\n',
    '.fold-half:not(.flip) { top: 50%; }\n',
    '.fold-line { position: absolute; left: 0; top: 50%; width: 100%; '
      + 'border-top: 0.3mm dashed rgba(0,0,0,0.35); }\n',
    '.pf { position: absolute; white-space: nowrap; }\n',
    '@media print { body { background: #fff; } .no-print { display: none !important; } }\n',
    '</style>\n</head>\n<body>\n',
    withToolbar
      ? '<div class="no-print" style="padding:12px;font:13px/1.6 system-ui;'
        + 'background:#fff8e1;color:#8a6d00;border-bottom:1px solid #ffe082;">'
        + '<button onclick="window.print()" style="margin-right:12px;padding:4px 14px;'
        + 'cursor:pointer;border:1px solid #8a6d00;border-radius:6px;background:#fff;'
        + 'color:#8a6d00;">打印</button>'
        + '请在打印对话框中选择「缩放 = 100%」（或「实际大小」），'
        + '并关闭页眉页脚，否则位置会偏移。'
        + '</div>\n'
      : '',
    pages.join(''),
    '\n</body>\n</html>',
  ].join('')
}

module.exports = {
  escapeHtml,
  mediaUrl,
  fieldStyle,
  fontFaceCss,
  pageSpec,
  resolveLayout,
  resolveTemplateDesign,
  prepareTemplateDesign,
  buildHtml,
}

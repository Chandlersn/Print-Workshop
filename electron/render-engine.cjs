/**
 * 渲染引擎：模板 × 记录 → 可打印 HTML（一记录一页）。
 *
 * 从 workbench server/print/routes.py 的 build_html 移植，输出语义保持一致：
 * - 字段百分比坐标 + translateX 对齐修正（不指定宽度也能居中/右对齐准确）
 * - 字号单位 pt，@page 毫米尺寸，page-break-after 分页
 * 与源项目的差异点：底图/上传字体走 pp:// 协议读本地数据目录（无 HTTP 服务器）。
 */
const fonts = require('./fonts.cjs')
const { PAGE_SIZES } = require('./templates.cjs')

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
 * 字段定位样式（与 workbench _field_style 语义一致）。
 * 居中/右对齐用 translate 修正，因此不需要指定宽度。
 */
function fieldStyle(f) {
  const x = f.x || 0
  const y = f.y || 0
  const align = f.align || 'center'
  const parts = [`left:${x}%;`, `top:${y}%;`]
  if (align === 'center') parts.push('transform:translateX(-50%);')
  else if (align === 'right') parts.push('transform:translateX(-100%);')
  if (f.fontSize) parts.push(`font-size:${f.fontSize}pt;`)
  if (f.bold) parts.push('font-weight:bold;')
  if (f.color) parts.push(`color:${f.color};`)
  if (f.fontFamily) {
    // family 名里的引号直接剥掉（family 可能来自文件名）
    const fam = String(f.fontFamily).replace(/'/g, '').replace(/"/g, '')
    parts.push(`font-family:'${fam}';`)
  }
  parts.push(`text-align:${align};`)
  return parts.join('')
}

/** 为所有已上传字体生成 @font-face（family 名 = 去扩展名文件名，画布与渲染共用） */
function fontFaceCss() {
  const rules = []
  for (const f of fonts.uploadedFonts()) {
    const ext = f.file.split('.').pop().toLowerCase()
    const fmt = FONT_FORMATS[ext]
    if (!fmt) continue
    rules.push(`@font-face { font-family:'${f.family}'; src:url('${mediaUrl('print-fonts/' + f.file)}') format('${fmt}'); }`)
  }
  return rules.join('\n')
}

// 未知纸张的回退默认显式命名，不依赖数组顺序（顺序只管下拉展示）
const DEFAULT_PAGE_ID = 'a4-landscape'

function pageSpec(pageSizeId) {
  return PAGE_SIZES.find((p) => p.id === pageSizeId)
    || PAGE_SIZES.find((p) => p.id === DEFAULT_PAGE_ID)
    || PAGE_SIZES[0]
}

/**
 * 底图 + 字段叠加 → 一份含 N 页的可打印 HTML。
 * withToolbar=true 时带浏览器打印工具条（供归档快照在浏览器里回看）；
 * Electron 内部打印/PDF 通道应传 false。
 */
function buildHtml(template, records, { withToolbar = true } = {}) {
  const spec = pageSpec(template.pageSize)
  const widthMm = spec.w
  const heightMm = spec.h
  const bg = template.background ? mediaUrl(template.background) : ''
  const fields = template.fields || []

  const pages = records.map((rec) => {
    const inner = fields
      .filter((f) => f.column || f.key) // column 为权威属性，key 是旧版 UI 的存法（兼容读取）
      .map((f) => `<div class="pf" style="${fieldStyle(f)}">${escapeHtml(rec[f.column || f.key])}</div>`)
      .join('')
    return `<div class="page">${inner}</div>`
  })

  return [
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n',
    `<title>${escapeHtml(template.name || '打印预览')}</title>\n<style>\n`,
    fontFaceCss() ? fontFaceCss() + '\n' : '',
    `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }\n`,
    '* { box-sizing: border-box; }\n',
    'body { margin: 0; background: #f0f0f0; }\n',
    // 无工具条 = Electron 预览/打印路径：关闭内部滚动。毫米换算的亚像素累加会先触发
    // 竖向滚动条 → 吃宽度 → 触发横向滚动条 → 互锁裁边；预览滚动由外层容器负责
    withToolbar ? '' : 'html { overflow: hidden; }\n',
    '.page { position: relative; ',
    `width: ${widthMm}mm; height: ${heightMm}mm; `,
    bg ? `background-image: url('${bg}'); background-size: 100% 100%; ` : '',
    'background-repeat: no-repeat; page-break-after: always; overflow: hidden; }\n',
    '.page:last-child { page-break-after: auto; }\n',
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

module.exports = { escapeHtml, mediaUrl, fieldStyle, fontFaceCss, pageSpec, buildHtml }

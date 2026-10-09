/**
 * 画布 ↔ 导出 对齐契约（静态守卫 + 值断言）。
 *
 * 守的是用户报过的那类 bug：「模板排版的预览页里字段的位置，和导出的 PDF 不一致，
 * 导出版本会往右漂移一点点」。
 *
 * 根因不是渲染引擎算错，而是**画布盒与渲染盒的定位口径不一致**：
 * 两边都用「盒宽 × anchorRatio」算 translateX 位移（center→0.5 / right→1 / left→0），
 * 所以画布盒宽必须恰好等于文字宽。历史上踩过两次：
 *
 *   ① .field-box 有 `padding: 2px 6px` + `border: 1px dashed`（渲染的 .pf 是 0）
 *      ⇒ 左对齐偏 +6.8px、右对齐反向偏 −6.8px（实测 1.88mm @A4）
 *   ② .field-box 有 `max-width: 90%`，长文本时盒宽被截到 90%
 *      ⇒ translateX 百分比按盒宽算 ⇒ 居中长文本偏 72px、右对齐偏 145px（实测 41.96mm）
 *
 * 这两条都是「画布看着好好的、出片位置不对」的静默故障，肉眼看不出因果关系。
 * 所以这里钉死：**画布字段框只许有定位与字体相关属性，不许有改变盒宽的布局属性**。
 *
 * 运行：node test/canvas-align.cjs
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TPL = 'src/views/TemplateView.vue'
const ENGINE = 'electron/render-engine.cjs'

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}

const tplSrc = fs.readFileSync(path.join(ROOT, TPL), 'utf-8')
const engineSrc = fs.readFileSync(path.join(ROOT, ENGINE), 'utf-8')

/**
 * 取出某个选择器的规则体（取第一个匹配的块）。
 * 两种来源都要能吃：
 *   - .vue 里的多行 CSS：`\n.selector {\n  k: v;\n}`
 *   - render-engine.cjs 里的单行 JS 字符串：`'.pf { position: absolute; ... }'`
 * 所以用 [\s\S]*? 惰性匹配到第一个 `}`，不要求前面有换行。
 */
function cssBlock(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[\\s'"+])${esc}\\s*\\{([\\s\\S]*?)\\}`, 'm')
  const m = src.match(re)
  return m ? m[1] : null
}

console.log('== 1. 画布字段框的盒宽必须恰好等于文字宽 ==')
{
  const body = cssBlock(tplSrc, '.field-box')
  ok(body !== null, '找得到 .field-box 规则', body)

  // 这三条是「盒被撑大/缩小」的直接来源，任何一条回归都会让出片位置漂移
  ok(!/(^|\s|;)\s*padding\s*:/.test(body),
    '.field-box 不许有 padding（会撑大盒宽 ⇒ 左右对齐漂移）', body.match(/padding[^;]*/))
  ok(!/(^|\s|;)\s*border\s*:/.test(body),
    '.field-box 不许有 border（会撑大盒宽 ⇒ 左右对齐漂移）', body.match(/border[^;]*/))
  ok(!/(^|\s|;)\s*border-width\s*:/.test(body),
    '.field-box 不许有 border-width', body.match(/border-width[^;]*/))
  ok(!/(^|\s|;)\s*max-width\s*:/.test(body),
    '.field-box 不许有 max-width（长文本截断盒宽 ⇒ 居中/右对齐大幅漂移）', body.match(/max-width[^;]*/))
  ok(!/(^|\s|;)\s*min-width\s*:/.test(body),
    '.field-box 不许有 min-width', body.match(/min-width[^;]*/))

  // 定位与省略语义必须保留（这是画布能对齐的前提）
  ok(/position\s*:\s*absolute/.test(body), '.field-box 仍是绝对定位')
  ok(/white-space\s*:\s*nowrap/.test(body), '.field-box 仍不换行（与渲染 .pf 一致）')
}

console.log('== 2. 画布盒与渲染盒的关键属性必须同口径 ==')
{
  const boxBody = cssBlock(tplSrc, '.field-box')
  const pfBody = cssBlock(engineSrc, '.pf')
  ok(pfBody !== null, '找得到渲染引擎的 .pf 规则', pfBody)

  // 渲染侧就是 padding:0 / border:0，必须一直保持——若哪天渲染侧加了 padding，
  // 画布也要跟着加，否则今天这条守卫就变成单边约束了
  ok(!/(^|\s|;)\s*padding\s*:/.test(pfBody), '渲染 .pf 无 padding（画布无 padding 的前提）')
  ok(!/(^|\s|;)\s*border\s*:/.test(pfBody), '渲染 .pf 无 border（画布无 border 的前提）')

  // 行高口径：画布写 line-height: normal，渲染不写（默认即 normal）
  const boxLH = /line-height\s*:\s*([^;]+)/.exec(boxBody)
  ok(boxLH && /normal/.test(boxLH[1]),
    '画布 .field-box 的 line-height 是 normal（与渲染一致，避免首行基线不同高）',
    boxLH && boxLH[1].trim())
  ok(!/line-height/.test(pfBody), '渲染 .pf 不设 line-height（默认 normal）')
}

console.log('== 3. 状态样式不许用会改变盒宽的属性 ==')
{
  // hover / selected / nodata / stale / inmulti 都只能用 outline / box-shadow
  for (const sel of ['.field-box:hover', '.field-box.selected', '.field-box.nodata', '.field-box.stale', '.field-box.inmulti']) {
    const body = cssBlock(tplSrc, sel)
    ok(body !== null, `找得到 ${sel} 规则`, body)
    if (!body) continue
    const hasBorderProp = /(^|\s|;)\s*border(-color|-style|-width)?\s*:/.test(body)
    const hasOutline = /(^|\s|;)\s*outline\s*:/.test(body)
    const hasShadow = /(^|\s|;)\s*box-shadow\s*:/.test(body)
    ok(!hasBorderProp,
      `${sel} 不用 border 系属性（border 会改变盒宽，破坏对齐；改用 outline / box-shadow）`,
      body.replace(/\s+/g, ' ').trim())
    ok(hasOutline || hasShadow, `${sel} 用 outline 或 box-shadow 表达状态`)
  }
}

console.log('== 4. 位移口径：画布与渲染都用 anchorRatio × 盒宽 ==')
{
  // 画布侧：fieldStyle 用 translateX(-{shift*100}%)
  const fieldStyle = tplSrc.match(/function fieldStyle\(f\)\s*\{[\s\S]*?\n\}/)
  ok(fieldStyle !== null, '找得到画布 fieldStyle')
  ok(/transform:\s*shift\s*\?\s*`translateX\(-\$\{shift \* 100\}%\)`/.test(fieldStyle[0]),
    '画布用 translateX(-shift×100%) 表达锚点位移', fieldStyle[0].match(/transform[^,]*/))

  // 渲染侧：fieldStyle 用 translateX(-50%) / translateX(-100%)
  ok(/transform:translateX\(-50%\);/.test(engineSrc) && /transform:translateX\(-100%\);/.test(engineSrc),
    '渲染引擎用同一套 translateX 百分比位移（center −50% / right −100%）')

  // 两边都要从同一个纯函数取比例
  ok(/anchorRatio/.test(tplSrc), '画布从 anchorRatio 取锚点比例（唯一权威源）')
  ok(/anchorRatio/.test(fs.readFileSync(path.join(ROOT, 'src/lib/field-layout.cjs'), 'utf-8')),
    'anchorRatio 定义在 src/lib/field-layout.cjs')
}

console.log('== 5. 吸附/对齐数学仍以盒边缘为准（不被本次修改破坏）==')
{
  // 拖拽吸附用 boxW 推边缘；对齐用 alignedX/alignedY 换算回锚点。
  // 盒宽现在等于文字宽，这套数学的输入更准了，但调用方式不许变。
  ok(/const boxW = ownRect\.width/.test(tplSrc), '拖拽取盒宽用 ownRect.width')
  ok(/ratio: anchorRatio\(f\)/.test(tplSrc), '拖拽记录 anchorRatio 供吸附换算')
  const fe = fs.readFileSync(path.join(ROOT, 'src/lib/field-edit.cjs'), 'utf-8')
  ok(/function alignedX\(kind, box, bounds, W, r\)/.test(fe), 'alignedX 仍按「盒边缘 → 锚点」换算')
  ok(/function alignedY\(kind, box, bounds, H\)/.test(fe), 'alignedY 仍按盒边缘换算')
}

console.log('== 6. 上传字体在画布与 PDF 使用同一字体名 ==')
{
  const fontModule = fs.readFileSync(path.join(ROOT, 'electron/fonts.cjs'), 'utf-8')
  const layoutModule = fs.readFileSync(path.join(ROOT, 'electron/design-layout.cjs'), 'utf-8')
  const surfaceSrc = fs.readFileSync(path.join(ROOT, 'src/components/DesignSurface.vue'), 'utf-8')
  const designerSrc = fs.readFileSync(path.join(ROOT, 'src/views/BackgroundDesignerView.vue'), 'utf-8')
  ok(/new FontFace\(font\.cssFamily/.test(tplSrc) && /document\.fonts\.add\(face\)/.test(tplSrc),
    '画布注册并加载上传字体，而不是只在下拉菜单里列出')
  ok(/fontFamily: family \? JSON\.stringify\(family\)/.test(tplSrc),
    '画布字段使用规范化后的字体名')
  ok(/const normalizeFamily = fonts\.normalizeFamily/.test(engineSrc)
    && /cssFamily: normalizeFamily\(family\)/.test(fontModule),
    'PDF 与画布共用同一规范化函数')
  // I-24 字体名规范化只有一处权威实现
  // 原来 fonts.cjs / DesignSurface.vue / BackgroundDesignerView.vue 各写了一份
  // `replace(/['"\\;{}()]/g,'').trim()`；任何一处被改动（比如把 () 从剔除集拿掉）
  // 都会让 @font-face 声明与引用方静默错配——正是本套件第 6 节要防的那类故障。
  const INLINE_RULE = "replace(/['\"\\\\;{}()]/g"
  ok(layoutModule.includes('function normalizeFamily(name)') && layoutModule.includes(INLINE_RULE),
    '规范化实现只留在 design-layout.cjs（零依赖，Vue 与 Node 都能引用）')
  ok(fontModule.includes("const { normalizeFamily } = require('./design-layout.cjs')"),
    'fonts.cjs 复用同一实现而不是再写一份')
  ok(!surfaceSrc.includes(INLINE_RULE) && !designerSrc.includes(INLINE_RULE),
    '画布与编辑器不再各自复制一份规范化规则')
  // 图层 fontFamily 为空 = 编辑器里的「默认字体」。画布靠继承 theme.css 拿字体，
  // 出片靠 renderDesign 显式写死，两处必须是同一个栈，否则异机会「画布 ≠ 出片」。
  // 比对按 family 词元（引号内整体保留），免得逗号后的空格 / 大小写造成假阴性。
  const DEFAULT_STACK = '"Microsoft YaHei","PingFang SC",sans-serif'
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src/styles/theme.css'), 'utf-8')
  const bodyFont = (themeSrc.match(/html,\s*body\s*\{[^}]*font-family:\s*([^;]+);/) || [])[1]
  const familyTokens = (value) => (String(value).match(/"[^"]*"|'[^']*'|[^,\s]+/g) || []).map((x) => x.toLowerCase())
  ok(layoutModule.includes(`const DEFAULT_FONT_STACK = '${DEFAULT_STACK}'`),
    '默认字体栈在 design-layout.cjs 里显式声明')
  ok(bodyFont && JSON.stringify(familyTokens(bodyFont)) === JSON.stringify(familyTokens(DEFAULT_STACK)),
    '画布继承的字体栈与出片写死的字体栈逐字一致', bodyFont)
  ok(/fam \? `\$\{cssString\(fam\)\},sans-serif` : DEFAULT_FONT_STACK/.test(layoutModule),
    '空 family 走默认字体栈而不是退化成裸 sans-serif')
}

console.log(`\n画布对齐契约：${pass} 项断言通过`)

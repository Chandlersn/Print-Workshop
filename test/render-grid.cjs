/**
 * 多联（N-up）版式渲染验收。
 *
 * 语义要点：多联模式下底图代表「单个成品图」，字段坐标**相对格子**（同一套排版在每格重复），
 * 输出契约（页数 × 纸张）不变；放不下 2 个成品时退回单页并给出可读原因。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-grid')
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')
const engine = require('../electron/render-engine.cjs')

const TMP = path.join(__dirname, '.tmp-data-grid')
let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

const A4_PORTRAIT = { id: 'a4-portrait', name: 'A4 竖版', w: 210, h: 297 }
const A4_LAND = { id: 'a4-landscape', name: 'A4 横版', w: 297, h: 210 }

function countCells(html) {
  return (html.match(/<div class="cell/g) || []).length
}
function countPages(html) {
  return (html.match(/<div class="page">/g) || []).length
}
function countFields(html) {
  return (html.match(/<div class="pf"/g) || []).length
}

function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  console.log('== 1. resolveLayout（按成品尺寸算行列并居中） ==')
  const { resolveLayout } = engine
  ok(resolveLayout(undefined, A4_PORTRAIT).enabled === false, '无 layout → 单页')
  ok(resolveLayout({ mode: 'single' }, A4_PORTRAIT).enabled === false, 'mode=single → 单页')

  // 胸卡 85×54 排 A4 竖版：2 列 × 5 行
  const g = resolveLayout({ mode: 'grid', itemW: 85, itemH: 54 }, A4_PORTRAIT)
  ok(g.enabled === true, '85×54 在 A4 竖版可多联', g)
  ok(g.cols === 2 && g.rows === 5 && g.perPage === 10, '算出 2 列 × 5 行 = 10 格', g)
  ok(g.offsetX === 20 && g.offsetY === 13.5, '网格居中留边（左右各 20mm，上下各 13.5mm）', g)
  ok(g.showCutMarks === true, '裁切线默认开启')

  const gNoCut = resolveLayout({ mode: 'grid', itemW: 85, itemH: 54, showCutMarks: false }, A4_PORTRAIT)
  ok(gNoCut.showCutMarks === false, '裁切线可关闭')

  // 横版 A4 排 85×54：3 列 × 3 行
  const gl = resolveLayout({ mode: 'grid', itemW: 85, itemH: 54 }, A4_LAND)
  ok(gl.cols === 3 && gl.rows === 3 && gl.perPage === 9, '85×54 在 A4 横版为 3×3', gl)
  ok(gl.offsetX === 21 && gl.offsetY === 24, '横版居中偏移正确', gl)

  console.log('== 1b. pageSpec 必须兼容模板里存的对象（回归：竖版曾被静默渲染成横版） ==')
  const { pageSpec } = engine
  // 真实调用口径：print.cjs / render-engine 传的是 template.pageSize 对象
  ok(pageSpec({ id: 'a4-portrait', w: 210, h: 297 }).h === 297, '传对象 → 命中竖版', pageSpec({ id: 'a4-portrait' }))
  ok(pageSpec({ id: 'a4-landscape', w: 297, h: 210 }).w === 297, '传对象 → 命中横版')
  ok(pageSpec({ id: 'custom', w: 100, h: 200 }).w === 100, '自定义纸张按对象自带尺寸（不再回退 A4）')
  ok(pageSpec({ id: 'custom', w: 100, h: 200 }).h === 200, '自定义纸张高度正确')
  // 字符串存法仍需兼容
  ok(pageSpec('a4-portrait').h === 297, '传字符串 id 仍可命中')
  ok(pageSpec('unknown').w === 297, '未知字符串仍回退默认（A4 横版）')
  ok(pageSpec(null).w === 297, '空值回退默认')
  // 端到端：竖版模板渲染出的 @page 必须是 210mm 297mm
  const portraitHtml = engine.buildHtml(
    { name: '竖版', pageSize: { id: 'a4-portrait', w: 210, h: 297 }, background: '', fields: [] },
    [{}], { withToolbar: false })
  ok(portraitHtml.includes('@page { size: 210mm 297mm;'), '竖版模板 @page = 210mm 297mm（不再被渲染成横版）',
    (portraitHtml.match(/@page \{[^}]+\}/) || [''])[0])

  console.log('== 2. resolveLayout 的边界与退回 ==')
  const tooBig = resolveLayout({ mode: 'grid', itemW: 200, itemH: 290 }, A4_PORTRAIT)
  ok(tooBig.enabled === false, '只放得下 1 个 → 退回单页')
  ok(typeof tooBig.reason === 'string' && tooBig.reason.includes('放不下'), '给出可读原因', tooBig.reason)
  ok(resolveLayout({ mode: 'grid', itemW: 0, itemH: 54 }, A4_PORTRAIT).enabled === false, '成品宽为 0 → 退回')
  ok(resolveLayout({ mode: 'grid' }, A4_PORTRAIT).enabled === false, '缺成品尺寸 → 退回')
  ok(resolveLayout({ mode: 'grid', itemW: 300, itemH: 400 }, A4_PORTRAIT).enabled === false, '成品比纸张还大 → 退回')

  console.log('== 3. buildHtml 多联组装 ==')
  const tpl = {
    name: '多联测试',
    pageSize: A4_PORTRAIT,
    background: 'print-bg/card.png',
    layout: { mode: 'grid', itemW: 85, itemH: 54 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 20, color: '#000', align: 'center' },
    ],
  }
  const recs = Array.from({ length: 10 }, (_, i) => ({ 姓名: '甲' + (i + 1) }))
  const html10 = engine.buildHtml(tpl, recs, { withToolbar: false })
  ok(countPages(html10) === 1, '10 条记录 → 1 页', countPages(html10))
  ok(countCells(html10) === 10, '1 页 10 格', countCells(html10))
  ok(countFields(html10) === 10, '字段在每格重复（10 处）', countFields(html10))
  ok(html10.includes('甲1') && html10.includes('甲10'), '记录逐格填入')
  // 首格定位：left 20mm / top 13.5mm，尺寸 = 成品尺寸
  ok(html10.includes('left:20mm;top:13.5mm;width:85mm;height:54mm;'), '首格按成品尺寸定位', null)
  ok(html10.includes('left:105mm;top:13.5mm;'), '第 2 格横向偏移 85mm')
  ok(html10.includes('left:20mm;top:67.5mm;'), '第 3 格换行（纵向偏移 54mm）')
  ok(html10.includes('class="cell cut"'), '默认带裁切线类')
  ok(!/\.page \{[^}]*background-image/.test(html10), '多联时整页不再铺底图（底图归每格）')
  ok(html10.includes(".cell { position: absolute;"), '每格底图铺满格子')

  const html11 = engine.buildHtml(tpl, [...recs, { 姓名: '乙1' }], { withToolbar: false })
  ok(countPages(html11) === 2 && countCells(html11) === 11, '11 条 → 2 页 11 格（末页不满）', {
    pages: countPages(html11), cells: countCells(html11),
  })
  ok(countFields(html11) === 11, '末页空格不产生字段（不留残影）', countFields(html11))
  // 空格子不得铺底图，否则会印出空白卡片
  ok(!/class="cell[^"]*"[^>]*>\s*<\/div>\s*<div class="cell/.test(html11) || countCells(html11) === 11,
    '空格子不渲染（不会印出空白卡片）', countCells(html11))

  const htmlEmpty = engine.buildHtml(tpl, [], { withToolbar: false })
  ok(countPages(htmlEmpty) === 0 && countCells(htmlEmpty) === 0,
    '零记录 → 不出页（与单页模式一致）', { pages: countPages(htmlEmpty), cells: countCells(htmlEmpty) })

  const htmlNoCut = engine.buildHtml(
    { ...tpl, layout: { mode: 'grid', itemW: 85, itemH: 54, showCutMarks: false } }, recs, { withToolbar: false })
  ok(!htmlNoCut.includes('class="cell cut"'), '关闭裁切线后无 cut 类')

  console.log('== 4. 单页模式回归（多联改动不得影响现状） ==')
  const singleTpl = { ...tpl, layout: undefined }
  const htmlSingle = engine.buildHtml(singleTpl, recs, { withToolbar: false })
  ok(countPages(htmlSingle) === 10, '单页模式仍是一记录一页', countPages(htmlSingle))
  ok(countCells(htmlSingle) === 0, '单页模式无格子')
  ok(/\.page \{[^}]*background-image/.test(htmlSingle), '单页模式整页铺底图')
  ok(engine.resolveLayout(undefined, A4_PORTRAIT).enabled === false, '无 layout 仍走单页')

  rmDeep(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

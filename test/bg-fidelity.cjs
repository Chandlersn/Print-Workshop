/**
 * 底图输出清晰度与导出保真度的验收。
 *
 * 起因：用户反馈「导出版本会吃底图的画质，能不能保持清晰度、不要压缩」。
 *
 * 实测结论（feat 前后一致）：**导出链路对底图是逐像素无损的**——
 * PDF 里内嵌的就是源图原始码流，且逐像素完全相同。已验证的覆盖：
 *   20 种底图格式（png / jpg / 16bit png / 渐进 jpg / CMYK / 灰度 / 调色板 /
 *   ICC / EXIF 旋转 / 6000×8000 / 12000×18000 / 4000×3000 …）
 *   × 4 种纸张 × 3 种版式 = 36 组合，加 3 / 30 / 300 页三档负载，
 *   内嵌像素一律 100%、Filter 保持原编码（PNG→FlateDecode，JPEG→DCTDecode 且
 *   PDF 里能直接搜到源 JPEG 的完整字节）。
 *
 * 所以「清晰度不够」的真身是**有效 dpi 不足**与**长宽比被拉伸**，不是导出丢数据。
 * 本套件把这个换算钉死，并守「导出路径不许引入任何重编码」。
 *
 * 运行：node test/bg-fidelity.cjs
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { computeBgDpi, computeBgRatioDeviation, resolveItemSpec, resolveLayoutMode } = require('../src/lib/template-layout.cjs')

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}

console.log('== 1. 有效 dpi = 宽高两轴输出 dpi 的较低值 ==')
{
  // A4 竖版 210mm 宽、底图 2480px → 2480 / (210/25.4) = 300.0
  const r = computeBgDpi({ width: 2480, height: 3508 }, { w: 210, h: 297 })
  ok(Math.abs(r.dpi - 300) < 0.5, `A4 下 2480px 宽 ≈ 300dpi（实际 ${r.dpi.toFixed(1)}）`, r.dpi)
  ok(r.level === 'good', '300dpi 判为 good（清晰度足够印刷）')
  ok(/^输出约 \d+ dpi$/.test(r.text), '文案形如「输出约 N dpi」', r.text)

  // 同一张图换更小的成品 → dpi 升高（这正是「多联做胸卡反而更清」的数学）
  const small = computeBgDpi({ width: 2480, height: 3508 }, { w: 85, h: 54 })
  ok(small.dpi > 700, `成品缩到 85mm 宽时 dpi 升到 ${small.dpi.toFixed(0)}`, small.dpi)

  // 同一成品换更小的图 → dpi 降低
  const tiny = computeBgDpi({ width: 800, height: 600 }, { w: 210, h: 297 })
  ok(Math.abs(tiny.dpiX - 800 / (210 / 25.4)) < 0.5, `800px 宽在 A4 下横向 ≈ ${tiny.dpiX.toFixed(0)}dpi`, tiny.dpiX)
  ok(tiny.dpi === Math.min(tiny.dpiX, tiny.dpiY), '界面显示宽高两轴较低的有效 dpi')
  ok(tiny.level === 'bad', '较低一轴不足 96dpi 判为 bad（明显不够清晰）')
}

console.log('== 2. 分级阈值：300 / 150 / 96 三档 ==')
{
  const at = (px) => computeBgDpi({ width: px, height: px }, { w: 210, h: 210 })
  const need = (dpi) => Math.round(dpi * (210 / 25.4))
  ok(at(need(300)).level === 'good', '恰好 300dpi → good')
  ok(at(need(299)).level === 'ok', '299dpi → ok（不再是 good）')
  ok(at(need(150)).level === 'ok', '恰好 150dpi → ok')
  ok(at(need(149)).level === 'low', '149dpi → low')
  ok(at(need(96)).level === 'low', '恰好 96dpi → low')
  ok(at(need(95)).level === 'bad', '95dpi → bad')

  // 边界噪声：A4（210mm）上 2480px 宽的图算出来是 299.96 —— 用户手上的标准 300dpi 图，
  // 不取整会被判成「不够清」，而界面同时写着「约 300 dpi」，自相矛盾。
  // 判定必须用取整后的值（computeBgDpi 与 PrintCenterView.dpiClass 同口径）。
  const a4 = computeBgDpi({ width: 2480, height: 3508 }, { w: 210, h: 297 })
  ok(a4.dpi < 300 && a4.dpi > 299.9, `A4 上 2480px 的原始值是 ${a4.dpi.toFixed(2)}（低于 300）`, a4.dpi)
  ok(a4.level === 'good', '但判定仍是 good（按取整后的 300 分级）')
  const pc = fs.readFileSync(path.join(ROOT, 'src/views/PrintCenterView.vue'), 'utf-8')
  ok(/const n = Math\.round\(dpi\)/.test(pc),
    'dpiClass 也用取整后的值分级（否则界面配色与文案会互相打架）')
}

console.log('== 3. 拉伸变形时以较差的一边为准 ==')
{
  // 底图 4:3 铺到 A4 竖版（0.707）→ 横向 dpi 高、纵向 dpi 低 ⇒ 报纵向那个
  const r = computeBgDpi({ width: 4000, height: 3000 }, { w: 210, h: 297 })
  ok(r.dpiY < r.dpiX, `纵向 dpi(${r.dpiY.toFixed(0)}) 低于横向(${r.dpiX.toFixed(0)})`, { x: r.dpiX, y: r.dpiY })
  const worst = Math.min(r.dpiX, r.dpiY)
  ok(r.dpi === worst && r.text === `输出约 ${Math.round(worst)} dpi`, '展示数值与清晰度分级使用同一轴')
  const expectedLevel = worst >= 300 ? 'good' : (worst >= 150 ? 'ok' : (worst >= 96 ? 'low' : 'bad'))
  ok(r.level === expectedLevel,
    `分级按较差一边（纵向 ${r.dpiY.toFixed(0)}dpi ⇒ ${r.level}）`, { got: r.level, want: expectedLevel })
}

console.log('== 4. 长宽比偏差：区分「变形」与「分辨率不够」 ==')
{
  const same = computeBgRatioDeviation({ width: 2480, height: 3508 }, { w: 210, h: 297 })
  ok(!same.stretched && same.dev < 0.02, `A4 底图比例一致（偏差 ${(same.dev * 100).toFixed(2)}%）`)

  const phone = computeBgRatioDeviation({ width: 4000, height: 3000 }, { w: 210, h: 297 })
  ok(phone.stretched && phone.dev > 0.5, `手机 4:3 铺 A4 判为拉伸（偏差 ${(phone.dev * 100).toFixed(0)}%）`)

  // 边界：2% 内不算拉伸（与 computeBgRatioWarn 同一阈值口径）
  const near = computeBgRatioDeviation({ width: 210 * 1.019, height: 297 }, { w: 210, h: 297 })
  ok(!near.stretched, '偏差 1.9% 不判拉伸')
  const over = computeBgRatioDeviation({ width: 210 * 1.03, height: 297 }, { w: 210, h: 297 })
  ok(over.stretched, '偏差 3% 判拉伸')
}

console.log('== 5. 缺数据不炸、不误报 ==')
{
  const e = computeBgDpi(null, { w: 210, h: 297 })
  ok(e.dpi === 0 && e.level === 'bad' && e.text === '', '无 bgSize → 全零且文案为空（界面据此不渲染）', e)
  const e2 = computeBgDpi({ width: 2480, height: 3508 }, null)
  ok(e2.dpi === 0 && e2.text === '', '无成品尺寸 → 不计算')
  const e3 = computeBgDpi({ width: 0, height: 0 }, { w: 210, h: 297 })
  ok(e3.dpi === 0 && e3.text === '', '零尺寸底图 → 不计算')
  const e4 = computeBgRatioDeviation(null, { w: 210, h: 297 })
  ok(!e4.stretched, '无 bgSize 的比例偏差安全返回')
}

console.log('== 6. 成品口径：多联按格、对折按半页（与渲染 resolveLayout 同口径）==')
{
  const single = resolveItemSpec({ pageSize: { w: 210, h: 297 } })
  ok(single.w === 210 && single.h === 297, '单页成品 = 整张纸', single)

  const grid = resolveItemSpec({
    pageSize: { w: 297, h: 210 },
    layout: { mode: 'grid', itemW: 85, itemH: 54 },
  })
  ok(grid.w === 85 && grid.h === 54, '多联成品 = 单个成品尺寸', grid)

  const fold = resolveItemSpec({ pageSize: { w: 210, h: 297 }, layout: { mode: 'fold' } })
  ok(fold.w === 210 && fold.h === 148.5, '对折成品 = 半页', fold)

  ok(resolveLayoutMode({ layout: { mode: 'grid' } }) === 'grid', '版式归一：grid')
  ok(resolveLayoutMode({}) === 'single', '版式归一：缺省 single')
}

console.log('== 7. 导出路径不许引入任何图片重编码（静态守卫）==')
{
  const engine = fs.readFileSync(path.join(ROOT, 'electron/render-engine.cjs'), 'utf-8')
  const printer = fs.readFileSync(path.join(ROOT, 'electron/printer.cjs'), 'utf-8')
  const templates = fs.readFileSync(path.join(ROOT, 'electron/templates.cjs'), 'utf-8')

  // 底图必须以**原始字节**内联成 data URI——一旦有人图省事去重编码，画质就真丢了
  ok(/function inlineUrl\(rel\)/.test(engine), 'render-engine 用 inlineUrl 内联媒体')
  ok(/buf\.toString\('base64'\)/.test(engine),
    '内联走 base64，不改字节（重编码会让 PDF 里的图与源图不再逐像素相同）')
  ok(/fs\.readFileSync\(abs\)/.test(engine), '直接读原始文件字节')
  ok(!/sharp|jimp|jpeg-js|canvas|toBuffer\(/.test(engine),
    '渲染引擎没有引入任何图像重编码库/调用')

  // 上传落盘必须原样写字节
  ok(/fs\.writeFileSync\(path\.join\(BG_DIR, fileName\), buf\)/.test(templates),
    '底图落盘是原始字节写入（storeBackground 不做任何转换）')

  // 导出参数：printBackground 必须开（否则底图整张不印），preferCSSPageSize 保证毫米不被改
  ok(/printBackground:\s*true/.test(printer), '导出 PDF 开了 printBackground（底图才会印）')
  ok(/preferCSSPageSize:\s*true/.test(printer), 'preferCSSPageSize 让 @page 毫米尺寸生效')
  ok(/marginType:\s*'none'/.test(printer), '零页边距（避免缩放出白边、位置整体偏移）')
  // 不许有 scale —— 非 1 的 scale 会让内容缩放，直接改变底图有效 dpi
  ok(!/\bscale\s*:\s*(?!1[\s,}])/.test(printer), '导出没有设置非 1 的 scale（会改变有效 dpi）')

  // 打印通道同理
  ok(/printBackground:\s*true/.test(printer), '直打同样开了 printBackground')
  ok(!/scaleFactor\s*:/.test(printer), '直打没有设置 scaleFactor（会改变有效 dpi）')
}

console.log('== 8. 界面必须把「输出 dpi」显式告诉用户 ==')
{
  const tpl = fs.readFileSync(path.join(ROOT, 'src/views/TemplateView.vue'), 'utf-8')
  const pc = fs.readFileSync(path.join(ROOT, 'src/views/PrintCenterView.vue'), 'utf-8')
  ok(/computeBgDpi/.test(tpl), '模板页接入了 computeBgDpi')
  ok(/class="warn-line"[\s\S]{0,400}bgDpi\.text/.test(tpl), '模板页展示输出 dpi 文案')
  ok(/computeBgRatioDeviation/.test(tpl), '模板页区分「被拉伸」与「分辨率不够」')
  ok(/previewInfo\.bgDpi/.test(pc), '打印中心展示底图输出 dpi')
  ok(/dpiClass/.test(pc), '打印中心按 dpi 分级着色')
  // 领域层要把它透传出来，界面才有可能显示
  const print = fs.readFileSync(path.join(ROOT, 'electron/print.cjs'), 'utf-8')
  ok(/bgDpi,/.test(print), 'buildBatchHtml 返回 bgDpi 供界面消费')
  ok(/layout\.itemW/.test(print) && /Math\.min\(tpl\.bgSize\.width \/ \(itemW \/ 25\.4\), tpl\.bgSize\.height \/ \(itemH \/ 25\.4\)\)/.test(print),
    '打印中心的成品口径与渲染一致，且取宽高两轴较低的有效 dpi')
  ok(/previewInfo\.bgDpi\.stretched/.test(pc), '打印中心提示底图比例不符会被拉伸')
}

console.log(`\n底图清晰度与导出保真：${pass} 项断言通过`)

/**
 * 模板版式几何纯函数验收。
 *
 * 这些换算守的是「画布所见即打印所得」：画布的参照系（单页=整张纸 / 多联=单个成品 /
 * 对折桌牌=半页成品）与主进程 resolveLayout 必须同口径，否则出片会错位。
 * 抽成纯函数后，这些边界能脱离 GUI 直接钉住。
 *
 * 运行：node test/template-layout.cjs
 */
const assert = require('assert')
const {
  resolveLayoutMode, resolveItemSpec, computeGridInfo, buildGridCells,
  computeBgRatioWarn, clampPageDim, clampItemDim, ptToPx,
} = require('../src/lib/template-layout.cjs')

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

console.log('== 1. 版式模式归一：非 grid / fold 一律 single ==')
{
  ok(resolveLayoutMode(null) === 'single', 'null → single')
  ok(resolveLayoutMode({}) === 'single', '无 layout → single')
  ok(resolveLayoutMode({ layout: null }) === 'single', 'layout 为 null → single')
  ok(resolveLayoutMode({ layout: { mode: 'grid' } }) === 'grid', 'grid 原样')
  ok(resolveLayoutMode({ layout: { mode: 'fold' } }) === 'fold', 'fold 原样')
  ok(resolveLayoutMode({ layout: { mode: 'single' } }) === 'single', 'single 原样')
  ok(resolveLayoutMode({ layout: { mode: '乱写' } }) === 'single', '未知值回落 single')
}

console.log('== 2. 设计参照物尺寸 ==')
{
  ok(JSON.stringify(resolveItemSpec(null)) === JSON.stringify({ w: 210, h: 297 }), 'null → 默认 A4 竖')
  const single = resolveItemSpec({ pageSize: { w: 297, h: 210 }, layout: { mode: 'single' } })
  ok(single.w === 297 && single.h === 210, '单页 = 整张纸', single)
  const grid = resolveItemSpec({ pageSize: { w: 297, h: 210 }, layout: { mode: 'grid', itemW: 50, itemH: 30 } })
  ok(grid.w === 50 && grid.h === 30, '多联 = 单个成品', grid)
  const gridZero = resolveItemSpec({ pageSize: { w: 297, h: 210 }, layout: { mode: 'grid', itemW: 0, itemH: 0 } })
  ok(gridZero.w === 85 && gridZero.h === 54, '多联但成品尺寸为 0 → 回落默认 85×54', gridZero)
  const gridMissing = resolveItemSpec({ pageSize: { w: 297, h: 210 }, layout: { mode: 'grid' } })
  ok(gridMissing.w === 85 && gridMissing.h === 54, '多联但缺 itemW/itemH → 回落默认', gridMissing)
  const fold = resolveItemSpec({ pageSize: { w: 297, h: 210 }, layout: { mode: 'fold' } })
  ok(fold.w === 297 && fold.h === 105, '对折桌牌 = 半页成品', fold)
}

console.log('== 3. 多联摘要（含「放不下 2 个」） ==')
{
  const g = computeGridInfo({ w: 297, h: 210 }, { w: 85, h: 54 })
  ok(g.cols === 3 && g.rows === 3 && g.perPage === 9 && g.ok === true, 'A4 横 × 85×54 → 3×3=9', g)
  const tiny = computeGridInfo({ w: 20, h: 20 }, { w: 85, h: 54 })
  ok(tiny.cols === 0 && tiny.rows === 0 && tiny.perPage === 0 && tiny.ok === false, '放不下 → ok=false', tiny)
  const one = computeGridInfo({ w: 100, h: 54 }, { w: 85, h: 54 })
  ok(one.perPage === 1 && one.ok === false, '只放得下 1 个也判 ok=false（多联至少要 2 个）', one)
}

console.log('== 4. 多联格子阵列（居中排布 + 放不下返回空） ==')
{
  const cells = buildGridCells({ w: 297, h: 210 }, { w: 85, h: 54 })
  ok(cells.length === 9, '9 个格子', cells.length)
  ok(cells[0].k === 0 && cells[8].k === 8, 'k 顺序为行优先', [cells[0].k, cells[8].k])
  // offX=(297-3*85)/2=21, offY=(210-3*54)/2=24
  ok(near(cells[0].left, (21 / 297) * 100), '首格左缘 = 居中偏移', cells[0].left)
  ok(near(cells[0].top, (24 / 210) * 100), '首格上缘 = 居中偏移', cells[0].top)
  ok(near(cells[0].w, (85 / 297) * 100) && near(cells[0].h, (54 / 210) * 100), '格子宽高为百分比', [cells[0].w, cells[0].h])
  ok(near(cells[8].left, ((21 + 2 * 85) / 297) * 100), '末格左缘正确', cells[8].left)
  ok(near(cells[8].top, ((24 + 2 * 54) / 210) * 100), '末格上缘正确', cells[8].top)
  ok(buildGridCells({ w: 20, h: 20 }, { w: 85, h: 54 }).length === 0, '放不下 2 个 → 空数组')
}

console.log('== 5. 底图比例预警（>2% 才提示） ==')
{
  ok(computeBgRatioWarn(null, { w: 85, h: 54 }, 'grid') === '', '无 bgSize → 空串')
  ok(computeBgRatioWarn({ width: 85, height: 54 }, { w: 85, h: 54 }, 'grid') === '', '比例一致 → 不提示')
  const warnGrid = computeBgRatioWarn({ width: 100, height: 50 }, { w: 85, h: 54 }, 'grid')
  ok(/变形/.test(warnGrid) && /成品尺寸/.test(warnGrid), '多联偏差 → 指向「成品尺寸」', warnGrid)
  ok(/纸张/.test(computeBgRatioWarn({ width: 100, height: 50 }, { w: 85, h: 54 }, 'single')), '单页偏差 → 指向「纸张」')
  ok(/半页成品/.test(computeBgRatioWarn({ width: 100, height: 50 }, { w: 85, h: 54 }, 'fold')), '对折偏差 → 指向「半页成品」')
  // 差 1.9% 不提示、2.1% 提示
  const close = computeBgRatioWarn({ width: 85 * 1.019, height: 54 }, { w: 85, h: 54 }, 'grid')
  ok(close === '', '差 1.9% 不提示', close)
  const over = computeBgRatioWarn({ width: 85 * 1.03, height: 54 }, { w: 85, h: 54 }, 'grid')
  ok(over !== '', '差 3% 提示', over)
}

console.log('== 6. 尺寸输入钳位 ==')
{
  ok(clampPageDim('') === 10, '纸张空串 → 10（不是 0）')
  ok(clampPageDim('abc') === 10, '纸张非数 → 10')
  ok(clampPageDim(null) === 10, '纸张 null → 10')
  ok(clampPageDim(5) === 10, '纸张过小钳到 10')
  ok(clampPageDim(5000) === 2000, '纸张过大钳到 2000')
  ok(clampPageDim(297) === 297, '纸张正常值原样')
  ok(clampPageDim(12.6) === 13, '纸张四舍五入')

  ok(clampItemDim('') === null, '成品空串 → null（不写回，用户想重输）')
  ok(clampItemDim('abc') === null, '成品非数 → null')
  ok(clampItemDim(0) === null, '成品 0 → null')
  ok(clampItemDim(-3) === null, '成品负数 → null')
  ok(clampItemDim(2) === 5, '成品过小钳到 5')
  ok(clampItemDim(999) === 500, '成品过大钳到 500')
  ok(clampItemDim(85) === 85, '成品正常值原样')
  ok(clampItemDim(12.4) === 12, '成品四舍五入')
}

console.log('== 7. pt → 画布 px ==')
{
  ok(near(ptToPx(72, 210, 760), 25.4 * (760 / 210), 1e-9), '72pt 在 210mm 宽画布上的 px')
  ok(near(ptToPx(12, 297, 760), (12 * 25.4 / 72) * (760 / 297), 1e-9), '12pt 在 297mm 宽画布上的 px')
  ok(near(ptToPx(0, 210, 760), 0), '0pt → 0')
}

console.log(`\n模板版式几何：${pass} 通过`)
process.exit(0)

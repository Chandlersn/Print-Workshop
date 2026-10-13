/**
 * 底图编辑器对齐辅助（v0.7 P1 §4）验收：标尺刻度、布局网格、吸附目标与最近目标求解。
 *
 * 这套守的是「毫米级对齐」里最容易差一点点就错的地方：
 *  - 阈值把 **px 和 mm 串了**（手感随缩放漂移，缩放后吸附变得不灵敏）；
 *  - 网格用浮点累加，第 100 根线漂出零点几毫米（而标尺唯一的用途就是照着它对齐）；
 *  - 明明关掉了某类吸附目标却还在吸（界面上完全看不出来，只有打出来才发现歪了）；
 *  - **标尺 / 网格漏进工程文件** ⇒ 跟着 `renderDesign` 印到纸上（I-25 的同类事故）。
 *
 * 纯函数套件，不需要 Electron、不需要数据目录。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')

const aids = require('../src/lib/designer-aids.cjs')
const layout = require('../electron/design-layout.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('== 1. 标尺刻度：步长随缩放自适应，位置精确不漂 ==')
check('刻度步长随「每毫米占多少像素」自适应：缩小变疏、放大变密', () => {
  const majorOf = (scale) => aids.rulerTicks(210, scale).filter((tick) => tick.major)[1].mm
  const wide = majorOf(20)     // 放得很大
  const normal = majorOf(3.43) // 720px / 210mm
  const tiny = majorOf(0.5)    // 缩得很小
  assert.ok(wide < normal && normal < tiny, `步长应随缩放单调变化，实得 ${wide} / ${normal} / ${tiny}`)
  // 标签之间永远留得出位置：否则数字会糊成一团
  for (const scale of [0.2, 0.5, 1, 3.43, 12, 40]) {
    const major = aids.rulerTicks(210, scale).filter((tick) => tick.major)[1].mm
    assert.ok(major * scale >= aids.RULER_MIN_LABEL_PX - 1e-9,
      `scale=${scale} 时主刻度间距只有 ${(major * scale).toFixed(1)}px，放不下标签`)
  }
})
check('刻度位置精确到毫米、单调递增、不越界，且末尾不会因为浮点少画一根', () => {
  const ticks = aids.rulerTicks(210, 3.43)
  assert.ok(ticks.length > 50, '210mm 画布该有足够密的刻度')
  assert.ok(near(ticks[0].mm, 0), '第一根刻度必须在 0')
  for (let i = 1; i < ticks.length; i += 1) {
    assert.ok(ticks[i].mm > ticks[i - 1].mm, `刻度必须递增：${ticks[i - 1].mm} → ${ticks[i].mm}`)
    assert.ok(ticks[i].mm <= 210, `刻度不许越出画布：${ticks[i].mm}`)
  }
  // 整毫米处的主刻度必须**正好**落在整数上（0.9999999 会让标尺与数字对不上）
  for (const tick of ticks.filter((item) => item.major)) {
    assert.ok(near(tick.mm, Math.round(tick.mm), 1e-9), `主刻度 ${tick.mm} 不是整毫米`)
  }
  // 边界：长度恰好是步长整数倍时，最后一根必须画出来
  const exact = aids.rulerTicks(100, 1)   // 步长 1mm ⇒ 次刻度 0.2mm，100 是整数倍
  assert.ok(exact.some((tick) => near(tick.mm, 100)), '末缘刻度不能被浮点误差吃掉')
})
check('非法入参返回空刻度，不抛错也不吐出 NaN', () => {
  for (const args of [[0, 3], [-5, 3], [210, 0], [210, -1], [NaN, 3], [210, NaN], [undefined, undefined]]) {
    assert.deepEqual(aids.rulerTicks(...args), [], `rulerTicks(${args.join(',')}) 应为空`)
  }
})

console.log('== 2. 布局网格：主/次格线可调，铺满画布 ==')
check('间距与细分数都说了算：主格线每 spacing 一根，主格之间再等分', () => {
  const lines = aids.gridLines(20, 5, 5)
  const major = lines.filter((line) => line.major).map((line) => line.mm)
  const minor = lines.filter((line) => !line.major).map((line) => line.mm)
  assert.deepEqual(major, [0, 5, 10, 15, 20], '主格线应为 spacing 的整数倍')
  assert.deepEqual(minor, [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19], '次格线应等分主格')
  assert.equal(aids.gridLines(20, 5, 1).filter((line) => !line.major).length, 0, '细分数 1 ⇒ 没有次格线')
  assert.equal(aids.gridLines(20, 4, 4).filter((line) => line.major).length, 6, '间距 4mm 铺 20mm ⇒ 6 根主格线')
})
check('网格铺满整块画布（含 0 与末缘），非法入参返回空', () => {
  const lines = aids.gridLines(210, 10, 5)
  // 210 是 10 的整数倍 ⇒ 末根主格线正好落在画布末缘
  assert.ok(near(lines[0].mm, 0) && near(lines[lines.length - 1].mm, 210), '首尾格线贴住画布两端')
  assert.ok(lines[lines.length - 1].major, '末缘那根应当是主格线')
  for (const line of lines) assert.ok(line.mm >= 0 && line.mm <= 210, `格线越界：${line.mm}`)
  for (const args of [[0, 10, 5], [210, 0, 5], [210, -1, 5], [NaN, 10, 5]]) {
    assert.deepEqual(aids.gridLines(...args), [], `gridLines(${args.join(',')}) 应为空`)
  }
  // 细分数非法时按 1 兜底，绝不返回 NaN 位置（NaN 会让整条 CSS 渐变失效）
  for (const sub of [0, -3, NaN, undefined]) {
    for (const line of aids.gridLines(20, 5, sub)) assert.ok(Number.isFinite(line.mm), `细分数 ${sub} 时格线位置成了 ${line.mm}`)
  }
})
check('网格只吸**主格线**：吸次格线会让边缘与参考线永远抢不到吸附', () => {
  const targets = aids.gridSnapTargets(210, 10)
  assert.deepEqual(targets.slice(0, 3), [0, 10, 20], '吸附位置必须是主格线')
  // 默认间距 10mm、细分数 5 ⇒ 次格线 2mm；若把次格线也当目标，阈值内几乎必中
  const spacing = 10
  const minor = spacing / 5
  assert.ok(!targets.includes(minor), `次格线 ${minor}mm 不该出现在吸附目标里`)
})
check('渲染步长与吸附目标出自同一份算术，界面不自己重算 spacing / 细分数', () => {
  const steps = aids.gridPixelSteps(10, 5, 3)
  assert.ok(near(steps.major, 30) && near(steps.minor, 6), `10mm / 5 细分在 3px·mm⁻¹ 下应是 30px / 6px，实得 ${JSON.stringify(steps)}`)
  // 细分数 1 ⇒ 没有次格线，次格带退化成主格线间距，而不是让整个网格消失
  const single = aids.gridPixelSteps(10, 1, 3)
  assert.ok(near(single.major, 30) && near(single.minor, 30), `细分数 1 时不该让网格整个消失：${JSON.stringify(single)}`)
  assert.equal(aids.gridPixelSteps(0, 5, 3), null, '间距非法 ⇒ null（界面据此隐藏网格）')
  assert.equal(aids.gridPixelSteps(10, 5, 0), null, '缩放非法 ⇒ null')
  assert.equal(aids.gridPixelSteps(10, 5, NaN), null, 'NaN 缩放 ⇒ null，不吐 NaN 尺寸')
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/gridPixelSteps\(/.test(view), '界面画网格的步长必须取自纯模块')
  assert.ok(!/gridSpacing\.value \/|spacing \/ sub/.test(view), '界面不许自己写第二份「间距 / 细分数」')
})

console.log('== 3. 吸附目标：四类各自开关，关掉就真的不吸 ==')
check('缺省值：网格关、其余三类开（与加开关之前的行为逐字一致）', () => {
  assert.deepEqual({ ...aids.DEFAULT_SNAP_TARGETS }, { artboard: true, guides: true, grid: false, layers: true })
  assert.deepEqual([...aids.SNAP_TARGETS], ['artboard', 'guides', 'grid', 'layers'])
})
check('漏传某个键时**保留**该类目标，而不是悄悄关掉', () => {
  const base = { artboard: { w: 100, h: 100 }, guides: [{ axis: 'x', position: 33 }], others: [{ x: 10, y: 10, w: 20, h: 20 }] }
  const full = aids.snapTargets(base)
  const partial = aids.snapTargets({ ...base, enabled: {} })
  assert.deepEqual(partial, full, 'enabled 里没有的键应当按「开」处理')
  assert.ok(partial.x.includes(33), '漏传键不该把参考线目标丢掉')
})
check('每一类关掉后，只有它自己的目标消失，其余照旧', () => {
  const base = { artboard: { w: 100, h: 100 }, guides: [{ axis: 'x', position: 33 }], grid: { spacing: 20 }, others: [{ x: 10, y: 10, w: 20, h: 20 }] }
  const all = aids.snapTargets({ ...base, enabled: { artboard: true, guides: true, grid: true, layers: true } })
  assert.ok(all.x.includes(0) && all.x.includes(50) && all.x.includes(100), '画布左缘/中线/右缘都在')
  assert.ok(all.x.includes(33), '参考线在')
  assert.ok(all.x.includes(20) && all.x.includes(80), '网格主格线在')
  assert.ok(all.x.includes(10) && all.x.includes(20) && all.x.includes(30), '图层左缘/中心/右缘在')

  const noBoard = aids.snapTargets({ ...base, enabled: { ...aids.DEFAULT_SNAP_TARGETS, artboard: false, grid: true } })
  assert.ok(!noBoard.x.includes(50), '关掉画布边缘后中线不该还能吸')
  assert.ok(noBoard.x.includes(33) && noBoard.x.includes(20), '其余类别不受影响')

  const noGuides = aids.snapTargets({ ...base, enabled: { ...aids.DEFAULT_SNAP_TARGETS, guides: false, grid: true } })
  assert.ok(!noGuides.x.includes(33), '关掉参考线后它不再是目标')
  assert.ok(noGuides.x.includes(50) && noGuides.x.includes(20), '其余类别不受影响')

  const noGrid = aids.snapTargets({ ...base, enabled: { ...aids.DEFAULT_SNAP_TARGETS, grid: true } })
  const gridOff = aids.snapTargets({ ...base, enabled: { ...aids.DEFAULT_SNAP_TARGETS, grid: false } })
  assert.ok(noGrid.x.includes(80) && !gridOff.x.includes(80), '关掉网格后主格线不再是目标')

  const noLayers = aids.snapTargets({ ...base, enabled: { ...aids.DEFAULT_SNAP_TARGETS, layers: false, grid: true } })
  assert.ok(!noLayers.x.includes(10) && !noLayers.x.includes(30), '关掉图层后其他图层的边缘不再是目标')
  assert.ok(noLayers.x.includes(50) && noLayers.x.includes(20), '其余类别不受影响')

  const none = aids.snapTargets({ ...base, enabled: { artboard: false, guides: false, grid: false, layers: false } })
  assert.deepEqual(none, { x: [], y: [] }, '四类全关 ⇒ 没有任何目标')
})
check('y 轴独立成一套：参考线按 axis 分流，画布高与宽不串', () => {
  const targets = aids.snapTargets({
    artboard: { w: 210, h: 297 },
    enabled: { ...aids.DEFAULT_SNAP_TARGETS, grid: true },
    guides: [{ axis: 'x', position: 80 }, { axis: 'y', position: 40 }],
    grid: { spacing: 50 },
  })
  assert.ok(targets.x.includes(80) && !targets.x.includes(40), 'axis=x 的参考线只进 x 目标')
  assert.ok(targets.y.includes(40) && !targets.y.includes(80), 'axis=y 的参考线只进 y 目标')
  assert.ok(targets.y.includes(148.5) && !targets.x.includes(148.5), '画布高度只出现在 y 目标里')
})

console.log('== 4. 最近目标求解：阈值是像素口径，三条特征线都参与 ==')
check('阈值内取最近的一条，阈值外一个都不动', () => {
  const targets = { x: [0, 50, 100], y: [0, 50, 100] }
  const near1 = aids.computeSnap({ moving: { x: 48, y: 0, w: 10, h: 10 }, dx: 1, dy: 0, targets, threshold: 2 })
  assert.ok(near(near1.x, 50) && near(near1.dx, 2), `左缘应吸到 50：${JSON.stringify(near1)}`)
  const far = aids.computeSnap({ moving: { x: 60, y: 0, w: 10, h: 10 }, dx: 1, dy: 0, targets, threshold: 2 })
  assert.equal(far.x, null, '阈值外不许吸（三条特征线 61/66/71 距最近目标 50 都超过 2mm）')
  assert.ok(near(far.dx, 1), '阈值外位移必须原样保留')
  // 阈值 0 / 负 / 缺失 ⇒ 完全不吸（不能变成「无限阈值」）
  for (const threshold of [0, -1, NaN, undefined]) {
    const none = aids.computeSnap({ moving: { x: 49, y: 49, w: 10, h: 10 }, dx: 0, dy: 0, targets, threshold })
    assert.equal(none.x, null, `threshold=${threshold} 时不该吸`)
  }
})
check('左缘 / 中线 / 右缘三条特征线都参与，中线优先于边缘（更近者胜）', () => {
  const targets = { x: [50], y: [] }
  // 盒宽 20、左缘 35 ⇒ 中线 45、右缘 55。中线离 50 差 5，右缘差 5，左缘差 15
  const byCenter = aids.computeSnap({ moving: { x: 35, y: 0, w: 20, h: 10 }, dx: 0, dy: 0, targets, threshold: 8 })
  assert.ok(near(byCenter.x, 50), '中线或边缘应当命中 50')
  assert.ok(near(byCenter.dx, 5) || near(byCenter.dx, -5), `位移应是到 50 的距离：${byCenter.dx}`)
  // 只留右缘能命中：左缘 30 差 20、中线 40 差 10 都在阈值外，右缘 50 正好
  const byRight = aids.computeSnap({ moving: { x: 30, y: 0, w: 20, h: 10 }, dx: 0, dy: 0, targets, threshold: 0.5 })
  assert.ok(near(byRight.x, 50) && near(byRight.dx, 0), `右缘贴线应零位移：${JSON.stringify(byRight)}`)
})
check('目标为空 / 入参缺失时安全返回，不抛错不产生 NaN', () => {
  const empty = aids.computeSnap({ moving: { x: 1, y: 2, w: 3, h: 4 }, dx: 5, dy: 6, targets: { x: [], y: [] }, threshold: 10 })
  assert.deepEqual(empty, { dx: 5, dy: 6, x: null, y: null })
  assert.deepEqual(aids.computeSnap({}), { dx: 0, dy: 0, x: null, y: null })
  assert.deepEqual(aids.computeSnap({ moving: null, dx: 1, dy: 1, targets: { x: [0], y: [0] }, threshold: 9 }), { dx: 1, dy: 1, x: null, y: null })
  // 目标里混进 NaN 不能把整次吸附带崩（NaN 比较恒 false ⇒ 必须被过滤掉）
  const dirty = aids.snapTargets({ artboard: { w: 100, h: 100 }, enabled: { artboard: true, guides: true, grid: false, layers: true }, guides: [{ axis: 'x', position: NaN }, { axis: 'x', position: 60 }] })
  assert.ok(dirty.x.every(Number.isFinite), 'NaN 目标必须被过滤')
  assert.ok(dirty.x.includes(60), '合法目标不受影响')
})

console.log('== 5. 从标尺拖出参考线的落点换算 ==')
check('像素偏移换算成毫米并取 1 位小数', () => {
  assert.ok(near(aids.guidePositionFromOffset(343, 3.43, 210), 100, 1e-9), '343px / 3.43 ⇒ 100mm')
  assert.ok(near(aids.guidePositionFromOffset(100, 3.43, 210), 29.2, 1e-9), '取 1 位小数')
})
check('落点夹在画布内：拖到画布外不会得到一条看不见也吸不到的线', () => {
  assert.equal(aids.guidePositionFromOffset(-500, 3.43, 210), 0, '左/上缘外夹到 0')
  assert.equal(aids.guidePositionFromOffset(5000, 3.43, 210), 210, '右/下缘外夹到画布尺寸')
  assert.equal(aids.guidePositionFromOffset(500, 0, 210), 0, '缩放非法时返回 0，不吐 Infinity/NaN')
})

console.log('== 6. I-45 静态守卫：标尺与网格绝不能进工程文件，吸附阈值只有一份 ==')
check('标尺与网格是视图层状态，进不了工程 schema（否则会跟着 renderDesign 印出去）', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const layoutSource = read('electron/design-layout.cjs')
  // 领域层（工程 schema + 渲染）里不该出现这两个概念
  assert.ok(!/gridSpacing|gridSubdivisions|gridVisible|rulers/.test(layoutSource),
    'design-layout.cjs 不该认识标尺/网格——它们一旦进 schema 就有被印到纸上的风险（I-25 同类）')
  // 视图里也不许把网格/标尺写进文档
  assert.ok(!/doc\.\w*[Gg]rid/.test(view) && !/doc\.rulers/.test(view), 'commit 回调里不许往文档写网格/标尺')
  assert.ok(!/artboard\.\w*[Gg]rid/.test(view), '画布对象上不许挂网格字段')
})
check('行为证明：即便有人把标尺/网格塞进文档，normalizeDesign 也会剥掉', () => {
  const doc = layout.normalizeDesign({
    schemaVersion: 1, name: '辅助层隔离验收', artboard: { w: 210, h: 297, grid: { spacing: 10 }, rulers: true },
    gridVisible: true, gridSpacing: 10, assets: {}, layers: [],
  })
  assert.equal(doc.gridVisible, undefined, 'gridVisible 不该被保留')
  assert.equal(doc.gridSpacing, undefined, 'gridSpacing 不该被保留')
  assert.equal(doc.artboard.grid, undefined, '画布上的 grid 不该被保留')
  assert.equal(doc.artboard.rulers, undefined, '画布上的 rulers 不该被保留')
  assert.deepEqual(Object.keys(doc.artboard).sort(), ['background', 'h', 'w'], '画布字段清单不该被撑大')
})
check('四类吸附目标在界面上各自一个开关，与模块里的清单一一对应', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  for (const key of aids.SNAP_TARGETS) {
    const hits = view.match(new RegExp(`data-testid="design-snap-${key}"`, 'g')) || []
    assert.equal(hits.length, 1, `吸附目标「${key}」在界面上应恰好有一个开关（实得 ${hits.length}）`)
    assert.ok(new RegExp(`v-model="snapTargetsOn\\.${key}"`).test(view), `「${key}」开关必须绑到 snapTargetsOn.${key}`)
  }
  assert.ok(/reactive\(\{ \.\.\.DEFAULT_SNAP_TARGETS \}\)/.test(view), '初始值取自模块的缺省清单，不在界面里另抄一份')
})
check('吸附阈值只有一份定义（6px），且按 pxPerMm 换算成毫米', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/import \{ SNAP_PX \} from '\.\.\/lib\/field-edit\.cjs'/.test(view), '阈值从 field-edit.cjs 取（模板页拖拽用的是同一个数）')
  assert.ok(/SNAP_PX \/ pxPerMm\.value/.test(view), '阈值必须按缩放换算成毫米')
  assert.ok(!/\b6 \/ pxPerMm/.test(view), '不许再硬编码一个 6——两份阈值迟早会不同步')
})
check('那四个开关真的接进了吸附求解，不是只摆了几个复选框', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const body = view.slice(view.indexOf('function snapDelta('), view.indexOf('function pointerMove('))
  assert.ok(/enabled: snapTargetsOn/.test(body), 'snapDelta 必须把四类开关交给纯模块')
  assert.ok(/computeSnap\(/.test(body) && /threshold: SNAP_PX \/ pxPerMm\.value/.test(body), '走纯模块求解，且阈值按像素口径换算')
  assert.ok(/guides: visibleGuides\.value/.test(body), '参考线目标只取可见的那些（隐藏的参考线也不该还能吸）')
  assert.ok(/grid: \{ spacing: Number\(gridSpacing\.value\) \}/.test(body), '网格目标用界面上的间距设置，不另取一份')
})
check('拖出参考线：拖动过程只画预览，松手才落一条（撤销栈不会被几十条中间态冲爆）', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  const body = (name, next) => view.slice(view.indexOf(`function ${name}(`), view.indexOf(`function ${next}(`))
  const move = body('rulerPointerMove', 'rulerPointerUp')
  assert.ok(!/commit\(/.test(move), 'pointermove 里不许 commit')
  assert.ok(/rulerDrag\.value = /.test(move), '拖动只更新预览')
  assert.ok(/commit\(/.test(body('rulerPointerUp', 'rulerPointerCancel')), 'pointerup 才落成参考线')
  // 参考线数量上限与领域层一致，超了要明确报错而不是静默不落
  assert.ok(/>=\s*100/.test(body('rulerPointerUp', 'rulerPointerCancel')), '超过 100 条要拦下来')
})
check('标尺挂在画布**外缘**，开标尺不会把画布挤小（I-34 的同类教训）', () => {
  const view = read('src/views/BackgroundDesignerView.vue')
  assert.ok(/\.ruler-h \{[^}]*bottom: 100%/.test(view), '横向标尺必须贴在画布上缘外侧')
  assert.ok(/\.ruler-v \{[^}]*right: 100%/.test(view), '纵向标尺必须贴在画布左缘外侧')
  assert.ok(/\.ruler \{[^}]*position: absolute/.test(view), '绝对定位 ⇒ 不参与画布布局，画布尺寸不变')
})

console.log(`\n底图对齐辅助（标尺 / 网格 / 吸附目标）：${passed} 项通过`)

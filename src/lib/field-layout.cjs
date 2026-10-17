/**
 * 画布字段锚点换算（纯函数，Node 可测）。
 * 坐标语义与渲染引擎一致：x/y 是**锚点**百分比——align=center 时 x 是文本中心线
 * （渲染 translateX(-50%)，画布同样位移），left/right 时为左/右缘；y 恒为上缘。
 * 因此换算只动锚点、不感知文本宽度——这正是画布与出片能对齐的前提。
 *
 * 「均分横排」曾住在这里，v0.6.2 连函数一起下线了（见 git log 的提交说明）——
 * 没有调用方的一键布局不该留下一个纯函数当死代码。
 */

/** 锚点在盒内的比例：居中 0.5 / 右缘 1 / 左缘 0。盒左缘 = 锚点px - ratio × 盒宽 */
function anchorRatio(f) {
  return f.align === 'center' ? 0.5 : f.align === 'right' ? 1 : 0
}

module.exports = { anchorRatio }

/**
 * 内置底图预设：把「已经排好位置」的常用底图做成模板，用户选一个就**复制成自己的新工程**。
 *
 * 纯 Node、零 electron 依赖，可单测。几何全部毫米，坐标原点在画布左上角。
 *
 * ⚠️ 内置预设**只保留身份证一套**（2026-10-09 收敛）。
 *
 * 原先还内置了票据粘贴单与 5 套手写练习纸（田字格 / 四线三格 / 横线稿纸 / 方格纸 / 五线谱），
 * 现全部移除。原因有两条，第二条才是主要的：
 *
 * 1. 练习纸属于**另一类需求**：它不帮用户「对齐图片」，只是替用户画一堆格线，而格线
 *    用「＋矩形」自己就能画。参考框预设才是真省事（85.6 × 54 是量不出来的标准尺寸）。
 * 2. **内置预设越多，工程库越容易被堆满**：「常用模板」下拉每选一次就落库一份**新工程**
 *    （见 `design:createFromPreset`），用户为了挑一套顺眼的版面点几遍，工程库里就多出
 *    一堆同名工程——实测一次会话堆出了 18 个。所以内置数量必须克制，把下拉让给
 *    「最近使用」（用户自己真正在用的工程），而不是一屏内置常量。
 *
 * ⚠️ 若日后重新加回格线类预设，务必记住两类预设的性质**相反**，别搞混：
 * - **证件 / 票据类 = 参考框**（`editorOnly: true`）：编辑器看得见、出片看不见，
 *   用户把图片拖进来照着它对位置。整张纸除了用户自己放的内容，**什么都不印**。
 * - **手写练习纸 = 格线**（普通图层）：格线**就是要印出来的**，绝不能标 `editorOnly`。
 *   标错的后果是一张白纸，且不会报错。
 *
 * 尺寸只收**有权威来源**的：身份证 / 银行卡用 ISO/IEC 7810 **ID-1 = 85.6 × 54 mm**。
 * 户口本、驾驶证、毕业证这类各版式差异大、把握不足的**一律不内置**——内置一个
 * 「可能不对」的尺寸比不内置更糟（用户会照着错的框去贴）。
 */
const { normalizeDesign } = require('./design-layout.cjs')

const A4 = { w: 210, h: 297, background: '#ffffff' }
const REF_INK = '#b03a2e' // 参考框：朱红，与画布选中框同一族
const REF_TEXT = '#8a8378' // 参考框标注

/** 每个预设一份自增 id：同一份工程内唯一，且可复现（不用随机数，测试才好断言）。 */
function ids() {
  let n = 0
  return () => `L${++n}`
}

/** 参考框：编辑器可见、出片不可见（`editorOnly` 见 design-layout.cjs）。 */
function refBox(id, name, x, y, w, h) {
  return { id, type: 'rect', name, x, y, w, h, fill: 'transparent', stroke: REF_INK, strokeWidth: 0.3, radius: 0, editorOnly: true }
}

/** 参考框的标注，贴在框上方 6mm；同样只在编辑器里出现。 */
function refLabel(id, text, x, y, w = 90) {
  return { id, type: 'text', name: `标注：${text}`, text, x, y, w, h: 5, fontFamily: '', fontSize: 8, bold: false, color: REF_TEXT, align: 'left', lineHeight: 1.2, letterSpacing: 0, editorOnly: true }
}

/** 只给编辑器看的说明文字（复印件上不该印任何说明）。 */
function note(id, text, x, y, w = 170, fontSize = 9) {
  return { id, type: 'text', name: '说明', text, x, y, w, h: 10, fontFamily: '', fontSize, bold: false, color: REF_TEXT, align: 'center', lineHeight: 1.4, letterSpacing: 0, editorOnly: true }
}

const PRESETS = [
  {
    id: 'id-card-a4',
    name: '身份证正反面复印件',
    summary: 'A4 竖版 · 上下两个 85.6 × 54 mm 标准卡位（ISO/IEC 7810 ID-1）',
    build() {
      const id = ids()
      const x = Math.round(((A4.w - 85.6) / 2) * 10) / 10 // 62.2，水平居中
      /*
       * 纵向按 A4 **三等分**排：两个卡位的中心分别落在 1/3、2/3 高度处。
       *   框高 54 ⇒ 正面 72~126、反面 171~225，框间净空 45mm，上下各留白 72mm。
       * 净空 45 不是随手取的：它正是「两框中心相距 99mm（= 297/3）」推出来的结果，
       * 所以整组天然在纸上垂直居中。
       *
       * 旧值（正面 40、反面 114）净空只有 20mm——不到框高的 40%，两框挤成一团；
       * 而下方空出 129mm，是上方留白（40mm）的 3 倍多，整组重心明显偏上。
       * 用户反馈「上下间隔太小、在 A4 上不协调」就是这个。
       *
       * ⚠️ 别再改小：净空 < 40mm 或整组不居中，`test/design-presets.cjs` 会红。
       */
      const TOP = 72 // 正面框顶
      const BOTTOM = TOP + 54 + 45 // 反面框顶 = 171（净空 45mm）
      return {
        artboard: A4,
        layers: [
          refLabel(id(), '身份证正面（人像面）· 85.6 × 54 mm', x, TOP - 7, 120),
          refBox(id(), '参考框：身份证正面（人像面）', x, TOP, 85.6, 54),
          refLabel(id(), '身份证反面（国徽面）· 85.6 × 54 mm', x, BOTTOM - 7, 120),
          refBox(id(), '参考框：身份证反面（国徽面）', x, BOTTOM, 85.6, 54),
          // 说明是「仅编辑可见」的脚注，压在框组下方，不参与框组的居中计算
          note(id(), '把身份证正面朝上放进上框、反面放进下框，四边对齐虚线。虚线框和这行说明都不会打印。', 20, 246),
        ],
      }
    },
  },
]

/** 给界面用的清单：只有 id / 名称 / 一句话说明，不带几何。 */
function listPresets() {
  return PRESETS.map(({ id, name, summary }) => ({ id, name, summary }))
}

/**
 * 按预设造一份**未保存**的新工程（`id` / `revision` 由 `designs.saveDesign` 补）。
 *
 * 一律过一遍 `normalizeDesign`：预设里写错一个字段就在创建时炸掉，而不是等用户
 * 印出来才发现。传空名字时退回预设名（`normalizeDesign` 对空名会抛错）。
 */
function buildPreset(presetId, name) {
  const preset = PRESETS.find((item) => item.id === presetId)
  if (!preset) throw new Error(`没有这个内置模板：${presetId}`)
  const title = String(name == null ? '' : name).trim() || preset.name
  return normalizeDesign({ schemaVersion: 1, revision: 0, name: title, assets: {}, ...preset.build() })
}

module.exports = { listPresets, buildPreset, PRESETS }

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import DesignSurface from '../components/DesignSurface.vue'
import AssetLibrarySidebar from '../components/AssetLibrarySidebar.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { designerNav } from '../lib/designer-nav.js'
import { activeDataset } from '../lib/active-dataset.js'
import { normalizeDesign, imageDpi, normalizeFamily, DEFAULT_FONT_STACK, BLEND_MODES, CROP_RATIOS, fitCropToRatio } from '../../electron/design-layout.cjs'
// 体积显示只有一份实现（含 GB 档），出片体积提示与本页导出结果共用
import { formatBytes } from '../lib/format-bytes.cjs'
// 格式表与体积估算在纯模块里——出图实现读的是同一份，界面不抄第二遍（见 I-41）。
import { FORMATS, normalizeQuality, estimateOutputBytes } from '../../electron/export-formats.cjs'
// 报错文案的唯一整理入口（I-48）。IPC 侧 preload 已经洗过一遍，这里再兜一层是为了
// **渲染进程自己抛的**（如 renderDesign 校验失败）也不漏英文。
import { toUserMessage } from '../../electron/user-error.cjs'
import {
  expandSelection, editableSelection, selectLayer as selectGroupedLayer, groupForLayer,
  createGroup, ungroupSelection, duplicateSelection, removeSelection, reorderSelection,
  copyLayerStyle, applyLayerStyle, transformGroup,
} from '../../electron/design-editor.cjs'
// 标尺刻度 / 布局网格 / 吸附目标的纯算术都在这里——DOM 测量留在本组件，见 I-45。
import {
  DEFAULT_SNAP_TARGETS, rulerTicks, gridPixelSteps, snapTargets, computeSnap, guidePositionFromOffset,
} from '../lib/designer-aids.cjs'
// 吸附阈值只有一份定义（6px，模板页拖拽用的是同一个数），别在这里再写一个 6。
import { SNAP_PX } from '../lib/field-edit.cjs'

defineOptions({ name: 'BackgroundDesignerView' })

const DRAFT_KEY = 'printpress-background-designer-draft-v1'
const clone = (value) => JSON.parse(JSON.stringify(value))
const uid = (prefix = 'layer') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
const portraitPicker = ref(false)
const portraitDatasets = ref([])
const portraitDataset = ref('')
const portraitColumns = ref([])
const portraitColumn = ref('')
const portraitLists = ref([])
const portraitChecking = ref(true)
const portraitInserting = ref(false)
let portraitListRequest = 0
const portraitTarget = computed(() => {
  const id = context.value?.datasetId || activeDataset.value
  if (id) return portraitLists.value.find(ds => ds.id === id)
  return portraitDatasets.value.find(ds => ds.id === portraitDataset.value) || portraitDatasets.value[0]
})
const canAddPortrait = computed(() => !portraitChecking.value && !!portraitTarget.value?.photoMatchColumn)
async function refreshPortraitAvailability() {
  const token = ++portraitListRequest
  portraitChecking.value = true
  try {
    const lists = await window.printpress.listDatasets()
    if (token !== portraitListRequest || !active) return false
    portraitLists.value = lists
    portraitDatasets.value = lists.filter(ds => ds.photoMatchColumn)
    return !!portraitTarget.value?.photoMatchColumn
  } catch (err) {
    if (token === portraitListRequest) {
      portraitLists.value = []; portraitDatasets.value = []
      fail(err)
    }
    return false
  } finally { if (token === portraitListRequest) portraitChecking.value = false }
}
let portraitRequest = 0
watch(portraitDataset, async id => {
  const token = ++portraitRequest
  portraitColumns.value = []; portraitColumn.value = ''
  if (!id) return
  try {
    const ds = await window.printpress.getDataset(id)
    if (token !== portraitRequest) return
    portraitColumns.value = ds.columns
    portraitColumn.value = ds.photoMatchColumn || ''
  } catch (err) { fail(err) }
})
async function openPortraitPicker() {
  if (busy.value || !canAddPortrait.value) return
  try {
    if (!await refreshPortraitAvailability()) return
    const targetId = portraitTarget.value?.id || ''
    portraitDataset.value = ''; portraitColumn.value = ''; portraitColumns.value = []
    await nextTick()
    portraitDataset.value = targetId
    portraitPicker.value = true
  } catch (err) { fail(err) }
}
async function addPortrait() {
  if (busy.value || portraitInserting.value || !portraitColumn.value) return
  const datasetId = portraitDataset.value
  const session = sessionToken.value
  portraitInserting.value = true
  try {
    // Recheck persisted matching before insertion; a stale dialog must not create an unbound layer.
    const ds = await window.printpress.getDataset(datasetId)
    if (!active || !portraitPicker.value || session !== sessionToken.value || datasetId !== portraitDataset.value) return
    if (!ds.photoMatchColumn || !ds.columns.some(c => c.key === ds.photoMatchColumn)) {
      portraitColumn.value = ''
      await refreshPortraitAvailability()
      fail('该名单已关闭配图，请先在数据页开启一个列头的“配图”开关。')
      return
    }
    const id = uid('portrait')
    commit(doc => doc.layers.push({ id, type: 'image', variable: true, name: '变量图', bindColumn: ds.photoMatchColumn, x: 10, y: 10, w: 35, h: 45, fit: 'cover', focal: { x: 0.5, y: 0.5 }, radius: 0 }))
    selectedIds.value = [id]
    portraitPicker.value = false
    message.value = '已添加变量图。保存工程并应用到模板后，在打印中心按名单换图。'
  } catch (err) { fail(err) }
  finally { portraitInserting.value = false }
}
function setPhotoFocal(axis, value) {
  commit(doc => { doc.layers.find(l => l.id === single.value.id).focal[axis] = Number(value) / 100 })
}
const round = (n) => Math.round(n * 1000) / 1000
function blank(w = 297, h = 210) {
  return { schemaVersion: 1, revision: 0, name: '未命名底图', artboard: { w, h, background: '#ffffff' }, layers: [], assets: {} }
}
// Save identity is independent of content: undo must never move the persisted revision backwards.
function fingerprint(value) {
  const { id, revision, createdAt, updatedAt, ...content } = value
  // The main process rewrites asset metadata from trusted files. Property insertion order
  // is not content: canonicalize keys so a successful save cannot appear perpetually dirty.
  return JSON.stringify(content, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
}
const design = ref(normalizeDesign(blank()))
const savedFingerprint = ref(fingerprint(design.value))
const dirty = computed(() => fingerprint(design.value) !== savedFingerprint.value)
const projects = ref([])
const presets = ref([])
const selectedIds = ref([])
const selected = computed(() => design.value.layers.filter((layer) => selectedIds.value.includes(layer.id)))
const single = computed(() => selected.value.length === 1 ? selected.value[0] : null)
const editable = computed(() => {
  const ids = new Set(editableSelection(design.value, selectedIds.value))
  return design.value.layers.filter((layer) => ids.has(layer.id) && selectedIds.value.includes(layer.id))
})
const singleBlocked = computed(() => single.value && !editable.value.some(layer => layer.id === single.value.id))
const selectedGroup = computed(() => (design.value.groups || []).find(group =>
  group.layerIds.length === selectedIds.value.length && group.layerIds.every(id => selectedIds.value.includes(id))) || null)
const hasSelectedGroup = computed(() => (design.value.groups || []).some(group => group.layerIds.some(id => selectedIds.value.includes(id))))
const hasPartialGroup = computed(() => (design.value.groups || []).some(group => {
  const count = group.layerIds.filter(id => selectedIds.value.includes(id)).length
  return count > 0 && count < group.layerIds.length
}))
const groupRows = computed(() => {
  const rows = [], seen = new Set()
  for (const layer of [...design.value.layers].reverse()) {
    const group = groupForLayer(design.value, layer.id)
    if (group && !seen.has(group.id)) { rows.push({ kind: 'group', id: group.id, group }); seen.add(group.id) }
    rows.push({ kind: 'layer', id: layer.id, layer, group })
  }
  return rows
})
const history = ref([])
const future = ref([])
const error = ref('')
const message = ref('')
const busy = ref(false)
// 素材库侧栏显隐 + 插入会话保护：每次切换/新建/另存工程都换令牌，
// 异步拉取素材期间若切换了工程，插入请求作废，绝不写进新画板（计划 §3.3）。
const showAssets = ref(false)
// 属性面板（工程与画布 / 检查器）是右侧常驻浮层：不占网格列，画布满宽。
// 工程级设置（名称/画布/参考线）是「文档」属性，不随选中态消失；
// 图层属性部分随选中自动出现/收起（见模板 selected.length 门控）。
// 左栏宽度可拖拽调节，记忆在 localStorage（150–420px）。
const TOOLS_W_KEY = 'printpress-designer-tools-width'
const toolsWidth = ref(clampNumber(Number((() => { try { return localStorage.getItem(TOOLS_W_KEY) } catch { return null } })()) || 176, 150, 420))
const resizingTools = ref(false)
const sessionToken = ref(0)
// 已加入素材库的原图 id 集合：图层行的 ★/＋ 状态以此为准（getAsset 有 entry = 已收藏）
const adoptedIds = ref(new Set())
async function refreshAdopted() {
  const ids = new Set()
  for (const id of Object.keys(design.value.assets || {})) {
    try {
      const res = await window.printpress.getAsset(id)
      if (res && res.entry) ids.add(id)
    } catch { /* 读不到按未收藏处理 */ }
  }
  adoptedIds.value = ids
}
/** 图层行「＋ 加入素材库」：升级为 library 受管理件（I-33 单向升级唯一出口） */
async function adoptLayerAsset(layer) {
  if (busy.value) return
  busy.value = true
  try {
    await window.printpress.adoptAsset(layer.assetId, {})
    adoptedIds.value = new Set([...adoptedIds.value, layer.assetId])
    // 同步文档里的 source：升为受管理后，「删图层会不会清原图」的判定才准确
    // （commit 内部会 clearFeedback，所以提示必须写在它之后）
    commit((doc) => { if (doc.assets[layer.assetId]) doc.assets[layer.assetId].source = 'managed' })
    message.value = '已加入素材库：这张图受管理，删除图层不会清理原件'
  } catch (err) { fail(err) }
  finally { busy.value = false }
}
const fonts = ref({ system: [], uploaded: [] })
const context = ref(null)
watch([() => context.value?.datasetId, activeDataset], () => {
  if (active) { portraitPicker.value = false; refreshPortraitAvailability() }
})
const pending = ref(null)
const stage = ref(null)
const canvasScroll = ref(null)
const horizontalScroll = ref(null)
const horizontalTrackWidth = ref(0)
const zoom = ref(1)
const focusCanvas = ref(false)
const copiedStyle = ref(null)
const groupScalePercent = ref(100)
const groupRotateDegrees = ref(0)
const navigator = ref({ needed: false, width: 170, height: 120, left: 0, top: 0, boxWidth: 170, boxHeight: 120 })
let canvasObserver = null
function syncHorizontalScroll() {
  const canvas = canvasScroll.value, bar = horizontalScroll.value
  if (!canvas || !bar) return
  // Match the actual scroll range, including the space reserved for the
  // floating inspector. The bar itself stops before that panel.
  const width = bar.clientWidth + Math.max(0, canvas.scrollWidth - canvas.clientWidth)
  if (horizontalTrackWidth.value !== width) {
    horizontalTrackWidth.value = width
    nextTick(() => { if (canvasScroll.value === canvas && horizontalScroll.value === bar) bar.scrollLeft = canvas.scrollLeft })
  } else if (Math.abs(bar.scrollLeft - canvas.scrollLeft) > 1) bar.scrollLeft = canvas.scrollLeft
}
function scrollFromHorizontalBar() {
  if (canvasScroll.value && horizontalScroll.value) canvasScroll.value.scrollLeft = horizontalScroll.value.scrollLeft
}
function updateNavigator() {
  syncHorizontalScroll()
  const scroll = canvasScroll.value, board = stage.value
  if (!scroll || !board) return
  const scrollRect = scroll.getBoundingClientRect(), boardRect = board.getBoundingClientRect()
  const left = boardRect.left - scrollRect.left + scroll.scrollLeft - scroll.clientLeft
  const top = boardRect.top - scrollRect.top + scroll.scrollTop - scroll.clientTop
  const width = board.offsetWidth, height = board.offsetHeight
  if (!width || !height) return
  const factor = 170 / Math.max(width, height)
  const previewWidth = Math.max(1, Math.round(width * factor)), previewHeight = Math.max(1, Math.round(height * factor))
  const clipX = Math.max(0, Math.min(width, scroll.scrollLeft - left))
  const clipY = Math.max(0, Math.min(height, scroll.scrollTop - top))
  navigator.value = {
    needed: width > scroll.clientWidth - 60 || height > scroll.clientHeight - 60,
    width: previewWidth, height: previewHeight,
    left: clipX * factor, top: clipY * factor,
    boxWidth: Math.max(1, Math.min(width - clipX, scroll.clientWidth) * factor),
    boxHeight: Math.max(1, Math.min(height - clipY, scroll.clientHeight) * factor),
  }
}
function navigateCanvas(event) {
  const scroll = canvasScroll.value, board = stage.value
  if (!scroll || !board) return
  const rect = event.currentTarget.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  const scrollRect = scroll.getBoundingClientRect(), boardRect = board.getBoundingClientRect()
  const left = boardRect.left - scrollRect.left + scroll.scrollLeft - scroll.clientLeft
  const top = boardRect.top - scrollRect.top + scroll.scrollTop - scroll.clientTop
  scroll.scrollLeft = left + x * board.offsetWidth - scroll.clientWidth / 2
  scroll.scrollTop = top + y * board.offsetHeight - scroll.clientHeight / 2
  updateNavigator()
}
function navigatorPointerDown(event) {
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  navigateCanvas(event)
}
function navigatorPointerMove(event) {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) navigateCanvas(event)
}
const snap = ref(true)
const keepRatio = ref(true)
/**
 * 证件照与卡片的**成品尺寸**预设（毫米）——由主进程下发，不在这里抄一份。
 *
 * 来源是 `templates.cjs` 的 `ITEM_SIZES`，多联拼版的「成品尺寸」下拉用的是同一份
 * （经 `app:env` 下发）。同一个「1 寸 = 25×35」只能有一个定义，否则改一处必漏另一处。
 */
const itemSizes = ref([])
/** 尺寸/比例下拉的当前值。选完立刻回位成空串，好让同一个预设能连点两次。 */
const sizePreset = ref('')
const guides = ref({ x: null, y: null })
const guidesVisible = ref(true)
const newGuideAxis = ref('x')
const newGuidePosition = ref(50)
const visibleGuides = computed(() => guidesVisible.value ? (design.value.guides || []).filter(guide => guide.position >= 0 && guide.position <= design.value.artboard[guide.axis === 'x' ? 'w' : 'h']) : [])
/**
 * 标尺与布局网格是**视图辅助**，不进工程文件、不进 `renderDesign`。
 *
 * 这一点必须咬死：它们一旦进了文档 schema，就有被真印到纸上的风险（I-25 的教训——
 * 「只编辑可见」的东西漏了 `editorOnly`，参考框就被印出去了）。放在视图层，
 * 从根上就没有「印出来」这条路径，也就不需要为它们抬工程版本号。
 */
const rulers = ref(false)
const gridVisible = ref(false)
const gridSpacing = ref(10)
const gridSubdivisions = ref(5)
/** 从标尺往外拖时的预览线（松手才真正落成参考线）。 */
const rulerDrag = ref(null)
/**
 * 四类吸附目标各自开关（画布边缘 / 参考线 / 网格 / 图层边缘与中心）。
 * 缺省**网格关**：网格默认不显示，而「看不见的吸附线」比不吸附更糟——用户会以为
 * 图层拖不动了。其余三类默认开，与加这个开关之前的行为逐字一致。
 */
const snapTargetsOn = reactive({ ...DEFAULT_SNAP_TARGETS })
const showExport = ref(false)
const exportDpi = ref(300)
const exportFormat = ref('png')
const exportQuality = ref(FORMATS.jpeg.quality)
const exportTransparent = ref(false)
const exportError = ref('')
const exportFormatInfo = computed(() => FORMATS[exportFormat.value])
/** 只有有损格式才谈得上质量；PNG 是无损的，滑杆对它没有任何意义。 */
const exportLossy = computed(() => exportFormatInfo.value.quality !== null)
/**
 * 切换格式时把质量拉回该格式的默认值——JPEG 的 90 与 WebP 的 80 不是一个量纲，
 * 沿用上一个格式的数字会让用户以为「同一个 90 在两个格式里等价」。
 */
function pickExportFormat() {
  exportQuality.value = normalizeQuality(undefined, exportFormat.value)
  // JPEG 没有 alpha 通道，勾着透明是自相矛盾的：直接清掉，让界面与最终产物一致。
  if (!exportFormatInfo.value.transparent) exportTransparent.value = false
}
/**
 * 最近一次成功导出的结果（含绝对路径），用来给出「打开所在文件夹 / 用系统程序打开」。
 *
 * 存结果、不存路径字符串本身：这两个动作**不接受参数**，真正被打开的路径由主进程
 * 记着（最近一次写出的图片）。渲染层手里这份只用于显示与按钮开关。
 */
const lastExport = ref(null)
const exportSize = computed(() => ({
  width: Math.round(design.value.artboard.w * exportDpi.value / 25.4),
  height: Math.round(design.value.artboard.h * exportDpi.value / 25.4),
}))
const exportSizeError = computed(() => {
  const { width, height } = exportSize.value
  if (width > 16384 || height > 16384) return '输出单边不能超过 16,384 像素，请降低 DPI 或缩小画布。'
  if (width * height > 40000000) return '输出不能超过 4,000 万像素，请降低 DPI 或缩小画布。'
  return ''
})
/**
 * 体积预估——**只对有损格式给**，而且一律写「约」。
 *
 * PNG 是无损的，体积由内容复杂度决定（矢量文字与照片能差几十倍），估出来既不准
 * 也帮不了用户做决定；给个像模像样的假数字比不给更糟。导出完成后用真实字节数覆盖。
 */
const exportEstimate = computed(() => {
  if (!exportLossy.value || exportSizeError.value) return null
  return estimateOutputBytes({
    width: exportSize.value.width, height: exportSize.value.height,
    format: exportFormat.value, quality: exportQuality.value,
  })
})
const inputEpoch = ref(0)
const canvasWidth = computed(() => 720 * zoom.value)
const pxPerMm = computed(() => canvasWidth.value / design.value.artboard.w)
const canvasHeight = computed(() => design.value.artboard.h * pxPerMm.value)
watch([zoom, focusCanvas, canvasWidth, canvasHeight], () => nextTick(updateNavigator))
/**
 * 标尺刻度与网格线的位置（毫米）。
 *
 * 刻度步长要按「每毫米占多少像素」自适应：画布放大就用更密的步长、缩小就变疏，
 * 否则缩小时数字糊成一团、放大时又只剩几个孤零零的标号。
 */
const rulerTicksX = computed(() => (rulers.value ? rulerTicks(design.value.artboard.w, pxPerMm.value) : []))
const rulerTicksY = computed(() => (rulers.value ? rulerTicks(design.value.artboard.h, pxPerMm.value) : []))
/**
 * 网格用 CSS 重复渐变画，而不是每格一个 div：300 图层工程里几百个额外节点会明显拖慢，
 * 而「间距 0.5mm / 细分数 20」这种配置下按格生成会是上千个节点。
 * 步长由纯模块的 `gridPixelSteps` 给出——界面画的线与吸附用的线必须出自同一份算术（见 I-45）。
 * 主格线写在前面：CSS 里**先声明的背景在最上层**，反过来次格线会盖住主格线。
 */
const gridOverlayStyle = computed(() => {
  const steps = gridPixelSteps(Number(gridSpacing.value), Number(gridSubdivisions.value), pxPerMm.value, design.value.artboard.w)
  if (!steps) return { display: 'none' }
  const band = (color, size) => `repeating-linear-gradient(to right, ${color} 0 1px, transparent 1px ${size}px), repeating-linear-gradient(to bottom, ${color} 0 1px, transparent 1px ${size}px)`
  return { backgroundImage: `${band('rgba(38,137,201,.5)', steps.major)}, ${band('rgba(38,137,201,.16)', steps.minor)}` }
})
const fontNames = computed(() => [...new Set([...fonts.value.system, ...fonts.value.uploaded].map((font) => font.family))])
const dimensionMismatch = computed(() => context.value && (
  Math.abs(context.value.artboard.w - design.value.artboard.w) > 0.01 ||
  Math.abs(context.value.artboard.h - design.value.artboard.h) > 0.01
))
const dpi = computed(() => {
  if (single.value?.type !== 'image') return null
  return imageDpi(single.value, design.value.assets[single.value.assetId])
})
const dpiText = computed(() => {
  const value = dpi.value
  if (typeof value === 'number') return Math.round(value)
  if (value && Number.isFinite(value.min)) return Math.round(value.min)
  if (value && Number.isFinite(value.x)) return Math.round(Math.min(value.x, value.y))
  return '—'
})
let initialized = false
let active = false
let draftTimer = null
let gesture = null
// 双击文字图层的判定状态（见 pointerDown 里的说明）
let lastTextDown = { id: '', at: 0 }
let keyBefore = null
let keyboardTimer = null
const fontFaces = []
const loadedFontFiles = new Set()

function fail(err) { error.value = toUserMessage(err); message.value = '' }
function formatColor(value) { return value === 'transparent' ? '透明' : String(value || '').toUpperCase() }
function clearFeedback() { error.value = ''; message.value = '' }
/**
 * 撤销 / 重做栈上限（步数）。
 *
 * 快照存的是整份文档（实测约 0.33 KB/图层：20 图层工程一步 ~6.6 KB，50 步 ≈ 0.3 MB；
 * 最重的 300 图层 × 50 步也只有 ~4 MB），所以**内存不是约束**——这个上限只是防御性封顶，
 * 防止超长编辑会话 / 超大工程把栈撑到无意义的大。
 *
 * 之所以敢从 5 放大到 50：删临时件时不再「整栈清空」，改成**只丢弃引用了被删素材的那些快照**
 * （见 discardOrphanedEphemeral）。清栈不再是钝刀，这个上限就不必再兼任「清栈损失的上限」。
 */
const UNDO_LIMIT = 50
function pushCapped(stack, snapshot) {
  stack.value.push(snapshot)
  while (stack.value.length > UNDO_LIMIT) stack.value.shift()
}
function record(before) {
  if (fingerprint(before) === fingerprint(design.value)) return
  pushCapped(history, before)
  future.value = []
}
function commit(change) {
  endGesture()
  finishKeyboardMove()
  colorDraft.value = null // 别的编辑一来就让取色快照失效，免得撤销时连带回滚无关改动
  const before = clone(design.value)
  try {
    change(design.value)
    design.value = normalizeDesign(design.value)
    record(before)
    clearFeedback()
    return true
  } catch (err) {
    design.value = before
    inputEpoch.value++
    fail(err)
    return false
  }
}
function undo() {
  endGesture(); finishKeyboardMove()
  if (!history.value.length) return
  pushCapped(future, clone(design.value))
  restoreHistory(history.value.pop())
}
function redo() {
  endGesture(); finishKeyboardMove()
  if (!future.value.length) return
  pushCapped(history, clone(design.value))
  restoreHistory(future.value.pop())
}
function restoreHistory(snapshot) {
  const { id, revision } = design.value
  colorDraft.value = null
  design.value = normalizeDesign({ ...snapshot, ...(id ? { id } : {}), revision })
  if (!id) delete design.value.id
  selectedIds.value = selectedIds.value.filter((id) => design.value.layers.some((layer) => layer.id === id))
  clearFeedback()
}
function replaceDesign(value, source = null, saved = true) {
  endGesture(); finishKeyboardMove()
  sessionToken.value++ // 切换工程：作废进行中的素材插入
  design.value = normalizeDesign(value)
  savedFingerprint.value = saved ? fingerprint(design.value) : ''
  context.value = source
  selectedIds.value = []
  history.value = []; future.value = []
  clearFeedback()
  zoom.value = 1
  persistDraft()
}
function protectDraft(action, cancel = null) {
  if (busy.value) return false
  if (dirty.value) {
    pending.value = { title: '切换底图工程', message: '当前底图有未保存的修改。继续将放弃这些修改，请先保存需要保留的内容。', confirmText: '放弃修改并继续', action, cancel }
    return false
  }
  return action()
}
function confirmPending() {
  const action = pending.value?.action
  pending.value = null
  action?.()
}
function cancelPending() {
  const cancel = pending.value?.cancel
  pending.value = null
  cancel?.()
}
function returnToTemplate(request = context.value) {
  if (!request) return
  designerNav.result = { nonce: request.nonce, templateKey: request.templateKey, canceled: true }
  if (request === context.value) context.value = null
}
function newDesign() {
  protectDraft(() => replaceDesign(blank(context.value?.artboard.w, context.value?.artboard.h), context.value, false))
}
async function refreshProjects() {
  projects.value = await window.printpress.listDesigns()
}
async function refreshPresets() {
  presets.value = await window.printpress.listDesignPresets()
}
/** 成品尺寸预设（证件照 / 卡片，毫米）——主进程下发，与多联拼版共用同一份定义。 */
async function loadItemSizes() {
  const env = await window.printpress.getEnv()
  itemSizes.value = env.itemSizes || []
}
/**
 * 「常用模板」下拉里的「常用」：**用户自己保存过的**工程，按最近使用倒序，最多 8 个。
 *
 * ⚠️ 门槛是「用户保存过」（摘要里有 `lastUsedAt`），不是「存在过」——
 * 系统按内置预设自动建出来的工程**不进常用**（主进程 `saveDesign(..., { recordUse: false })`），
 * 否则每点一次「身份证（新建）」就往常用里塞一条，跟「工程库每点一次多一个」
 * 是同一类病（实测一次会话 18 个、装上 0.4.0 又点了 4 个）。
 * 打开一份从没保存过的工程也不会把它塞进来（`touchDesign` 只刷新已在常用里的）。
 *
 * 排序键优先 `lastUsedAt`，没有它的（本特性之前保存的旧工程）退回 `updatedAt`——
 * 这样不需要任何数据迁移，老工程照样出现在列表里，只是排在新记录后面。
 */
const RECENT_LIMIT = 8
const recentDesigns = computed(() => {
  /*
   * 两道过滤，顺序不能反：
   *
   * 1. **门槛**：`lastUsedAt !== null` 才是「用户自己保存过」的工程。
   *    `null` 表示「系统按内置预设自动建出来的」（主进程 `saveDesign(..., { recordUse: false })`），
   *    它不该一出生就进常用——否则每点一次「身份证（新建）」就往常用里塞一条。
   *    老工程没有这个字段（`undefined`），按旧行为照收，靠 `updatedAt` 排序。
   *
   * 2. **同名折叠**：工程库里若堆着几份同名工程（「每点一次多一个」堆出来的历史残留），
   *    下拉里出现一排一模一样的名字，用户根本分不清该点哪个。
   *    只在「常用」里折叠，工程库仍列全部（那是真实清单，不能替用户藏工程）。
   */
  const seen = new Set()
  return [...projects.value]
    .filter((item) => item.lastUsedAt !== null)
    .sort((a, b) => String(b.lastUsedAt || b.updatedAt).localeCompare(String(a.lastUsedAt || a.updatedAt)))
    .filter((item) => (seen.has(item.name) ? false : (seen.add(item.name), true)))
    .slice(0, RECENT_LIMIT)
})
/**
 * 记一次「使用」（打开工程时调用），供上面的「最近使用」排序。
 *
 * 最佳努力：**使用记录失败不该让「打开工程」本身报错**（工程已经打开了），所以只吞
 * 这一条 IPC 的失败。保存路径不用调它——`designs.saveDesign` 在主进程里已经把
 * `lastUsedAt` 刷成保存时刻了（保存本身就是一次使用）。
 */
async function markUsed(id) {
  if (!id) return
  try { await window.printpress.touchDesign(id) } catch { /* 使用记录失败不影响打开 */ }
}
/**
 * 从内置预设建工程：**工程库里已有同名工程就打开它**，否则才新建一份。
 *
 * 每次都复制一份会把工程库堆满（实测一次会话 18 个、装上 0.4.0 又点了 4 个）——
 * 判据放在主进程的 `design:createFromPreset` 里（**通道层面**堵住，不靠前端自觉），
 * 前端只负责把「新建了」和「打开了已有的」讲清楚，否则用户会以为「点了没反应」。
 *
 * 落库（而不是只放到编辑器里）是为了让它和「新建底图」一样是「一份真实工程」——
 * 否则用户刷新页面就丢了，而他可能已经往里面放过图片。
 */
function newFromPreset(presetId) {
  if (!presetId || busy.value) return
  const preset = presets.value.find((item) => item.id === presetId)
  protectDraft(async () => {
    busy.value = true
    try {
      const result = await window.printpress.createDesignFromPreset(presetId, '')
      await refreshProjects()
      replaceDesign(result.design, null, true)
      message.value = result.reused
        ? `「${result.design.name}」你已经有一份了，直接打开它——不复制新的（想要第二份用「另存副本」）。`
        : `已按「${preset?.name || '内置模板'}」新建工程，把图片拖到参考框上对齐即可。`
    } catch (err) { fail(err) } finally { busy.value = false }
  })
}
/**
 * 下拉里有两类条目，用值前缀区分（`<optgroup>` 只是视觉分组，值本身必须能自解释）：
 *
 * - `preset:<id>`：**内置版面**，选中即「**打开或新建**」——工程库里已有同名工程
 *   就打开它，没有才新建一份。判据在主进程 `design:createFromPreset`（**通道层面**），
 *   不是无条件复制：「每点一次多一个同名工程」正是工程库被堆满的根源
 *   （实测一次会话 18 个、装上 0.4.0 又点了 4 个）。
 * - `design:<id>`：**最近用过的工程**，选中即**打开它本身**——**绝不复制**。
 *
 * 选完一律复位：否则再选同一项不会触发 change，用户会以为「点了没反应」。
 */
function pickPreset(event) {
  const value = event.target.value
  event.target.value = ''
  if (value.startsWith('preset:')) { newFromPreset(value.slice('preset:'.length)); return }
  if (value.startsWith('design:')) {
    const id = value.slice('design:'.length)
    loadProject(projects.value.find((item) => item.id === id) || { id })
  }
}
async function refreshFonts() {
  fonts.value = await window.printpress.listFonts()
  for (const font of fonts.value.uploaded) {
    if (loadedFontFiles.has(font.file)) continue
    loadedFontFiles.add(font.file)
    const family = font.cssFamily || normalizeFamily(font.family)
    const face = new FontFace(family, `url("pp://media/print-fonts/${encodeURIComponent(font.file)}")`)
    document.fonts.add(face); fontFaces.push(face)
    face.load().catch(() => {
      loadedFontFiles.delete(font.file)
      if (design.value.layers.some((layer) => layer.type === 'text' && layer.fontFamily === font.family)) fail(`字体“${font.family}”加载失败，请检查字体文件。`)
    })
  }
}
async function loadProject(project) {
  if (!project?.id) return
  // 打开的就是当前这份、且没有未保存修改：直接返回。重载会清掉撤销历史，
  // 用户从「最近使用」里点中当前这一份时不该有这种副作用。
  if (project.id === design.value.id && !dirty.value) return
  return protectDraft(async () => {
    busy.value = true
    try {
      replaceDesign(await window.printpress.getDesign(project.id), context.value)
      // 先记使用、再刷列表：反过来的话下拉里拿到的还是记录前的顺序。
      await markUsed(project.id)
      await refreshProjects()
    }
    catch (err) { fail(err) }
    finally { busy.value = false }
  })
}
async function save(copy = false, apply = false) {
  if (busy.value) return
  endGesture(); finishKeyboardMove(); clearFeedback()
  if (apply && dimensionMismatch.value) { fail('工程尺寸与模板不一致，请先点击“采用模板尺寸”。'); return }
  busy.value = true
  try {
    const submitted = normalizeDesign(clone(design.value))
    if (copy) { delete submitted.id; submitted.revision = 0; submitted.name = `${submitted.name} 副本` }
    const contentBeforeCopy = fingerprint(design.value)
    const saved = await window.printpress.saveDesign(submitted)
    // Edits made while the write is in flight are retained and remain dirty.
    if (fingerprint(design.value) === contentBeforeCopy) { design.value = normalizeDesign(saved); sessionToken.value++ }
    else {
      design.value.id = saved.id
      design.value.revision = saved.revision
      sessionToken.value++ // 另存副本：身份换成新工程，作废进行中的素材插入
      if (copy && design.value.name === submitted.name.replace(/ 副本$/, '')) design.value.name = submitted.name
    }
    // 落点就是主进程规范化后的文档本身：它的指纹永远非空，比较基准只能是它。
    savedFingerprint.value = fingerprint(saved)
    message.value = dirty.value ? '已保存提交时的版本；之后的修改尚未保存。' : `已保存 · 第 ${saved.revision} 版`
    await refreshProjects()
    persistDraft()
    if (apply && context.value) {
      designerNav.result = { nonce: context.value.nonce, templateKey: context.value.templateKey, designRef: { id: saved.id, revision: saved.revision } }
      if (dirty.value) message.value += '模板使用刚刚保存的版本。'
    }
  } catch (err) { fail(err) }
  finally { busy.value = false }
}
function deleteProject(project) {
  if (busy.value) return
  pending.value = {
    title: '删除底图工程', message: `删除“${project.name}”的所有保存版本？被模板引用的工程无法删除。${design.value.id === project.id && dirty.value ? '\n当前工程的未保存修改也将清除。' : ''}`,
    confirmText: '删除工程', action: async () => {
      busy.value = true
      try {
        await window.printpress.deleteDesign(project.id)
        if (design.value.id === project.id) replaceDesign(blank(), null)
        await refreshProjects()
        message.value = '工程已删除。'
      } catch (err) { fail(err) }
      finally { busy.value = false }
    },
  }
}
async function consumeRequest(request) {
  if (!request || busy.value) return
  designerNav.request = null
  protectDraft(async () => {
    busy.value = true
    try {
      let value
      if (request.designRef) value = await window.printpress.getDesign(request.designRef.id, request.designRef.revision)
      else if (request.background) value = await window.printpress.importDesignBackground({ background: request.background, w: request.artboard.w, h: request.artboard.h, name: request.name || '模板底图' })
      else value = { ...blank(request.artboard.w, request.artboard.h), name: request.name || '模板底图' }
      replaceDesign(value, clone(request), !!request.designRef)
    } catch (err) { fail(err) }
    finally { busy.value = false }
  }, () => returnToTemplate(request))
}
watch(() => designerNav.request, (request) => { if (initialized) consumeRequest(request) })
watch(busy, (value) => { if (!value && initialized && designerNav.request) consumeRequest(designerNav.request) })
// 切换 / 新建 / 另存工程后重算「已加入素材库」集合（图层行 ★/＋ 状态）
watch(() => design.value.id, () => { refreshAdopted() })
/**
 * 顶部提示条 5 秒后自动消失（「已恢复上次未保存的底图草稿。」这类）。
 * 只作用于 `message`（成功 / 信息）：`error` 是 `role="alert"`，还可能带「采用模板尺寸」
 * 这类需要用户动手的按钮，自动消失会把操作入口一起带走，所以保持常驻、由用户点「关闭」。
 * 每次 message 变化都重置计时（含 `message.value += ...` 的追加写法）。
 */
const MESSAGE_TTL = 5000
let messageTimer = null
watch(message, (value) => {
  clearTimeout(messageTimer)
  if (!value) return
  messageTimer = setTimeout(() => { message.value = '' }, MESSAGE_TTL)
})

function persistDraft() {
  clearTimeout(draftTimer)
  try {
    if (dirty.value) localStorage.setItem(DRAFT_KEY, JSON.stringify({ design: design.value, savedFingerprint: savedFingerprint.value, context: context.value }))
    else localStorage.removeItem(DRAFT_KEY)
  } catch (err) { fail(`本地恢复草稿无法写入，请及时保存工程：${toUserMessage(err)}`) }
}
watch([design, savedFingerprint], () => {
  designerNav.dirty = dirty.value
  clearTimeout(draftTimer)
  draftTimer = setTimeout(persistDraft, 250)
}, { deep: true })

function selectLayer(layer, event = {}, memberOnly = false) {
  const toggle = !!(event.shiftKey || event.ctrlKey || event.metaKey)
  if (memberOnly) {
    selectedIds.value = toggle
      ? selectedIds.value.includes(layer.id) ? selectedIds.value.filter(id => id !== layer.id) : [...selectedIds.value, layer.id]
      : [layer.id]
  } else selectedIds.value = selectGroupedLayer(design.value, selectedIds.value, layer.id, { toggle })
}
function selectGroup(group, event = {}) { selectLayer({ id: group.layerIds[0] }, event) }
function groupMembers(group) { return design.value.layers.filter(layer => group.layerIds.includes(layer.id)) }
function groupHas(group, key) { return groupMembers(group).some(layer => layer[key]) }
function groupChosen(group) { return group.layerIds.every(id => selectedIds.value.includes(id)) }
const styleTargets = computed(() => copiedStyle.value
  ? editable.value.filter(layer => copiedStyle.value.kind === (['rect', 'ellipse'].includes(layer.type) ? 'shape' : layer.type)).length
  : 0)
function copyStyle() {
  if (!single.value) return
  try {
    copiedStyle.value = copyLayerStyle(design.value, single.value.id)
    message.value = `已复制“${single.value.name}”的样式，选择其他同类图层后点击“应用样式”。`
  } catch (err) { fail(err) }
}
function pasteStyle() {
  if (!copiedStyle.value || !styleTargets.value) return
  let count = 0
  const applied = commit(doc => {
    const result = applyLayerStyle(doc, selectedIds.value, copiedStyle.value)
    Object.assign(doc, result.design)
    count = result.applied
  })
  if (applied) message.value = `已把样式应用到 ${count} 个图层。`
}
function changeGroupTransform() {
  const group = selectedGroup.value
  if (!group || !Number.isFinite(Number(groupScalePercent.value)) || !Number.isFinite(Number(groupRotateDegrees.value))) return
  const scale = Number(groupScalePercent.value) / 100
  const rotation = Number(groupRotateDegrees.value)
  if (scale === 1 && rotation === 0) return
  const applied = commit(doc => Object.assign(doc, transformGroup(doc, group.id, { scale, rotation })))
  if (applied) {
    groupScalePercent.value = 100
    groupRotateDegrees.value = 0
    message.value = '已调整整组位置与大小，可用 Ctrl+Z 撤销。'
  }
}
function makeGroup() {
  if (selected.value.length < 2) return
  const groupId = uid('group')
  const made = commit(doc => Object.assign(doc, createGroup(doc, selectedIds.value, { id: groupId, name: '新建分组' })))
  if (made) selectedIds.value = design.value.groups.find(group => group.id === groupId).layerIds.slice()
}
function ungroup() {
  commit(doc => Object.assign(doc, ungroupSelection(doc, selectedIds.value)))
}
function renameGroup(value) {
  if (!selectedGroup.value) return
  const id = selectedGroup.value.id
  commit(doc => { doc.groups.find(group => group.id === id).name = value })
}
function toggleGroup(group, key) {
  const next = !groupHas(group, key)
  commit(doc => {
    for (const layer of doc.layers.filter(layer => group.layerIds.includes(layer.id))) layer[key] = next
  })
}
function addGuide() {
  commit(doc => {
    doc.guides = [...(doc.guides || []), { id: uid('guide'), axis: newGuideAxis.value, position: Number(newGuidePosition.value) }]
  })
}
function editGuide(id, value) {
  commit(doc => { doc.guides.find(guide => guide.id === id).position = Number(value) })
}
function removeGuide(id) { commit(doc => { doc.guides = doc.guides.filter(guide => guide.id !== id) }) }
function guideOutside(guide) {
  return guide.position < 0 || guide.position > design.value.artboard[guide.axis === 'x' ? 'w' : 'h']
}
/**
 * 从标尺往外拖出一条参考线。
 *
 * 语义按标尺的**度量方向**定：上方标尺量的是 X（左右），所以从它往下拖出来的是
 * 一条**垂直线**（`axis: 'x'`，位置是「距左边多少毫米」）；左侧标尺量 Y，拖出来的是水平线。
 * 拖的时候只画预览，**松手才 `commit`**——否则整段拖拽会在撤销栈里留下几十条中间态。
 */
function rulerPointerDown(event, axis) {
  const rect = stage.value?.getBoundingClientRect()
  if (!rect) return
  // 拖出参考线是「在标尺上按下」的手势，别让它同时触发画布上的取消选中 / 文本失焦。
  event.preventDefault()
  rulerDrag.value = { axis, position: mmAtPointer(event, axis, rect) }
  window.addEventListener('pointermove', rulerPointerMove)
  window.addEventListener('pointerup', rulerPointerUp, { once: true })
  window.addEventListener('pointercancel', rulerPointerCancel, { once: true })
}
function mmAtPointer(event, axis, rect) {
  const span = design.value.artboard[axis === 'x' ? 'w' : 'h']
  const offset = axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top
  return guidePositionFromOffset(offset, pxPerMm.value, span)
}
function rulerPointerMove(event) {
  if (!rulerDrag.value) return
  const rect = stage.value?.getBoundingClientRect()
  if (!rect) return
  rulerDrag.value = { axis: rulerDrag.value.axis, position: mmAtPointer(event, rulerDrag.value.axis, rect) }
}
function rulerPointerUp() {
  const pending = rulerDrag.value
  rulerDrag.value = null
  detachRulerDrag()
  if (!pending) return
  if ((design.value.guides?.length || 0) >= 100) { fail(new Error('最多支持 100 条参考线')); return }
  commit((doc) => {
    doc.guides = [...(doc.guides || []), { id: uid('guide'), axis: pending.axis, position: pending.position }]
  })
}
function rulerPointerCancel() {
  rulerDrag.value = null
  detachRulerDrag()
}
function detachRulerDrag() {
  window.removeEventListener('pointermove', rulerPointerMove)
  window.removeEventListener('pointerup', rulerPointerUp)
  window.removeEventListener('pointercancel', rulerPointerCancel)
}
function openExport() { if (!busy.value) { exportError.value = ''; showExport.value = true } }
async function runExport() {
  if (busy.value || exportSizeError.value) return
  endGesture(); finishKeyboardMove()
  busy.value = true
  exportError.value = ''
  try {
    const result = await window.printpress.exportDesignPng({
      design: normalizeDesign(clone(design.value)),
      dpi: Number(exportDpi.value),
      // JPEG 没有 alpha 通道：勾选框在切到 JPEG 时已被清掉，这里再兜一次，
      // 免得渲染层与主进程对「到底铺不铺底」各说各话。
      transparent: exportFormatInfo.value.transparent && exportTransparent.value,
      format: exportFormat.value,
      quality: exportLossy.value ? Number(exportQuality.value) : undefined,
    })
    if (result.canceled) return
    showExport.value = false
    clearFeedback()
    // 不再走通用 message：导出成功要带「打开所在文件夹 / 用系统程序打开」两个动作，
    // 那条提示条承载不了按钮，所以单独渲染一个带按钮的完成条。
    lastExport.value = result
  } catch (err) { exportError.value = toUserMessage(err) }
  finally { busy.value = false }
}
/**
 * 打开刚导出的图片。
 *
 * 两个动作都不传参数——路径由主进程记着。这是安全边界，不是省事：
 * 渲染进程若能指定路径，`shell.openPath` 就等于「以当前用户身份打开任意本地文件」。
 */
async function runExportAction(action) {
  if (busy.value) return
  busy.value = true
  try { await action() }
  catch (err) { fail(err) }
  finally { busy.value = false }
}
const revealExport = () => runExportAction(() => window.printpress.revealDesignExport())
const openExportedFile = () => runExportAction(() => window.printpress.openDesignExport())

// ---- 工程包 .ppdesign（v0.5.0 M2）----
/**
 * 任何浮层打开时都不抢键盘 / 粘贴 / 拖放。
 *
 * 单独收成一个 computed 而不是到处补条件：每加一个浮层就要改五处判断，
 * 迟早漏一个——漏了的表现是「弹窗开着按 Ctrl+Z 却把画布改了」这种难复现的毛病。
 */
const modalOpen = computed(() => Boolean(pending.value || showExport.value || showPackageExport.value || packageSummary.value))
/**
 * 导出的是「**已保存的那一版**」，不是当前草稿：版本文件不可变，所以导出期间
 * 继续编辑不会影响包的内容。有未保存修改时让用户二选一（保存后导出 / 直接导出已保存版本），
 * 不偷偷替他决定，也不让「改了没保存却以为导出的是最新版」这种事发生。
 */
const showPackageExport = ref(false)
const packageIncludeFonts = ref(true)
const packageExportError = ref('')
const packageProgress = ref(null)
const packageTaskId = ref('')
function openPackageExport() {
  if (busy.value || showPackageExport.value) return
  if (!design.value.id || !design.value.revision) {
    fail(new Error('请先保存工程：工程包导出的是已保存的版本（新建未保存的工程没有版本可导出）'))
    return
  }
  packageExportError.value = ''
  showPackageExport.value = true
}
async function runPackageExport(saveFirst) {
  if (busy.value) return
  packageExportError.value = ''
  // 先保存必须放在 busy 之外：save() 自己会开关 busy，被占着会直接返回
  if (saveFirst) {
    await save()
    if (!design.value.id || !design.value.revision) return
  }
  const taskId = uid('package-export')
  packageTaskId.value = taskId
  packageProgress.value = { index: 0, total: 0, name: '' }
  const stopProgress = window.printpress.onDesignPackageProgress((progress) => {
    if (progress.taskId === taskId) packageProgress.value = progress
  })
  busy.value = true
  try {
    const result = await window.printpress.exportDesignPackage({
      id: design.value.id, revision: design.value.revision, includeFonts: packageIncludeFonts.value, taskId,
    })
    if (result.canceled) {
      packageExportError.value = '工程包导出已取消，未覆盖已有文件。'
      return
    }
    showPackageExport.value = false
    message.value = `工程包已导出：${result.entries} 个条目 · ${(result.bytes / 1024).toFixed(0)} KB`
  } catch (err) { packageExportError.value = toUserMessage(err) }
  finally {
    stopProgress?.()
    busy.value = false
    packageTaskId.value = ''
    packageProgress.value = null
  }
}
async function cancelPackageExport() {
  const taskId = packageTaskId.value
  if (!taskId) return
  packageExportError.value = '正在取消导出…'
  try { await window.printpress.cancelExportDesignPackage(taskId) }
  catch (err) { packageExportError.value = toUserMessage(err) }
}

/**
 * 导入分两步：先检查（后端解包校验、返回摘要与令牌），用户确认后才提交。
 * 提交只认令牌对应的暂存快照——检查之后源文件被换也不影响导入结果。
 * 缺失字体必须在提交前逐条决定：替代 / 用默认字体 / 提供字体文件，不然不让过。
 */
const packageSummary = ref(null)
const packageError = ref('')
const fontChoices = ref({})
async function importPackage() {
  if (busy.value || packageSummary.value) return
  busy.value = true
  packageError.value = ''
  try {
    const result = await window.printpress.inspectDesignPackage({})
    if (result.canceled) return
    packageSummary.value = result
    // 默认给「用默认字体栈」，用户可改成替代或提供文件——但不允许留空蒙混过关
    fontChoices.value = Object.fromEntries((result.unresolved || []).map((family) => [family, { action: 'default' }]))
  } catch (err) { fail(err) }
  finally { busy.value = false }
}
function closeImport(openIt = false) {
  const summary = packageSummary.value
  packageSummary.value = null
  fontChoices.value = {}
  packageError.value = ''
  if (summary && !openIt) {
    // 取消要把后端的暂存区放掉，否则它会一直躺在数据目录里直到过期
    window.printpress.cancelDesignPackage(summary.token).catch(() => {})
  }
}
async function pickFontFor(family) {
  const result = await window.printpress.pickPackageFont()
  if (result.canceled || !result.filePath) return
  fontChoices.value = { ...fontChoices.value, [family]: { action: 'file', filePath: result.filePath } }
}
async function commitImport(openCopy) {
  const summary = packageSummary.value
  if (busy.value || !summary) return
  busy.value = true
  packageError.value = ''
  try {
    // Vue 把对象包成 Proxy，Electron IPC structured clone 不接受 Proxy；传普通快照。
    const ref = await window.printpress.commitDesignPackage({ token: summary.token, fontDecisions: clone(fontChoices.value) })
    packageSummary.value = null
    fontChoices.value = {}
    await refreshProjects()
    if (openCopy) {
      // loadProject guards on busy and must also participate in this promise chain.
      busy.value = false
      await loadProject({ id: ref.id })
    }
    message.value = `已导入副本：${ref.name}（第 ${ref.revision} 版）${openCopy ? '' : '，可在工程库打开'}`
  } catch (err) { packageError.value = toUserMessage(err) }
  finally { busy.value = false }
}
function add(type, asset = null) {
  const w = design.value.artboard.w, h = design.value.artboard.h
  const layer = { id: uid(), type, name: { text: '固定文字', image: (asset?.name || '图片').slice(0, 120), rect: '矩形', ellipse: '椭圆', line: '直线' }[type], x: round(w * 0.15), y: round(h * 0.15), w: Math.min(80, w * 0.7), h: Math.min(35, h * 0.5), rotation: 0, opacity: 1, visible: true, locked: false }
  if (type === 'text') Object.assign(layer, { text: '双击后在右侧编辑文字', fontFamily: '', fontSize: 24, bold: false, color: '#2b2622', align: 'left', lineHeight: 1.3, letterSpacing: 0 })
  else if (type === 'image') {
    const scale = Math.min(w * 0.7 / asset.width, h * 0.7 / asset.height)
    Object.assign(layer, { assetId: asset.id, w: round(asset.width * scale), h: round(asset.height * scale), crop: { x: 0, y: 0, w: 1, h: 1 }, flipX: false, flipY: false })
  } else Object.assign(layer, { fill: type === 'line' ? 'transparent' : '#ead9bf', stroke: '#b03a2e', strokeWidth: 0.4, radius: 0, ...(type === 'line' ? { h: 0.5 } : {}) })
  commit((doc) => { if (asset) doc.assets[asset.id] = asset; doc.layers.push(layer) })
  selectedIds.value = [layer.id]
}
async function addImage() {
  if (busy.value) return
  busy.value = true
  try { const asset = await window.printpress.uploadDesignImageDialog(); if (!asset?.canceled) add('image', asset) }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

/**
 * 从素材库插入：先抓会话令牌，异步拉取原件描述；期间若切换了工程
 * （sessionToken 变化），作废本次插入，绝不写进新画板（计划 §3.3）。
 * 入画板与新增图层合并进同一条撤销记录由 add() 内的 commit 保证。
 */
async function insertLibraryAsset(assetId) {
  const token = sessionToken.value
  let asset
  try {
    const res = await window.printpress.getAsset(assetId)
    asset = res && res.asset
  } catch (err) { fail(err); return }
  if (token !== sessionToken.value) return
  if (!asset || !asset.width || !asset.height) { fail(new Error('素材原件不可用')); return }
  add('image', asset)
}

// ---- 粘贴 / 拖拽直接加图片图层 ----
/**
 * 剪贴板截图与拖进来的文件都只有内存字节、没有文件路径，所以统一读成 base64 走
 * design:importBytes（与模板页 uploadBackgroundBytes 同一条思路）。真实格式由主进程
 * 按内容嗅探（designs.cjs），前端给的文件名只当归档命名用——拖拽/粘贴场景下它完全不可信。
 * 上限与领域层 MAX_BYTES 对齐，避免前端比主进程更严、报错口径打架。
 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const IMAGE_LIKE = /\.(png|jpe?g)$/i
const dropActive = ref(false)
// dragenter / dragleave 会在子元素间冒泡，用进出计数避免高亮闪烁
let dropDepth = 0

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const out = String(reader.result || '')
      const comma = out.indexOf(',')
      resolve(comma >= 0 ? out.slice(comma + 1) : out) // 去掉 data:image/png;base64, 前缀
    }
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 粘贴与拖拽共用：校验 → 导入素材 → 立刻落成一个图片图层（与「＋ 图片」同一条落点）。 */
async function acceptImageFile(file) {
  if (!file || busy.value) return
  // 部分拖拽源不带 type，此时退回按文件名判断；最终仍由主进程按内容定夺
  const looksImage = file.type
    ? file.type === 'image/png' || file.type === 'image/jpeg'
    : !file.name || IMAGE_LIKE.test(file.name)
  if (!looksImage) { fail(new Error('只能粘贴 / 拖入 PNG 或 JPEG 图片')); return }
  if (file.size > MAX_IMAGE_BYTES) {
    fail(new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，请先压缩后再导入`))
    return
  }
  busy.value = true
  try {
    const base64 = await fileToBase64(file)
    const asset = await window.printpress.uploadDesignImageBytes({ base64, name: file.name || '粘贴的图片' })
    add('image', asset)
    // add() 内部的 commit 会 clearFeedback，所以这句提示必须写在它之后
    message.value = `已加入图片图层：${asset.name}`
  } catch (err) { fail(err) }
  finally { busy.value = false }
}

/**
 * Ctrl+V 直接粘贴截图。
 * 焦点在输入框 / 文本域 / 可编辑区时不能抢——那里的粘贴属于文字编辑。
 */
function onPaste(event) {
  if (!active || modalOpen.value) return
  if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return
  const items = event.clipboardData && event.clipboardData.items
  if (!items) return
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    event.preventDefault()
    acceptImageFile(file)
    return
  }
}

function onDragEnter() {
  if (modalOpen.value) return
  dropDepth += 1
  dropActive.value = true
}

function onDragOver(event) {
  if (modalOpen.value) return
  event.preventDefault() // 不阻止默认行为的话，浏览器会直接把这个文件打开
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave() {
  dropDepth = Math.max(0, dropDepth - 1)
  if (dropDepth === 0) dropActive.value = false
}

function onDrop(event) {
  event.preventDefault()
  dropDepth = 0
  dropActive.value = false
  if (modalOpen.value) return
  const dt = event.dataTransfer
  const file = dt && dt.files && dt.files.length ? dt.files[0] : null
  if (file) { acceptImageFile(file); return }
  // 从网页里拖图只有 URL、没有文件内容，暂不支持（也避免去下载外链资源）
  fail(new Error('请把图片文件直接拖进来（暂不支持拖入网页图片链接）'))
}
function setDoc(key, value) {
  commit((doc) => { doc[key] = value })
}
function setArtboard(key, value) {
  commit((doc) => { doc.artboard[key] = key === 'background' ? value : Number(value) })
}
function setPaint(scope, key, value) {
  commit((doc) => {
    const target = scope === 'artboard' ? doc.artboard : doc.layers.find((item) => item.id === single.value?.id)
    if (!target) return
    const paintKey = scope === 'artboard' ? 'backgroundPaint' : 'fillPaint'
    if (key === 'enabled') {
      if (value) target[paintKey] = { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#dbeafe', opacity: 1 }] }
      else delete target[paintKey]
    } else if (target[paintKey]) {
      if (key === 'angle') target[paintKey].angle = Number(value)
      else {
        const [field, indexText] = String(key).split(':')
        const stop = target[paintKey].stops[Number(indexText)]
        if (stop) stop[field] = field === 'color' ? value : Number(value)
      }
    }
  })
}
function changePaintStops(scope, action) {
  commit((doc) => {
    const target = scope === 'artboard' ? doc.artboard : doc.layers.find((item) => item.id === single.value?.id)
    const paint = target?.[scope === 'artboard' ? 'backgroundPaint' : 'fillPaint']
    if (!paint) return
    if (action === 'add' && paint.stops.length < 8) {
      const left = paint.stops.at(-2), right = paint.stops.at(-1)
      paint.stops.push({ offset: (left.offset + right.offset) / 2, color: '#b7c8e8', opacity: 1 })
      paint.stops.sort((a, b) => a.offset - b.offset)
    } else if (action === 'remove' && paint.stops.length > 2) paint.stops.splice(paint.stops.length - 2, 1)
  })
}
function setShadow(key, value) {
  const id = single.value?.id
  if (!id || singleBlocked.value) return
  commit((doc) => {
    const layer = doc.layers.find(item => item.id === id)
    // 图片图层同样支持投影（渲染走 CSS drop-shadow，见 design-layout.cjs）。
    if (!layer || !['rect', 'ellipse', 'image'].includes(layer.type)) return
    if (key === 'enabled') {
      if (value) layer.shadow = { dxMm: 1, dyMm: 1.5, blurMm: 1, color: '#000000', opacity: 0.2 }
      else delete layer.shadow
    } else if (layer.shadow) layer.shadow[key] = value
  })
}
/**
 * 图片图层的描边（证件照衬边）。
 *
 * 与形状的描边**语义不同**：形状天生带一圈描边（`stroke`/`strokeWidth` 有默认值），
 * 图片的描边是「用户主动加」的。所以关掉时要把字段**删掉**，而不是留一个 0 宽度——
 * `strokeWidth: 0` 也会把工程标成版本 7（旧应用明确拒绝），却没给用户任何视觉差别。
 */
function setStroke(key, value) {
  const id = single.value?.id
  if (!id || singleBlocked.value) return
  commit((doc) => {
    const layer = doc.layers.find(item => item.id === id)
    if (!layer || layer.type !== 'image') return
    if (key === 'enabled') {
      if (value) { layer.stroke = '#ffffff'; layer.strokeWidth = 1 }
      else { delete layer.stroke; delete layer.strokeWidth }
    } else if (layer.strokeWidth !== undefined) layer[key] = value
  })
}
function adoptTemplateSize() {
  commit((doc) => { doc.artboard.w = context.value.artboard.w; doc.artboard.h = context.value.artboard.h })
}
function setLayer(key, value, numeric = false) {
  if (!single.value || singleBlocked.value) return
  const id = single.value.id
  commit((doc) => {
    const layer = doc.layers.find((item) => item.id === id)
    // 工程名与组名都有非空校验，图层名保持一致：空名在图层列表里是一行无法辨认的空白。
    // 抛错走 commit 的回滚 + inputEpoch 重绘，输入框会退回模型里的旧名字。
    if (key === 'name' && !String(value).trim()) throw new Error('图层名称不能为空')
    const previous = layer[key]
    layer[key] = numeric ? Number(value) : value
    if (layer.type === 'image' && keepRatio.value && (key === 'w' || key === 'h') && previous > 0) {
      const other = key === 'w' ? 'h' : 'w'
      layer[other] = round(layer[other] * layer[key] / previous)
    }
  })
}
/*
 * ---- 颜色控件：拖动即时生效，一次取色只记一条撤销 ----
 *
 * 过去只绑了 @change，而原生 <input type="color"> 只保证发 input（拖动过程中连续发），
 * change 是「取色器关掉」才发、且不同环境行为并不一致——一旦 change 不来，
 * 表现就是「点了色块、选了颜色，画布上的字一点没变」，属于看不见的失败。
 * 所以 input 就即时把颜色写进模型（所见即所得），change 再收尾记一条撤销。
 * 中间过程不进撤销栈，否则拖一次取色器能塞进上百条历史。
 */
const colorDraft = ref(null)
function colorInput(key, value, scope = 'layer') {
  if (scope === 'artboard') {
    if (!colorDraft.value) colorDraft.value = { before: clone(design.value) }
    design.value.artboard[key] = value
    return
  }
  if (!single.value || singleBlocked.value) return
  if (!colorDraft.value) colorDraft.value = { before: clone(design.value) }
  const layer = design.value.layers.find((item) => item.id === single.value.id)
  if (layer) layer[key] = value
}
function colorChange(key, value, scope = 'layer') {
  colorInput(key, value, scope) // change 携带的是最终值；没收到 input 时靠这里补上
  const draft = colorDraft.value
  colorDraft.value = null
  if (!draft) return
  try {
    design.value = normalizeDesign(design.value)
    record(draft.before)
    clearFeedback()
  } catch (err) {
    design.value = draft.before
    inputEpoch.value++
    fail(err)
  }
}

// ---- 图层混合模式 / 图片颜色调整 / 组透明度（v0.7 第一批）----
// 渲染与校验的权威实现在 electron/design-layout.cjs（BLEND_MODES、imageAdjust、
// renderDesign 的 filterOf / mix-blend-mode / 组透明度乘算）。这里只做界面与撤销语义。

/** 混合模式中文名——与 BLEND_MODES 一一对应，顺序即下拉顺序 */
const BLEND_LABELS = {
  normal: '正常（不混合）', multiply: '正片叠底', screen: '滤色', overlay: '叠加',
  darken: '变暗', lighten: '变亮', 'color-dodge': '颜色减淡', 'color-burn': '颜色加深',
  'hard-light': '强光', 'soft-light': '柔光', difference: '差值', exclusion: '排除',
  hue: '色相', saturation: '饱和度', color: '颜色', luminosity: '明度',
}
const blendOptions = BLEND_MODES.map((mode) => ({ value: mode, label: BLEND_LABELS[mode] || mode }))

/**
 * 图片颜色调整字段表：`[key, 标签, 滑杆上限%, 恒等值%]`。
 *
 * schema 里两种口径（权威在 `electron/design-layout.cjs` 的 `imageAdjust`）：
 * brightness/contrast/saturate 是「**1 = 原样**」的乘数（0~3），
 * grayscale/invert 是「**0 = 原样**、1 = 拉满」的比例（0~1）。
 * 界面一律用「0 ~ 上限」的百分比表示，写回时**统一 ÷100**（`ADJUST_PERCENT`），
 * 所以两类的差别只在**上限**和**恒等值**这两列上——都放在这张表里，别在换算函数里另写一份。
 *
 * ⚠️ 去色/反相的恒等值是 **0 而不是 100**。这里真踩过一次：曾经按字段配「除数」，
 * 去色/反相写成 ÷1（把 schema 里的「取值 0~1」错当成「除以 1」），于是滑杆拖到 50 时
 * 写进 schema 的是 **50**。而 `normalizeDesign` 对越界是**抛错**而不是夹取 ⇒ 画布渲染
 * （`renderDesign`）与松手提交（`adjustChange`）都会抛，滑杆被整体回滚并报
 * 「去色超出有效范围（0–1）」；滑杆 step=1 意味着 0 以外全是整数 ⇒ **除 0 之外没有任何档位可用**。
 * 改这张表时务必连着 `adjustPercent` / `adjustInput` 一起看。
 */
const ADJUST_FIELDS = Object.freeze([
  ['brightness', '亮度 %', 300, 100],
  ['contrast', '对比度 %', 300, 100],
  ['saturate', '饱和度 %', 300, 100],
  ['grayscale', '去色 %', 100, 0],
  ['invert', '反相 %', 100, 0],
])
/** 界面百分比 → schema 值：所有字段一律 ÷100（见上面字段表的说明） */
const ADJUST_PERCENT = 100
/**
 * 「预览→确认」两步：拖动滑杆只改模型（画布即时变），**不进撤销栈**；
 * 松手（change）时把拖动前的快照记成**一条**撤销。整套语义与 colorDraft 相同——
 * 滑杆类控件一次手势只允许留一条历史，否则连续拖动会塞满撤销栈。
 */
const adjustDraft = ref(null)
/** 滑杆显示值：没调过时用该字段的恒等值（亮度类是 100%，去色/反相是 0%） */
function adjustPercent(key, identity) {
  const value = single.value?.adjust?.[key]
  if (value === undefined) return identity
  return Math.round(value * ADJUST_PERCENT)
}
/** 上限由字段表传进来——换算函数里不许再写一份，否则改了表会被静默夹到旧上限 */
function adjustInput(key, percent, max) {
  if (!single.value || singleBlocked.value || single.value.type !== 'image') return
  const value = Math.min(Math.max(Number(percent) || 0, 0), Number(max)) / ADJUST_PERCENT
  if (!adjustDraft.value) adjustDraft.value = { before: clone(design.value) }
  const layer = design.value.layers.find((item) => item.id === single.value.id)
  if (layer) layer.adjust = { ...(layer.adjust || {}), [key]: value }
}
function adjustChange() {
  const draft = adjustDraft.value
  adjustDraft.value = null
  if (!draft) return
  try {
    design.value = normalizeDesign(design.value)
    record(draft.before)
    clearFeedback()
  } catch (err) {
    design.value = draft.before
    inputEpoch.value++
    fail(err)
  }
}
/** 恢复原始颜色：整块 adjust 删掉，渲染侧少一个 filter，与从没调过逐字节一致 */
function resetAdjust() {
  if (!single.value || singleBlocked.value || single.value.type !== 'image') return
  adjustDraft.value = null
  const id = single.value.id
  commit((doc) => {
    const layer = doc.layers.find((item) => item.id === id)
    if (layer) delete layer.adjust
  })
}

/** 组透明度：与图片调整同款的「预览→确认」——整组滑块一次拖动只记一条撤销 */
const groupOpacityDraft = ref(null)
function groupOpacityInput(percent) {
  if (!selectedGroup.value) return
  const value = Math.min(Math.max(Number(percent) || 0, 0), 100) / 100
  if (!groupOpacityDraft.value) groupOpacityDraft.value = { before: clone(design.value) }
  const group = design.value.groups.find((item) => item.id === selectedGroup.value.id)
  if (group) group.opacity = value
}
function groupOpacityChange() {
  const draft = groupOpacityDraft.value
  groupOpacityDraft.value = null
  if (!draft) return
  try {
    design.value = normalizeDesign(design.value)
    record(draft.before)
    clearFeedback()
  } catch (err) {
    design.value = draft.before
    inputEpoch.value++
    fail(err)
  }
}
/**
 * 整块颜色控件都能唤起取色器。
 *
 * 只靠 <label> 转发不够稳：Chromium 对「label 转发的 click 能不能唤起 color chooser」
 * 并没有保证（实测点击事件确实转发到了 input，但取色器弹不弹不受控），
 * 而色块本体只有 34px 宽，用户点的往往是整块盒子 → 看起来「点了没反应」。
 * 自己调 showPicker()：在真实点击里算用户手势，允许调用；失败再退回 click()。
 */
function openColorPicker(event) {
  const input = event.currentTarget?.querySelector?.('input[type="color"]')
  if (!input || input.disabled) return
  if (event.target === input) return // 点色块本体：交给原生，别重复开
  event.preventDefault() // 掐掉 label 的默认转发，避免开两次
  if (typeof input.showPicker === 'function') {
    try { input.showPicker(); return } catch (err) { /* 不支持/不允许则退回 click() */ }
  }
  input.click()
}
function setCrop(key, percent) {
  if (!single.value || singleBlocked.value) return
  const id = single.value.id
  commit((doc) => {
    const layer = doc.layers.find((item) => item.id === id)
    const crop = { ...layer.crop, [key]: Number(percent) / 100 }
    if (!Number.isFinite(crop[key]) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1.000001 || crop.y + crop.h > 1.000001) throw new Error('裁切范围必须在原图内：起点 + 宽高不得超过 100%。')
    if (keepRatio.value) {
      const asset = doc.assets[layer.assetId]
      layer.h = round(layer.w * asset.height * crop.h / (asset.width * crop.w))
    }
    layer.crop = crop
  })
}
function resetCrop() {
  if (!single.value || singleBlocked.value) return
  const id = single.value.id
  commit((doc) => {
    const layer = doc.layers.find((item) => item.id === id)
    layer.crop = { x: 0, y: 0, w: 1, h: 1 }
    if (keepRatio.value) {
      const asset = doc.assets[layer.assetId]
      layer.h = round(layer.w * asset.height / asset.width)
    }
  })
}
/**
 * 套用「成品尺寸 / 比例」预设。
 *
 * 两件事**必须同时做**，只做一件都是错的：
 * 1. 把图层尺寸改成目标毫米（证件照的意义就在于成品恰好是 25×35 mm，不能靠手输）；
 * 2. 把静态图片的 `crop` 调成同一长宽比——只改尺寸不改裁切，换来的是**被拉长的脸**。
 *
 * 变量图没有 `crop`（取景由 `cover` + 焦点决定），帧尺寸本身就是成品尺寸，所以只做第 1 件。
 * 比例类预设「保持当前宽度、只改高度」，尺寸类预设两轴都定死。
 */
function applySizePreset(value) {
  if (!single.value || singleBlocked.value) return
  if (single.value.type !== 'image') return
  // 只按**第一个**冒号切分：比例预设的 id 本身含冒号（`1:1` / `9:16`），
  // 用 `split(':')` 解构会把 `ratio:1:1` 读成 id `1` ⇒ 找不到预设 ⇒ **静默无操作**。
  const raw = String(value)
  const sep = raw.indexOf(':')
  if (sep < 0) return
  const kind = raw.slice(0, sep)
  const id = raw.slice(sep + 1)
  const preset = kind === 'size'
    ? itemSizes.value.find((item) => item.id === id)
    : CROP_RATIOS.find((item) => item.id === id)
  if (!preset) return
  const layerId = single.value.id
  commit((doc) => {
    const layer = doc.layers.find((item) => item.id === layerId)
    const width = kind === 'size' ? preset.w : layer.w
    const height = kind === 'size' ? preset.h : round(width * preset.h / preset.w)
    layer.w = round(width)
    layer.h = round(height)
    if (!layer.variable && layer.assetId) {
      const asset = doc.assets[layer.assetId]
      // 传的是**取整后的实际毫米**，不是预设的名义值：这样裁切比例与真实帧比例严格一致。
      if (asset) layer.crop = fitCropToRatio(layer.crop, layer.w, layer.h, asset.width, asset.height)
    }
  })
}
// 选完立刻回位到「自定义」：不回位的话同一个预设点第二次不会触发 change（值没变）。
watch(sizePreset, (value) => {
  if (!value) return
  sizePreset.value = ''
  applySizePreset(value)
})
function toggleLayer(layer, key) { commit((doc) => { const target = doc.layers.find((item) => item.id === layer.id); target[key] = !target[key] }) }
async function removeSelected() {
  if (!editable.value.length) return
  // 删图层会把「没加入素材库的临时件原图」（粘贴 / 拖入 / 「＋ 图片」对话框加入）一并清理，
  // 且不可恢复。这里**刻意不弹确认框**——2026-10-11 用户明确要求删图时别打断操作。
  // 清理结果由顶部提示条告知（见 discardOrphanedEphemeral 里设置的 message），
  // 已加入素材库（managed）的图不受影响。
  await applyRemoveSelected()
}
async function applyRemoveSelected() {
  let result
  let orphanedIds = []
  if (commit(doc => {
    result = removeSelection(doc, selectedIds.value, { expandGroups: false })
    Object.assign(doc, result.design)
    // 删图层后不再被任何图层引用的图片原件，从文档里一并撤引用（I-33）：
    // 不撤的话磁盘扫描永远判「仍被引用」，临时件永远删不掉。
    // 受管理（managed）来源的原件撤引用后仍留在素材库，不受影响。
    const used = new Set(doc.layers.filter((layer) => layer.type === 'image' && layer.assetId).map((layer) => layer.assetId))
    orphanedIds = Object.keys(doc.assets).filter((id) => !used.has(id))
    for (const id of orphanedIds) delete doc.assets[id]
  })) {
    selectedIds.value = result.selectedIds
    if (orphanedIds.length) await discardOrphanedEphemeral(orphanedIds)
  }
}

/**
 * 图层删除后的后台同步清理（I-33，与模板页上传同一逻辑）：
 * ephemeral 来源（粘贴 / 拖入 / 「＋ 图片」对话框直接加入）且再无任何引用的原件
 * 当场删文件；managed 来源（已点「加入素材库」）保留。
 *
 * **文件生死不进撤销栈**：被删掉的原件，任何「引用了它」的快照都不能再当撤销目标
 * （撤销回去只会得到一个指向已删文件的碎图层）。但**整栈清空是钝刀**——它把不相关的
 * 编辑历史一起丢掉。所以这里做外科手术：**只丢弃快照里引用了这些素材的那些步**，其余照留。
 * 判据与下面 `serialized.includes(id)` 同一手法（序列化后查 id 子串），未知字段也不怕。
 * 代价是「删图层」这一步本身不可撤销（它的 before 快照必然引用被删素材），界面会明说。
 */
async function discardOrphanedEphemeral(ids) {
  // 双保险：撤完引用后再核对一遍序列化文档里确实再无任何引用形状（未知字段也不怕）
  const serialized = JSON.stringify(design.value)
  const safeIds = ids.filter((id) => !serialized.includes(id))
  const removedIds = []
  let failed = false
  for (const id of safeIds) {
    try {
      const res = await window.printpress.discardEphemeralAsset(id, design.value.id || undefined)
      if (res && res.removed) removedIds.push(id)
    } catch { failed = true }
  }
  if (!removedIds.length) {
    message.value = failed
      ? '图层已删除，但原图清理失败；请稍后检查未引用原件。'
      : '图层已删除；原图仍被其他工程引用或已加入素材库，因此保留。'
    return
  }
  const stale = (snapshot) => {
    const s = JSON.stringify(snapshot)
    return removedIds.some((id) => s.includes(id))
  }
  history.value = history.value.filter((snapshot) => !stale(snapshot))
  future.value = future.value.filter((snapshot) => !stale(snapshot))
  message.value = failed
    ? '已清理未加入素材库的原图，但部分原图清理失败；请稍后检查未引用原件。'
    : '已删除所选图层，未加入素材库的原图已同步清理（原图不可恢复，此步不可撤销）'
}
function duplicate() {
  if (!selected.value.length) return
  let result
  if (commit(doc => {
    result = duplicateSelection(doc, selectedIds.value, { makeId: uid, dx: 3, dy: 3, expandGroups: false })
    Object.assign(doc, result.design)
  })) selectedIds.value = result.selectedIds
}
function reorder(direction) {
  if (!editable.value.length) return
  if (hasPartialGroup.value) { fail('请点击组名选择完整分组，再调整层级。'); return }
  commit(doc => Object.assign(doc, reorderSelection(doc, selectedIds.value, direction)))
}
function bounds(layer) {
  const angle = layer.rotation * Math.PI / 180
  const w = Math.abs(Math.cos(angle)) * layer.w + Math.abs(Math.sin(angle)) * layer.h
  const h = Math.abs(Math.sin(angle)) * layer.w + Math.abs(Math.cos(angle)) * layer.h
  return { x: layer.x + (layer.w - w) / 2, y: layer.y + (layer.h - h) / 2, w, h }
}
function union(layers) {
  const boxes = layers.map(bounds)
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}
function align(mode) {
  if (!editable.value.length) return
  // A group is one alignment unit so aligning it never collapses the members onto each other.
  const units = [], seen = new Set()
  for (const layer of editable.value) {
    const group = groupForLayer(design.value, layer.id)
    const id = group?.id || layer.id
    if (seen.has(id)) continue
    seen.add(id)
    units.push(group ? editable.value.filter(item => group.layerIds.includes(item.id)) : [layer])
  }
  const target = units.length > 1 ? union(editable.value) : { x: 0, y: 0, ...design.value.artboard }
  commit((doc) => {
    for (const unit of units) {
      const box = union(unit)
      let dx = 0, dy = 0
      if (mode === 'left') dx = target.x - box.x
      if (mode === 'center') dx = target.x + target.w / 2 - box.x - box.w / 2
      if (mode === 'right') dx = target.x + target.w - box.x - box.w
      if (mode === 'top') dy = target.y - box.y
      if (mode === 'middle') dy = target.y + target.h / 2 - box.y - box.h / 2
      if (mode === 'bottom') dy = target.y + target.h - box.y - box.h
      const ids = new Set(unit.map(layer => layer.id))
      for (const layer of doc.layers.filter(layer => ids.has(layer.id))) {
        layer.x = round(layer.x + dx); layer.y = round(layer.y + dy)
      }
    }
  })
}
function hitStyle(layer) {
  const height = layer.h * pxPerMm.value
  const hitHeight = layer.type === 'line' ? Math.max(height, 12) : Math.max(height, 3)
  return {
    left: `${layer.x * pxPerMm.value}px`,
    top: `${layer.y * pxPerMm.value - (hitHeight - height) / 2}px`,
    width: `${layer.w * pxPerMm.value}px`,
    height: `${hitHeight}px`,
    transform: `rotate(${layer.rotation}deg)`,
  }
}
// ---- 画布内就地编辑文字（像改 PPT 的文本框）----
/**
 * 双击文字图层后，在画布上原位出现一个编辑框，所见即所得地改字。
 *
 * 与出片保持一致的关键：**复用 DesignSurface 的同一套坐标变换**——内容按毫米排版、
 * 再整体 scale 到画布宽度，字号同样用 pt。于是编辑框里的字与打印出来的字同源同尺寸，
 * 不需要手工换算 px，也不会因换算舍入而错位（换算一次 96/72 就可能差一像素）。
 */
const editingTextId = ref('')
const editingValue = ref('')
// 模板 ref 在 <script setup> 里必须绑定同名变量（脚本中不能用 $refs 访问）
const inlineTextEditor = ref(null)
const editingText = computed(() => (editingTextId.value
  ? design.value.layers.find((layer) => layer.id === editingTextId.value) || null
  : null))
// 编辑中的图层先隐去画布上的文字，否则会和编辑框里的字叠成双影
const surfaceDesign = computed(() => {
  const id = editingTextId.value
  if (!id) return design.value
  return { ...design.value, layers: design.value.layers.map((layer) => (layer.id === id ? { ...layer, text: '' } : layer)) }
})
const textEditScale = computed(() => canvasWidth.value / (design.value.artboard.w * 96 / 25.4))
const textEditLayerStyle = computed(() => ({
  position: 'absolute',
  left: '0',
  top: '0',
  width: `${design.value.artboard.w}mm`,
  height: `${design.value.artboard.h}mm`,
  transform: `scale(${textEditScale.value})`,
  transformOrigin: '0 0',
  pointerEvents: 'none',
  zIndex: 6,
}))
const inlineTextStyle = computed(() => {
  const layer = editingText.value
  if (!layer) return {}
  const fam = normalizeFamily(layer.fontFamily)
  // 逐项对齐 renderDesign 的文字样式（design-layout.cjs），少一项就会「编辑时一个样、出片另一个样」
  return {
    left: `${layer.x}mm`,
    top: `${layer.y}mm`,
    width: `${layer.w}mm`,
    height: `${layer.h}mm`,
    transform: `rotate(${layer.rotation}deg)`,
    opacity: layer.opacity,
    fontFamily: fam ? `"${fam}",sans-serif` : DEFAULT_FONT_STACK,
    fontSize: `${layer.fontSize}pt`,
    fontWeight: layer.bold ? 700 : 400,
    lineHeight: layer.lineHeight,
    letterSpacing: `${layer.letterSpacing}pt`,
    color: layer.color,
    textAlign: layer.align,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }
})

function beginTextEdit(layer) {
  if (!layer || layer.type !== 'text' || layer.locked) return
  // 正在编辑别的图层就先提交，否则刚敲的字会被静默丢掉（pointerDown 里的 preventDefault
  // 挡掉了浏览器的默认焦点转移，blur 不会来救场）。
  if (editingTextId.value && editingTextId.value !== layer.id) finishTextEdit()
  const fresh = design.value.layers.find((item) => item.id === layer.id) || layer
  if (!selectedIds.value.includes(fresh.id)) selectLayer(fresh)
  editingValue.value = fresh.text
  editingTextId.value = fresh.id
}

/**
 * 提交画布上的就地编辑。重复调用安全：第一次收尾后 editingTextId 即为空。
 *
 * 触发点有四处，少一个都会「看不见地丢字」：
 *  ① textarea 的 blur（Tab 走开、窗口失焦）；
 *  ② Esc —— 照 PPT 的习惯：Esc 收工并保留改动（想撤销按 Ctrl+Z）；
 *  ③ window 捕获阶段的 pointerdown —— 见 onWindowPointerDown；
 *  ④ 保存 / 切页 / 关窗前主动收尾（onKeyDown 的 Ctrl+S 分支、deactivate、onBeforeUnload）。
 *
 * 特别注意 ③ 为什么必须自己来：pointerDown() 对 pointerdown 调了 preventDefault()，
 * 浏览器就不会把焦点移走，点另一个图层时 blur 根本不会触发，只能主动收尾。
 * 另外，**文档无焦点的窗口里 Chromium 不派发 focus/blur 事件**（离屏窗口、e2e 环境），
 * 所以 ③ 也是唯一在那种环境下仍然生效的收尾路径。
 */
function finishTextEdit() {
  const id = editingTextId.value
  if (!id) return
  editingTextId.value = '' // 先退出编辑态，避免 blur 重入
  const layer = design.value.layers.find((item) => item.id === id)
  if (!layer || editingValue.value === layer.text) return // 没改就不进撤销栈
  commit((doc) => {
    const target = doc.layers.find((item) => item.id === id)
    if (target) target.text = editingValue.value
  })
}

// 点编辑框以外的地方就收工：画布、右侧面板、工具栏都算数。
function onWindowPointerDown(event) {
  if (!editingTextId.value) return
  if (event.target === inlineTextEditor.value) return // 点编辑框内部是在挪光标，不收工
  finishTextEdit()
}

watch(editingTextId, async (id) => {
  if (!id) return
  await nextTick()
  const el = inlineTextEditor.value
  if (!el) return
  el.focus()
  el.select() // 整段选中：想重写就直接打字，想微调点一下取消选择
})

function clampNumber(value, min, max) { return Math.min(max, Math.max(min, value)) }
let toolsResizeStart = null
/** 拖动左栏右缘调节宽度；pointer capture 保证拖出元素范围也不丢事件 */
function startToolsResize(event) {
  if (event.button !== 0 || pending.value) return
  event.preventDefault()
  toolsResizeStart = { x: event.clientX, w: toolsWidth.value }
  resizingTools.value = true
  event.target.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', onToolsResizeMove)
  window.addEventListener('pointerup', endToolsResize, { once: true })
  window.addEventListener('pointercancel', endToolsResize, { once: true })
}
function onToolsResizeMove(event) {
  if (!toolsResizeStart) return
  toolsWidth.value = clampNumber(toolsResizeStart.w + (event.clientX - toolsResizeStart.x), 150, 420)
}
function endToolsResize() {
  if (!toolsResizeStart) return
  toolsResizeStart = null
  resizingTools.value = false
  window.removeEventListener('pointermove', onToolsResizeMove)
  try { localStorage.setItem(TOOLS_W_KEY, String(toolsWidth.value)) } catch { /* 存不了就算了，下次回默认宽 */ }
}
function pointerDown(event, layer, corner = null) {
  if (event.button !== 0 || pending.value) return
  event.preventDefault(); event.stopPropagation()
  /*
   * 双击文字图层 → 直接改字。
   *
   * 两个都不能用的写法：
   * ① 模板上的 @dblclick —— 本函数对 pointerdown 调了 preventDefault()，按 Pointer Events
   *    规范会一并抑制随后的 mousedown / click / dblclick，那个监听器永远收不到事件；
   * ② event.detail === 2 —— detail 是 MouseEvent 的概念，Chromium 的 pointerdown 上恒为 0
   *    （实测两次按下拿到 [0, 0]），永远判不出来。
   *
   * 所以只能自己记「上一次按下同一文字图层的时刻」。400ms 取在 Windows 默认双击间隔
   * （500ms）之内，并且只在同一图层上才算——点了别的图层就重新计时，不会跨图层误判。
   */
  if (!corner) {
    const now = Date.now()
    const isDouble = layer.type === 'text' && !layer.locked
      && lastTextDown.id === layer.id && now - lastTextDown.at < 400
    lastTextDown = { id: layer.type === 'text' && !layer.locked ? layer.id : '', at: now }
    if (isDouble) {
      lastTextDown = { id: '', at: 0 } // 消费掉，避免第三下继续触发
      beginTextEdit(layer)
      return
    }
  }
  if (!corner && (event.shiftKey || event.ctrlKey || event.metaKey)) { selectLayer(layer, event); return }
  if (!selectedIds.value.includes(layer.id)) selectLayer(layer)
  if (!corner) selectedIds.value = expandSelection(design.value, selectedIds.value)
  if (layer.locked || !editable.value.some(item => item.id === layer.id)) return
  finishKeyboardMove(); endGesture()
  // corner：被拖的角点手柄（se/sw/ne/nw；直线只拖右端点也记 'se'）。null = 移动。
  gesture = { before: clone(design.value), type: corner ? 'resize' : 'move', corner: layer.type === 'line' ? 'se' : corner, startX: event.clientX, startY: event.clientY, layerId: layer.id, ids: new Set(editable.value.map((item) => item.id)), ratio: keepRatio.value && layer.type === 'image' }
  window.addEventListener('pointermove', pointerMove)
  window.addEventListener('pointerup', endGesture, { once: true })
  window.addEventListener('pointercancel', cancelGesture, { once: true })
}
function snapDelta(originals, dx, dy) {
  const moving = union(originals)
  /*
   * 四类目标按各自开关汇总（纯逻辑在 src/lib/designer-aids.cjs）：
   * 画布边缘与中线 / 参考线 / 布局网格主格线 / 其他图层的边缘与中心。
   * 阈值是**像素**口径（SNAP_PX / pxPerMm）：不论缩放多少，「差 6px 以内就吸」的手感恒定。
   */
  const targets = snapTargets({
    artboard: design.value.artboard,
    enabled: snapTargetsOn,
    guides: visibleGuides.value,
    grid: { spacing: Number(gridSpacing.value) },
    others: design.value.layers
      .filter((layer) => layer.visible && !gesture.ids.has(layer.id))
      .map((layer) => bounds(layer)),
  })
  const result = computeSnap({ moving, dx, dy, targets, threshold: SNAP_PX / pxPerMm.value })
  guides.value = { x: result.x, y: result.y }
  return { dx: result.dx, dy: result.dy }
}
function pointerMove(event) {
  if (!gesture) return
  let dx = (event.clientX - gesture.startX) / pxPerMm.value
  let dy = (event.clientY - gesture.startY) / pxPerMm.value
  const originals = gesture.before.layers.filter((layer) => gesture.ids.has(layer.id))
  if (gesture.type === 'move') {
    if (snap.value && !event.altKey) ({ dx, dy } = snapDelta(originals, dx, dy))
    else guides.value = { x: null, y: null }
    for (const original of originals) {
      const layer = design.value.layers.find((item) => item.id === original.id)
      layer.x = round(original.x + dx); layer.y = round(original.y + dy)
    }
  } else {
    const original = gesture.before.layers.find((layer) => layer.id === gesture.layerId)
    const layer = design.value.layers.find((item) => item.id === original.id)
    const angle = original.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
    /*
     * 四角拉伸手柄：拖哪角、**对角固定**。
     * 拖动向量先投到图层本地轴：u = 沿宽度方向、v = 沿高度方向（旋转感知），
     * 再按角点符号放大/缩小（se/ne 加宽，sw/nw 反向；ne/nw 反向高度），
     * 最后把「固定角的本地坐标」从旧尺寸映射到新尺寸反推左上角——
     * 对任意旋转角都是精确锚定（不再是早年近似半 dw 的写法）。
     */
    const corner = gesture.corner || 'se'
    const su = corner === 'sw' || corner === 'nw' ? -1 : 1
    const sv = corner === 'ne' || corner === 'nw' ? -1 : 1
    const u = dx * cos + dy * sin
    const v = -dx * sin + dy * cos
    let w = Math.max(0.2, original.w + su * u)
    let h = original.type === 'line' ? original.h : Math.max(0.2, original.h + sv * v)
    if (original.type !== 'line' && (gesture.ratio || event.shiftKey)) {
      const factor = Math.max(w / original.w, h / original.h)
      w = original.w * factor; h = original.h * factor
    }
    const dw = w - original.w, dh = h - original.h
    // 固定角在旧/新本地坐标里的位置：se 固定左上 (0,0)；sw 固定右上；ne 固定左下；nw 固定右下
    const a0x = su === 1 ? 0 : original.w, a0y = sv === 1 ? 0 : original.h
    const a1x = su === 1 ? 0 : w, a1y = sv === 1 ? 0 : h
    const ddx = a0x - a1x, ddy = a0y - a1y
    layer.x = round(original.x + ddx * cos - ddy * sin)
    layer.y = round(original.y + ddx * sin + ddy * cos)
    layer.w = round(w); layer.h = round(h)
  }
}
function cleanGesture() {
  window.removeEventListener('pointermove', pointerMove)
  window.removeEventListener('pointerup', endGesture)
  window.removeEventListener('pointercancel', cancelGesture)
  guides.value = { x: null, y: null }
}
function endGesture() {
  if (gesture) {
    const before = gesture.before
    gesture = null
    try { design.value = normalizeDesign(design.value); record(before) }
    catch (err) { design.value = before; fail(err) }
  }
  cleanGesture()
}
function cancelGesture() {
  if (gesture) design.value = gesture.before
  gesture = null
  cleanGesture()
}
function finishKeyboardMove() {
  clearTimeout(keyboardTimer)
  if (keyBefore) {
    const before = keyBefore
    keyBefore = null
    try { design.value = normalizeDesign(design.value); record(before) }
    catch (err) { design.value = before; fail(err) }
  }
}
function onKeyDown(event) {
  if (!active || modalOpen.value || event.isComposing) return
  const input = event.target?.closest?.('input,textarea,select,[contenteditable="true"]')
  const modifier = event.ctrlKey || event.metaKey
  // 就地编辑要先落定再存盘，否则「改完字按 Ctrl+S」会把旧文字存下去
  if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); finishTextEdit(); event.target?.blur?.(); save(); return }
  if (input) return
  if (event.key === 'Escape') { if (focusCanvas.value) { focusCanvas.value = false; return }; cancelGesture(); selectedIds.value = []; return }
  if (!modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); focusCanvas.value = !focusCanvas.value; return }
  if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
  if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
  if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); selectedIds.value = expandSelection(design.value, design.value.layers.filter((layer) => layer.visible).map((layer) => layer.id)); return }
  if (modifier && event.key.toLowerCase() === 'g') { event.preventDefault(); event.shiftKey ? ungroup() : makeGroup(); return }
  if (modifier && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return }
  if (event.key.startsWith('Arrow') && editable.value.length) {
    event.preventDefault()
    if (!keyBefore) keyBefore = clone(design.value)
    const step = event.shiftKey ? 1 : 0.1
    for (const layer of editable.value) {
      if (event.key === 'ArrowLeft') layer.x = round(layer.x - step)
      if (event.key === 'ArrowRight') layer.x = round(layer.x + step)
      if (event.key === 'ArrowUp') layer.y = round(layer.y - step)
      if (event.key === 'ArrowDown') layer.y = round(layer.y + step)
    }
    clearTimeout(keyboardTimer)
    keyboardTimer = setTimeout(finishKeyboardMove, 250)
  }
}
function onKeyUp(event) { if (event.key.startsWith('Arrow')) finishKeyboardMove() }
function onBeforeUnload() { finishTextEdit(); document.activeElement?.blur?.(); endGesture(); finishKeyboardMove(); persistDraft() }
function activate() {
  if (active) return
  active = true
  refreshPortraitAvailability()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', endGesture)
  window.addEventListener('beforeunload', onBeforeUnload)
  // 捕获阶段：要在 pointerDown 的 preventDefault 之前收尾，也要先于被点控件的 click 处理器，
  // 这样「改完字直接点保存」保存到的就是新文字。
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  // 素材库抽屉：点外部（画布 / 工具面板 / 检查器）收起；抽屉内部与开关按钮不收
  document.addEventListener('pointerdown', onDocPointerDown, true)
  // 粘贴挂在 window 上（而不是画布上）：截图粘贴时焦点可能在任意地方，
  // 挂画布会漏掉大多数情况。用 active 门控，切走标签页后不再响应。
  window.addEventListener('paste', onPaste)
  if (initialized) Promise.allSettled([refreshProjects(), refreshFonts(), refreshPresets()]).then((results) => {
    for (const result of results) if (result.status === 'rejected') fail(result.reason)
  })
}
function deactivate() {
  active = false
  ++portraitListRequest
  ++portraitRequest
  portraitChecking.value = true
  portraitPicker.value = false
  finishTextEdit()
  endGesture(); finishKeyboardMove(); persistDraft()
  // 切走时可能正拖着一条参考线：不停掉监听，回来时指针一动就会凭空落一条线。
  rulerPointerCancel()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', endGesture)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('paste', onPaste)
  dropDepth = 0
  dropActive.value = false
}
/** 素材库抽屉点外部收起：开关按钮与抽屉内部除外（开关自己 toggle，别打架） */
function onDocPointerDown(event) {
  if (!showAssets.value) return
  const t = event.target
  if (t && (t.closest?.('.asset-library') || t.closest?.('[data-testid="design-toggle-assets"]'))) return
  showAssets.value = false
}
onMounted(async () => {
  await nextTick()
  if (canvasScroll.value) {
    canvasObserver = new ResizeObserver(updateNavigator)
    canvasObserver.observe(canvasScroll.value)
    if (stage.value) canvasObserver.observe(stage.value)
    updateNavigator()
  }
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
    if (draft?.design) {
      design.value = normalizeDesign(draft.design)
      savedFingerprint.value = typeof draft.savedFingerprint === 'string' ? draft.savedFingerprint : ''
      context.value = draft.context || null
      message.value = '已恢复上次未保存的底图草稿。'
    }
  } catch (err) { fail(`恢复草稿失败：${toUserMessage(err)}`) }
  try {
    // 内置预设必须**在这里**也刷一次，不能只靠 activate()：首次进入本页时
    // onActivated 早于 onMounted 的这轮 await 跑完（那时 initialized 还是 false），
    // activate() 里那句被 initialized 门控的 refreshPresets 会被整个跳过——
    // 结果是「常用模板」下拉一直空着且禁用，用户以为没有这个功能，
    // 得先切到别的页再切回来才出现。属于「看不见的失败」。
    const results = await Promise.allSettled([refreshProjects(), refreshFonts(), refreshPresets(), loadItemSizes()])
    if (results[0].status === 'rejected') fail(results[0].reason)
    if (results[1].status === 'rejected') fail(results[1].reason)
    if (results[2].status === 'rejected') fail(results[2].reason)
    // 成品尺寸拿不到不阻断编辑：比例类预设不依赖它，只是少了一组证件照规格。
    if (results[3].status === 'rejected') itemSizes.value = []
  } catch (err) { fail(err) }
  initialized = true
  refreshAdopted()
  if (designerNav.request) consumeRequest(designerNav.request)
})
onActivated(() => { activate(); nextTick(updateNavigator) })
onDeactivated(deactivate)
onBeforeUnmount(() => { deactivate(); canvasObserver?.disconnect(); detachRulerDrag(); clearTimeout(draftTimer); clearTimeout(messageTimer); for (const face of fontFaces) document.fonts.delete(face) })
</script>

<template>
  <section class="designer-view">
    <div v-if="portraitPicker" class="portrait-mask" @click.self="portraitPicker = false">
      <section class="portrait-picker" role="dialog" aria-modal="true" aria-label="添加变量图">
        <h3>添加变量图</h3><p>变量图跟随数据页唯一启用的“配图”列。出片时按每行的值匹配同名照片，缺图留白。</p>
        <p v-if="!portraitDatasets.length">暂无已开启配图的名单，请先到数据页点击一个列头的“配图”开关。</p>
        <label>参考名单<select v-model="portraitDataset" :disabled="!portraitDatasets.length"><option v-for="ds in portraitDatasets" :key="ds.id" :value="ds.id">{{ ds.name }}</option></select></label>
        <p v-if="portraitDatasets.length">已自动选择开启配图的名单；这里只列出已开启配图的名单。</p>
        <p>当前配图列：{{ portraitColumns.find(c => c.key === portraitColumn)?.alias || portraitColumn || '未选择，请先到数据页点击列头的“配图”' }}</p>
        <p>默认 35 × 45 mm；添加后可拖动位置、调整尺寸、圆角和裁切焦点。</p>
        <button class="primary" :disabled="busy || portraitInserting || !portraitColumn" @click="addPortrait">插入变量图</button> <button @click="portraitPicker = false">取消</button>
      </section>
    </div>
    <PageHeader title="底图制作" description="图片、固定文字与形状分别编辑，保存后用于打印模板。">
      <template #actions>
        <button data-testid="design-new" class="primary" :disabled="busy" @click="newDesign">新建底图</button>
        <label class="preset-picker" title="内置版面与常用工程：选「内置模板」是「已有就打开、没有才新建」——不会每点一次就多一个同名工程；「常用」里只列你自己保存过的工程，选中直接打开那份（也不会复制）">
          <span>常用模板</span>
          <select data-testid="design-preset" :disabled="busy || (!presets.length && !recentDesigns.length)" @change="pickPreset">
            <option value="">选择…</option>
            <optgroup label="内置模板">
              <option v-for="preset in presets" :key="preset.id" :value="`preset:${preset.id}`" :title="preset.summary">{{ preset.name }}（打开或新建）</option>
            </optgroup>
            <optgroup v-if="recentDesigns.length" label="常用">
              <option v-for="project in recentDesigns" :key="project.id" :value="`design:${project.id}`" :title="`打开「${project.name}」（不会新建副本）`">{{ project.name }} · v{{ project.revision }}</option>
            </optgroup>
          </select>
        </label>
        <button data-testid="design-copy" :disabled="busy" @click="save(true)">另存副本</button>
        <button data-testid="design-toggle-assets" :class="{ on: showAssets }" :disabled="busy" :title="showAssets ? '隐藏素材库侧栏' : '显示素材库侧栏（v0.5 本地素材库）'" @click="showAssets = !showAssets">素材库</button>
        <button data-testid="design-export-png" :disabled="busy" title="导出 PNG / JPEG / WebP 图片" @click="openExport">导出图片</button>
        <button data-testid="design-export-package" :disabled="busy" title="把已保存的这一版连图带字体打包成 .ppdesign，可在另一台电脑上继续编辑（导出的是已保存版本，不是当前未保存的修改）" @click="openPackageExport">导出工程包</button>
        <button data-testid="design-import-package" :disabled="busy" title="从 .ppdesign 导入一份可编辑副本；同名工程不会被覆盖" @click="importPackage">导入工程包</button>
        <button data-testid="design-save" class="primary" :disabled="busy" @click="save()">{{ busy ? '处理中…' : '保存工程' }}</button>
        <button v-if="context" data-testid="design-apply" class="primary" :disabled="busy || dimensionMismatch" @click="save(false, true)">保存并应用到模板</button>
      </template>
    </PageHeader>
    <div v-if="error" class="notice error" role="alert">{{ error }}<button @click="error = ''">关闭</button></div>
    <div v-else-if="message" class="notice success" role="status">{{ message }}</div>
    <!--
      导出完成条：刻意排在通用提示条**之后**——`.notice.success` 的选择器要优先命中
      通用提示（既有验收就是这么取文案的），抢在前面会把那些断言指错元素。
      它说的是「磁盘上那个文件」，所以不跟编辑状态走：改了工程也不消失，直到下次导出或手动关掉。
    -->
    <div v-if="lastExport" class="notice success export-done" role="status">
      <span class="export-done-text">{{ FORMATS[lastExport.format]?.label || '图片' }} 已导出：{{ lastExport.width }} × {{ lastExport.height }} px · {{ lastExport.dpi }} DPI<template v-if="lastExport.bytes"> · {{ formatBytes(lastExport.bytes) }}</template><code class="export-done-path" :title="lastExport.filePath">{{ lastExport.filePath }}</code></span>
      <button data-testid="design-reveal-export" :disabled="busy" title="在文件管理器里选中这个文件，双击就能用系统看图器打印" @click="revealExport">打开所在文件夹</button>
      <button data-testid="design-open-export" :disabled="busy" title="用系统默认程序（看图器）打开" @click="openExportedFile">用系统程序打开</button>
      <button data-testid="design-export-done-close" title="只关掉这条提示，不影响已导出的文件" @click="lastExport = null">关闭</button>
    </div>
    <div v-if="context" class="notice context-note">
      正在编辑模板“{{ context.name || '当前模板' }}”的底图 · 成品 {{ context.artboard.w }} × {{ context.artboard.h }} mm
      <button :disabled="busy" @click="returnToTemplate()">返回模板（不应用）</button>
      <button @click="context = null">转为独立制作</button>
    </div>
    <div v-if="dimensionMismatch" class="notice error">当前画布尺寸与模板不同，应用前请调整。<button @click="adoptTemplateSize">采用模板尺寸（图层不缩放）</button></div>
    <div class="designer-workspace" :class="{ 'tools-resizing': resizingTools, 'focus-canvas': focusCanvas }" :style="{ '--tools-w': `${toolsWidth}px` }">
      <aside class="designer-panel tools-panel">
        <h3>添加内容</h3>
        <div class="tool-grid">
          <button data-testid="design-add-image" :disabled="busy" title="也可以 Ctrl+V 粘贴截图，或把图片文件拖进画布" @click="addImage">＋ 图片</button>
          <button data-testid="design-add-portrait" :disabled="busy || !canAddPortrait" @click="openPortraitPicker">＋ 变量图</button>
          <button data-testid="design-add-text" @click="add('text')">＋ 文字</button>
          <button data-testid="design-add-rect" @click="add('rect')">＋ 矩形</button>
          <button @click="add('ellipse')">＋ 椭圆</button>
          <button @click="add('line')">＋ 直线</button>
        </div>
        <p class="muted">图片也可以直接 <b>Ctrl+V</b> 粘贴截图，或把图片文件拖进画布。</p>
        <h3>工程库 <span>{{ projects.length }}</span></h3>
        <p v-if="!projects.length" class="muted">保存后可在这里重新打开。</p>
        <div class="project-list">
          <div v-for="project in projects" :key="project.id" class="project-row" :class="{ current: project.id === design.id }">
            <button class="project-open" :disabled="busy" :title="project.name" @click="loadProject(project)">
              <b>{{ project.name }}</b><small>{{ project.artboard?.w }} × {{ project.artboard?.h }} mm · v{{ project.revision }}</small>
            </button>
            <button class="icon-button" :disabled="busy" :aria-label="`删除工程 ${project.name}`" @click="deleteProject(project)">×</button>
          </div>
        </div>
        <h3>图层 <span>{{ design.layers.length }} · 上方在前</span></h3>
        <div class="tool-grid group-actions">
          <button data-testid="design-group" :disabled="selected.length < 2 || editable.length < selected.length" title="Ctrl+G；合并已有组时会展开其全部成员" @click="makeGroup">组合所选</button>
          <button data-testid="design-ungroup" :disabled="!hasSelectedGroup" title="Ctrl+Shift+G" @click="ungroup">解除分组</button>
        </div>
        <p v-if="!design.layers.length" class="muted">添加图片、文字或形状开始制作。</p>
        <div class="layer-list">
          <template v-for="row in groupRows" :key="`${row.kind}-${row.id}`">
            <div v-if="row.kind === 'group'" :data-group-id="row.id" class="layer-row group-row" :class="{ selected: groupChosen(row.group) }" @click="selectGroup(row.group, $event)">
              <button class="icon-button" data-testid="design-group-visible" :aria-label="groupHas(row.group, 'visible') ? '隐藏分组' : '显示分组'" :title="groupHas(row.group, 'visible') ? '隐藏分组' : '显示分组'" @click.stop="toggleGroup(row.group, 'visible')">{{ groupHas(row.group, 'visible') ? '◉' : '○' }}</button>
              <span class="layer-name" :title="row.group.name">▣ {{ row.group.name }}</span>
              <button class="icon-button" data-testid="design-group-lock" :aria-label="groupHas(row.group, 'locked') ? '解锁分组' : '锁定分组'" :title="groupHas(row.group, 'locked') ? '解锁分组' : '锁定分组'" @click.stop="toggleGroup(row.group, 'locked')">{{ groupHas(row.group, 'locked') ? '锁' : '开' }}</button>
            </div>
            <div v-else :data-layer-id="row.id" class="layer-row" :class="{ selected: selectedIds.includes(row.id), hidden: !row.layer.visible, 'group-member': !!row.group }" @click="selectLayer(row.layer, $event, true)">
              <button class="icon-button" :title="row.layer.visible ? '隐藏图层' : '显示图层'" :aria-label="row.layer.visible ? '隐藏图层' : '显示图层'" @click.stop="toggleLayer(row.layer, 'visible')">{{ row.layer.visible ? '◉' : '○' }}</button>
              <span class="layer-name" :title="row.layer.name">{{ row.layer.name }}</span>
              <span v-if="row.layer.editorOnly" class="layer-flag" title="仅编辑可见：打印、PDF 与导出的图片里都不会出现">仅编辑</span>
              <span class="layer-row-actions" @click.stop>
                <template v-if="row.layer.type === 'image' && row.layer.assetId">
                  <button v-if="!adoptedIds.has(row.layer.assetId)" class="icon-button" title="加入素材库：收藏这张原图，之后删除图层不会清理它" @click.stop="adoptLayerAsset(row.layer)">＋</button>
                  <span v-else class="adopted-flag" title="已在素材库（受管理，删除图层不会清理）">★</span>
                </template>
              </span>
              <button class="icon-button" :title="row.layer.locked ? '解锁图层' : '锁定图层'" :aria-label="row.layer.locked ? '解锁图层' : '锁定图层'" @click.stop="toggleLayer(row.layer, 'locked')">{{ row.layer.locked ? '锁' : '开' }}</button>
            </div>
          </template>
        </div>
        <div class="tool-grid">
          <button data-testid="design-group-copy" :disabled="!selected.length" @click="duplicate">{{ selectedGroup ? '复制整组' : '复制所选' }}</button><button data-testid="design-group-delete" :disabled="!editable.length" @click="removeSelected">{{ selectedGroup ? '删除整组' : '删除所选' }}</button>
        </div>
        <div class="tool-grid">
          <button data-testid="design-copy-style" :disabled="!single" @click="copyStyle">复制样式</button>
          <button data-testid="design-paste-style" :disabled="!styleTargets" :title="copiedStyle ? `可应用到 ${styleTargets} 个同类图层` : '先选中一个图层并复制样式'" @click="pasteStyle">应用样式{{ styleTargets ? ` (${styleTargets})` : '' }}</button>
        </div>
        <p v-if="design.groups?.length" class="muted">点组名或画布选择整组；点列表中的成员可单独编辑属性。</p>
      </aside>
      <div class="workspace-resizer" title="拖动调节左栏宽度" aria-label="调节左侧面板宽度" @pointerdown="startToolsResize"></div>
      <AssetLibrarySidebar v-if="showAssets && !focusCanvas" :draft-asset-ids="Object.keys(design.assets || {})" @insert="insertLibraryAsset" />
      <div class="canvas-column" :class="{ 'inspector-open': !focusCanvas }">
        <div class="canvas-toolbar">
          <!-- 撤销/重做只有快捷键（Ctrl+Z / Ctrl+Shift+Z 或 Ctrl+Y），工具栏不放按钮：
               画布工具栏已经很长，而这两个操作的发现路径本来就是键盘而不是工具栏。 -->
          <button :disabled="!editable.length || hasPartialGroup" :title="hasPartialGroup ? '先点击组名选中完整分组再调整层级' : '选中图层上移一层'" @click="reorder('up')">上移 ↑</button>
          <button :disabled="!editable.length || hasPartialGroup" :title="hasPartialGroup ? '先点击组名选中完整分组再调整层级' : '选中图层下移一层'" @click="reorder('down')">下移 ↓</button>
          <button :disabled="!editable.length || hasPartialGroup" :title="hasPartialGroup ? '先点击组名选中完整分组再调整层级' : '选中图层置顶'" @click="reorder('top')">置顶 ⤒</button>
          <button :disabled="!editable.length || hasPartialGroup" :title="hasPartialGroup ? '先点击组名选中完整分组再调整层级' : '选中图层置底'" @click="reorder('bottom')">置底 ⤓</button>
          <label class="inline"><input v-model="snap" data-testid="design-snap" type="checkbox"> 吸附</label>
          <label class="inline"><input v-model="rulers" data-testid="design-rulers" type="checkbox"> 标尺</label>
          <label class="inline"><input v-model="gridVisible" data-testid="design-grid" type="checkbox"> 网格</label>
          <span class="toolbar-spacer"></span>
          <button data-testid="design-focus-canvas" :title="focusCanvas ? '退出专注画布（F 或 Esc）' : '专注画布（F）'" @click="focusCanvas = !focusCanvas">{{ focusCanvas ? '退出专注' : '专注画布' }}</button>
          <button title="缩小" @click="zoom = Math.max(0.25, round(zoom - 0.25))">−</button>
          <button title="恢复预览大小" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button>
          <button title="放大" @click="zoom = Math.min(3, round(zoom + 0.25))">＋</button>
        </div>
        <div ref="canvasScroll" class="canvas-scroll" :class="{ 'drop-active': dropActive }" @scroll.passive="updateNavigator" @pointerdown.self="selectedIds = []" @dragenter.prevent="onDragEnter" @dragover.prevent="onDragOver" @dragleave.prevent="onDragLeave" @drop.prevent="onDrop">
          <div ref="stage" data-testid="design-stage" class="design-stage" :style="{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }" @pointerdown.self="selectedIds = []">
            <DesignSurface :design="surfaceDesign" :width="canvasWidth" :height="canvasHeight" :show-editor-only="true" @error="fail" />
            <!-- 布局网格：只是画布上的辅助层，不进工程、不进 renderDesign（见 I-45） -->
            <div v-if="gridVisible" data-testid="design-grid-overlay" class="grid-overlay" :style="gridOverlayStyle" aria-hidden="true"></div>
            <div v-if="editingText" class="text-edit-layer" :style="textEditLayerStyle">
              <textarea
                ref="inlineTextEditor"
                data-testid="design-inline-text"
                class="inline-text-editor"
                :style="inlineTextStyle"
                :value="editingValue"
                spellcheck="false"
                @input="editingValue = $event.target.value"
                @pointerdown.stop
                @keydown.esc.prevent="finishTextEdit"
                @blur="finishTextEdit"
              ></textarea>
            </div>
            <div v-for="layer in design.layers.filter(item => item.visible)" :key="layer.id" :data-canvas-layer-id="layer.id" class="layer-hit" :class="{ chosen: selectedIds.includes(layer.id), locked: layer.locked, 'line-hit': layer.type === 'line' }" :style="hitStyle(layer)" @pointerdown="pointerDown($event, layer)">
              <template v-if="single?.id === layer.id && editable.some(item => item.id === layer.id)">
                <button v-if="layer.type === 'line'" class="resize-handle line-resize-handle" :aria-label="'调整直线长度'" :title="'拖动线段末端调整长度'" @pointerdown.stop="pointerDown($event, layer, 'se')"></button>
                <template v-else>
                  <button class="resize-handle corner-se" data-corner="se" :aria-label="'从右下角调整图层大小'" :title="'拖动调整大小；Shift 保持比例'" @pointerdown.stop="pointerDown($event, layer, 'se')"></button>
                  <button class="resize-handle corner-sw" data-corner="sw" :aria-label="'从左下角调整图层大小'" :title="'拖动调整大小；Shift 保持比例'" @pointerdown.stop="pointerDown($event, layer, 'sw')"></button>
                  <button class="resize-handle corner-ne" data-corner="ne" :aria-label="'从右上角调整图层大小'" :title="'拖动调整大小；Shift 保持比例'" @pointerdown.stop="pointerDown($event, layer, 'ne')"></button>
                  <button class="resize-handle corner-nw" data-corner="nw" :aria-label="'从左上角调整图层大小'" :title="'拖动调整大小；Shift 保持比例'" @pointerdown.stop="pointerDown($event, layer, 'nw')"></button>
                </template>
              </template>
            </div>
            <div v-for="guide in visibleGuides" :key="guide.id" :data-guide-line="guide.id" class="persistent-guide" :class="guide.axis === 'x' ? 'vertical' : 'horizontal'" :style="guide.axis === 'x' ? { left: `${guide.position * pxPerMm}px` } : { top: `${guide.position * pxPerMm}px` }"></div>
            <div v-if="guides.x !== null" class="snap-guide vertical" :style="{ left: `${guides.x * pxPerMm}px` }"></div>
            <div v-if="guides.y !== null" class="snap-guide horizontal" :style="{ top: `${guides.y * pxPerMm}px` }"></div>
            <!--
              标尺贴在画布**外缘**（bottom/right: 100%），刻度与画布共用同一个 pxPerMm，
              所以缩放、滚动都不会错位。从上方标尺往下拖出的是垂直线（量 X），
              从左侧标尺往右拖出的是水平线（量 Y）——与标尺自己的度量方向一致。
            -->
            <template v-if="rulers">
              <div data-testid="design-ruler-h" class="ruler ruler-h" :style="{ width: `${canvasWidth}px` }" @pointerdown="rulerPointerDown($event, 'x')">
                <span v-for="tick in rulerTicksX" :key="`x-${tick.mm}`" class="ruler-tick" :class="{ major: tick.major }" :style="{ left: `${tick.mm * pxPerMm}px` }"><span v-if="tick.major" class="ruler-label">{{ tick.mm }}</span></span>
              </div>
              <div data-testid="design-ruler-v" class="ruler ruler-v" :style="{ height: `${canvasHeight}px` }" @pointerdown="rulerPointerDown($event, 'y')">
                <span v-for="tick in rulerTicksY" :key="`y-${tick.mm}`" class="ruler-tick" :class="{ major: tick.major }" :style="{ top: `${tick.mm * pxPerMm}px` }"><span v-if="tick.major" class="ruler-label">{{ tick.mm }}</span></span>
              </div>
            </template>
            <div v-if="rulerDrag" data-testid="design-ruler-drag" class="snap-guide" :class="rulerDrag.axis === 'x' ? 'vertical' : 'horizontal'" :style="rulerDrag.axis === 'x' ? { left: `${rulerDrag.position * pxPerMm}px` } : { top: `${rulerDrag.position * pxPerMm}px` }"></div>
            <div v-if="dropActive" class="drop-hint" aria-hidden="true">松开鼠标，把图片加为图层</div>
          </div>
        </div>
        <div ref="horizontalScroll" class="canvas-horizontal-scroll" data-testid="design-horizontal-scroll" role="region" aria-label="画布横向滚动" tabindex="0" @scroll.passive="scrollFromHorizontalBar">
          <div class="canvas-horizontal-track" :style="{ width: `${horizontalTrackWidth}px` }"></div>
        </div>
        <div v-if="navigator.needed" class="canvas-navigator" data-testid="design-navigator" :style="{ width: `${navigator.width}px`, height: `${navigator.height}px` }" title="拖动定位画布" @pointerdown="navigatorPointerDown" @pointermove="navigatorPointerMove">
          <DesignSurface :design="surfaceDesign" :width="navigator.width" :height="navigator.height" :show-editor-only="true" @error="fail" />
          <div class="navigator-viewport" :style="{ left: `${navigator.left}px`, top: `${navigator.top}px`, width: `${navigator.boxWidth}px`, height: `${navigator.boxHeight}px` }"></div>
        </div>
        <div class="canvas-status"><span>{{ design.artboard.w }} × {{ design.artboard.h }} mm · {{ selected.length ? `已选 ${selected.length} 个图层` : '未选中图层' }}</span><span :class="{ unsaved: dirty }">{{ dirty ? '未保存' : design.id ? `已保存 · v${design.revision}` : '空白工程' }}</span></div>
        <p class="shortcut-note">Ctrl+V 粘贴截图 / 拖入图片即加图层 · 双击文字直接改字 · Shift / Ctrl 点击多选 · 方向键移动 0.1 mm，Shift 加速 · Alt 拖动暂停吸附 · Ctrl+S 保存</p>
      </div>
      <aside v-if="!focusCanvas" class="designer-panel inspector">
        <h3>工程与画布</h3>
        <label>工程名称<input data-testid="design-name" :value="design.name" maxlength="120" @change="setDoc('name', $event.target.value)"></label>
        <div class="property-grid">
          <label>宽度 mm<input type="number" min="1" step="0.1" :value="design.artboard.w" :disabled="!!context" @change="setArtboard('w', $event.target.value)"></label>
          <label>高度 mm<input type="number" min="1" step="0.1" :value="design.artboard.h" :disabled="!!context" @change="setArtboard('h', $event.target.value)"></label>
        </div>
        <label class="color-field" @click="openColorPicker"><span>画布背景</span><span class="color-control"><input type="color" :value="design.artboard.background === 'transparent' ? '#ffffff' : design.artboard.background" aria-label="选择画布背景颜色" @input="colorInput('background', $event.target.value, 'artboard')" @change="colorChange('background', $event.target.value, 'artboard')"><code class="color-value">{{ formatColor(design.artboard.background) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label>
        <label class="inline"><input data-testid="design-board-gradient" type="checkbox" :checked="!!design.artboard.backgroundPaint" @change="setPaint('artboard', 'enabled', $event.target.checked)"> 使用线性渐变</label>
        <div v-if="design.artboard.backgroundPaint" class="property-grid">
          <label>方向 °<input data-testid="design-board-gradient-angle" type="number" min="-360" max="360" :value="design.artboard.backgroundPaint.angle" @change="setPaint('artboard', 'angle', $event.target.value)"></label>
          <label v-for="(stop, index) in design.artboard.backgroundPaint.stops" :key="`board-stop-${index}`">色标 {{ index + 1 }}
            <span class="property-grid"><input type="color" :value="stop.color" @change="setPaint('artboard', `color:${index}`, $event.target.value)"><input type="number" min="0" max="1" step="0.01" aria-label="色标位置" :disabled="index===0 || index===design.artboard.backgroundPaint.stops.length-1" :value="stop.offset" @change="setPaint('artboard', `offset:${index}`, $event.target.value)"><input type="number" min="0" max="1" step="0.05" aria-label="色标透明度" :value="stop.opacity" @change="setPaint('artboard', `opacity:${index}`, $event.target.value)"></span>
          </label>
          <button :disabled="design.artboard.backgroundPaint.stops.length>=8" @click="changePaintStops('artboard','add')">添加色标</button><button :disabled="design.artboard.backgroundPaint.stops.length<=2" @click="changePaintStops('artboard','remove')">移除中间色标</button>
        </div>
        <details class="guide-panel" open>
          <summary>标尺 / 网格 / 参考线 <span>{{ design.guides?.length || 0 }}</span></summary>
          <label class="inline"><input v-model="rulers" data-testid="design-rulers-panel" type="checkbox"> 显示标尺（可从标尺拖出参考线）</label>
          <label class="inline"><input v-model="gridVisible" data-testid="design-grid-panel" type="checkbox"> 显示布局网格</label>
          <div v-if="gridVisible" class="property-grid">
            <label>间距 mm<input v-model.number="gridSpacing" data-testid="design-grid-spacing" type="number" min="0.5" max="200" step="0.5"></label>
            <label>细分数<input v-model.number="gridSubdivisions" data-testid="design-grid-subdivisions" type="number" min="1" max="20" step="1"></label>
          </div>
          <!--
            吸附目标按类别各自开关。**网格主格线**只吸主格线不吸次格线：
            默认间距 10mm、细分数 5 ⇒ 次格线 2mm 一根，而阈值约 1.7mm，
            吸次格线会让边缘与参考线永远抢不到吸附。次格线是「看的」，主格线才是「对的」。
          -->
          <h4>吸附目标</h4>
          <div class="snap-targets">
            <label class="inline"><input v-model="snapTargetsOn.artboard" data-testid="design-snap-artboard" type="checkbox"> 画布边缘与中线</label>
            <label class="inline"><input v-model="snapTargetsOn.guides" data-testid="design-snap-guides" type="checkbox"> 参考线</label>
            <label class="inline"><input v-model="snapTargetsOn.grid" data-testid="design-snap-grid" type="checkbox"> 网格主格线</label>
            <label class="inline"><input v-model="snapTargetsOn.layers" data-testid="design-snap-layers" type="checkbox"> 图层边缘与中心</label>
          </div>
          <label class="inline"><input v-model="guidesVisible" data-testid="design-guides-visible" type="checkbox"> 显示参考线（隐藏后也不再吸附）</label>
          <div class="property-grid">
            <label>方向<select v-model="newGuideAxis" data-testid="design-guide-axis"><option value="x">垂直线（X）</option><option value="y">水平线（Y）</option></select></label>
            <label>位置 mm<input v-model.number="newGuidePosition" data-testid="design-guide-position" type="number" min="-10000" max="10000" step="0.1"></label>
          </div>
          <button data-testid="design-guide-add" :disabled="(design.guides?.length || 0) >= 100" @click="addGuide">添加参考线</button>
          <div class="guide-list">
            <div v-for="guide in design.guides || []" :key="`${guide.id}-${inputEpoch}`" :data-guide-id="guide.id" class="guide-row">
              <span :title="guide.axis === 'x' ? '距左侧的毫米数' : '距顶部的毫米数'">{{ guide.axis.toUpperCase() }}</span>
              <input data-testid="design-guide-edit-position" type="number" min="-10000" max="10000" step="0.1" :aria-label="`${guide.axis.toUpperCase()}参考线位置，毫米`" :value="guide.position" @change="editGuide(guide.id, $event.target.value)">
              <small v-if="guideOutside(guide)" class="guide-outside">画布外</small>
              <button class="icon-button" data-testid="design-guide-delete" aria-label="删除参考线" @click="removeGuide(guide.id)">×</button>
            </div>
          </div>
          <p class="muted">随工程保存；参考线不会出现在打印或 PNG 中。</p>
        </details>
        <template v-if="selected.length">
        <h3>{{ selectedGroup ? '分组属性' : selected.length > 1 ? `多选 ${selected.length} 个图层` : single ? '图层属性' : '排版属性' }}</h3>
        <template v-if="selectedGroup">
          <label>分组名称<input data-testid="design-group-name" :value="selectedGroup.name" maxlength="120" @change="renameGroup($event.target.value)"></label>
          <label>组透明度 %<input data-testid="design-group-opacity" type="number" min="0" max="100" step="1" :value="Math.round((selectedGroup.opacity ?? 1) * 100)" @input="groupOpacityInput($event.target.value)" @change="groupOpacityChange()"></label>
          <p class="muted">组透明度会乘算到组内每一个图层（与该图层自身的不透明度叠加）。拖动即时预览，松手才记一步撤销；打印与 PDF 同效。</p>
          <div class="property-grid"><label>整组缩放 %<input v-model.number="groupScalePercent" data-testid="design-group-scale" type="number" min="10" max="400" step="1"></label><label>整组旋转 °<input v-model.number="groupRotateDegrees" data-testid="design-group-rotation" type="number" min="-360" max="360" step="1"></label></div>
          <button data-testid="design-group-transform" :disabled="!editable.length || groupHas(selectedGroup, 'locked') || (groupScalePercent === 100 && groupRotateDegrees === 0)" @click="changeGroupTransform">应用整组变换</button>
          <p class="muted">以整组中心为基准，按比例缩放并旋转；成员间距、文字字号和边框效果一同调整。一次应用可整体撤销。</p>
          <p v-if="groupHas(selectedGroup, 'locked')" class="locked-note">组内存在锁定图层，整组无法移动、排序或删除。</p>
        </template>
        <div class="align-grid">
          <button v-for="item in [['left','靠左'],['center','水平居中'],['right','靠右'],['top','靠上'],['middle','垂直居中'],['bottom','靠下']]" :key="item[0]" :disabled="!editable.length" @click="align(item[0])">{{ item[1] }}</button>
        </div>
        <p v-if="!single && !selectedGroup" class="muted">{{ selected.length > 1 ? '按选中且未锁定的图层或整组外框对齐。' : '选中图层后编辑属性。单个图层或单组按画布对齐。' }}</p>
        <template v-if="single">
          <p v-if="groupForLayer(design, single.id)" class="muted">正在单独编辑组内成员。属性、复制和删除只作用于所选成员；点击组名或画布可选择整组。</p>
          <p v-if="singleBlocked" class="locked-note">该图层或同组成员已锁定，请在图层列表解锁后编辑。</p>
          <fieldset :key="`${single.id}-${inputEpoch}`" :disabled="singleBlocked">
            <label>图层名称<input :value="single.name" maxlength="120" @change="setLayer('name', $event.target.value)"></label>
            <label class="inline"><input data-testid="design-layer-editor-only" type="checkbox" :checked="single.editorOnly" @change="setLayer('editorOnly', $event.target.checked)"> 仅编辑可见（不打印）</label>
            <p v-if="single.editorOnly" class="muted">对齐用的参考框勾上它：编辑时看得见、能选中能拖动，打印、导出 PDF 和 PNG 里都不会出现。</p>
            <div class="property-grid">
              <label v-for="[key, label] in [['x','X mm'],['y','Y mm'],['w','宽度 mm'],['h','高度 mm']]" :key="key">{{ label }}<input type="number" step="0.1" :value="single[key]" :data-testid="`design-layer-${key}`" @change="setLayer(key, $event.target.value, true)"></label>
              <label>旋转 °<input type="number" step="1" :value="single.rotation" @change="setLayer('rotation', $event.target.value, true)"></label>
              <label>不透明度 %<input type="number" min="0" max="100" step="1" :value="Math.round(single.opacity * 100)" @change="setLayer('opacity', Number($event.target.value) / 100, true)"></label>
            </div>
            <label>混合模式<select data-testid="design-layer-blend" :value="single.blend || 'normal'" @change="setLayer('blend', $event.target.value)"><option v-for="opt in blendOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select></label>
            <p v-if="(single.blend || 'normal') !== 'normal'" class="muted">混合模式决定这个图层如何与下方内容叠色，画布、打印与 PDF 同源；不确定就选「正常」。</p>
            <div v-if="single.type === 'image'">
              <h4>颜色调整</h4>
              <p class="muted">拖动即时预览，松手只记一步撤销；打印、PDF 与导出的图片同效。</p>
              <div class="property-grid">
                <label v-for="[key, label, max, identity] in ADJUST_FIELDS" :key="key">{{ label }}<input type="range" min="0" :max="max" step="1" :value="adjustPercent(key, identity)" :data-testid="`design-adjust-${key}`" @input="adjustInput(key, $event.target.value, max)" @change="adjustChange()"><output :data-testid="`design-adjust-${key}-value`">{{ adjustPercent(key, identity) }}%</output></label>
              </div>
              <button data-testid="design-adjust-reset" :disabled="!single.adjust" @click="resetAdjust">恢复原始颜色</button>
            </div>
            <template v-if="single.type === 'text'">
              <label>固定文字<textarea data-testid="design-text" rows="4" :value="single.text" @change="setLayer('text', $event.target.value)"></textarea></label>
              <label>字体<select :value="single.fontFamily" @change="setLayer('fontFamily', $event.target.value)"><option value="">默认字体</option><option v-for="name in fontNames" :key="name" :value="name">{{ name }}</option><option v-if="single.fontFamily && !fontNames.includes(single.fontFamily)" :value="single.fontFamily">{{ single.fontFamily }}（当前未找到）</option></select></label>
              <div class="property-grid">
                <label>字号 pt<input type="number" min="1" step="1" :value="single.fontSize" @change="setLayer('fontSize', $event.target.value, true)"></label>
                <label class="color-field" @click="openColorPicker"><span>文字颜色</span><span class="color-control"><input type="color" :value="single.color === 'transparent' ? '#ffffff' : single.color" aria-label="选择文字颜色" @input="colorInput('color', $event.target.value)" @change="colorChange('color', $event.target.value)"><code class="color-value">{{ formatColor(single.color) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label>
                <label>行距倍数<input type="number" min="0.5" step="0.1" :value="single.lineHeight" @change="setLayer('lineHeight', $event.target.value, true)"></label>
                <label>字距 pt<input type="number" step="0.1" :value="single.letterSpacing" @change="setLayer('letterSpacing', $event.target.value, true)"></label>
              </div>
              <label class="inline"><input type="checkbox" :checked="single.bold" @change="setLayer('bold', $event.target.checked)"> 粗体</label>
              <label>段落对齐<select :value="single.align" @change="setLayer('align', $event.target.value)"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
            </template>
            <template v-else-if="single.type === 'image' && single.variable">
              <h4>变量照片</h4>
              <p>匹配字段跟随名单的“配图”开关。切换字段无需重新制作变量图。</p>
              <label>成品尺寸 / 比例
                <select v-model="sizePreset" data-testid="design-size-preset" :disabled="singleBlocked">
                  <option value="">自定义（不改动）</option>
                  <optgroup v-if="itemSizes.length" label="证件照与卡片（毫米）">
                    <option v-for="size in itemSizes" :key="size.id" :value="`size:${size.id}`">{{ size.name }}</option>
                  </optgroup>
                  <optgroup label="仅比例（保持当前宽度）">
                    <option v-for="ratio in CROP_RATIOS" :key="ratio.id" :value="`ratio:${ratio.id}`">{{ ratio.name }}</option>
                  </optgroup>
                </select>
              </label>
              <p class="muted">选尺寸会把框设成该毫米成品（如 1 寸 = 25×35 mm）；取景由「适应方式 + 焦点」决定，不会把脸拉长。</p>
              <label>适应方式<select :value="single.fit" @change="setLayer('fit', $event.target.value)"><option value="cover">铺满框（裁切边缘）</option><option value="contain">完整显示（可能留白）</option></select></label>
              <label v-for="[axis, label] in [['x','水平焦点 %'],['y','垂直焦点 %']]" :key="axis">{{ label }}<input type="number" min="0" max="100" :value="single.focal[axis] * 100" @change="setPhotoFocal(axis, $event.target.value)"></label>
              <label>圆角 mm<input type="number" min="0" step="0.5" :value="single.radius" @change="setLayer('radius', $event.target.value, true)"></label>
              <p class="muted">缺图或空值时照片位置留白。同名多图、坏图仍需在照片库处理。</p>
            </template>
            <template v-else-if="single.type === 'image'">
              <label class="inline"><input v-model="keepRatio" type="checkbox"> 缩放与裁切保持图片比例</label>
              <label>成品尺寸 / 比例
                <select v-model="sizePreset" data-testid="design-size-preset" :disabled="singleBlocked">
                  <option value="">自定义（不改动）</option>
                  <optgroup v-if="itemSizes.length" label="证件照与卡片（毫米）">
                    <option v-for="size in itemSizes" :key="size.id" :value="`size:${size.id}`">{{ size.name }}</option>
                  </optgroup>
                  <optgroup label="仅比例（保持当前宽度）">
                    <option v-for="ratio in CROP_RATIOS" :key="ratio.id" :value="`ratio:${ratio.id}`">{{ ratio.name }}</option>
                  </optgroup>
                </select>
              </label>
              <p class="muted">选尺寸会把图层设成该毫米成品（如 1 寸 = 25×35 mm），并同时把裁切调成同一长宽比——只改尺寸不改裁切会把照片拉长。</p>
              <div class="tool-grid"><button @click="setLayer('flipX', !single.flipX)">{{ single.flipX ? '取消水平翻转' : '水平翻转' }}</button><button @click="setLayer('flipY', !single.flipY)">{{ single.flipY ? '取消垂直翻转' : '垂直翻转' }}</button></div>
              <h4>裁切范围（原图百分比）</h4>
              <div class="property-grid"><label v-for="[key, label] in [['x','左侧 %'],['y','顶部 %'],['w','宽度 %'],['h','高度 %']]" :key="key">{{ label }}<input :data-testid="`design-crop-${key}`" type="number" min="0" max="100" step="1" :value="round(single.crop[key] * 100)" @change="setCrop(key, $event.target.value)"></label></div>
              <button @click="resetCrop">恢复完整图片范围</button>
              <p class="muted">原图 {{ design.assets[single.assetId]?.width }} × {{ design.assets[single.assetId]?.height }} px · 当前约 {{ dpiText }} DPI</p>
            </template>
            <template v-else>
              <label v-if="single.type !== 'line'" class="color-field" @click="openColorPicker"><span>填充颜色</span><span class="color-control"><input type="color" :value="single.fill === 'transparent' ? '#ffffff' : single.fill" aria-label="选择填充颜色" @input="colorInput('fill', $event.target.value)" @change="colorChange('fill', $event.target.value)"><code class="color-value">{{ formatColor(single.fill) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label>
              <label v-if="single.type !== 'line'" class="inline"><input type="checkbox" :checked="single.fill === 'transparent'" @change="setLayer('fill', $event.target.checked ? 'transparent' : '#ead9bf')"> 无填充</label>
              <label v-if="['rect','ellipse'].includes(single.type)" class="inline"><input data-testid="design-layer-gradient" type="checkbox" :checked="!!single.fillPaint" @change="setPaint('layer', 'enabled', $event.target.checked)"> 使用线性渐变</label>
              <div v-if="single.fillPaint" class="property-grid">
                <label>方向 °<input data-testid="design-layer-gradient-angle" type="number" min="-360" max="360" :value="single.fillPaint.angle" @change="setPaint('layer', 'angle', $event.target.value)"></label>
                <label v-for="(stop, index) in single.fillPaint.stops" :key="`layer-stop-${index}`">色标 {{ index + 1 }}
                  <span class="property-grid"><input type="color" :value="stop.color" @change="setPaint('layer', `color:${index}`, $event.target.value)"><input type="number" min="0" max="1" step="0.01" aria-label="色标位置" :disabled="index===0 || index===single.fillPaint.stops.length-1" :value="stop.offset" @change="setPaint('layer', `offset:${index}`, $event.target.value)"><input type="number" min="0" max="1" step="0.05" aria-label="色标透明度" :value="stop.opacity" @change="setPaint('layer', `opacity:${index}`, $event.target.value)"></span>
                </label>
                <button :disabled="single.fillPaint.stops.length>=8" @click="changePaintStops('layer','add')">添加色标</button><button :disabled="single.fillPaint.stops.length<=2" @click="changePaintStops('layer','remove')">移除中间色标</button>
              </div>
              <label v-if="['rect','ellipse'].includes(single.type)" class="inline"><input data-testid="design-layer-shadow" type="checkbox" :checked="!!single.shadow" @change="setShadow('enabled', $event.target.checked)"> 使用外阴影</label>
              <div v-if="single.shadow" class="property-grid">
                <label>水平偏移 mm<input data-testid="design-shadow-dx" type="number" min="-50" max="50" step="0.1" :value="single.shadow.dxMm" @change="setShadow('dxMm', Number($event.target.value))"></label>
                <label>垂直偏移 mm<input data-testid="design-shadow-dy" type="number" min="-50" max="50" step="0.1" :value="single.shadow.dyMm" @change="setShadow('dyMm', Number($event.target.value))"></label>
                <label>模糊 mm<input data-testid="design-shadow-blur" type="number" min="0" max="10" step="0.1" :value="single.shadow.blurMm" @change="setShadow('blurMm', Number($event.target.value))"></label>
                <label>透明度 %<input data-testid="design-shadow-opacity" type="number" min="0" max="100" step="1" :value="Math.round(single.shadow.opacity * 100)" @change="setShadow('opacity', Number($event.target.value) / 100)"></label>
                <label>阴影颜色<input data-testid="design-shadow-color" type="color" :value="single.shadow.color" @change="setShadow('color', $event.target.value)"></label>
              </div>
              <div class="property-grid"><label class="color-field" @click="openColorPicker"><span>描边颜色</span><span class="color-control"><input type="color" :value="single.stroke === 'transparent' ? '#000000' : single.stroke" aria-label="选择描边颜色" @input="colorInput('stroke', $event.target.value)" @change="colorChange('stroke', $event.target.value)"><code class="color-value">{{ formatColor(single.stroke) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label><label>描边 mm<input type="number" min="0" step="0.1" :value="single.strokeWidth" @change="setLayer('strokeWidth', $event.target.value, true)"></label></div>
              <label v-if="single.type === 'rect'">圆角 mm<input type="number" min="0" step="0.5" :value="single.radius" @change="setLayer('radius', $event.target.value, true)"></label>
            </template>
            <!-- 图片图层的描边与投影（v0.7 §6）。放在两支图片分支**之外**共用一份：
                 静态图与变量图要的是同一个功能，写两遍必然走偏（形状那套两套按钮已经吃过这个亏）。 -->
            <template v-if="single.type === 'image'">
              <h4>描边（衬边）</h4>
              <label class="inline"><input data-testid="design-layer-stroke" type="checkbox" :checked="single.strokeWidth !== undefined" @change="setStroke('enabled', $event.target.checked)"> 使用描边</label>
              <div v-if="single.strokeWidth !== undefined" class="property-grid">
                <label>宽度 mm<input data-testid="design-stroke-width" type="number" min="0" max="100" step="0.1" :value="single.strokeWidth" @change="setStroke('strokeWidth', Number($event.target.value))"></label>
                <label>描边颜色<input data-testid="design-stroke-color" type="color" :value="single.stroke === 'transparent' ? '#ffffff' : single.stroke" @change="setStroke('stroke', $event.target.value)"></label>
              </div>
              <p v-if="single.strokeWidth !== undefined" class="muted">描边画在框的内侧，<strong>不改变成品的毫米尺寸</strong>，也不会把照片拉长。</p>
              <h4>投影</h4>
              <label class="inline"><input data-testid="design-layer-shadow" type="checkbox" :checked="!!single.shadow" @change="setShadow('enabled', $event.target.checked)"> 使用投影</label>
              <div v-if="single.shadow" class="property-grid">
                <label>水平偏移 mm<input data-testid="design-shadow-dx" type="number" min="-50" max="50" step="0.1" :value="single.shadow.dxMm" @change="setShadow('dxMm', Number($event.target.value))"></label>
                <label>垂直偏移 mm<input data-testid="design-shadow-dy" type="number" min="-50" max="50" step="0.1" :value="single.shadow.dyMm" @change="setShadow('dyMm', Number($event.target.value))"></label>
                <label>模糊 mm<input data-testid="design-shadow-blur" type="number" min="0" max="10" step="0.1" :value="single.shadow.blurMm" @change="setShadow('blurMm', Number($event.target.value))"></label>
                <label>透明度 %<input data-testid="design-shadow-opacity" type="number" min="0" max="100" step="1" :value="Math.round(single.shadow.opacity * 100)" @change="setShadow('opacity', Number($event.target.value) / 100)"></label>
                <label>阴影颜色<input data-testid="design-shadow-color" type="color" :value="single.shadow.color" @change="setShadow('color', $event.target.value)"></label>
              </div>
              <p v-if="single.shadow" class="muted">投影跟着图片的<strong>实际轮廓</strong>走（抠过底的 PNG 只投轮廓，不会投出一个方盒）；<strong>不会</strong>被框裁掉。</p>
            </template>
          </fieldset>
        </template>
        </template>
      </aside>
    </div>
    <div v-if="showExport" class="export-mask" @click.self="!busy && (showExport = false)">
      <section data-testid="design-export-dialog" class="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-heading">
        <h3 id="export-heading">导出图片底图</h3>
        <p>导出当前编辑内容，包含所有可见图层（「仅编辑可见」的参考框不会导出，和打印保持一致）。</p>
        <label>图片格式<select v-model="exportFormat" data-testid="design-export-format" :disabled="busy" @change="pickExportFormat">
          <option v-for="(info, key) in FORMATS" :key="key" :value="key">{{ info.label }}</option>
        </select></label>
        <label>输出分辨率<select v-model.number="exportDpi" data-testid="design-export-dpi" :disabled="busy"><option :value="150">150 DPI</option><option :value="300">300 DPI</option><option :value="600">600 DPI</option></select></label>
        <label v-if="exportLossy">图片质量<input v-model.number="exportQuality" data-testid="design-export-quality" type="range" min="1" max="100" :disabled="busy"><output data-testid="design-export-quality-value">{{ exportQuality }}</output></label>
        <label class="inline"><input v-model="exportTransparent" data-testid="design-export-transparent" type="checkbox" :disabled="busy || !exportFormatInfo.transparent"> 透明背景（不绘制画布背景色）</label>
        <p v-if="!exportFormatInfo.transparent" class="muted" data-testid="design-export-flatten-hint">JPEG 没有透明通道，会铺上画布自己的底色导出。</p>
        <p class="export-dimensions" data-testid="design-export-size">{{ exportSize.width.toLocaleString() }} × {{ exportSize.height.toLocaleString() }} 像素 · {{ (exportSize.width * exportSize.height / 1000000).toFixed(1) }} 百万像素<template v-if="exportEstimate !== null"> · 约 {{ formatBytes(exportEstimate) }}</template></p>
        <p class="muted">图片保持现有可见细节；提高 DPI 不会增加原图细节。图层工程可继续编辑。</p>
        <p v-if="exportFormatInfo.dpi === 'none'" class="muted" data-testid="design-export-dpi-hint">WebP 没有公认的分辨率元数据，文件里不会写入 DPI；要按物理尺寸打印请选 PNG 或 JPEG。</p>
        <p v-if="exportSizeError || exportError" class="export-error" role="alert">{{ exportSizeError || exportError }}</p>
        <div class="export-actions"><button :disabled="busy" @click="showExport = false">取消</button><button data-testid="design-export-confirm" class="primary" :disabled="busy || !!exportSizeError" @click="runExport">{{ busy ? '正在导出…' : '选择位置并导出' }}</button></div>
      </section>
    </div>
    <!--
      工程包导出：有未保存修改时必须让用户自己选「保存后导出」还是「导出已保存版本」。
      导出的是**不可变的版本文件**，所以对话框里把版本号写出来，别让用户以为导出的是眼前这一屏。
    -->
    <div v-if="showPackageExport" class="export-mask" @click.self="!busy && (showPackageExport = false)">
      <section data-testid="design-package-export-dialog" class="export-dialog" role="dialog" aria-modal="true" aria-labelledby="package-export-heading">
        <h3 id="package-export-heading">导出工程包（.ppdesign）</h3>
        <p>把工程这一版连图片原件与上传字体一起打包，换台电脑导入后可以继续编辑。</p>
        <p class="export-dimensions" data-testid="design-package-version">导出内容：已保存的第 {{ design.revision }} 版 · {{ design.layers.length }} 个图层</p>
        <label class="inline"><input v-model="packageIncludeFonts" data-testid="design-package-include-fonts" type="checkbox" :disabled="busy"> 携带已上传的字体原件（换机后字形一致；系统字体不会打包）</label>
        <p v-if="dirty" class="export-error" role="alert">当前有未保存的修改。工程包只能导出已保存的版本——请选择「保存后导出」，或直接导出第 {{ design.revision }} 版。</p>
        <p v-if="packageExportError" class="export-error" role="alert">{{ packageExportError }}</p>
        <p v-if="packageProgress" class="export-dimensions" data-testid="design-package-progress">打包 {{ packageProgress.index }} / {{ packageProgress.total }}：{{ packageProgress.name }}</p>
        <div class="export-actions">
          <button :disabled="busy" @click="showPackageExport = false">取消</button>
          <button data-testid="design-package-export-saved" :disabled="busy" @click="runPackageExport(false)">导出第 {{ design.revision }} 版</button>
          <button v-if="dirty" data-testid="design-package-export-save-first" class="primary" :disabled="busy" @click="runPackageExport(true)">保存后导出</button>
          <button v-else data-testid="design-package-export-confirm" class="primary" :disabled="busy" @click="runPackageExport(false)">{{ busy ? '正在导出…' : '选择位置并导出' }}</button>
          <button v-if="busy" data-testid="design-package-export-cancel" @click="cancelPackageExport">取消导出</button>
        </div>
      </section>
    </div>
    <!--
      导入检查页：先给用户看「这是什么、有多大、字体有没有问题」，确认后才真的导入。
      缺失字体必须逐条决定（替代 / 默认 / 提供文件）——不许静默替代，那是「打开后字体全变了」的根源。
    -->
    <div v-if="packageSummary" class="export-mask" @click.self="!busy && closeImport()">
      <section data-testid="design-package-import-dialog" class="export-dialog package-import" role="dialog" aria-modal="true" aria-labelledby="package-import-heading">
        <h3 id="package-import-heading">导入工程包</h3>
        <p><b>{{ packageSummary.name }}</b> · {{ packageSummary.artboard?.w }} × {{ packageSummary.artboard?.h }} mm</p>
        <p class="export-dimensions" data-testid="design-package-stats">
          {{ packageSummary.stats?.layerCount }} 个图层 · {{ packageSummary.stats?.imageCount }} 张图片 · {{ packageSummary.stats?.fontCount }} 种字体 · 解压 {{ (packageSummary.totalBytes / 1024 / 1024).toFixed(1) }} MB
        </p>
        <p class="muted">导入会新建一份副本（新工程、第 1 版），不会覆盖现有工程，也不改动当前画板。</p>
        <div v-if="packageSummary.fonts?.length" class="package-fonts">
          <h4>字体</h4>
          <div v-for="font in packageSummary.fonts" :key="font.family" class="package-font-row" :data-font="font.family">
            <span class="package-font-name">{{ font.family }}</span>
            <span v-if="font.action === 'missing'" class="package-font-missing">本机没有，需要选择处理方式</span>
            <span v-else-if="font.action === 'alias'" class="muted">本机已有同名不同内容的字体 → 将使用别名 {{ font.targetFamily }}</span>
            <span v-else class="muted">{{ font.status === 'embedded' ? '包内自带' : '本机已有' }}</span>
            <template v-if="font.action === 'missing'">
              <select v-model="fontChoices[font.family].action" :data-testid="`package-font-action-${font.family}`">
                <option value="default">用默认字体</option>
                <option value="substitute">替代为本机字体</option>
                <option value="file">提供字体文件…</option>
              </select>
              <select v-if="fontChoices[font.family].action === 'substitute'" v-model="fontChoices[font.family].family" :data-testid="`package-font-substitute-${font.family}`">
                <option v-for="item in fonts.uploaded" :key="item.file" :value="item.family">{{ item.family }}</option>
              </select>
              <button v-if="fontChoices[font.family].action === 'file'" :disabled="busy" :data-testid="`package-font-pick-${font.family}`" @click="pickFontFor(font.family)">{{ fontChoices[font.family].filePath ? '已选择字体文件（点击可更换）' : '选择字体文件…' }}</button>
            </template>
          </div>
        </div>
        <p v-if="packageError" class="export-error" role="alert">{{ packageError }}</p>
        <div class="export-actions">
          <button :disabled="busy" @click="closeImport()">取消</button>
          <button data-testid="design-package-import-confirm" :disabled="busy" @click="commitImport(false)">{{ busy ? '正在导入…' : '导入副本' }}</button>
          <button data-testid="design-package-import-open" class="primary" :disabled="busy" @click="commitImport(true)">{{ busy ? '正在导入…' : '导入并打开' }}</button>
        </div>
      </section>
    </div>
    <ConfirmDialog v-if="pending" :title="pending.title" :message="pending.message" :confirm-text="pending.confirmText" @confirm="confirmPending" @cancel="cancelPending" />
  </section>
</template>

<style scoped>
.portrait-mask{position:fixed;inset:0;z-index:2000;background:rgba(30,26,20,.45);display:grid;place-items:center}.portrait-picker{width:440px;padding:24px;background:var(--paper-card);color:var(--ink);border-radius:14px;box-shadow:0 20px 60px #0003}.portrait-picker label{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:16px 0}.portrait-picker select{max-width:280px}.portrait-picker p{color:var(--stone);line-height:1.7}
.designer-view { min-width: 960px; }
button { border: 1px solid var(--line-strong); background: var(--paper-card); color: var(--ink); border-radius: 5px; padding: 6px 9px; font-size: 12px; }
button:hover:not(:disabled) { border-color: var(--cinnabar); color: var(--cinnabar); }
button:disabled { opacity: .42; cursor: default; }
button.primary { color: #fff; background: var(--cinnabar); border-color: var(--cinnabar); }
button.primary:hover:not(:disabled) { color: #fff; filter: brightness(1.07); }
/* 「素材库」开关的选中态（`on` 只此一处用）。布局与间距由 PageHeader 的
   `.page-header__actions` 统一负责，这里只管这一个按钮自己的态。 */
button.on { border-color: var(--cinnabar); color: var(--cinnabar); background: var(--paper-card); }
/* 下拉里塞了「名称 — 说明」，收起来时按固定宽度截断；展开的列表仍是完整文案 */
.preset-picker { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-2); }
.preset-picker select { max-width: 230px; font-size: 12px; }
.notice { padding: 10px 12px; margin-bottom: 10px; border: 1px solid var(--line); border-radius: 6px; display: flex; align-items: center; gap: 12px; font-size: 12px; }
.notice button { margin-left: auto; flex-shrink: 0; }
.notice.error { background: var(--warn-soft); color: var(--warn); border-color: var(--warn-line); }
.notice.success { background: var(--ok-soft); color: var(--ok); }
.context-note { background: var(--paper-card); color: var(--ink-2); }
/* 导出完成条：文字占满一行（路径可能很长），按钮在第二行靠右 */
.export-done { flex-wrap: wrap; }
.export-done-text { flex: 1 1 100%; }
.export-done-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: var(--ink-2); background: var(--paper); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; margin-left: 6px; overflow-wrap: anywhere; }
.export-done button { margin-left: 0; }
.export-done button:first-of-type { margin-left: auto; }
.designer-workspace { display: grid; grid-template-columns: var(--tools-w, 176px) minmax(450px, 1fr); gap: 12px; align-items: start; position: relative; }
.designer-workspace.focus-canvas { grid-template-columns: minmax(0, 1fr); }
.designer-workspace.focus-canvas .tools-panel,
.designer-workspace.focus-canvas .workspace-resizer { display: none; }
.designer-workspace.focus-canvas .canvas-scroll { height: calc(100vh - 250px); max-height: none; }
.designer-workspace.focus-canvas .canvas-toolbar,
.designer-workspace.focus-canvas .canvas-status { padding-right: 8px; }
/* 左栏宽度拖拽柄：骑在两列之间的 gap 上（11px 热区），拖动时全局禁选中防拖出选区 */
.workspace-resizer { position: absolute; top: 0; bottom: 0; left: calc(var(--tools-w, 176px) + 1px); width: 10px; z-index: 30; cursor: col-resize; touch-action: none; }
.workspace-resizer::after { content: ''; position: absolute; top: 12px; bottom: 12px; left: 4px; width: 2px; border-radius: 1px; background: transparent; transition: background .15s; }
.workspace-resizer:hover::after, .designer-workspace.tools-resizing .workspace-resizer::after { background: var(--cinnabar-soft); }
.designer-workspace.tools-resizing { user-select: none; cursor: col-resize; }
/* 素材库抽屉：浮在画布左侧（覆盖而非占列），打开不再挤压画布；内部自行滚动；点外部收起 */
/* 素材库浮层顶部让开画布工具栏那一行（撤销 / 重做 / 上移 / 下移 / 置顶 / 置底）：
   它原本 top: 0，从工作区顶部铺下来，会把工具栏左半整排盖住。工具栏高 48px，再留 8px 间隙
   （2026-10-11 用户要求：别遮挡那一排按钮）。 */
.designer-panel.asset-library { position: absolute; top: 56px; bottom: 0; left: calc(var(--tools-w, 176px) + 12px); width: 256px; z-index: 40; box-shadow: 0 6px 24px rgba(43, 38, 34, 0.22); }
/* 属性面板抽屉：浮在画布右侧；选中图层自动弹出、点空白画布取消选中自动收起（无手动开关）；
   打开时工具条与状态栏让出其宽度（缩放/保存状态不被盖住） */
.designer-panel.inspector { position: absolute; top: 0; bottom: 0; right: 0; width: 264px; z-index: 40; box-shadow: 0 6px 24px rgba(43, 38, 34, 0.22); }
.canvas-column.inspector-open .canvas-toolbar,
.canvas-column.inspector-open .canvas-status { padding-right: 276px; }
.designer-panel { border: 1px solid var(--line); border-radius: 8px; background: var(--paper-card); padding: 12px; min-width: 0; max-height: calc(100vh - 200px); overflow: auto; }
h3 { font-size: 13px; margin: 4px 0 10px; display: flex; align-items: center; justify-content: space-between; }
h3:not(:first-child) { margin-top: 20px; padding-top: 13px; border-top: 1px solid var(--line); }
h3 span { font-weight: 400; font-size: 10px; color: var(--stone); } h4 { font-size: 12px; margin: 14px 0 8px; }
.tool-grid, .property-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.align-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.align-grid button { font-size: 11px; padding: 6px 2px; }
.muted, .locked-note { font-size: 11px; color: var(--stone); line-height: 1.7; margin: 8px 0; }
.locked-note { color: var(--warn); }
.project-list { max-height: 190px; overflow: auto; }
.project-row { display: flex; align-items: center; margin: 3px 0; border-radius: 5px; border: 1px solid var(--line); }
.project-row.current { border-color: var(--cinnabar); }
.project-open { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; padding: 7px; }
.project-open b, .project-open small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-open b { font-weight: 500; } .project-open small { font-size: 10px; color: var(--stone); margin-top: 4px; }
.icon-button { padding: 4px 5px; border: 0; background: transparent; font-size: 12px; }
.group-actions { margin-bottom: 8px; }
.layer-list { max-height: 290px; overflow: auto; margin-bottom: 8px; }
.layer-row { display: flex; align-items: center; min-height: 32px; border: 1px solid transparent; border-bottom-color: var(--line); border-radius: 4px; cursor: pointer; position: relative; }
.layer-row.selected { border-color: var(--cinnabar); background: var(--cinnabar-soft); } .layer-row.hidden .layer-name { opacity: .45; }
.group-row { margin-top: 6px; background: var(--paper); font-weight: 600; }
.group-member { margin-left: 12px; border-left-color: var(--line-strong); }
.layer-name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
/* 行内操作层：hover 覆盖在名称上方（实底、不挤压布局），锁/开仍常显在行尾 */
.layer-row-actions { position: absolute; right: 24px; top: 0; bottom: 0; display: none; align-items: center; gap: 1px; padding: 0 2px; background: var(--paper-card); border-radius: 4px; }
.layer-row.group-member .layer-row-actions, .layer-row.selected .layer-row-actions { background: var(--paper); }
.layer-row:hover .layer-row-actions, .layer-row:focus-within .layer-row-actions { display: inline-flex; }
.layer-row-actions .icon-button { font-size: 11px; padding: 2px 3px; min-width: 17px; }
.adopted-flag { font-size: 11px; color: var(--warn); line-height: 1; }
/* 徽标一律 nowrap + inline-block：表格/弹性布局按 min-content 分列宽，中文徽标可断字，
   窄窗口下「仅编辑」会被拆成两行（同 I-14 的 .det-flag）。 */
.layer-flag { flex: none; display: inline-block; white-space: nowrap; font-size: 11px; line-height: 1.4; padding: 0 5px; border-radius: 999px; color: var(--cinnabar); background: var(--cinnabar-soft); border: 1px solid currentColor; }
.canvas-column { min-width: 0; position: relative; --inspector-reserve: 276px; }
.canvas-column:not(.inspector-open) { --inspector-reserve: 0px; }
.canvas-toolbar { display: flex; align-items: center; gap: 7px; background: var(--paper-card); border: 1px solid var(--line); padding: 8px; border-radius: 8px 8px 0 0; }
.toolbar-spacer { flex: 1; }
.canvas-scroll { overflow-x: hidden; overflow-y: auto; min-height: 410px; height: calc(100vh - 315px); max-height: 860px; padding: 30px; padding-right: calc(30px + var(--inspector-reserve)); background-color: var(--line); background-image: radial-gradient(var(--stone) .6px, transparent .6px); background-size: 12px 12px; }
.canvas-horizontal-scroll { height: 20px; margin-right: var(--inspector-reserve); overflow-x: scroll; overflow-y: hidden; background: var(--paper-card); border: 1px solid var(--line); box-sizing: border-box; scrollbar-color: var(--stone) var(--paper-card); }
.canvas-horizontal-track { height: 1px; pointer-events: none; }
.canvas-horizontal-scroll::-webkit-scrollbar { height: 14px; }
.canvas-horizontal-scroll::-webkit-scrollbar-thumb { background: var(--stone); border: 3px solid var(--paper-card); border-radius: 8px; }
.canvas-horizontal-scroll::-webkit-scrollbar-track { background: var(--paper-card); }
.canvas-navigator { position: absolute; left: 18px; bottom: 56px; z-index: 25; overflow: hidden; box-sizing: content-box; border: 2px solid var(--paper-card); background: white; box-shadow: 0 3px 16px #0005; cursor: crosshair; touch-action: none; }
.canvas-navigator > :first-child { pointer-events: none; }
.navigator-viewport { position: absolute; box-sizing: border-box; border: 2px solid var(--cinnabar); background: rgba(176,58,46,.12); pointer-events: none; }
/* 拖入高亮：用 outline 而不是 border —— 不参与布局，画布尺寸不会被拖动过程改变 */
.canvas-scroll.drop-active { outline: 2px dashed var(--cinnabar); outline-offset: -4px; }
.drop-hint { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; background: var(--paper-card); opacity: .88; color: var(--cinnabar); font-size: 13px; font-weight: 600; pointer-events: none; }
/* 画布内就地编辑：尺寸/字号/行距全部由 inline style 按图层数据给出，这里只做「把浏览器默认外观清干净」，
   否则 textarea 自带的 border/padding 会让编辑中的字比出片时偏一点。outline 不占布局。 */
.inline-text-editor { position: absolute; box-sizing: border-box; margin: 0; padding: 0; border: 0; background: transparent; resize: none; overflow: hidden; transform-origin: center center; pointer-events: auto; caret-color: currentColor; outline: 1px dashed var(--cinnabar); outline-offset: 2px; }
.design-stage { position: relative; flex-shrink: 0; background: #fff; box-shadow: 0 3px 16px #0003; margin: 0 auto; isolation: isolate; }
.layer-hit { position: absolute; cursor: move; touch-action: none; outline: 1px solid transparent; transform-origin: center; user-select: none; }
.layer-hit:hover { outline-color: #b03a2e88; } .layer-hit.chosen { outline: 1px solid #b03a2e; z-index: 2; }
.layer-hit.locked { cursor: default; } .layer-hit.locked.chosen { outline: 1px dashed #8c8577; }
.layer-hit.line-hit, .layer-hit.line-hit:hover, .layer-hit.line-hit.chosen, .layer-hit.line-hit.locked.chosen { outline: none; }
.layer-hit.line-hit.chosen { z-index: 2; }
.layer-hit.line-hit::after { content: ''; display: none; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed #b03a2e; transform: translateY(-50%); pointer-events: none; }
.layer-hit.line-hit:hover::after, .layer-hit.line-hit.chosen::after { display: block; }
.layer-hit.line-hit.locked::after { border-color: #8c8577; }
.resize-handle { position: absolute; padding: 0; width: 11px; height: 11px; background: #fff; border: 1px solid #b03a2e; border-radius: 2px; touch-action: none; }
.resize-handle.corner-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.resize-handle.corner-sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.resize-handle.corner-ne { right: -6px; top: -6px; cursor: nesw-resize; }
.resize-handle.corner-nw { left: -6px; top: -6px; cursor: nwse-resize; }
.resize-handle.line-resize-handle { top: 50%; right: -6px; transform: translateY(-50%); cursor: ew-resize; }
.snap-guide { position: absolute; pointer-events: none; z-index: 10; }
.snap-guide.vertical { top: 0; bottom: 0; border-left: 1px dashed #d02775; } .snap-guide.horizontal { left: 0; right: 0; border-top: 1px dashed #d02775; }
.persistent-guide { position: absolute; pointer-events: none; z-index: 9; }
.persistent-guide.vertical { top: 0; bottom: 0; border-left: 1px solid #2689c9; }
.persistent-guide.horizontal { left: 0; right: 0; border-top: 1px solid #2689c9; }
/* 布局网格：只画在画布内，pointer-events:none 保证它不吃任何鼠标事件。
   线的疏密与颜色全由 inline 的 backgroundImage 给出（见 gridOverlayStyle）。 */
.grid-overlay { position: absolute; inset: 0; pointer-events: none; }
/*
 * 标尺贴在画布**外缘**（bottom/right: 100%），与画布共用同一个 pxPerMm。
 * overflow:hidden 让超出画布末缘的半格刻度不至于糊出边界；crosshair 提示「这里可以拖」。
 */
.ruler { position: absolute; overflow: hidden; background: var(--paper-card); color: var(--stone); font-size: 9px; line-height: 1; cursor: crosshair; touch-action: none; user-select: none; }
.ruler-h { left: 0; bottom: 100%; height: 18px; border-bottom: 1px solid var(--line-strong); }
.ruler-v { top: 0; right: 100%; width: 18px; border-right: 1px solid var(--line-strong); }
.ruler-tick { position: absolute; background: var(--line-strong); }
.ruler-h .ruler-tick { top: 0; width: 1px; height: 4px; }
.ruler-h .ruler-tick.major { height: 9px; }
.ruler-v .ruler-tick { left: 0; height: 1px; width: 4px; }
.ruler-v .ruler-tick.major { width: 9px; }
.ruler-label { position: absolute; white-space: nowrap; }
.ruler-h .ruler-label { left: 2px; top: 8px; }
/* 竖排数字：18px 宽的竖条里横排数字放不下，旋转后既省地方又一眼能读 */
.ruler-v .ruler-label { top: 10px; left: 1px; writing-mode: vertical-rl; }
.snap-targets { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.snap-targets label.inline { margin: 3px 0; }
.canvas-status { display: flex; justify-content: space-between; gap: 12px; padding: 9px; background: var(--paper-card); border: 1px solid var(--line); border-radius: 0 0 8px 8px; font-size: 11px; color: var(--ink-2); }
.unsaved { color: var(--cinnabar); } .shortcut-note { font-size: 11px; color: var(--stone); line-height: 1.7; margin: 8px 0; }
.inspector label, .tools-panel label { display: flex; flex-direction: column; gap: 5px; color: var(--ink-2); font-size: 11px; margin-bottom: 9px; }
.inspector input, .inspector select, .inspector textarea, .tools-panel input, .tools-panel select, .tools-panel textarea { width: 100%; min-width: 0; border: 1px solid var(--line-strong); background: var(--input-bg); color: var(--ink); border-radius: 4px; padding: 6px; font: inherit; font-size: 12px; }
.inspector .color-field, .tools-panel .color-field { gap: 6px; }
.inspector .color-control, .tools-panel .color-control { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 40px; padding: 4px 10px 4px 5px; box-sizing: border-box; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--input-bg); transition: border-color .15s, box-shadow .15s; }
.inspector .color-control:focus-within, .tools-panel .color-control:focus-within { border-color: var(--cinnabar); box-shadow: 0 0 0 2px var(--cinnabar-soft); }
.inspector .color-control input[type="color"], .tools-panel .color-control input[type="color"] { flex: 0 0 34px; width: 34px; height: 30px; padding: 2px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper-card); cursor: pointer; }
.inspector .color-value, .tools-panel .color-value { color: var(--ink); font: 11px ui-monospace, Consolas, monospace; letter-spacing: .04em; }
.inspector .color-open, .tools-panel .color-open { margin-left: auto; color: var(--stone); font-size: 16px; line-height: 1; }
.inspector textarea { resize: vertical; line-height: 1.6; }
label.inline { display: flex; flex-direction: row; align-items: center; gap: 4px; font-size: 11px; margin: 0; }
label.inline input { width: auto; margin: 3px; } .inspector label.inline, .tools-panel label.inline { margin: 8px 0; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; } fieldset:disabled { opacity: .55; }
.guide-panel { padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin: 14px 0; }
.guide-panel summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--ink); }
.guide-panel summary span { margin-left: 6px; font-weight: 400; color: var(--stone); }
.guide-list { margin-top: 8px; max-height: 170px; overflow: auto; }
.guide-row { display: flex; gap: 5px; align-items: center; margin: 5px 0; font-size: 11px; }
.guide-row input { flex: 1; width: 65px; padding: 5px 3px; }
.guide-outside { color: var(--warn); flex-shrink: 0; font-size: 10px; }
.export-mask { position: fixed; inset: 0; z-index: 130; background: #201b1666; display: flex; align-items: center; justify-content: center; }
.export-dialog { width: 410px; padding: 24px; border-radius: 10px; background: var(--paper-card); border: 1px solid var(--line-strong); box-shadow: var(--shadow); }
.export-dialog h3 { font-size: 16px; margin: 0 0 12px; }
.export-dialog p { font-size: 12px; line-height: 1.8; color: var(--ink-2); }
.export-dialog label:not(.inline) { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; margin: 14px 0; }
.export-dialog .export-dimensions { font-size: 14px; font-weight: 600; color: var(--ink); padding: 10px 12px; background: var(--paper); border-radius: 6px; margin: 18px 0 12px; }
.export-dialog .export-error { color: var(--warn); background: var(--warn-soft); padding: 8px 10px; border-radius: 5px; }
.export-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
/* 导入检查页：字体冲突要逐条给处理方式，比导出对话框宽一些，内容多了自己滚 */
.package-import { width: 520px; max-height: 84vh; overflow: auto; }
.package-fonts { margin: 14px 0 0; }
.package-fonts h4 { font-size: 12px; margin: 0 0 8px; color: var(--ink-2); }
.package-font-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
.package-font-name { font-weight: 600; }
.package-font-missing { color: var(--warn); }
@media (max-width: 1180px) { .designer-workspace { grid-template-columns: min(160px, var(--tools-w, 176px)) minmax(400px, 1fr); gap: 8px; } .designer-panel.asset-library { width: 230px; } .designer-panel.inspector { width: 236px; } .canvas-column { --inspector-reserve: 248px; } .canvas-column.inspector-open .canvas-toolbar, .canvas-column.inspector-open .canvas-status { padding-right: 248px; } .designer-panel { padding: 9px; } .page-header { align-items: flex-start; } }
</style>

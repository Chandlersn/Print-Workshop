<script setup>
/**
 * 模板工坊：模板列表 + 画布编辑器。
 * - 底图上传：真实像素尺寸 → 纸张建议；比例差 >2% 变形预警
 * - 画布：百分比坐标系拖拽排版，字号存 pt
 * - 字段属性：字体（分组：默认/系统/上传）/ 字号 / 颜色 / 对齐 / 加粗
 * - 预览：选中数据集首行真实数据，空值半透明提示（打印时将留空）
 * 吸附对齐 / 多选 / 撤销重做在 M4。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue'
import CustomSelect from '../components/CustomSelect.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import DesignSurface from '../components/DesignSurface.vue'
import { designerNav, openDesigner } from '../lib/designer-nav.js'
import { evenRow, anchorRatio } from '../lib/field-layout.cjs'
import {
  resolveLayoutMode, resolveItemSpec, computeGridInfo, buildGridCells,
  computeBgRatioWarn, computeBgDpi, computeBgRatioDeviation,
  clampPageDim, clampItemDim, ptToPx as ptToPxOf,
} from '../lib/template-layout.cjs'
import {
  clampPct, snapTo, snapshotOf, parseSnapshot, pushCapped,
  shouldStartNewNudge, alignedX, alignedY,
} from '../lib/field-edit.cjs'

const CANVAS_W = 760 // 画布显示宽度 px

// ---- 多联版式 ----
// 语义：多联模式下底图代表「单个成品图」，画布切换为**单个成品**尺寸——
// 小成品（如 1 寸照）在整页缩放下只有几十像素，根本没法拖字段。
// 因此画布的定位参照系天然就是「格子」，拖拽/吸附/对齐逻辑无需改动。
const ITEM_SIZE_PRESETS = ref([])
const layoutMode = computed(() => resolveLayoutMode(activeTpl.value))

/** 设计参照物尺寸：多联 = 单个成品；对折桌牌 = 半页成品；单页 = 整张纸 */
const itemSpec = computed(() => resolveItemSpec(activeTpl.value))

/**
 * 版式摘要（仅用于界面提示；行列的权威计算在主进程 resolveLayout）。
 * ok=false 表示当前配置会退回单页（尺寸缺失、放不下或超过 400 格）。
 */
const gridInfo = computed(() => {
  const t = activeTpl.value
  if (!t || layoutMode.value !== 'grid') return null
  if (!(Number(t.layout?.itemW) > 0) || !(Number(t.layout?.itemH) > 0)) {
    return { cols: 0, rows: 0, perPage: 0, ok: false, invalid: true }
  }
  return computeGridInfo(t.pageSize, itemSpec.value)
})

// 多联放不下或超出每页 400 格上限时，渲染引擎会按整页出片；清晰度提示也必须按整页算。
const outputItemSpec = computed(() =>
  layoutMode.value === 'grid' && gridInfo.value && !gridInfo.value.ok
    ? activeTpl.value.pageSize
    : itemSpec.value)
const outputTarget = computed(() =>
  layoutMode.value === 'grid' && gridInfo.value?.ok ? '成品'
    : layoutMode.value === 'fold' ? '半页成品' : '纸张')

const layoutOptions = [
  { value: 'single', label: '单页' },
  { value: 'grid', label: '多联' },
  { value: 'fold', label: '对折桌牌' },
]

/** 是否多联版式 */
const isGrid = computed(() => layoutMode.value === 'grid')
/** 是否对折桌牌版式（一页一条记录 × 上下镜像半页） */
const isFold = computed(() => layoutMode.value === 'fold')
/** 是否画裁切线（仅多联有意义） */
const cutMarks = computed(() => activeTpl.value?.layout?.showCutMarks !== false)

/** 对折桌牌摘要：半页成品尺寸 */
const foldInfo = computed(() => {
  if (!isFold.value || !activeTpl.value) return null
  return { w: itemSpec.value.w, h: itemSpec.value.h }
})

/**
 * 多联格子阵列（百分比定位，与主进程 resolveLayout 同口径）。
 * 放不下 2 个成品时返回空数组——不画网格，由下方红字提示原因。
 */
const gridCells = computed(() => {
  const t = activeTpl.value
  if (!t || !isGrid.value || !gridInfo.value?.ok) return []
  return buildGridCells(t.pageSize, itemSpec.value)
})

/** 当前拖拽所在的格子（吸附辅助线画在这一格里；所有格子内容相同） */
const activeCellIdx = ref(0)

/** 定位参照系元素：多联 = 当前格，对折桌牌 = 下半联（编辑联），单页 = 整张画布 */
function refFrameEl() {
  if (isFold.value && canvasEl.value) {
    return canvasEl.value.querySelector('.fold-ref') || canvasEl.value
  }
  if (!isGrid.value || !canvasEl.value) return canvasEl.value
  const cells = canvasEl.value.querySelectorAll('.canvas-cell')
  return cells[Math.min(activeCellIdx.value, cells.length - 1)] || canvasEl.value
}

/** 当前成品尺寸是否命中预设（未命中显示为「自定义」） */
const itemSizeId = computed(() => {
  const l = activeTpl.value?.layout
  if (!l) return 'custom'
  const hit = ITEM_SIZE_PRESETS.value.find(
    (s) => s.w === Number(l.itemW) && s.h === Number(l.itemH))
  return hit ? hit.id : 'custom'
})
const itemSizeOptions = computed(() => [
  ...ITEM_SIZE_PRESETS.value.map((s) => ({ value: s.id, label: `${s.name}mm` })),
  { value: 'custom', label: '自定义' },
])

function ensureLayout() {
  const t = activeTpl.value
  if (!t) return
  if (!t.layout) t.layout = { mode: 'single', itemW: 85, itemH: 54, showCutMarks: true }
}

function onLayoutModeChange(mode) {
  if (!activeTpl.value) return
  ensureLayout()
  activeTpl.value.layout.mode = mode === 'grid' || mode === 'fold' ? mode : 'single'
}

function onItemSizeChange(id) {
  const t = activeTpl.value
  if (!t) return
  const hit = ITEM_SIZE_PRESETS.value.find((s) => s.id === id)
  if (!hit) return
  ensureLayout()
  t.layout.itemW = hit.w
  t.layout.itemH = hit.h
}

/**
 * 成品尺寸输入。
 * 空值/非法值一律不写回：原来是 Number('')→0→钳到 5，用户只是想清空重输，
 * 结果被静默锁成 5mm——画布按 5mm 算格子，小到看不出东西，字段像凭空消失。
 * 用户还没输完就被改掉值，比不接受输入更糟。
 */
function onItemDim(which, val) {
  const t = activeTpl.value
  if (!t) return
  const clamped = clampItemDim(val)
  if (clamped === null) return
  ensureLayout()
  if (which === 'w') t.layout.itemW = clamped
  else t.layout.itemH = clamped
}

function onCutMarks(on) {
  ensureLayout()
  activeTpl.value.layout.showCutMarks = Boolean(on)
}

const templates = ref([])
const fonts = ref({ system: [], uploaded: [] })
const datasets = ref([])
const activeTpl = ref(null)
const activeDatasetId = ref('')
const catalog = ref([])
const sampleRow = ref(null)
const selectedIdx = ref(-1)
const msg = ref('')
const errorMsg = ref('')
const dragState = ref(null)
const canvasEl = ref(null)
const designs = ref([])
const activeDesign = ref(null)
const selectedDesignId = ref('')
const templateKey = ref('')
let requestedDesignNonce = null
let designReadToken = 0
const hasBackground = computed(() => Boolean(activeTpl.value?.background || activeTpl.value?.backgroundDesign))
const designOptions = computed(() => designs.value.map((d) => ({
  value: d.id, label: `${d.name} · v${d.revision} · ${d.artboard.w}×${d.artboard.h}mm`,
})))
const candidateDesign = computed(() => designs.value.find((d) => d.id === selectedDesignId.value))
const designSurfaceWidth = computed(() => activeDesign.value
  ? CANVAS_W * activeDesign.value.artboard.w / activeTpl.value.pageSize.w : CANVAS_W)

/**
 * 工程尺寸问题的唯一判据，返回 `{ kind, text }` 或 `null`。
 *
 * 分 `kind` 是因为两类问题的**归属**不同：
 *   `grid`     → **模板自身**的多联版式放不下 2 个成品（跟选了哪份工程无关）；
 *   `mismatch` → **这份工程**的 artboard 与当前成品尺寸不一致。
 * 「候选工程」提示只关心 mismatch——grid 问题状态条带里已经有一条在说，候选行再说一遍就是复读。
 *
 * `text` 一律写成**从句**（不带「请…」前缀），由调用方去拼「，请…」的尾巴；
 * 否则会拼出「…让纸张至少容纳 2 个成品，请调整尺寸后再应用」这种两个「请」的句子。
 */
function designSizeIssue(doc) {
  if (!doc || !activeTpl.value) return null
  if (isGrid.value && !gridInfo.value?.ok) return { kind: 'grid', text: '纸张放不下 2 个成品' }
  const { w, h } = outputItemSpec.value
  return Math.abs(doc.artboard.w - w) > 0.01 || Math.abs(doc.artboard.h - h) > 0.01
    ? { kind: 'mismatch', text: `尺寸 ${doc.artboard.w}×${doc.artboard.h}mm 与当前成品 ${w}×${h}mm 不一致` }
    : null
}
/** 已挂上的工程 vs 当前模板尺寸（状态条带、保存前校验都用它） */
const designSizeWarning = computed(() => designSizeIssue(activeDesign.value)?.text || '')
/** 下拉里选中但还没应用的工程：只在「这份工程与模板对不上」时给提示 */
const candidateSizeHint = computed(() => {
  const issue = designSizeIssue(candidateDesign.value)
  return issue && issue.kind === 'mismatch' ? issue.text : ''
})

/**
 * 「应用工程」按钮的状态。**原先这里是两个并排按钮**，但它们永远不会同时有效：
 *   尺寸一致   → 候选提示为空 → 第二个按钮不渲染，只有「应用工程」能用；
 *   尺寸不一致 → 两个都显示，但「应用工程」走 `matchSize=false`（不改尺寸），
 *                紧接着的校验必然失败——**可见、可点、点了必报错**，
 *                而报错内容正是旁边那个按钮主动帮用户做的事，是条死路。
 * 合成一个随状态自适应的按钮后，「能点的那个」永远只有一种语义，也就不存在
 * 「是不是重复了」的疑问。
 */
const applyDesignButton = computed(() => {
  const issue = designSizeIssue(candidateDesign.value)
  if (!candidateDesign.value) {
    return { text: '应用工程', match: false, disabled: true, title: '先在上面的下拉里选一份已保存工程' }
  }
  if (issue && issue.kind === 'grid') {
    // 模板自己的版式就放不下 2 个成品——改工程尺寸也救不了，得先修纸张/成品尺寸
    return { text: '应用工程', match: false, disabled: true, title: `${issue.text}，请先调整纸张或成品尺寸` }
  }
  if (issue) {
    return {
      text: '匹配工程尺寸并应用',
      match: true,
      disabled: false,
      title: '当前模板尺寸与这份工程不一致：点击会把模板的纸张/成品尺寸改成与工程一致，再挂上引用'
        + '（改尺寸不进撤销栈，失败会自动回滚）',
    }
  }
  return { text: '应用工程', match: false, disabled: false, title: '工程尺寸与模板一致，直接挂上引用' }
})

async function loadActiveDesign() {
  const token = ++designReadToken
  const ref = activeTpl.value?.backgroundDesign
  activeDesign.value = null
  if (!ref) return
  try {
    const doc = await window.printpress.getDesign(ref.id, ref.revision)
    if (token === designReadToken) activeDesign.value = doc
  } catch (err) {
    if (token === designReadToken) errorMsg.value = extractError(err)
  }
}
watch(() => activeTpl.value?.backgroundDesign
  ? `${activeTpl.value.backgroundDesign.id}:${activeTpl.value.backgroundDesign.revision}` : '', loadActiveDesign)

async function applyDesignReference(ref, matchSize = false) {
  const t = activeTpl.value
  if (!t) return
  const doc = await window.printpress.getDesign(ref.id, ref.revision)
  if (activeTpl.value !== t) return
  // 「匹配工程尺寸并应用」会改纸张或成品尺寸，而这些改动不进撤销栈。
  // 所以失败时必须原样回滚，否则用户会留下一个被悄悄改过、又没应用成功的尺寸。
  const sizeBefore = matchSize
    ? { pageSize: t.pageSize, layout: t.layout ? { ...t.layout } : undefined }
    : null
  try {
    if (matchSize) {
      if (isGrid.value) {
        ensureLayout()
        t.layout.itemW = doc.artboard.w
        t.layout.itemH = doc.artboard.h
      } else {
        t.pageSize = { id: 'custom', w: doc.artboard.w, h: doc.artboard.h * (isFold.value ? 2 : 1) }
      }
    }
    const issue = designSizeIssue(doc)
    if (issue) throw new Error(`${issue.text}，请调整尺寸后再应用`)
  } catch (err) {
    if (sizeBefore) {
      t.pageSize = sizeBefore.pageSize
      if (sizeBefore.layout === undefined) delete t.layout
      else t.layout = sizeBefore.layout
    }
    throw err
  }
  t.backgroundDesign = { id: doc.id, revision: doc.revision }
  // 旧图保留到用户主动移除：编辑器已经复制素材，不因切换草稿损坏已保存模板。
  t.background = ''
  t.bgSize = null
  activeDesign.value = doc
  bgSelected.value = false
  flash(`已应用「${doc.name}」v${doc.revision}，保存模板后用于打印`)
}

async function applySelectedDesign(matchSize = false) {
  if (!candidateDesign.value) return
  errorMsg.value = ''
  try {
    await applyDesignReference(candidateDesign.value, matchSize)
  } catch (err) { errorMsg.value = extractError(err) }
}

function editBackgroundDesign() {
  const t = activeTpl.value
  if (!t) return
  if (isGrid.value && !gridInfo.value?.ok) {
    errorMsg.value = '请先调整纸张或成品尺寸，让纸张至少容纳 2 个成品'
    return
  }
  openDesigner({
    templateKey: templateKey.value,
    designRef: t.backgroundDesign ? { ...t.backgroundDesign } : undefined,
    background: t.background || undefined,
    artboard: { ...outputItemSpec.value },
    name: `${t.name || '未命名模板'}底图`,
  })
  requestedDesignNonce = designerNav.request?.nonce
}

watch(() => designerNav.result, async (result) => {
  if (!result || result.templateKey !== templateKey.value || result.nonce !== requestedDesignNonce) return
  requestedDesignNonce = null
  if (result.canceled) return
  try {
    await applyDesignReference(result.designRef)
    designs.value = await window.printpress.listDesigns()
  } catch (err) { errorMsg.value = extractError(err) }
})

// 底图选中态：点底图选中它，再按 Delete 移除。
// 走「选中 → Delete」而不是「点一下就删」，是为了跟字段同一套心智——
// 底图铺满整张纸，单击即删的话，随手点一下空白处就会把图弄没。
const bgSelected = ref(false)

// ---- M4：多选 / 撤销重做 / 吸附辅助线 ----
const multiSel = ref(new Set())      // 多选集合（含 selectedIdx）
const undoStack = ref([])            // 字段快照栈（撤销）
const redoStack = ref([])            // 重做栈
const guideV = ref(null)             // 垂直辅助线（画布内 px 坐标）
const guideH = ref(null)             // 水平辅助线
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)
/** 一键布局可用：多选 ≥2 或画布全部字段 ≥2 */
const canLayout = computed(() => layoutTargets().length >= 2)

const pageSizeOptions = computed(() => {
  const sizes = window.__PAGE_SIZES__ || []
  const opts = sizes.map((p) => ({ value: p.id, label: p.name }))
  // 纸张始终是「类型操作」：预设纸型（A3/A4/A5/B5/A6 横竖）+ 自定义尺寸，二者自由组合
  opts.push({ value: 'custom', label: '自定义尺寸' })
  return opts
})

// 数据集下拉：已激活打印字段的表自动置顶（用户在数据页列头点过「印」的），
// 置顶组内按激活数降序——每次点印/取消都产生可见的位置变化，其余保持导入顺序
const datasetOptions = computed(() => {
  const ready = datasets.value.filter((d) => d.printCols > 0).sort((a, b) => b.printCols - a.printCols)
  const rest = datasets.value.filter((d) => !(d.printCols > 0))
  const label = (d) => (d.printCols > 0 ? `${d.name}（${d.printCols} 个打印字段）` : d.name)
  return [...ready, ...rest].map((d) => ({ value: d.id, label: label(d) }))
})

const fieldOptions = computed(() =>
  catalog.value
    .filter((c) => c.printOn === true) // 只显示用户在数据页列头显式激活的字段
    .map((c) => ({
      value: c.key,
      label: `${c.alias}（${c.fill}）`,
      disabled: c.fillRate === 0,
    })))

// 未激活字段数（提醒用户去数据页开启）
const hiddenFieldCount = computed(() =>
  catalog.value.filter((c) => c.printOn !== true).length)

const fontOptions = computed(() => [
  { value: '', label: '默认字体', group: '默认' },
  ...fonts.value.system.map((f) => ({ value: f.family, label: f.family, group: '系统字体' })),
  ...fonts.value.uploaded.map((f) => ({ value: f.family, label: f.family, group: '上传字体' })),
])

// PDF 会把上传字体内联为 @font-face；画布也必须加载同一字体，否则字宽不同会使预览位置看起来漂移。
let uploadedFontFaces = []
function syncUploadedFontFaces() {
  for (const face of uploadedFontFaces) document.fonts.delete(face)
  uploadedFontFaces = []
  for (const font of fonts.value.uploaded) {
    if (!font.cssFamily) continue
    try {
      const url = `pp://media/print-fonts/${encodeURIComponent(font.file)}`
      const face = new FontFace(font.cssFamily, `url("${url}")`)
      document.fonts.add(face)
      uploadedFontFaces.push(face)
    } catch (err) {
      console.warn(`[font] 注册失败 ${font.file}:`, err)
    }
  }
}

const selectedField = computed(() => {
  if (!activeTpl.value || selectedIdx.value < 0) return null
  return activeTpl.value.fields[selectedIdx.value] || null
})

// 选中字段的填充率徽标（从字段目录派生，不在画布重复计算）
const selectedFill = computed(() => {
  const f = selectedField.value
  if (!f) return null
  return catalog.value.find((c) => c.key === (f.column || f.key)) || null
})

const bgUrl = computed(() =>
  activeTpl.value && activeTpl.value.background
    ? `pp://media/${activeTpl.value.background}`
    : '')

// 底图比例应与「设计参照物」一致：单页对纸张、多联对单个成品、对折桌牌对半页成品
const bgRatioWarn = computed(() => {
  const t = activeTpl.value
  if (!t || !t.bgSize) return ''
  return computeBgRatioWarn(t.bgSize, outputItemSpec.value,
    outputTarget.value === '成品' ? 'grid' : outputTarget.value === '半页成品' ? 'fold' : 'single')
})

/**
 * 底图铺到成品上之后的有效输出分辨率。
 *
 * 「导出会吃清晰度」这个反馈，实测下来导出链路是逐像素无损的（PDF 里就是源图原始码流）；
 * 真正决定印出来清不清的是「底图像素 ÷ 成品尺寸」。这里把它算出来常驻显示，
 * 免得用户在「预览看着还行 → 打出来发虚」之间反复猜。
 */
const bgDpi = computed(() => {
  const t = activeTpl.value
  if (!t || !t.bgSize) return null
  return computeBgDpi(t.bgSize, outputItemSpec.value)
})

// 比例不一致 = 被拉伸（background-size:100% 100%），这是「看着被压缩了」的直接原因。
// 与「分辨率不够」是两回事：前者靠裁图/换纸解决，后者只能换更清晰的底图。
const bgStretched = computed(() => {
  const t = activeTpl.value
  if (!t || !t.bgSize) return false
  return computeBgRatioDeviation(t.bgSize, outputItemSpec.value).stretched
})

// 画布始终按**整张纸**缩放：多联时页面上要画出 M 列 × N 行格子，
// 整页统一缩放才能一眼看到真实拼版效果（字段位置与字号都随纸张比例走）
const canvasH = computed(() => {
  const t = activeTpl.value
  if (!t) return 540
  return (CANVAS_W * t.pageSize.h) / t.pageSize.w
})

function ptToPx(pt) {
  const t = activeTpl.value
  if (!t) return pt
  return ptToPxOf(pt, t.pageSize.w, CANVAS_W)
}

async function refreshLists() {
  templates.value = await window.printpress.listTemplates()
  fonts.value = await window.printpress.listFonts()
  syncUploadedFontFaces()
  datasets.value = await window.printpress.listDatasets()
  designs.value = await window.printpress.listDesigns()
}

function extractError(err) {
  return String(err && err.message ? err.message : err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * 成功提示的存活时长。与底图制作页的 MESSAGE_TTL 取同一个数（5000），
 * 两页行为一致；只作用于 `msg`，`errorMsg` 常驻由用户点「关闭」。
 */
const MESSAGE_TTL = 5000
let msgTimer = null
watch(msg, (value) => {
  clearTimeout(msgTimer)
  if (!value) return
  msgTimer = setTimeout(() => { msg.value = '' }, MESSAGE_TTL)
})

function flash(text) {
  msg.value = text // 自动消失交给上面的 watch（每次变化都重置计时）
}

/**
 * 状态条带是否有内容。没有就整块不渲染——否则会留一个空边框盒子。
 * 与条带里各 `<p>` 的 v-if 一一对应，改一处要同步另一处。
 */
const showStatusBand = computed(() => Boolean(
  activeDesign.value
  || designSizeWarning.value
  || candidateSizeHint.value
  || !activeDatasetId.value
  || (activeDatasetId.value && hiddenFieldCount.value)
  || gridInfo.value
  || foldInfo.value
  || bgRatioWarn.value
  || bgDpi.value,
))

function newTemplate() {
  errorMsg.value = '' // 切换编辑对象前清掉上一次的报错，避免提示张冠李戴
  msg.value = ''
  templateKey.value = `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
  activeTpl.value = {
    name: '未命名模板',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    background: '',
    bgSize: null,
    datasetId: '',
    fields: [],
    // 版式：默认单页；切到多联后画布变成「单个成品」，成品尺寸决定每页排几列几行
    layout: { mode: 'single', itemW: 85, itemH: 54, showCutMarks: true },
  }
  selectedIdx.value = -1
  multiSel.value = new Set()
  bgSelected.value = false
  undoStack.value = []
  redoStack.value = []
  activeDatasetId.value = ''
  catalog.value = []
  sampleRow.value = null
}

async function openTemplate(id) {
  try {
    errorMsg.value = '' // 换模板即清掉旧报错——错误属于上一个模板，不该跟过来
    msg.value = ''
    activeTpl.value = await window.printpress.getTemplate(id)
    templateKey.value = id
    ensureLayout() // 旧模板没有 layout 字段：补默认单页，避免下游读到 undefined
    selectedIdx.value = -1
    multiSel.value = new Set()
    bgSelected.value = false
    undoStack.value = []
    redoStack.value = []
    // 绑定的数据集已被删除：目录加载必然失败，提前给用户可读的出路提示
    if (activeTpl.value.datasetId && !datasets.value.some((d) => d.id === activeTpl.value.datasetId)) {
      activeDatasetId.value = ''
      catalog.value = []
      sampleRow.value = null
      errorMsg.value = '该模板关联的数据集已被删除：请重新选择数据集，并删除画布上的失效字段后保存'
      return
    }
    if (activeTpl.value.datasetId) {
      activeDatasetId.value = activeTpl.value.datasetId
      await loadCatalog(activeDatasetId.value)
    } else {
      activeDatasetId.value = ''
      catalog.value = []
      sampleRow.value = null
    }
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

let catalogReadToken = 0
async function loadCatalog(dsId) {
  const token = ++catalogReadToken
  catalog.value = []
  sampleRow.value = null
  if (!dsId) return
  try {
    const [fields, ds] = await Promise.all([
      window.printpress.fieldCatalog(dsId), window.printpress.getDataset(dsId),
    ])
    if (token !== catalogReadToken || dsId !== activeDatasetId.value) return
    catalog.value = fields
    sampleRow.value = ds.rows.find((r) => Object.values(r).some((v) => String(v).trim())) || ds.rows[0] || null
  } catch (err) {
    if (token === catalogReadToken && dsId === activeDatasetId.value) errorMsg.value = extractError(err)
  }
}

watch(activeDatasetId, (id) => {
  if (activeTpl.value) activeTpl.value.datasetId = id
  loadCatalog(id)
})

function onPageSizeChange(id) {
  const t = activeTpl.value
  if (!t) return
  if (id === 'custom') {
    // 选「自定义尺寸」：保留当前宽高，等待用户在毫米输入框中自由填写
    t.pageSize = { id: 'custom', w: Number(t.pageSize?.w) || 210, h: Number(t.pageSize?.h) || 297 }
    return
  }
  const hit = (window.__PAGE_SIZES__ || []).find((p) => p.id === id)
  if (hit) t.pageSize = { id: hit.id, w: hit.w, h: hit.h }
}

// 纸张自定义尺寸（毫米自由输入）：与成品尺寸对称，两个维度都能任意匹配
function onPageDim(which, val) {
  const t = activeTpl.value
  if (!t) return
  const n = clampPageDim(val)
  t.pageSize = {
    id: 'custom',
    w: which === 'w' ? n : Number(t.pageSize?.w) || 210,
    h: which === 'h' ? n : Number(t.pageSize?.h) || 297,
  }
}

/**
 * 丢弃一张底图文件。规则由主进程统一执行：只要还有**已保存**的模板引用它就不动，
 * 否则直接删掉。换图 / 删图共用这一条，print-bg 才不会越攒越多。
 */
async function discardBackgroundFile(bgPath) {
  if (!bgPath) return
  try {
    await window.printpress.discardBackground({ assetId: bgPath })
  } catch (err) {
    // 清理失败不该挡住正在做的事（元数据已经改好了），留个痕即可
    console.warn('[bg] 旧底图清理失败', err)
  }
}

/** 三条入口（对话框 / 拖拽 / 粘贴）共用：把上传结果落到当前模板上 */
async function applyBackgroundResult(result) {
  const t = activeTpl.value
  if (!t) return
  const prev = t.background
  delete t.backgroundDesign
  t.background = result.background
  t.bgSize = { width: result.width, height: result.height }
  bgSelected.value = false
  // 换底图 = 先把旧图按「不再被引用就删」的规则处理掉
  if (prev && prev !== result.background) await discardBackgroundFile(prev)
  if (result.suggest.matched) {
    t.pageSize = { id: result.suggest.page.id, w: result.suggest.page.w, h: result.suggest.page.h }
    flash(`底图已上传，纸张匹配为${result.suggest.page.name}`)
  } else {
    t.pageSize = { id: 'custom', w: result.suggest.page.w, h: result.suggest.page.h }
    flash('底图已上传，非标准比例，按像素换算为自定义纸张')
  }
}

/** 点底图 = 选中它（属性面板切到底图信息，按 Delete 即可移除） */
function selectBackground() {
  const t = activeTpl.value
  if (!t || !hasBackground.value) return
  bgSelected.value = true
  selectedIdx.value = -1
  multiSel.value = new Set()
}

/**
 * 移除底图：清掉引用 + 把文件删掉，与「换底图」是同一条逻辑，只是没有新图顶上来。
 * 因此底图不进撤销栈——撤销回来也只会是一张指向已删文件的破图，重传一次更省事。
 */
async function removeBackground() {
  const t = activeTpl.value
  if (!t || !hasBackground.value) return
  const prev = t.background
  delete t.backgroundDesign
  t.background = ''
  t.bgSize = null
  bgSelected.value = false
  await discardBackgroundFile(prev)
  flash('底图已移除——点画布中央可重新上传')
}

/**
 * 底图加载失败的兜底。
 *
 * 两种情况会走到这里：文件被外部删掉；或者「换了图 / 删了图但没保存就切走」，
 * 磁盘上那条模板记录还留着指向已删文件的引用。
 * 不管哪种，把引用清掉并说明原因，别把一张破图留在画布上。
 */
function onBgError() {
  const t = activeTpl.value
  if (!t || !t.background) return
  t.background = ''
  t.bgSize = null
  bgSelected.value = false
  errorMsg.value = '底图文件已不存在，已清除引用——请重新上传'
}

async function uploadBackground() {
  if (!activeTpl.value) return
  errorMsg.value = ''
  try {
    const result = await window.printpress.uploadBackgroundDialog()
    if (result.canceled) return
    await applyBackgroundResult(result)
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

// ---- 拖拽 / 粘贴上传底图 ----
/**
 * 拖拽与剪贴板里的图片只有内存字节、没有文件路径（截图尤其如此），
 * 所以统一读成 base64 走 template:uploadBackgroundBytes。
 * 真实格式由主进程按内容嗅探决定——前端给的文件名后缀不可信，只当归档命名用。
 */
const MAX_BG_BYTES = 20 * 1024 * 1024
const IMAGE_LIKE = /\.(png|jpe?g)$/i

const dragging = ref(false)
// dragenter / dragleave 会在子元素间冒泡，用进出计数避免高亮闪烁
let dragDepth = 0

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

async function acceptImageFile(file) {
  if (!activeTpl.value || !file) return
  // 部分拖拽源不带 type，此时退回按文件名判断；最终仍由主进程按内容定夺
  const looksImage = file.type
    ? file.type === 'image/png' || file.type === 'image/jpeg'
    : !file.name || IMAGE_LIKE.test(file.name)
  if (!looksImage) {
    errorMsg.value = '只能上传 PNG / JPEG 图片'
    return
  }
  if (file.size > MAX_BG_BYTES) {
    errorMsg.value = `图片超过 ${MAX_BG_BYTES / 1024 / 1024}MB，请先压缩后再上传`
    return
  }
  errorMsg.value = ''
  try {
    const dataBase64 = await fileToBase64(file)
    const result = await window.printpress.uploadBackgroundBytes({
      dataBase64,
      fileName: file.name || '',
    })
    await applyBackgroundResult(result)
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

function onDragEnter() {
  if (!activeTpl.value) return
  dragDepth += 1
  dragging.value = true
}

function onDragOver(e) {
  if (!activeTpl.value) return
  e.preventDefault() // 不阻止默认行为的话，浏览器会直接把这个文件打开
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(e) {
  if (!activeTpl.value) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  const dt = e.dataTransfer
  const file = dt && dt.files && dt.files.length ? dt.files[0] : null
  if (file) {
    acceptImageFile(file)
    return
  }
  // 从网页里拖图只有 URL、没有文件内容，暂不支持（也避免去下载外链资源）
  errorMsg.value = '请把图片文件直接拖进来（暂不支持拖入网页图片链接）'
}

function onPaste(e) {
  if (!activeTpl.value) return
  const items = e.clipboardData && e.clipboardData.items
  if (!items) return
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    e.preventDefault()
    acceptImageFile(file)
    return
  }
}

// ---- 撤销 / 重做：字段布局快照栈（纯逻辑在 src/lib/field-edit.cjs） ----
// 快照必须含 layout（成品尺寸、裁切线也是模板的一部分）；底图**故意不进快照**——
// 换图 / 删图都会把旧图文件真正删掉，撤销回来只会是张破图。理由详见 field-edit.cjs。
function pushUndo() {
  if (!activeTpl.value) return
  const snap = snapshotOf(activeTpl.value)
  // 去重与封顶：连续触发（focus/pointerdown 叠加）且状态未变时不重复入栈
  if (!pushCapped(undoStack.value, snap)) return
  redoStack.value = []
}

function restoreSnapshot(json) {
  if (!activeTpl.value) return
  const { fields, layout } = parseSnapshot(json)
  activeTpl.value.fields = fields
  if (layout) activeTpl.value.layout = layout
  if (selectedIdx.value >= activeTpl.value.fields.length) {
    selectedIdx.value = activeTpl.value.fields.length - 1
  }
  multiSel.value = new Set(
    [...multiSel.value].filter((i) => i < activeTpl.value.fields.length),
  )
}

function undo() {
  if (!undoStack.value.length) return
  redoStack.value.push(snapshotOf(activeTpl.value))
  restoreSnapshot(undoStack.value.pop())
}

function redo() {
  if (!redoStack.value.length) return
  undoStack.value.push(snapshotOf(activeTpl.value))
  restoreSnapshot(redoStack.value.pop())
}

function addField(key) {
  const t = activeTpl.value
  if (!t || !key) return
  pushUndo()
  const col = catalog.value.find((c) => c.key === key)
  t.fields.push({
    column: key, // 权威属性：渲染引擎与打印校验读 column
    label: col ? col.alias : key,
    x: 40,
    y: 40,
    fontSize: 24,
    color: '#2b2622',
    align: 'center',
    bold: false,
    fontFamily: '',
  })
  selectedIdx.value = t.fields.length - 1
  multiSel.value = new Set([selectedIdx.value])
}

function removeField() {
  const t = activeTpl.value
  if (!t || selectedIdx.value < 0) return
  pushUndo()
  const victims = multiSel.value.size > 1 ? [...multiSel.value].sort((a, b) => b - a) : [selectedIdx.value]
  for (const i of victims) t.fields.splice(i, 1)
  selectedIdx.value = -1
  multiSel.value = new Set()
}

/**
 * 字段锚点比例来自 field-layout.cjs（与渲染引擎同一口径）：align=center 时锚点在盒中心
 * （出片 translateX(-50%)，画布同样位移），right 在右缘，left 在左缘。
 * 盒左缘 = x% - ratio × 盒宽 —— 拖拽 / 吸附 / 对齐换算都要过这个函数。
 * v0.2.3 前画布缺这段位移，导致「画布看着居中、出片偏左半个身位」。
 */
function fieldStyle(f) {
  const shift = anchorRatio(f)
  const family = fonts.value.uploaded.find((font) => font.family === f.fontFamily)?.cssFamily || f.fontFamily
  return {
    left: `${f.x}%`,
    top: `${f.y}%`,
    transform: shift ? `translateX(-${shift * 100}%)` : 'none',
    fontSize: `${ptToPx(f.fontSize)}px`,
    color: f.color,
    fontFamily: family ? JSON.stringify(family) : 'inherit',
    fontWeight: f.bold ? 700 : 400,
    textAlign: f.align,
  }
}

function fieldText(f) {
  const v = sampleRow.value ? String(sampleRow.value[f.column || f.key] || '').trim() : ''
  return v || f.label
}

function fieldEmpty(f) {
  return !sampleRow.value || !String(sampleRow.value[f.column || f.key] || '').trim()
}

// 失效字段：模板字段的列在当前数据集中不存在（如旧模板残留字段）——画布标红，定位打印中心「字段不匹配」警告的来源
function fieldMissing(f) {
  if (!catalog.value.length) return false
  const col = f.column || f.key
  return Boolean(col) && !catalog.value.some((c) => c.key === col)
}

function onFieldPointerDown(e, idx) {
  bgSelected.value = false // 摸到字段即取消底图选中态（两者互斥）
  // Ctrl/Shift 点击：切换多选成员；普通点击：单选
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    const next = new Set(multiSel.value)
    if (next.has(idx) && next.size > 1) next.delete(idx)
    else next.add(idx)
    multiSel.value = next
  } else {
    multiSel.value = new Set([idx])
  }
  selectedIdx.value = idx

  // 定位参照系：多联时是「被抓住的那一格」（字段坐标本就相对格子），
  // 对折桌牌是下半联（编辑联），单页时是整张画布。
  // 吸附目标也只取同一参照系内的字段——否则会把别的格子里的同名字段当成对齐基准。
  const cellEl = e.currentTarget && e.currentTarget.closest
    ? e.currentTarget.closest('.canvas-cell, .fold-ref')
    : null
  if (cellEl && canvasEl.value) {
    const all = [...canvasEl.value.querySelectorAll('.canvas-cell')]
    activeCellIdx.value = Math.max(0, all.indexOf(cellEl))
  }
  const refEl = cellEl || canvasEl.value
  const rect = refEl.getBoundingClientRect()
  const f = activeTpl.value.fields[idx]
  pushUndo()

  // 拖拽起点：抓取偏移 + 多选成员初始坐标 + 自身盒子尺寸 + 吸附目标
  const starts = [...multiSel.value].map((i) => ({ i, x: activeTpl.value.fields[i].x, y: activeTpl.value.fields[i].y }))
  const ownEl = refEl.querySelectorAll('.field-box')[idx]
  const ownRect = ownEl ? ownEl.getBoundingClientRect() : rect
  const boxW = ownRect.width
  const boxH = ownRect.height
  // grabX = 指针相对参照系原点的偏移 − 锚点当前px。反解 rawX = (clientX − rect.left − grabX)/W×100
  // 恰好给出「新锚点」。锚点语义由 fieldStyle 的 translateX(-r×盒宽) 承担，这里不再补偿——
  // 若在此多加 boxW×ratio，反解出的锚点会在按下瞬间左跳半个盒宽，
  // 且 onPointerMove 的吸附边缘随之整体错位（吸附命中后字段停在线旁半个盒宽）。
  const targetsV = [rect.width / 2]
  const targetsH = [rect.height / 2]
  refEl.querySelectorAll('.field-box').forEach((el, i) => {
    if (multiSel.value.has(i)) return
    const r = el.getBoundingClientRect()
    targetsV.push(r.left - rect.left, r.left - rect.left + r.width / 2, r.right - rect.left)
    targetsH.push(r.top - rect.top, r.top - rect.top + r.height / 2, r.bottom - rect.top)
  })

  dragState.value = {
    idx,
    grabX: e.clientX - rect.left - (f.x / 100) * rect.width,
    grabY: e.clientY - rect.top - (f.y / 100) * rect.height,
    rect,
    starts,
    boxW,
    boxH,
    ratio: anchorRatio(f),
    targetsV,
    targetsH,
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(e) {
  if (!dragState.value || !canvasEl.value) return
  const d = dragState.value
  const rawX = ((e.clientX - d.rect.left - d.grabX) / d.rect.width) * 100
  const rawY = ((e.clientY - d.rect.top - d.grabY) / d.rect.height) * 100
  const f = activeTpl.value.fields[d.idx]

  // 顺序很关键：先算出吸附后的最终值，再统一摆位。
  // 原来是多选成员先按未吸附的 dx 摆好、主字段随后被额外推开——整组会撕裂一帧，
  // 下一帧才整体跳到位；主字段贴到吸附线时看起来像「只有它自己吸过去了」。
  // 吸附检测以主拖拽字段为准。三个自身边缘都要换算到「锚点 - 边缘 = 偏移」的口径：
  // 盒左缘 = 锚点px - ratio×盒宽，故 pxX(f.x) 是锚点线，盒左/中/右需各自减去对应偏移
  const own = d.starts.find((s) => s.i === d.idx)
  const pxX = (v) => (v / 100) * d.rect.width
  const pxY = (v) => (v / 100) * d.rect.height
  const off = d.ratio * d.boxW
  const snapV = snapTo(
    [[pxX(clampPct(rawX)) - off, 'l'], [pxX(clampPct(rawX)) - off + d.boxW / 2, 'c'], [pxX(clampPct(rawX)) - off + d.boxW, 'r']],
    d.targetsV,
  )
  const snapH = snapTo(
    [[pxY(clampPct(rawY)), 't'], [pxY(clampPct(rawY)) + d.boxH / 2, 'm'], [pxY(clampPct(rawY)) + d.boxH, 'b']],
    d.targetsH,
  )
  f.x = snapV ? clampPct(rawX + (snapV.adjust / d.rect.width) * 100) : clampPct(rawX)
  f.y = snapH ? clampPct(rawY + (snapH.adjust / d.rect.height) * 100) : clampPct(rawY)

  // 多选：全体成员跟随同一位移（用的是已吸附的主字段位置，整组不再撕裂）
  if (d.starts.length > 1) {
    const dx = f.x - own.x
    const dy = f.y - own.y
    for (const s of d.starts) {
      if (s.i === d.idx) continue
      const m = activeTpl.value.fields[s.i]
      m.x = clampPct(s.x + dx)
      m.y = clampPct(s.y + dy)
    }
  }

  // 辅助线用「画布坐标系」定位：多联时参照格有原点偏移，要加上去，否则线会画错位置
  const cRect = canvasEl.value.getBoundingClientRect()
  const offX = d.rect.left - cRect.left
  const offY = d.rect.top - cRect.top
  guideV.value = snapV ? offX + snapV.line : null
  guideH.value = snapH ? offY + snapH.line : null
}

function onPointerUp() {
  dragState.value = null
  guideV.value = null
  guideH.value = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}

// ---- 多选对齐：以选中盒子的实际包围盒为基准 ----
function measureSelected() {
  const ref = refFrameEl()
  const els = ref.querySelectorAll('.field-box')
  return [...multiSel.value]
    .filter((i) => els[i])
    .map((i) => {
      const r = els[i].getBoundingClientRect()
      const c = ref.getBoundingClientRect()
      return { i, left: r.left - c.left, top: r.top - c.top, w: r.width, h: r.height }
    })
}

function alignSelected(kind) {
  if (!activeTpl.value || multiSel.value.size < 2 || !canvasEl.value) return
  pushUndo()
  const boxes = measureSelected()
  if (!boxes.length) return
  const bounds = {
    minLeft: Math.min(...boxes.map((b) => b.left)),
    maxRight: Math.max(...boxes.map((b) => b.left + b.w)),
    minTop: Math.min(...boxes.map((b) => b.top)),
    maxBottom: Math.max(...boxes.map((b) => b.top + b.h)),
  }
  // 换算基准同样用参照格，保证多联下对齐结果是「格内坐标」
  const refRect = refFrameEl().getBoundingClientRect()
  const W = refRect.width
  const H = refRect.height
  for (const b of boxes) {
    const f = activeTpl.value.fields[b.i]
    // 对齐目标是一个像素位置，f.x、f.y 是锚点，写入前必须换算——
    // 漏掉换算会让非居中字段整体偏 (0.5−r)×盒宽，之后吸附起点随之错位
    // （表现为「辅助线不灵敏、拖半天对不齐」）。推导见 lib/field-edit.cjs 的 alignedX/alignedY。
    const r = anchorRatio(f)
    const nx = alignedX(kind, b, bounds, W, r)
    if (nx !== null) f.x = nx
    const ny = alignedY(kind, b, bounds, H)
    if (ny !== null) f.y = ny
  }
}

// ---- 一键布局：均分横排（锚点百分比语义，与渲染引擎一致）----
// 目标：多选 ≥2 时作用于选中字段，否则作用于画布全部字段（新模板起步一键铺开）
function layoutTargets() {
  const t = activeTpl.value
  if (!t) return []
  return multiSel.value.size > 1
    ? [...multiSel.value].map((i) => t.fields[i]).filter(Boolean)
    : t.fields
}

function applyEvenRow() {
  const targets = layoutTargets()
  if (targets.length < 2) return
  pushUndo()
  const plan = evenRow(targets)
  targets.forEach((f, j) => { f.x = plan[j].x; f.y = plan[j].y })
  flash(`已均分横排 ${targets.length} 个字段`)
}

// ---- 键盘：方向键微调（0.1%，Shift 1%）、Delete 删除选中项（字段 / 底图）、Ctrl+Z/Y 撤销重做 ----

/**
 * 连续键盘微调只记一次撤销。
 *
 * 原来每次 keydown 都 pushUndo，而 clamp 保留 1 位小数故每步都是唯一值，
 * 去重永远不命中——按住方向键 1.3 秒就把 50 级撤销栈冲光，
 * 之后想退回改动前就只剩「重新做一遍」。
 * 合并口径见 lib/field-edit.cjs 的 shouldStartNewNudge（距上次超过 800ms 才算新一段操作）。
 */
let lastNudgeAt = 0

function pushUndoForNudge() {
  const now = Date.now()
  if (shouldStartNewNudge(now, lastNudgeAt)) pushUndo()
  lastNudgeAt = now
}

function onKeydown(e) {
  const tag = (e.target && e.target.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  // 模态开着时一律不响应全局快捷键：确认弹窗上按 Delete 会把字段删掉，
  // 而弹窗问的正是「要不要删」——用户看着问号，字段已经没了。
  if (pendingConfirm.value) return
  if (!activeTpl.value) return

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
  if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
    || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); return }

  // 底图选中时 Delete 删底图。这一条必须排在 targets 判空**之前**：
  // 选中底图时 selectedIdx 是 -1，targets 为空，会被下面的提前 return 吃掉。
  if (bgSelected.value && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault()
    removeBackground()
    return
  }

  const targets = multiSel.value.size > 0 ? [...multiSel.value] : (selectedIdx.value >= 0 ? [selectedIdx.value] : [])
  if (!targets.length) return

  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeField(); return }

  const step = e.shiftKey ? 1 : 0.1
  let dx = 0
  let dy = 0
  if (e.key === 'ArrowLeft') dx = -step
  else if (e.key === 'ArrowRight') dx = step
  else if (e.key === 'ArrowUp') dy = -step
  else if (e.key === 'ArrowDown') dy = step
  else return
  e.preventDefault()
  pushUndoForNudge()
  for (const i of targets) {
    const f = activeTpl.value.fields[i]
    if (!f) continue
    f.x = clampPct(f.x + dx)
    f.y = clampPct(f.y + dy)
  }
}

async function saveTemplate() {
  if (!activeTpl.value) return
  errorMsg.value = ''
  if (designSizeWarning.value) {
    errorMsg.value = `${designSizeWarning.value}，请调整尺寸后保存`
    return
  }
  if (!activeDatasetId.value) {
    errorMsg.value = '模板必须关联数据集：请先在工具栏选择数据集，再保存'
    return
  }
  try {
    const payload = JSON.parse(JSON.stringify(activeTpl.value))
    payload.datasetId = activeDatasetId.value // 模板 × 数据集绑定：打印中心按模板直接带出
    const saved = await window.printpress.saveTemplate(payload)
    activeTpl.value = saved
    await refreshLists()
    flash('模板已保存')
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

// ---- 危险操作确认（应用内统一弹窗，替代原生 confirm） ----
const pendingConfirm = ref(null)

function onConfirmConfirmed() {
  const c = pendingConfirm.value
  pendingConfirm.value = null
  if (c) c.action()
}

async function removeTemplate() {
  const t = activeTpl.value
  if (!t || !t.id) { activeTpl.value = null; return }
  pendingConfirm.value = {
    message: `确定删除模板「${t.name}」？\n该操作不可恢复。`,
    action: async () => {
      try {
        await window.printpress.deleteTemplate(t.id)
        activeTpl.value = null
        selectedIdx.value = -1
        await refreshLists()
        flash('模板已删除')
      } catch (err) {
        errorMsg.value = extractError(err)
      }
    },
  }
}

async function uploadFont() {
  errorMsg.value = ''
  try {
    const result = await window.printpress.uploadFontDialog()
    if (result.canceled) return
    fonts.value = await window.printpress.listFonts()
    syncUploadedFontFaces()
    flash(`字体「${result.family}」已上传`)
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

async function removeFont(file) {
  const family = file.replace(/\.[^.]+$/, '')
  pendingConfirm.value = {
    message: `确定删除字体「${family}」？`,
    action: async () => {
      errorMsg.value = ''
      try {
        await window.printpress.deleteFont(file)
        fonts.value = await window.printpress.listFonts()
        syncUploadedFontFaces()
      } catch (err) {
        errorMsg.value = extractError(err)
      }
    },
  }
}

let viewMounted = false
let viewActive = true
function bindTemplateEvents() {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('paste', onPaste)
}
function unbindTemplateEvents() {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  dragState.value = null
  guideV.value = null
  guideH.value = null
  dragging.value = false
  dragDepth = 0
}
onActivated(() => {
  viewActive = true
  bindTemplateEvents()
  if (viewMounted) {
    refreshLists().then(() => {
      // KeepAlive 保留排版草稿，数据页改过的打印字段和样例仍需重新读取。
      return Promise.all([
        activeDatasetId.value ? loadCatalog(activeDatasetId.value) : Promise.resolve(),
        activeTpl.value?.backgroundDesign ? loadActiveDesign() : Promise.resolve(),
      ])
    }).catch((err) => { errorMsg.value = extractError(err) })
  }
})
onDeactivated(() => {
  viewActive = false
  unbindTemplateEvents()
})

onMounted(async () => {
  // 纸张与成品尺寸常量由主进程下发（单一权威定义源）
  try {
    const env = await window.printpress.getEnv()
    window.__PAGE_SIZES__ = env.pageSizes || []
    ITEM_SIZE_PRESETS.value = env.itemSizes || []
  } catch {
    window.__PAGE_SIZES__ = []
    ITEM_SIZE_PRESETS.value = []
  }
  if (viewActive) bindTemplateEvents()
  try { await refreshLists() } catch (err) { errorMsg.value = extractError(err) }
  viewMounted = true
})

onBeforeUnmount(() => {
  viewActive = false
  for (const face of uploadedFontFaces) document.fonts.delete(face)
  uploadedFontFaces = []
  unbindTemplateEvents()
})
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h2 class="page-title">模板工坊</h2>
      <div class="head-actions">
        <button class="btn-primary" @click="newTemplate">新建模板</button>
      </div>
    </div>

    <!--
      提示条：原先挤在 page-head 右侧当 12px 小字，而操作点在下方工具栏/画布上，
      视线要来回跳。搬成整条带底色的横条（对齐底图制作页的 `.notice`）。
      error 优先于 success 显示；success 5 秒自动消失，error 常驻并给「关闭」——
      报错往往要用户对照着改，自动消失会把依据一起带走。
    -->
    <div v-if="errorMsg" class="notice error" role="alert">
      {{ errorMsg }}<button class="notice-close" @click="errorMsg = ''">关闭</button>
    </div>
    <div v-else-if="msg" class="notice success" role="status">{{ msg }}</div>

    <div class="layout">
      <aside class="side">
        <h3 class="side-title">模板</h3>
        <div class="tpl-list">
          <button
            v-for="t in templates"
            :key="t.id"
            class="tpl-item"
            :class="{ active: activeTpl && activeTpl.id === t.id }"
            @click="openTemplate(t.id)"
          >
            <span class="tpl-name">{{ t.name }}</span>
            <span class="tpl-meta">{{ t.fieldCount }} 个字段{{ t.hasBackground ? ' · 有底图' : '' }}</span>
          </button>
          <p v-if="templates.length === 0" class="side-empty">还没有模板</p>
        </div>

        <h3 class="side-title">字体管理</h3>
        <div class="font-panel">
          <div class="font-actions">
            <button class="btn-ghost" @click="uploadFont">上传字体</button>
            <a
              class="btn-ghost font-download"
              href="https://www.maoken.com/"
              target="_blank"
              rel="noopener noreferrer"
              title="猫啃网：国内收录最全的免费商用中文字体站（800+ 款，授权清晰），下载 ttf/otf 后点「上传字体」装入"
            >下载字体</a>
          </div>
          <div class="font-list">
            <div v-for="f in fonts.system" :key="'s-' + f.family" class="font-row">
              <span class="font-name">{{ f.family }}</span>
              <span class="font-tag">系统</span>
            </div>
            <div v-for="f in fonts.uploaded" :key="'u-' + f.file" class="font-row">
              <span class="font-name">{{ f.family }}</span>
              <button class="font-del" title="删除字体" @click="removeFont(f.file)">删除</button>
            </div>
          </div>
        </div>
      </aside>

      <div v-if="!activeTpl" class="editor-empty">
        <p class="hint-main">新建或打开一个模板开始排版</p>
        <p class="hint-sub">上传底图 → 选数据集 → 摆放字段 → 保存</p>
      </div>

      <div v-else class="editor">
        <!--
          工具栏分两行（.tb-row）。此前是一条 flex-wrap 长龙：多联态下 17 个控件随机折行，
          把「保存 / 删除」甩到第二行左边、「撤销 / 重做」留在第一行末尾——同一个操作组被劈成两半。
          按语义分行后折行位置不再随机。**DOM 顺序必须保持**：`.toolbar .custom-select` 的
          首个元素是「纸张」下拉，多处 e2e 直接点它，换序会静默选错下拉。
          第 1 行 = 模板与版式属性；第 2 行 = 数据集与操作。
        -->
        <div class="toolbar">
          <div class="tb-row">
          <input v-model="activeTpl.name" class="name-input" placeholder="模板名称" />
          <span class="tb-label">纸张</span>
          <CustomSelect
            :model-value="activeTpl.pageSize.id"
            :options="pageSizeOptions"
            width="130px"
            @change="onPageSizeChange"
          />
          <template v-if="activeTpl.pageSize.id === 'custom'">
            <input
              class="item-input"
              type="number"
              min="10"
              max="2000"
              :value="activeTpl.pageSize.w"
              title="纸张宽度（mm）"
              @change="onPageDim('w', $event.target.value)"
            />
            <span class="tb-unit">×</span>
            <input
              class="item-input"
              type="number"
              min="10"
              max="2000"
              :value="activeTpl.pageSize.h"
              title="纸张高度（mm）"
              @change="onPageDim('h', $event.target.value)"
            />
            <span class="tb-unit">mm</span>
          </template>
          <!-- 版式：单页 = 一记录一页；多联 = 一页排多个成品（画布切换为单个成品） -->
          <CustomSelect
            :model-value="layoutMode"
            :options="layoutOptions"
            width="96px"
            @change="onLayoutModeChange"
          />
          <template v-if="layoutMode === 'grid'">
            <span class="tb-label">成品</span>
            <CustomSelect
              :model-value="itemSizeId"
              :options="itemSizeOptions"
              width="150px"
              @change="onItemSizeChange"
            />
            <input
              class="item-input"
              type="number"
              min="5"
              max="500"
              :value="itemSpec.w"
              title="成品宽度（mm）"
              @change="onItemDim('w', $event.target.value)"
            />
            <span class="tb-unit">×</span>
            <input
              class="item-input"
              type="number"
              min="5"
              max="500"
              :value="itemSpec.h"
              title="成品高度（mm）"
              @change="onItemDim('h', $event.target.value)"
            />
            <span class="tb-unit">mm</span>
            <label class="cut-toggle" title="在格子边缘画 0.2mm 虚线，便于手工裁切">
              <input
                type="checkbox"
                :checked="activeTpl.layout.showCutMarks !== false"
                @change="onCutMarks($event.target.checked)"
              />
              裁切线
            </label>
          </template>
          </div>
          <div class="tb-row tb-row-actions">
          <CustomSelect
            v-model="activeDatasetId"
            :options="datasetOptions"
            placeholder="选择数据集"
            width="150px"
          />
          <button class="btn-ghost btn-icon" :disabled="!canUndo" title="撤销（Ctrl+Z）" @click="undo">撤销</button>
          <button class="btn-ghost btn-icon" :disabled="!canRedo" title="重做（Ctrl+Y）" @click="redo">重做</button>
          <button class="btn-ghost" :disabled="!canLayout" title="所选字段（未多选时为全部字段）按 x 顺序等距排成一行，y 取中位数" @click="applyEvenRow">均分横排</button>
          <button class="btn-primary" @click="saveTemplate">保存</button>
          <button class="btn-danger" @click="removeTemplate">删除</button>
          </div>
        </div>

        <div class="design-toolbar">
          <span class="tb-label">图层底图</span>
          <CustomSelect v-model="selectedDesignId" :options="designOptions" width="290px" placeholder="选择已保存工程" />
          <button
            data-testid="tpl-apply-design"
            class="btn-ghost"
            :disabled="applyDesignButton.disabled"
            :title="applyDesignButton.title"
            @click="applySelectedDesign(applyDesignButton.match)"
          >{{ applyDesignButton.text }}</button>
          <button class="btn-ghost" @click="editBackgroundDesign">{{ activeTpl.backgroundDesign ? '编辑底图工程' : bgUrl ? '将底图转为图层编辑' : '制作新底图' }}</button>
          <button v-if="hasBackground" class="btn-ghost" @click="uploadBackground">更换为图片</button>
          <button v-if="activeTpl.backgroundDesign" class="btn-ghost" @click="removeBackground">移除工程底图</button>
        </div>

        <!--
          状态条带：把原先散落的 4–8 行裸 `.warn-line` 收进一个有边框底色的容器里。
          此前它们夹在工具栏与字段面板之间，视觉上像工具栏「漏出来的几行」。
          **`.warn-line` 类名不改**：`bg-fidelity.cjs` 的静态守卫、`e2e-grid`、`design-e2e`
          都把它当锚点（改名要连带改 4 处断言，风险大于收益）。它现在读作「状态行」，
          真正的警告由 `warn-strong` 修饰类加色。
        -->
        <div v-if="showStatusBand" class="status-band">
        <p v-if="activeDesign" class="warn-line">
          底图工程：{{ activeDesign.name }} · 固定版本 v{{ activeDesign.revision }} · {{ activeDesign.artboard.w }}×{{ activeDesign.artboard.h }}mm
        </p>
        <!--
          候选工程提示必须排在「底图工程」那行**之后**：design-e2e.cjs 用
          `document.querySelector('.warn-line')` 取**第一个**并要求它是「底图工程」行。
          此前这个提示只被当作「显示第二个按钮」的开关，文案从不显示——用户选了尺寸
          不匹配的工程，界面只说「多出一个按钮」，不告诉他差在哪。
        -->
        <p v-if="candidateSizeHint" class="warn-line warn-strong">选中的工程{{ candidateSizeHint }}</p>
        <p v-if="designSizeWarning" class="warn-line warn-strong">{{ designSizeWarning }}，请调整工程或成品尺寸后保存</p>
        <p v-if="!activeDatasetId" class="warn-line">先选择数据集，字段面板和真实数据预览才会出现</p>
        <p v-if="activeDatasetId && hiddenFieldCount" class="warn-line">
          {{ hiddenFieldCount }} 个字段未启用打印（数据表格列头点「印」可开启）
        </p>
        <!-- 多联版式摘要：明确告诉用户「现在设计的是单个成品、每页能排几个」 -->
        <p v-if="gridInfo" class="warn-line" :class="{ 'warn-strong': !gridInfo.ok }">
          <template v-if="gridInfo.ok">
            多联版式：{{ activeTpl.pageSize.w }}×{{ activeTpl.pageSize.h }}mm 纸排
            <b>{{ gridInfo.cols }} 列 × {{ gridInfo.rows }} 行 = 每页 {{ gridInfo.perPage }} 个</b>
            {{ itemSpec.w }}×{{ itemSpec.h }}mm 成品；字段按单个成品排版，画布上每一格同步生效
          </template>
          <template v-else-if="gridInfo.invalid">
            成品尺寸未填写，已按单页出片——请填写成品宽高
          </template>
          <template v-else-if="gridInfo.perPage > 400">
            每页将排 {{ gridInfo.perPage }} 个成品（上限 400），已按单页出片——请增大成品尺寸
          </template>
          <template v-else>
            当前纸张放不下 2 个 {{ itemSpec.w }}×{{ itemSpec.h }}mm 的成品——请换更大的纸张，或缩小成品尺寸
          </template>
        </p>
        <!-- 对折桌牌版式摘要：说明半页语义与对折用法 -->
        <p v-if="foldInfo" class="warn-line">
          对折桌牌：<b>{{ foldInfo.w }}×{{ foldInfo.h }}mm 半页成品</b> · 一页一条记录 · 上半联自动倒置——打印后沿折线对折即成双面台签，无需打印机双面功能
        </p>
        <p v-if="bgRatioWarn" class="warn-line warn-strong">{{ bgRatioWarn }}</p>
        <!-- 底图输出清晰度：把「印出来会不会发虚」提前讲清楚。
             与上面的比例警告分工明确——比例讲「会不会变形」，这里讲「够不够清」。 -->
        <p v-if="bgDpi && bgDpi.level !== 'good'" class="warn-line" :class="{ 'warn-strong': bgDpi.level === 'low' || bgDpi.level === 'bad' }">
          底图 {{ activeTpl.bgSize.width }}×{{ activeTpl.bgSize.height }}px ·
          <b>{{ bgDpi.text }}</b>
          <template v-if="bgStretched"> · 底图比例与{{ outputTarget }}不符，会被拉伸</template>
          —— {{ bgDpi.advice }}
        </p>
        <p v-else-if="bgDpi" class="warn-line">
          底图 {{ activeTpl.bgSize.width }}×{{ activeTpl.bgSize.height }}px · {{ bgDpi.text }}（{{ bgDpi.advice }}）
        </p>
        </div>

        <!-- 多选对齐条：选中 ≥2 个字段时出现（移到状态条带之后——它是选中态的临时工具，
             与「模板/底图状态」不是一类信息） -->
        <div v-if="multiSel.size > 1" class="align-bar">
          <span class="align-label">已选 {{ multiSel.size }} 个字段</span>
          <button class="btn-ghost btn-mini" @click="alignSelected('left')">左对齐</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('center-h')">水平居中</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('right')">右对齐</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('top')">顶对齐</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('center-v')">垂直居中</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('bottom')">底对齐</button>
        </div>

        <!-- 字段面板：数据页启用「印」的字段平铺于此，点击即加入画布 -->
        <div v-if="activeDatasetId" class="field-palette">
          <span class="palette-label">字段面板</span>
          <button
            v-for="opt in fieldOptions"
            :key="opt.value"
            class="palette-chip"
            :disabled="opt.disabled"
            :title="opt.disabled ? '整列为空，点击后打印将留空' : `点击把「${opt.label}」加入画布`"
            @click="addField(opt.value)"
          >{{ opt.label }}</button>
          <span v-if="!fieldOptions.length" class="palette-empty">
            没有已启用的字段——去数据页表格列头点「印」开启
          </span>
        </div>

        <div class="workbench">
          <div
            class="canvas-wrap"
            :class="{ 'drop-active': dragging }"
            @dragenter.prevent="onDragEnter"
            @dragover.prevent="onDragOver"
            @dragleave="onDragLeave"
            @drop.prevent="onDrop"
          >
            <div
              ref="canvasEl"
              class="canvas"
              :style="{ height: canvasH + 'px' }"
            >
              <!-- 没有底图时，画布中央就是上传入口（原来在工具栏的「上传底图」按钮已移除）。
                   放在所有字段之前，字段在上层，不会挡住拖拽；容器本身不吃事件，
                   只有中间那块按钮可点。有字段时收成底部的小胶囊，避免占住纸面中央。 -->
              <div
                v-if="!hasBackground"
                class="canvas-drop"
                :class="{ 'drop-compact': activeTpl.fields.length > 0 }"
              >
                <button type="button" class="canvas-drop-btn" @click="uploadBackground">
                  <span class="canvas-drop-title">点击上传底图</span>
                  <span class="canvas-drop-sub">也可以把图片拖到这里，或 Ctrl+V 粘贴截图</span>
                </button>
                <p v-if="activeTpl.fields.length === 0" class="canvas-drop-tip">
                  {{ activeDatasetId ? '上传后点上方字段面板，把字段加入画布' : '选择数据集后添加字段' }}
                </p>
              </div>

              <!-- 单页：整页底图 + 字段 -->
              <template v-if="!isGrid && !isFold">
                <div v-if="activeDesign" class="canvas-design" :class="{ selected: bgSelected }" @click="selectBackground">
                  <DesignSurface :design="activeDesign" :width="designSurfaceWidth" />
                </div>
                <img
                  v-if="bgUrl"
                  :src="bgUrl"
                  class="canvas-bg"
                  :class="{ selected: bgSelected }"
                  alt=""
                  draggable="false"
                  @click="selectBackground"
                  @error="onBgError"
                />
                <div
                  v-for="(f, idx) in activeTpl.fields"
                  :key="idx"
                  class="field-box"
                  :class="{
                    selected: idx === selectedIdx,
                    inmulti: multiSel.has(idx) && multiSel.size > 1,
                    nodata: fieldEmpty(f) && !fieldMissing(f),
                    stale: fieldMissing(f),
                  }"
                  :style="fieldStyle(f)"
                  @pointerdown.prevent="onFieldPointerDown($event, idx)"
                >
                  {{ fieldText(f) }}
                </div>
              </template>

              <!-- 对折桌牌：上半联只读镜像预览（不可交互），下半联为编辑参照系；
                   字段只需在下半联摆位，上半联实时镜像同步 -->
              <template v-if="isFold">
                <div class="canvas-fold-half flip">
                  <div v-if="activeDesign" class="canvas-design">
                    <DesignSurface :design="activeDesign" :width="designSurfaceWidth" />
                  </div>
                  <img
                    v-if="bgUrl"
                    :src="bgUrl"
                    class="canvas-bg"
                    :class="{ selected: bgSelected }"
                    alt=""
                    draggable="false"
                    @error="onBgError"
                  />
                  <div
                    v-for="(f, idx) in activeTpl.fields"
                    :key="'m' + idx"
                    class="field-box"
                    :class="{ nodata: fieldEmpty(f) && !fieldMissing(f), stale: fieldMissing(f) }"
                    :style="fieldStyle(f)"
                  >
                    {{ fieldText(f) }}
                  </div>
                </div>
                <div class="canvas-fold-half fold-ref">
                  <div v-if="activeDesign" class="canvas-design" :class="{ selected: bgSelected }" @click="selectBackground">
                    <DesignSurface :design="activeDesign" :width="designSurfaceWidth" />
                  </div>
                  <img
                    v-if="bgUrl"
                    :src="bgUrl"
                    class="canvas-bg"
                    :class="{ selected: bgSelected }"
                    alt=""
                    draggable="false"
                    @click="selectBackground"
                    @error="onBgError"
                  />
                  <div
                    v-for="(f, idx) in activeTpl.fields"
                    :key="idx"
                    class="field-box"
                    :class="{
                      selected: idx === selectedIdx,
                      inmulti: multiSel.has(idx) && multiSel.size > 1,
                      nodata: fieldEmpty(f) && !fieldMissing(f),
                      stale: fieldMissing(f),
                    }"
                    :style="fieldStyle(f)"
                    @pointerdown.prevent="onFieldPointerDown($event, idx)"
                  >
                    {{ fieldText(f) }}
                  </div>
                </div>
                <div class="canvas-fold-line"></div>
                <p v-if="hasBackground && activeTpl.fields.length === 0" class="canvas-hint">
                  {{ activeDatasetId ? '点击上方字段面板，把字段加入下半联（上半联自动镜像）' : '选择数据集后添加字段' }}
                </p>
              </template>

              <!-- 多联：一页 M 列 × N 行格子，每格铺一张成品底图 + 同一套字段 -->
              <template v-else-if="isGrid">
                <div
                  v-for="c in gridCells"
                  :key="c.k"
                  class="canvas-cell"
                  :class="{ cut: cutMarks }"
                  :style="{ left: c.left + '%', top: c.top + '%', width: c.w + '%', height: c.h + '%' }"
                >
                  <div v-if="activeDesign" class="canvas-design" :class="{ selected: bgSelected }" @click="selectBackground">
                    <DesignSurface :design="activeDesign" :width="designSurfaceWidth" />
                  </div>
                  <img
                    v-if="bgUrl"
                    :src="bgUrl"
                    class="canvas-bg"
                    :class="{ selected: bgSelected }"
                    alt=""
                    draggable="false"
                    @click="selectBackground"
                    @error="onBgError"
                  />
                  <div
                    v-for="(f, idx) in activeTpl.fields"
                    :key="idx"
                    class="field-box"
                    :class="{
                      selected: idx === selectedIdx,
                      inmulti: multiSel.has(idx) && multiSel.size > 1,
                      nodata: fieldEmpty(f) && !fieldMissing(f),
                      stale: fieldMissing(f),
                    }"
                    :style="fieldStyle(f)"
                    @pointerdown.prevent="onFieldPointerDown($event, idx)"
                  >
                    {{ fieldText(f) }}
                  </div>
                </div>
                <p v-if="!gridCells.length" class="canvas-hint">
                  当前纸张放不下 2 个成品——请调整纸张或成品尺寸
                </p>
              </template>

              <!-- 吸附辅助线（朱砂红，拖拽靠近时出现；按画布坐标系定位） -->
              <div v-if="guideV !== null" class="snap-guide guide-v" :style="{ left: guideV + 'px' }"></div>
              <div v-if="guideH !== null" class="snap-guide guide-h" :style="{ top: guideH + 'px' }"></div>

              <p v-if="hasBackground && !isGrid && !isFold && activeTpl.fields.length === 0" class="canvas-hint">
                {{ activeDatasetId ? '点击上方字段面板，把字段加入画布' : '选择数据集后添加字段' }}
              </p>

              <!-- 有底图时，鼠标进纸面就给一句「点它 / 按 Delete」——底图选中靠点击，
                   没有按钮，提示必须出现得及时，否则用户不知道还能删。
                   但**选中字段时要收起来**：此刻用户的心思在字段上，飘一句「点底图」只会打架，
                   而且底图正压在字段底下，本来也轮不到它被点。 -->
              <p v-if="hasBackground && !selectedField" class="bg-tip">
                {{ bgSelected ? '按 Delete 键移除底图' : '点击底图选中，再按 Delete 移除' }}
              </p>
            </div>
          </div>

          <!--
            属性面板 = **浮层抽屉**（照搬底图制作页的 .designer-panel.inspector）：
            绝对定位、不占 flex 列，只在选中字段/底图时出现。
            此前它是常驻 210px 的 flex 列：默认 1280×800 窗口下把 .canvas-wrap 挤到 739px，
            而画布固定 760px → 右边缘被裁 21px 并出现横向滚动条（960 窗口下被裁 341px）。
            改成浮层后 canvas-wrap 恢复整宽，默认窗口下 760px 画布完整可见。
          -->
          <aside v-if="selectedField || bgSelected" class="props">
            <h3 class="side-title">{{ bgSelected ? '底图' : '字段属性' }}</h3>
            <!-- 底图选中：只报信息与删除方式，不放按钮——删除统一走 Delete 键 -->
            <template v-if="bgSelected && !selectedField">
              <template v-if="activeDesign">
                <div class="fill-badge">{{ activeDesign.name }} · v{{ activeDesign.revision }}</div>
                <p class="kbd-hint">{{ activeDesign.artboard.w }} × {{ activeDesign.artboard.h }} mm · {{ activeDesign.layers.length }} 个图层</p>
                <button class="btn-ghost" @click="editBackgroundDesign">编辑图层</button>
                <p class="kbd-hint">按 Delete 解除模板引用，工程保留</p>
              </template>
              <template v-else>
              <div class="fill-badge">
                底图 {{ activeTpl.bgSize ? `${activeTpl.bgSize.width} × ${activeTpl.bgSize.height} px` : '（尺寸未知）' }}
              </div>
              <p class="kbd-hint">按 Delete 键移除底图，图片文件会一并删掉</p>
              </template>
            </template>
            <template v-else-if="selectedField">
              <div v-if="fieldMissing(selectedField)" class="fill-badge warn-strong">
                该字段的数据列在当前数据集中不存在——请删除本字段，或从上方字段面板重新添加
              </div>
              <div v-if="selectedFill" class="fill-badge" :class="{ warn: selectedFill.suggestSkip }">
                填充 {{ selectedFill.fill }}<template v-if="selectedFill.suggestSkip"> · 建议跳过</template>
              </div>
              <label class="prop-row">
                <span class="prop-label">显示名</span>
                <input v-model="selectedField.label" class="prop-input" @focus="pushUndo" />
              </label>
              <div class="prop-row">
                <span class="prop-label">字体</span>
                <CustomSelect v-model="selectedField.fontFamily" :options="fontOptions" width="130px" @open="pushUndo" />
              </div>
              <label class="prop-row">
                <span class="prop-label">字号 pt</span>
                <input v-model.number="selectedField.fontSize" type="number" min="6" max="200" class="prop-input" @focus="pushUndo" />
              </label>
              <label class="prop-row">
                <span class="prop-label">颜色</span>
                <input v-model="selectedField.color" type="color" class="prop-color" @pointerdown="pushUndo" />
              </label>
              <div class="prop-row">
                <span class="prop-label">对齐</span>
                <CustomSelect
                  v-model="selectedField.align"
                  :options="[
                    { value: 'left', label: '左对齐' },
                    { value: 'center', label: '居中' },
                    { value: 'right', label: '右对齐' },
                  ]"
                  width="130px"
                  @open="pushUndo"
                />
              </div>
              <label class="prop-row">
                <span class="prop-label">加粗</span>
                <input v-model="selectedField.bold" type="checkbox" class="prop-check" @pointerdown="pushUndo" />
              </label>
              <div class="prop-row">
                <span class="prop-label">位置</span>
                <span class="prop-meta">x {{ selectedField.x }}% · y {{ selectedField.y }}%</span>
              </div>
              <button class="btn-danger prop-remove" @click="removeField">移除字段</button>
              <p class="kbd-hint">方向键微调 0.1%（Shift 加速）· Ctrl+Z 撤销 · Delete 删除选中项</p>
            </template>
          </aside>
        </div>
      </div>
    </div>

    <!-- 危险操作确认（删除模板/字体） -->
    <ConfirmDialog
      v-if="pendingConfirm"
      title="确认删除"
      :message="pendingConfirm.message"
      confirm-text="删除"
      @confirm="onConfirmConfirmed"
      @cancel="pendingConfirm = null"
    />
  </section>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  color: var(--ink);
  border-left: 4px solid var(--cinnabar);
  padding-left: 10px;
}

.head-actions { display: flex; align-items: center; gap: 12px; }

/* 提示条：与底图制作页 `.notice` 同一套（整条带底色、按钮靠右） */
.notice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12px;
}
.notice.success { background: var(--ok-soft); color: var(--ok); }
.notice.error { background: var(--warn-soft); color: var(--warn); border-color: var(--warn-line); }
/* 模板页的按钮都是类选择器（没有全局 button 元素样式），所以这里要写全，
   并用 currentColor 跟随所在条带的配色（error 是琥珀色、success 是绿色） */
.notice-close {
  margin-left: auto;
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.btn-primary {
  padding: 7px 18px;
  border: 1px solid var(--cinnabar);
  border-radius: 6px;
  background: var(--cinnabar);
  color: #fff;
  font-size: 13px;
}

.btn-ghost {
  padding: 6px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink);
  font-size: 13px;
}

.btn-ghost:hover { border-color: var(--cinnabar); color: var(--cinnabar); }

.btn-danger {
  padding: 6px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--cinnabar);
  font-size: 12px;
}

.btn-danger:hover { border-color: var(--cinnabar); background: var(--cinnabar-soft); }

.layout { display: flex; gap: 20px; align-items: flex-start; }

.side { width: 230px; flex-shrink: 0; }

.side-title {
  font-size: 13px;
  color: var(--ink-2);
  margin: 0 0 8px;
  padding-left: 8px;
  border-left: 3px solid var(--line-strong);
}

/* 模板列表：**8 条封顶，超出就在列表内部滚动**，不把下面的字体管理一直往下顶。
   max-height 与条目高度共用同一个变量——改一处两边同步，不会各算各的。
   （此前是无限增高：模板一多，字体管理要滚很久才看得到。） */
.tpl-list {
  --tpl-item-h: 56px;  /* 条目固定高度：封顶算式依赖它 */
  --tpl-gap: 6px;
  --tpl-visible: 8;    /* 最多露出几条 */
  display: flex;
  flex-direction: column;
  gap: var(--tpl-gap);
  margin-bottom: 20px;
  max-height: calc(var(--tpl-visible) * var(--tpl-item-h) + (var(--tpl-visible) - 1) * var(--tpl-gap));
  overflow-y: auto;
  padding-right: 2px;  /* 滚动条不压卡片圆角 */
}

/* 细滚动条：系统默认那根在 230px 侧栏里太喧宾夺主 */
.tpl-list::-webkit-scrollbar { width: 8px; }
.tpl-list::-webkit-scrollbar-track { background: transparent; }
.tpl-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 999px; }
.tpl-list::-webkit-scrollbar-thumb:hover { background: var(--stone); }

.tpl-item {
  height: var(--tpl-item-h);
  flex-shrink: 0;  /* 必须：列表溢出时 flex 会把条目压到 min-content 高（53.6px），
                      封顶算式就白算了——实测过，不加这行 12 条时条目会缩水 */
  justify-content: center;  /* 固定高度后把两行居中，别都挤在顶部 */
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
  text-align: left;
}

.tpl-item:hover { border-color: var(--line-strong); }
.tpl-item.active { border-color: var(--cinnabar); background: var(--cinnabar-soft); }

.tpl-name { font-size: 13px; font-weight: 600; color: var(--ink); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpl-meta { font-size: 11px; color: var(--stone); }
.side-empty { font-size: 12px; color: var(--stone); }

.font-panel { display: flex; flex-direction: column; gap: 8px; }

.font-actions {
  display: flex;
  gap: 8px;
}

.font-actions .btn-ghost { flex: 1; }

.font-download {
  text-decoration: none;
  text-align: center;
  color: var(--stone);
}

.font-download:hover { border-color: var(--cinnabar); color: var(--cinnabar); }
.font-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }

.font-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px dashed var(--line);
  font-size: 12px;
}

.font-name { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.font-tag { font-size: 10px; color: var(--stone); border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; flex-shrink: 0; }

.font-del {
  border: none;
  background: transparent;
  color: var(--cinnabar);
  font-size: 11px;
  padding: 2px 4px;
  flex-shrink: 0;
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 15vh;
}

.hint-main { font-size: 15px; color: var(--ink-2); }
.hint-sub { font-size: 12px; color: var(--stone); }

.editor { flex: 1; min-width: 0; }

/* 工具栏：外层仍是卡片（e2e 用 `.editor .toolbar .btn-primary` / `.toolbar button` /
   `.toolbar .custom-select` 定位，**外层类名与 DOM 顺序都不能动**），内部改成两条显式行。
   此前是一条 flex-wrap 长龙，折行位置随窗口宽度随机，会把「保存/删除」与「撤销/重做」劈开。 */
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
  margin-bottom: 10px;
}

.tb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 第二行（数据集 + 操作）：操作组靠右，与左侧的数据集选择分开 */
.tb-row-actions .btn-icon:first-of-type { margin-left: 12px; }
.tb-row-actions .btn-primary { margin-left: auto; }

.name-input {
  width: 140px;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink);
  font-size: 13px;
}

/* ---- 多联版式控件 ---- */
.item-input {
  width: 62px;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tb-unit { font-size: 12px; color: var(--stone); }

/* 工具栏维度标签：明确区分「纸张」（整张大纸）与「成品」（单个底图小件）两类操作 */
.tb-label { font-size: 12px; color: var(--ink); font-weight: 600; white-space: nowrap; }

.cut-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  white-space: nowrap;
}

/* 状态条带：把散落的 `.warn-line` 收进一个有边框底色的容器。
   注意 `.warn-line` 是**测试锚点**（bg-fidelity 静态守卫 / e2e-grid / design-e2e 都钉它），
   只能加容器、不能改名；它现在的语义是「状态行」，警告靠 `.warn-strong` 加色。 */
.status-band {
  padding: 8px 12px;
  margin: 0 0 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
}

.warn-line { font-size: 12px; color: var(--stone); margin: 3px 0; }
.warn-strong { color: var(--warn); }

/* position:relative 是属性抽屉的定位参照（抽屉 absolute 挂在它右侧） */
.workbench { position: relative; display: flex; gap: 16px; align-items: flex-start; }

.canvas-wrap { flex: 1; min-width: 0; overflow: auto; }

/* 拖图片进来时给明确高亮：让用户清楚「此时松手就会被当成底图」。
   用主题变量，深色模式下自动跟着变。 */
.canvas-wrap.drop-active .canvas {
  outline: 2px dashed var(--cinnabar);
  outline-offset: -3px;
}

.canvas {
  position: relative;
  width: 760px;
  background: #fff;
  outline: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
  overflow: hidden;
}

/* 与上方 `.toolbar` 同款卡片容器。此前是无边框无底色的裸行，视觉上像工具栏「漏出来的第三行」，
   但它其实是独立的一组（图层底图），套上卡片才有正确的层级。 */
.design-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
}
.canvas-design { position: absolute; inset: 0; cursor: pointer; overflow: hidden; }
.canvas-design.selected { outline: 2px solid var(--cinnabar); outline-offset: -2px; }

.canvas-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  user-select: none;
  cursor: pointer;
}

/* 底图铺满整张纸，没有边框就完全看不出「选中了它」 */
.canvas-bg.selected {
  outline: 2px solid var(--cinnabar);
  outline-offset: -2px;
}

/* ---- 无底图时的上传入口（工具栏的「上传底图」按钮已移除） ---- */
/* 容器铺满画布但 pointer-events: none，只有中间那块按钮可点——
   否则已经有字段时，这块会把纸面中央的字段一起挡住、拖都拖不动 */
.canvas-drop {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  pointer-events: none;
}

.canvas-drop-btn {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 20px 30px;
  border: 1.5px dashed var(--line-strong);
  border-radius: 10px;
  background: #fff;
  color: var(--stone);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}

.canvas-drop-btn:hover {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.canvas-drop-title { font-size: 14px; font-weight: 600; }
.canvas-drop-sub { font-size: 12px; }
.canvas-drop-tip { margin: 0; font-size: 12px; color: var(--stone); }

/* 已经有字段了：收成底部的小胶囊，别占住纸面中央 */
.canvas-drop.drop-compact { justify-content: flex-end; padding-bottom: 12px; }

.canvas-drop.drop-compact .canvas-drop-btn {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
}

.canvas-drop.drop-compact .canvas-drop-title { font-size: 12px; }
.canvas-drop.drop-compact .canvas-drop-sub { font-size: 11px; }

/* 有底图时鼠标进纸面的提示。底图没有按钮，删除靠「点选中 + Delete」，
   提示得及时出现，否则用户根本不知道它还能删 */
.bg-tip {
  position: absolute;
  left: 50%;
  bottom: 10px;
  z-index: 6;
  transform: translateX(-50%);
  margin: 0;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
}

.canvas:hover .bg-tip { opacity: 1; }

/* ---- 多联格子：页面上的一个成品位 ---- */
/* 必须是 absolute 且形成包含块，字段的百分比坐标才是「相对格子」——
   与渲染引擎输出（.cell）保持同一语义，画布所见即打印所得 */
.canvas-cell {
  position: absolute;
  overflow: hidden;
}

.canvas-cell.cut {
  outline: 1px dashed var(--cinnabar);
  outline-offset: -1px;
}

/* ---- 对折桌牌：上半联只读镜像，下半联（fold-ref）为编辑参照系 ----
   字段百分比坐标相对半页——与渲染引擎 .fold-half 输出保持同一语义 */
.canvas-fold-half {
  position: absolute;
  left: 0;
  width: 100%;
  height: 50%;
  overflow: hidden;
}

.canvas-fold-half.flip {
  top: 0;
  transform: rotate(180deg);
  pointer-events: none; /* 镜像联只看不摸，拖拽/吸附数学全部落在下半联 */
  opacity: 0.92;
}

.canvas-fold-half.fold-ref { top: 50%; }

.canvas-fold-line {
  position: absolute;
  left: 0;
  top: 50%;
  width: 100%;
  border-top: 1px dashed var(--stone);
  pointer-events: none;
}

/* 画布字段框：**必须与渲染引擎的 .pf 共用同一套定位口径**。
   两边都靠「盒宽」算 translateX 位移（anchorRatio：center→0.5 / right→1 / left→0），
   所以画布盒宽必须**恰好等于文字宽**，多出来的每一像素都会变成出片位置漂移。

   踩过的坑（用户报「导出版本的字段会往右漂移一点点」）：
   ① `padding: 2px 6px` + `border: 1px dashed` 让盒比文字两侧各宽 6.8px，而渲染的 .pf
      是 padding:0 / border:0 ⇒ 左对齐偏 +6.8px、右对齐反向偏 −6.8px（实测 1.88mm）。
   ② `max-width: 90%` 在长文本时把盒宽截到 90%（文字 827px、盒只剩 682px），
      而 transform:translateX() 的百分比是按**盒宽**算的 ⇒ 居中长文本偏 72px、
      右对齐偏 145px（实测 21.92mm / 41.96mm）——这才是"漂移"最刺眼的那种。
   现在：盒宽 = 文字宽（nowrap 下 shrink-to-fit，与渲染一致）；hover / 选中态改用
   **outline**（不参与布局）画在文字外侧。
   —— 动这段之前先读 test/canvas-align.cjs，它钉住了「不许有 padding / max-width」。 */
.field-box {
  position: absolute;
  white-space: nowrap;
  line-height: normal; /* 与渲染 .pf 一致（不设 line-height 即 normal） */
  cursor: move;
  user-select: none;
}

.field-box:hover {
  outline: 1px dashed var(--line-strong);
  outline-offset: 3px;
}

.field-box.selected {
  outline: 1px solid var(--cinnabar);
  outline-offset: 3px;
}

.field-box.nodata {
  opacity: 0.45;
  outline: 1px dashed var(--cinnabar);
  outline-offset: 3px;
}

/* 失效字段：数据列不存在——朱砂警示标，一眼定位打印中心「字段不匹配」的来源 */
.field-box.stale {
  outline: 1px dashed var(--cinnabar);
  outline-offset: 3px;
  background: var(--cinnabar-soft);
}

.field-box.stale::after {
  content: '已失效';
  position: absolute;
  top: -15px;
  left: -7px; /* 盒已无 padding，补偿回原来的视觉位置 */
  padding: 0 5px;
  border-radius: 4px;
  background: var(--cinnabar);
  color: #fff;
  font-size: 10px;
  line-height: 1.5;
}

.canvas-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--stone);
  font-size: 13px;
  /* 纯文字提示，别吃事件——它铺满整张纸，否则点它选不中底图 */
  pointer-events: none;
}

/* 属性抽屉：绝对定位浮在画布右侧，**不占 flex 列**（对齐底图制作页的 .designer-panel.inspector）。
   之前是常驻 210px 的 flex 列，默认 1280×800 窗口下把 .canvas-wrap 挤到 739px，
   而画布固定 760px → 右边缘被裁 21px + 横向滚动条；960 窗口下被裁 341px。
   宽度取 240px（底图页是 264）：模板页画布是**固定 760px**、不会跟着缩，
   抽屉每宽 1px 就多盖住画布 1px，所以收窄一点。 */
.props {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 40;
  width: 240px;
  max-height: calc(100vh - 200px);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper-card);
  box-shadow: 0 6px 24px rgba(43, 38, 34, 0.22);
}

.prop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.prop-label { font-size: 12px; color: var(--ink-2); flex-shrink: 0; }

.prop-input {
  width: 120px;
  padding: 4px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
}

.prop-color { width: 60px; height: 28px; border: 1px solid var(--line-strong); background: var(--input-bg); }

.btn-icon { padding: 6px 10px; }
.btn-icon:disabled { opacity: 0.4; cursor: default; }

.align-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  border: 1px solid var(--cinnabar);
  border-radius: 6px;
  background: var(--cinnabar-soft);
}

/* ---- 字段面板：数据页启用「印」的字段，点击即加入画布 ---- */
.field-palette {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  background: var(--paper-card);
}

.palette-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--stone);
}

.palette-chip {
  padding: 3px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}

.palette-chip:hover:not(:disabled) {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.palette-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.palette-empty { font-size: 12px; color: var(--stone); }

.align-label { font-size: 12px; color: var(--cinnabar); margin-right: 4px; }

.btn-mini { padding: 3px 10px; font-size: 12px; }

.snap-guide {
  position: absolute;
  background: var(--cinnabar);
  pointer-events: none;
  z-index: 10;
}

.guide-v { top: 0; bottom: 0; width: 1px; }
.guide-h { left: 0; right: 0; height: 1px; }

/* 多选成员：用 box-shadow 画环，这样能和 .selected 的 outline 同时显示
   （一个元素只有一条 outline，若这里也用 outline 会把选中态盖掉）。
   box-shadow 同样不参与布局，不会破坏盒宽口径。 */
.field-box.inmulti {
  box-shadow: 0 0 0 1px var(--cinnabar);
}

.fill-badge {
  font-size: 11px;
  color: var(--ok);
  border: 1px solid var(--ok);
  border-radius: 8px;
  padding: 1px 8px;
  width: fit-content;
  margin-bottom: 10px;
}

.fill-badge.warn {
  color: var(--cinnabar);
  border-color: var(--cinnabar);
}

.fill-badge.warn-strong {
  color: #fff;
  border-color: var(--cinnabar);
  background: var(--cinnabar);
  white-space: normal;
  line-height: 1.5;
}

.kbd-hint {
  font-size: 11px;
  color: var(--stone);
  margin: 10px 0 0;
  line-height: 1.6;
}

.prop-check { width: 16px; height: 16px; accent-color: var(--cinnabar); }

.prop-meta { font-size: 11px; color: var(--stone); }

.prop-remove { width: 100%; margin-top: 4px; }
</style>

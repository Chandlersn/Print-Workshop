<script setup>
/**
 * 模板工坊：模板列表 + 画布编辑器。
 * - 底图上传：真实像素尺寸 → 纸张建议；比例差 >2% 变形预警
 * - 画布：百分比坐标系拖拽排版，字号存 pt
 * - 字段属性：字体（分组：默认/系统/上传）/ 字号 / 颜色 / 对齐 / 加粗
 * - 预览：选中数据集首行真实数据，空值半透明提示（打印时将留空）
 * 吸附对齐 / 多选 / 撤销重做在 M4。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import CustomSelect from '../components/CustomSelect.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { evenRow, columnSnap, anchorRatio } from '../lib/field-layout.cjs'

const CANVAS_W = 760 // 画布显示宽度 px
const SNAP_PX = 6    // 吸附阈值（像素，源项目同值）

// ---- 多联版式 ----
// 语义：多联模式下底图代表「单个成品图」，画布切换为**单个成品**尺寸——
// 小成品（如 1 寸照）在整页缩放下只有几十像素，根本没法拖字段。
// 因此画布的定位参照系天然就是「格子」，拖拽/吸附/对齐逻辑无需改动。
const ITEM_SIZE_PRESETS = ref([])
const layoutMode = computed(() => {
  const m = activeTpl.value?.layout?.mode
  return m === 'grid' || m === 'fold' ? m : 'single'
})

/** 设计参照物尺寸：多联 = 单个成品；对折桌牌 = 半页成品；单页 = 整张纸 */
const itemSpec = computed(() => {
  const t = activeTpl.value
  if (!t) return { w: 210, h: 297 }
  if (layoutMode.value === 'grid') {
    const w = Number(t.layout?.itemW) || 0
    const h = Number(t.layout?.itemH) || 0
    return { w: w > 0 ? w : 85, h: h > 0 ? h : 54 }
  }
  if (layoutMode.value === 'fold') {
    return { w: t.pageSize.w, h: t.pageSize.h / 2 }
  }
  return { w: t.pageSize.w, h: t.pageSize.h }
})

/**
 * 版式摘要（仅用于界面提示；行列的权威计算在主进程 resolveLayout）。
 * ok=false 表示当前纸张放不下 2 个成品，出片时会退回单页。
 */
const gridInfo = computed(() => {
  const t = activeTpl.value
  if (!t || layoutMode.value !== 'grid') return null
  const cols = Math.floor(t.pageSize.w / itemSpec.value.w)
  const rows = Math.floor(t.pageSize.h / itemSpec.value.h)
  return { cols, rows, perPage: cols * rows, ok: cols >= 1 && rows >= 1 && cols * rows >= 2 }
})

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
  if (!t || !isGrid.value) return []
  const iw = itemSpec.value.w
  const ih = itemSpec.value.h
  const cols = Math.max(1, Math.floor(t.pageSize.w / iw))
  const rows = Math.max(1, Math.floor(t.pageSize.h / ih))
  if (cols * rows < 2) return []
  const offX = (t.pageSize.w - cols * iw) / 2
  const offY = (t.pageSize.h - rows * ih) / 2
  const w = (iw / t.pageSize.w) * 100
  const h = (ih / t.pageSize.h) * 100
  const out = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        k: r * cols + c,
        left: ((offX + c * iw) / t.pageSize.w) * 100,
        top: ((offY + r * ih) / t.pageSize.h) * 100,
        w,
        h,
      })
    }
  }
  return out
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
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return
  const clamped = Math.min(500, Math.max(5, Math.round(n)))
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
  const { w, h } = itemSpec.value
  const diff = Math.abs(t.bgSize.width / t.bgSize.height - w / h) / (w / h)
  const target = layoutMode.value === 'grid'
    ? '成品尺寸'
    : (layoutMode.value === 'fold' ? '半页成品' : '纸张')
  return diff > 0.02 ? `底图比例与${target}相差约 ${(diff * 100).toFixed(1)}%，打印时可能变形` : ''
})

// 画布始终按**整张纸**缩放：多联时页面上要画出 M 列 × N 行格子，
// 整页统一缩放才能一眼看到真实拼版效果（字段位置与字号都随纸张比例走）
const canvasH = computed(() => {
  const t = activeTpl.value
  if (!t) return 540
  return Math.round((CANVAS_W * t.pageSize.h) / t.pageSize.w)
})

function ptToPx(pt) {
  const t = activeTpl.value
  if (!t) return pt
  const pxPerMm = CANVAS_W / t.pageSize.w
  return (pt * 25.4) / 72 * pxPerMm
}

async function refreshLists() {
  templates.value = await window.printpress.listTemplates()
  fonts.value = await window.printpress.listFonts()
  datasets.value = await window.printpress.listDatasets()
}

function extractError(err) {
  return String(err && err.message ? err.message : err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/, '')
}

function flash(text) {
  msg.value = text
  setTimeout(() => { if (msg.value === text) msg.value = '' }, 2500)
}

function newTemplate() {
  errorMsg.value = '' // 切换编辑对象前清掉上一次的报错，避免提示张冠李戴
  msg.value = ''
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

async function loadCatalog(dsId) {
  catalog.value = []
  sampleRow.value = null
  if (!dsId) return
  try {
    catalog.value = await window.printpress.fieldCatalog(dsId)
    const ds = await window.printpress.getDataset(dsId)
    sampleRow.value = ds.rows.find((r) => Object.values(r).some((v) => String(v).trim())) || ds.rows[0] || null
  } catch (err) {
    errorMsg.value = extractError(err)
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
  const n = Math.min(2000, Math.max(10, Math.round(Number(val) || 0)))
  t.pageSize = {
    id: 'custom',
    w: which === 'w' ? n : Number(t.pageSize?.w) || 210,
    h: which === 'h' ? n : Number(t.pageSize?.h) || 297,
  }
}

/** 三条入口（对话框 / 拖拽 / 粘贴）共用：把上传结果落到当前模板上 */
function applyBackgroundResult(result) {
  const t = activeTpl.value
  if (!t) return
  pushUndo() // 换底图也是一次可撤销的编辑
  t.background = result.background
  t.bgSize = { width: result.width, height: result.height }
  bgSelected.value = false
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
  if (!t || !t.background) return
  bgSelected.value = true
  selectedIdx.value = -1
  multiSel.value = new Set()
}

/**
 * 移除底图：只清模板上的引用。
 *
 * 磁盘上的图片文件**不在这里删**——撤销栈里还存着它的路径，
 * 删了文件就会让「Ctrl+Z 撤销回来」变成一个加载失败的破图。
 * 换底图同理：旧图会留在数据目录里，与「换图不删旧文件」的既有行为一致。
 */
function removeBackground() {
  const t = activeTpl.value
  if (!t || !t.background) return
  pushUndo()
  t.background = ''
  t.bgSize = null
  bgSelected.value = false
  flash('底图已移除——点画布中央可重新上传，Ctrl+Z 可撤销')
}

async function uploadBackground() {
  if (!activeTpl.value) return
  errorMsg.value = ''
  try {
    const result = await window.printpress.uploadBackgroundDialog()
    if (result.canceled) return
    applyBackgroundResult(result)
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
const IMAGE_LIKE = /\.(png|jpe?g|webp)$/i

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
    ? file.type.startsWith('image/')
    : !file.name || IMAGE_LIKE.test(file.name)
  if (!looksImage) {
    errorMsg.value = '只能上传图片（png / jpg / webp）'
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
    applyBackgroundResult(result)
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

// ---- 撤销 / 重做：字段布局快照栈（上限 50 条） ----
/**
 * 撤销栈快照。必须含 layout 与 background：成品尺寸、裁切线、底图都是模板的一部分——
 * 只快照 fields 的话，误改尺寸 / 误删底图后按撤销救不回来（字段没变，去重还会把它挡掉）。
 */
function snapshotFields() {
  const t = activeTpl.value
  return JSON.stringify(t
    ? {
      fields: t.fields,
      layout: t.layout || null,
      background: t.background || '',
      bgSize: t.bgSize || null,
    }
    : { fields: [] })
}

function pushUndo() {
  if (!activeTpl.value) return
  const snap = snapshotFields()
  // 去重：连续触发（focus/pointerdown 叠加）且状态未变时不重复入栈
  if (undoStack.value.length && undoStack.value[undoStack.value.length - 1] === snap) return
  undoStack.value.push(snap)
  if (undoStack.value.length > 50) undoStack.value.shift()
  redoStack.value = []
}

function restoreSnapshot(json) {
  if (!activeTpl.value) return
  const snap = JSON.parse(json)
  // 兼容早期只存fields 数组的快照
  activeTpl.value.fields = Array.isArray(snap) ? snap : snap.fields
  if (!Array.isArray(snap)) {
    if (snap.layout) activeTpl.value.layout = snap.layout
    // 底图随快照一起回滚（旧快照没有这个键，此时保持现状不动）
    if ('background' in snap) {
      activeTpl.value.background = snap.background || ''
      activeTpl.value.bgSize = snap.bgSize || null
      bgSelected.value = false
    }
  }
  if (selectedIdx.value >= activeTpl.value.fields.length) {
    selectedIdx.value = activeTpl.value.fields.length - 1
  }
  multiSel.value = new Set(
    [...multiSel.value].filter((i) => i < activeTpl.value.fields.length),
  )
}

function undo() {
  if (!undoStack.value.length) return
  redoStack.value.push(snapshotFields())
  restoreSnapshot(undoStack.value.pop())
}

function redo() {
  if (!redoStack.value.length) return
  undoStack.value.push(snapshotFields())
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
  return {
    left: `${f.x}%`,
    top: `${f.y}%`,
    transform: shift ? `translateX(-${shift * 100}%)` : 'none',
    fontSize: `${ptToPx(f.fontSize)}px`,
    color: f.color,
    fontFamily: f.fontFamily ? `"${f.fontFamily}"` : 'inherit',
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

/** 吸附：自身盒子左/中/右（上/中/下）靠近目标线 6px 内则吸附，返回 [值, 线位置] */
function snap(valueEdges, targets) {
  let best = null
  for (const [offset, label] of valueEdges) {
    for (const t of targets) {
      const diff = Math.abs(offset - t)
      if (diff <= SNAP_PX && (!best || diff < best.diff)) {
        best = { diff, adjust: t - offset, line: t }
      }
    }
  }
  return best
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
  const snapV = snap(
    [[pxX(clamp(rawX)) - off, 'l'], [pxX(clamp(rawX)) - off + d.boxW / 2, 'c'], [pxX(clamp(rawX)) - off + d.boxW, 'r']],
    d.targetsV,
  )
  const snapH = snap(
    [[pxY(clamp(rawY)), 't'], [pxY(clamp(rawY)) + d.boxH / 2, 'm'], [pxY(clamp(rawY)) + d.boxH, 'b']],
    d.targetsH,
  )
  f.x = snapV ? clamp(rawX + (snapV.adjust / d.rect.width) * 100) : clamp(rawX)
  f.y = snapH ? clamp(rawY + (snapH.adjust / d.rect.height) * 100) : clamp(rawY)

  // 多选：全体成员跟随同一位移（用的是已吸附的主字段位置，整组不再撕裂）
  if (d.starts.length > 1) {
    const dx = f.x - own.x
    const dy = f.y - own.y
    for (const s of d.starts) {
      if (s.i === d.idx) continue
      const m = activeTpl.value.fields[s.i]
      m.x = clamp(s.x + dx)
      m.y = clamp(s.y + dy)
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
  const minLeft = Math.min(...boxes.map((b) => b.left))
  const maxRight = Math.max(...boxes.map((b) => b.left + b.w))
  const minTop = Math.min(...boxes.map((b) => b.top))
  const maxBottom = Math.max(...boxes.map((b) => b.top + b.h))
  // 换算基准同样用参照格，保证多联下对齐结果是「格内坐标」
  const refRect = refFrameEl().getBoundingClientRect()
  const W = refRect.width
  const H = refRect.height
  for (const b of boxes) {
    const f = activeTpl.value.fields[b.i]
    // 对齐目标是一个像素位置，f.x、f.y 是锚点，写入前必须换算。
    //
    // 推导（x 轴）：画布 fieldStyle 会按 anchorRatio 加 translateX(-r×盒宽)，
    //   盒左缘 = 锚点px − r×盒宽，盒中心 = 盒左缘 + 盒宽/2 = 锚点px + (0.5 − r)×盒宽。
    // center-h 要「盒中心落在 targetCenter」，故：
    //   锚点px = targetCenter − (0.5 − r)×盒宽
    // 验证三种对齐方式：r=0.5(center) → 锚点=target（锚点本就在盒中心）；
    //                   r=0(left)    → 锚点=target−半个盒宽（盒中心才在 target）；
    //                   r=1(right)   → 锚点=target+半个盒宽。
    // 漏掉换算（直接写 target）会让非居中字段整体偏 (0.5−r)×盒宽，
    // 之后拖动时吸附起点随之错位——表现为「辅助线不灵敏、拖半天对不齐」。
    const r = anchorRatio(f)
    if (kind === 'left') f.x = clamp(((minLeft + r * b.w) / W) * 100)
    if (kind === 'center-h') f.x = clamp((((minLeft + maxRight) / 2 + (r - 0.5) * b.w) / W) * 100)
    if (kind === 'right') f.x = clamp(((maxRight - (1 - r) * b.w) / W) * 100)
    // y 轴锚点恒在盒中心（与 align 无关），故 top/bottom 用盒边缘、center-v 减半个盒高
    if (kind === 'top') f.y = clamp((minTop / H) * 100)
    if (kind === 'center-v') f.y = clamp((((minTop + maxBottom) / 2 - b.h / 2) / H) * 100)
    if (kind === 'bottom') f.y = clamp(((maxBottom - b.h) / H) * 100)
  }
}

// ---- 一键布局：均分横排 / 列对齐（锚点百分比语义，与渲染引擎一致）----
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

function applyColumnSnap() {
  const targets = layoutTargets()
  if (targets.length < 2) return
  pushUndo()
  const plan = columnSnap(targets)
  targets.forEach((f, j) => { f.x = plan[j].x })
  flash(`已按列对齐 ${targets.length} 个字段`)
}

// ---- 键盘：方向键微调（0.1%，Shift 1%）、Delete 删除选中项（字段 / 底图）、Ctrl+Z/Y 撤销重做 ----

/**
 * 连续键盘微调只记一次撤销。
 *
 * 原来每次 keydown 都pushUndo，而 clamp 保留 1 位小数故每步都是唯一值，
 * 去重永远不命中——按住方向键 1.3 秒就把 50 级撤销栈冲光，
 * 之后想退回改动前就只剩「重新做一遍」。
 * 合并口径：距上次微调超过 800ms 才算新的一段操作。
 */
const NUDGE_MERGE_MS = 800
let lastNudgeAt = 0

function pushUndoForNudge() {
  const now = Date.now()
  if (now - lastNudgeAt > NUDGE_MERGE_MS) pushUndo()
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
    f.x = clamp(f.x + dx)
    f.y = clamp(f.y + dy)
  }
}

function clamp(v) {
  return Math.min(100, Math.max(0, Math.round(v * 10) / 10))
}

async function saveTemplate() {
  if (!activeTpl.value) return
  errorMsg.value = ''
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
      } catch (err) {
        errorMsg.value = extractError(err)
      }
    },
  }
}

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
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('paste', onPaste)
  await refreshLists()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h2 class="page-title">模板工坊</h2>
      <div class="head-actions">
        <span v-if="msg" class="ok-text">{{ msg }}</span>
        <span v-if="errorMsg" class="error-text">{{ errorMsg }}</span>
        <button class="btn-primary" @click="newTemplate">新建模板</button>
      </div>
    </div>

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
        <div class="toolbar">
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
          <CustomSelect
            v-model="activeDatasetId"
            :options="datasetOptions"
            placeholder="选择数据集"
            width="150px"
          />
          <button class="btn-ghost btn-icon" :disabled="!canUndo" title="撤销（Ctrl+Z）" @click="undo">撤销</button>
          <button class="btn-ghost btn-icon" :disabled="!canRedo" title="重做（Ctrl+Y）" @click="redo">重做</button>
          <button class="btn-ghost" :disabled="!canLayout" title="所选字段（未多选时为全部字段）按 x 顺序等距排成一行，y 取中位数" @click="applyEvenRow">均分横排</button>
          <button class="btn-ghost" :disabled="!canLayout" title="所选字段（未多选时为全部字段）中 x 相近的对齐成一列" @click="applyColumnSnap">列对齐</button>
          <button class="btn-primary" @click="saveTemplate">保存</button>
          <button class="btn-danger" @click="removeTemplate">删除</button>
        </div>

        <!-- 多选对齐条：选中 ≥2 个字段时出现 -->
        <div v-if="multiSel.size > 1" class="align-bar">
          <span class="align-label">已选 {{ multiSel.size }} 个字段</span>
          <button class="btn-ghost btn-mini" @click="alignSelected('left')">左对齐</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('center-h')">水平居中</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('right')">右对齐</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('top')">顶对齐</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('center-v')">垂直居中</button>
          <button class="btn-ghost btn-mini" @click="alignSelected('bottom')">底对齐</button>
        </div>

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
          <template v-else>
            当前纸张放不下 2 个 {{ itemSpec.w }}×{{ itemSpec.h }}mm 的成品——请换更大的纸张，或缩小成品尺寸
          </template>
        </p>
        <!-- 对折桌牌版式摘要：说明半页语义与对折用法 -->
        <p v-if="foldInfo" class="warn-line">
          对折桌牌：<b>{{ foldInfo.w }}×{{ foldInfo.h }}mm 半页成品</b> · 一页一条记录 · 上半联自动倒置——打印后沿折线对折即成双面台签，无需打印机双面功能
        </p>
        <p v-if="bgRatioWarn" class="warn-line warn-strong">{{ bgRatioWarn }}</p>

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
                v-if="!bgUrl"
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
                <img
                  v-if="bgUrl"
                  :src="bgUrl"
                  class="canvas-bg"
                  :class="{ selected: bgSelected }"
                  alt=""
                  draggable="false"
                  @click="selectBackground"
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
                  <img
                    v-if="bgUrl"
                    :src="bgUrl"
                    class="canvas-bg"
                    :class="{ selected: bgSelected }"
                    alt=""
                    draggable="false"
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
                  <img
                    v-if="bgUrl"
                    :src="bgUrl"
                    class="canvas-bg"
                    :class="{ selected: bgSelected }"
                    alt=""
                    draggable="false"
                    @click="selectBackground"
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
                <p v-if="bgUrl && activeTpl.fields.length === 0" class="canvas-hint">
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
                  <img
                    v-if="bgUrl"
                    :src="bgUrl"
                    class="canvas-bg"
                    :class="{ selected: bgSelected }"
                    alt=""
                    draggable="false"
                    @click="selectBackground"
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

              <p v-if="bgUrl && !isGrid && !isFold && activeTpl.fields.length === 0" class="canvas-hint">
                {{ activeDatasetId ? '点击上方字段面板，把字段加入画布' : '选择数据集后添加字段' }}
              </p>

              <!-- 有底图时，鼠标进纸面就给一句「点它 / 按 Delete」——底图选中靠点击，
                   没有按钮，提示必须出现得及时，否则用户不知道还能删 -->
              <p v-if="bgUrl" class="bg-tip">
                {{ bgSelected ? '按 Delete 键移除底图' : '点击底图选中，再按 Delete 移除' }}
              </p>
            </div>
          </div>

          <aside class="props" :class="{ disabled: !selectedField && !bgSelected }">
            <h3 class="side-title">{{ bgSelected ? '底图' : '字段属性' }}</h3>
            <!-- 底图选中：只报信息与删除方式，不放按钮——删除统一走 Delete 键 -->
            <template v-if="bgSelected && !selectedField">
              <div class="fill-badge">
                底图 {{ activeTpl.bgSize ? `${activeTpl.bgSize.width} × ${activeTpl.bgSize.height} px` : '（尺寸未知）' }}
              </div>
              <p class="kbd-hint">按 Delete 键移除底图，Ctrl+Z 可撤销</p>
            </template>
            <template v-if="selectedField">
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
            <p v-else class="props-empty">点击画布中的字段查看属性，拖拽调整位置</p>
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

.ok-text { font-size: 12px; color: var(--ok); }
.error-text { font-size: 12px; color: var(--cinnabar); }

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

.tpl-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; }

.tpl-item {
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

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
  margin-bottom: 10px;
}

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

.warn-line { font-size: 12px; color: var(--stone); margin: 4px 0; }
.warn-strong { color: var(--warn); }

.workbench { display: flex; gap: 16px; align-items: flex-start; }

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
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
  overflow: hidden;
}

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

.field-box {
  position: absolute;
  max-width: 90%;
  padding: 2px 6px;
  border: 1px dashed transparent;
  cursor: move;
  user-select: none;
  white-space: nowrap;
  line-height: 1.2;
}

.field-box:hover { border-color: var(--line-strong); }

.field-box.selected {
  border-color: var(--cinnabar);
  outline: 1px solid var(--cinnabar-soft);
}

.field-box.nodata {
  opacity: 0.45;
  border: 1px dashed var(--cinnabar);
}

/* 失效字段：数据列不存在——朱砂警示标，一眼定位打印中心「字段不匹配」的来源 */
.field-box.stale {
  border: 1px dashed var(--cinnabar);
  background: var(--cinnabar-soft);
}

.field-box.stale::after {
  content: '已失效';
  position: absolute;
  top: -15px;
  left: -1px;
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

.props {
  width: 210px;
  flex-shrink: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
}

.props.disabled { opacity: 0.75; }

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

.field-box.inmulti {
  border-color: var(--cinnabar);
  border-style: dashed;
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

.props-empty { font-size: 12px; color: var(--stone); }
</style>

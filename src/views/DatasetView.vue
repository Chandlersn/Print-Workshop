<script setup>
/**
 * 数据页：导入入口 → 数据集列表 → 预览确认（字段清单 + 前若干行）。
 * 入口宽松：导入零校验；字段只做填充率/类型透明提示。
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { cellNav, ackCell } from '../lib/cell-nav.js'
import {
  sanitizeHidden, hiddenKeysOf, withHidden, visibleColumnsOf, canHideMore, pruneHidden,
} from '../lib/column-visibility.cjs'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const datasets = ref([])
const activeId = ref('')
const detail = ref(null)
const importing = ref(false)
const errorMsg = ref('')
const editingKey = ref('')
const editingAlias = ref('')

// 数据表格编辑：导入后允许直接修数（局部小问题 / 补足打印校验空值）
// 分页只影响显示，行号始终用全量 0 基索引，编辑直写数据层
const PAGE_SIZE = 50
const page = ref(0)
const gridBusy = ref(false)
const editingCell = ref(null) // { rowIndex, key }
const editingValue = ref('')

const pageCount = computed(() => (detail.value ? Math.max(1, Math.ceil(detail.value.rows.length / PAGE_SIZE)) : 1))
const pageStart = computed(() => page.value * PAGE_SIZE)
const pagedRows = computed(() =>
  detail.value ? detail.value.rows.slice(pageStart.value, pageStart.value + PAGE_SIZE) : [])

// 拖拽导入（dragenter/dragleave 计数防抖，子元素进出不会误熄遮罩）
const dragDepth = ref(0)

// 工作表选择弹窗状态
const sheetPicker = ref(null) // { filePath, fileName, sheets }
const sheetItems = ref([]) // [{ name, dataRows, colCount, headerRow, headerPreview, checked, headerInput }]
const sheetSearch = ref('')
const importMode = ref('split')
const sheetBusy = ref(false)
const pickerError = ref('')
const IMPORT_EXTS = ['.xlsx', '.xls', '.csv', '.txt']
/** 扩展名口径的唯一来源：文案与拖放高亮都从这里拼，避免三处各写一份而漂移 */
const IMPORT_EXTS_TEXT = IMPORT_EXTS.join(' / ')

// 数据集列表检索（一次导入上百个分表后的通用需求）
const dsSearch = ref('')

// ---- 导入会话（批次）：一次导入 = 一个管理单元，可整批切换与删除 ----
// 同一次导入（split 出 N 个工作簿）共享 source.batchId；旧数据没有 batchId，
// 按「文件名+导入时间」回退分组（importSheets 的 sourceMeta 一次生成，同批必同值）。
const activeBatchKey = ref('')

function batchKeyOf(ds) {
  const src = ds.source || {}
  if (src.batchId) return src.batchId
  const file = src.fileName || ''
  const at = src.importedAt || ''
  // 旧数据无 batchId：按「文件名+导入时间」回退分组（同次导入必同值）；
  // 两者皆空才退到 id，避免不同孤儿数据集被错误合并
  if (file || at) return `${file}|${at}`
  return ds.id
}

const batches = computed(() => {
  const map = new Map()
  for (const d of datasets.value) {
    const key = batchKeyOf(d)
    if (!map.has(key)) {
      const src = d.source || {}
      map.set(key, {
        key,
        fileName: src.fileName || d.name,
        importedAt: src.importedAt || '',
        count: 0,
        ids: [],
      })
    }
    const b = map.get(key)
    b.count += 1
    b.ids.push(d.id)
  }
  // 新导入的批次排前面：进数据页第一眼是最近的工作
  return [...map.values()].sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))
})

// 当前批次三级回退：显式选择 → 当前数据集所在批次 → 最新批次。
// 保证下拉、侧栏、详情三者任何时刻指向一致，不出现「空批次死路」。
const activeBatch = computed(() => {
  const list = batches.value
  if (!list.length) return null
  return list.find((b) => b.key === activeBatchKey.value)
    || list.find((b) => b.ids.includes(activeId.value))
    || list[0]
})

// 表格字号（阅读体验用户自调，像手机系统字体档位）：选择持久化，data-size 驱动样式
const SIZE_OPTIONS = [
  { value: 's', label: '小' },
  { value: 'm', label: '标准' },
  { value: 'l', label: '大' },
  { value: 'xl', label: '特大' },
]
const tableSize = ref('m')

// 列显隐：{ [数据集 id]: [列 key, ...] }，与字号同住在 display-settings 里
// （不新开存储键：store 通道是白名单制，且断言钉着「前端只用到两个键」）
const hiddenColumns = ref({})

// 读到落盘值之前不许写：镜像此刻还是空的，一写就把用户存着的隐藏状态整个盖掉
let prefsLoaded = false

/**
 * 偏好存盘：把**内存镜像整体**写下去，不做「读-改-写」。
 * 读-改-写在两次快速操作下会交错（先点字号、再隐藏列，后写的把前一次丢掉）；
 * 镜像里只有本组件拥有的两个字段，整写不会误伤别的键。
 *
 * 两处必须小心：
 *  1. 传下去的得是**纯对象**——ref 里装的是 Vue 响应式 Proxy，而 IPC 传参走结构化克隆，
 *     Proxy 克隆不了（"An object could not be cloned."）。同一个坑 TemplateView
 *     存模板时踩过，那边也是 JSON.parse(JSON.stringify(...)) 过的。
 *  2. 整个调用要兜住：saveData 是**同步**抛这个错的，而 Vue 会吞掉事件处理里的异常——
 *     于是表现成「状态改了、盘上没写」，还连带让同一次操作后面的语句跑不到
 *     （隐藏列之后菜单关不上就是这个原因）。宁可静默丢一次偏好，也不能破坏交互。
 */
function persistDisplay() {
  if (!prefsLoaded) return Promise.resolve()
  try {
    const payload = JSON.parse(JSON.stringify({
      tableSize: tableSize.value,
      hiddenColumns: hiddenColumns.value,
    }))
    return window.printpress.saveData('display-settings', payload).catch(() => { /* 偏好存不下不阻塞交互 */ })
  } catch {
    return Promise.resolve()
  }
}

async function loadDisplayPrefs() {
  try {
    const saved = await window.printpress.loadData('display-settings')
    if (saved && SIZE_OPTIONS.some((o) => o.value === saved.tableSize)) {
      tableSize.value = saved.tableSize
    }
    hiddenColumns.value = sanitizeHidden(saved && saved.hiddenColumns)
    prefsLoaded = true // 只有读成功才开闸；读失败宁可不存，也不拿空镜像覆盖用户数据
  } catch { /* 读取失败用默认档，不打扰 */ }
}

/**
 * 读取在 setup 阶段就发起，不等 onMounted。
 *
 * 为什么：补录跳转靠 `watch(cellNav.req, { immediate: true })`，它在 setup 阶段就跑，
 * 要读隐藏状态来判断「目标列是不是被藏了」。等 onMounted 再读就晚了——跳转回来时
 * 读到的还是空 map，于是「自动展开隐藏列」失效，用户从打印中心跳过来只看到一片空白。
 * 这个竞态是真机 e2e 抓到的（程序化断言看不出来）。
 * 顺带也挡住了反向覆盖：读盘晚于写盘时，会把刚写下去的隐藏状态用旧值盖回来。
 */
const prefsReady = loadDisplayPrefs()

function setSize(v) {
  tableSize.value = v
  persistDisplay()
}

const activeSummary = computed(() => datasets.value.find((d) => d.id === activeId.value) || null)
const columns = computed(() => (detail.value ? detail.value.columns : []))

// 列显隐的派生状态：三者都由「当前列 + 隐藏集」算出，所以挨着 columns 放
// hiddenSet 只收当前数据集**真实存在**的 key——换过文件后盘上的旧 key 不算数，
// 否则会出现「已隐藏 1 列」却看不见藏了谁
const hiddenSet = computed(() => hiddenKeysOf(hiddenColumns.value, activeId.value, columns.value))
const visibleColumns = computed(() => visibleColumnsOf(columns.value, hiddenSet.value))
const hiddenCount = computed(() => hiddenSet.value.size)
const canHideMoreCols = computed(() => canHideMore(columns.value, hiddenSet.value))
const filteredSheets = computed(() => {
  const kw = sheetSearch.value.trim().toLowerCase()
  if (!kw) return sheetItems.value
  return sheetItems.value.filter((s) => s.name.toLowerCase().includes(kw))
})
const checkedCount = computed(() => sheetItems.value.filter((s) => s.checked).length)
const shownDatasets = computed(() => {
  if (!activeBatch.value) return []
  const inBatch = new Set(activeBatch.value.ids)
  const kw = dsSearch.value.trim().toLowerCase()
  const list = datasets.value.filter(
    (d) => inBatch.has(d.id) && (!kw || d.name.toLowerCase().includes(kw))
  )
  // 已激活打印字段的数据集置顶，组内按激活数降序（稳定排序）——
  // 点印/取消时激活数变化，位置随之可见地移动；未激活的保持导入顺序
  const ready = list.filter((d) => d.printCols > 0).sort((a, b) => b.printCols - a.printCols)
  const rest = list.filter((d) => !(d.printCols > 0))
  return [...ready, ...rest]
})

function extractError(err) {
  return String(err && err.message ? err.message : err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/, '')
}

async function refreshList(preferId) {
  datasets.value = await window.printpress.listDatasets()
  pruneStaleHidden()
  const target = preferId || activeId.value
  if (target && datasets.value.some((d) => d.id === target)) {
    await selectDataset(target)
  } else {
    activeId.value = ''
    detail.value = null
  }
}

/** 清掉已删数据集留下的隐藏记录：长期用下来这个 map 只增不减（列表为空时不动手） */
function pruneStaleHidden() {
  const next = pruneHidden(hiddenColumns.value, datasets.value.map((d) => d.id))
  const before = Object.keys(hiddenColumns.value)
  const after = Object.keys(next)
  if (before.length === after.length && before.every((k) => after.includes(k))) return
  hiddenColumns.value = next
  persistDisplay()
}

async function selectDataset(id) {
  activeId.value = id
  closeMenus() // 菜单里记的是上一个数据集的列，留着会误操作
  // 页码必须归零：切到行数更少的数据集时，旧的 page 会让 pagedRows 直接算成空，
  // 而分页器只在 pageCount > 1 时渲染——表格空白、分页器也没了，成死路。
  // removeRow / appendRow 都会重置，唯独切换数据集这条路径漏了。
  page.value = 0
  try {
    detail.value = await window.printpress.getDataset(id)
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

async function startImport() {
  errorMsg.value = ''
  try {
    const result = await window.printpress.importDatasetDialog()
    if (result.canceled) return
    await importFromPath(result.filePath)
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

// ---- 拖拽导入 ----
function onDragEnter(e) {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return
  dragDepth.value++
}

function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(e) {
  dragDepth.value = 0
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.path)
  if (!file) return
  importFromPath(file.path) // Electron 渲染进程 File.path（v28 可用）
}

// ---- 导入主流程：检视 →（Excel 多表）工作表选择 → 导入 ----
async function importFromPath(filePath) {
  importing.value = true
  errorMsg.value = ''
  try {
    const r = await window.printpress.inspectFile(filePath)
    if (r.kind === 'csv') {
      await refreshList(r.datasets[0].id)
    } else if (r.sheets.length === 1) {
      // 单表快速路径：按检测结果直接导入（不打扰用户）
      const res = await window.printpress.importSheets({
        filePath: r.filePath, mode: 'split',
        selections: [{ name: r.sheets[0].name, headerRow: r.sheets[0].headerRow }],
      })
      await refreshList(res[0].id)
    } else {
      openSheetPicker(r)
    }
  } catch (err) {
    errorMsg.value = extractError(err)
  } finally {
    importing.value = false
  }
}

function openSheetPicker(r) {
  sheetItems.value = r.sheets.map((s) => ({
    ...s,
    checked: s.dataRows > 0, // 没有数据行的表默认不勾（入口宽松，可手动勾选）
    headerInput: s.headerRow >= 0 ? s.headerRow : -1, // -1 = 自动
  }))
  sheetPicker.value = r
  sheetSearch.value = ''
  pickerError.value = ''
}

function closeSheetPicker() {
  sheetPicker.value = null
  sheetItems.value = []
}

function sheetHeaderLabel(item) {
  return item.headerInput >= 0 ? `第 ${item.headerInput + 1} 行` : '自动'
}

// ---- 导入进度（主进程分阶段推送，消解大文件导入的等待焦虑） ----
const importProgress = ref(null) // { pct, label }
let unbindImportProgress = null

async function confirmImport() {
  const picked = sheetItems.value.filter((s) => s.checked)
  if (!picked.length) {
    pickerError.value = '请至少勾选一个工作表'
    return
  }
  sheetBusy.value = true
  pickerError.value = ''
  importProgress.value = { pct: 0, label: '准备导入…' }
  try {
    const res = await window.printpress.importSheets({
      filePath: sheetPicker.value.filePath,
      mode: importMode.value,
      selections: picked.map((s) => ({ name: s.name, headerRow: s.headerInput })),
    })
    closeSheetPicker()
    await refreshList(res[0].id)
  } catch (err) {
    pickerError.value = extractError(err)
  } finally {
    sheetBusy.value = false
    importProgress.value = null
  }
}

// ---- 危险操作确认（应用内统一弹窗，替代原生 confirm） ----
const pendingConfirm = ref(null)

function onConfirmConfirmed() {
  const c = pendingConfirm.value
  pendingConfirm.value = null
  if (c) c.action()
}

/**
 * 删除当前导入会话的全部工作簿（整批）。
 * 单个数据集的批次显示为「删除数据集」，多个时一键删整批——
 * 删除范围跟随顶部批次下拉，所见即所删。
 */
function removeActiveBatch() {
  const b = activeBatch.value
  if (!b) return
  const single = datasets.value.find((d) => d.id === activeId.value)
  const label = b.count > 1
    ? `「${b.fileName}」导入的全部 ${b.count} 个工作簿`
    : `数据集「${single ? single.name : b.fileName}」`
  pendingConfirm.value = {
    message: `确定删除${label}？\n该操作不可恢复。`,
    action: async () => {
      try {
        await window.printpress.deleteBatch(b.ids)
        await refreshList()
      } catch (err) {
        errorMsg.value = extractError(err)
      }
    },
  }
}

function beginRename(col) {
  editingKey.value = col.key
  editingAlias.value = col.alias
}

// ---- 数据表格编辑 ----
function beginEdit(rowIndex, key, value) {
  editingCell.value = { rowIndex, key }
  editingValue.value = String(value ?? '')
}

function cancelEdit() {
  editingCell.value = null
  editingValue.value = ''
}

async function commitEdit() {
  const cell = editingCell.value
  if (!cell || !detail.value) return
  const original = detail.value.rows[cell.rowIndex]?.[cell.key]
  editingCell.value = null
  if (String(original ?? '') === editingValue.value) return // 未变化不写盘
  gridBusy.value = true
  try {
    await window.printpress.updateCell(detail.value.id, cell.rowIndex, cell.key, editingValue.value)
    await selectDataset(detail.value.id) // 重新拉取行 + 字段目录（填充率/类型即时刷新）
  } catch (err) {
    errorMsg.value = extractError(err)
  } finally {
    gridBusy.value = false
  }
}

async function removeRow(rowIndex) {
  if (!detail.value) return
  pendingConfirm.value = {
    message: `删除第 ${rowIndex + 1} 行数据？\n该操作不可恢复。`,
    action: async () => {
      gridBusy.value = true
      try {
        await window.printpress.deleteRow(detail.value.id, rowIndex)
        await selectDataset(detail.value.id)
        if (page.value > pageCount.value - 1) page.value = pageCount.value - 1 // 删后页码回缩
      } catch (err) {
        errorMsg.value = extractError(err)
      } finally {
        gridBusy.value = false
      }
    },
  }
}

async function appendRow() {
  if (!detail.value) return
  gridBusy.value = true
  try {
    const r = await window.printpress.addRow(detail.value.id)
    await selectDataset(detail.value.id)
    page.value = Math.floor(r.rowIndex / PAGE_SIZE) // 按新行号直接落到目标页
    const last = r.rowIndex
    const firstKey = detail.value.columns[0]?.key
    if (firstKey) beginEdit(last, firstKey, '') // 新行直接进入编辑
  } catch (err) {
    errorMsg.value = extractError(err)
  } finally {
    gridBusy.value = false
  }
}

function goPage(p) {
  page.value = Math.min(Math.max(0, p), pageCount.value - 1)
}

// ---- 列级打印开关：默认停用，用户逐列激活后才进入模板设计页 ----
function isPrintOn(col) {
  return col.printOn === true
}

async function togglePrint(col) {
  if (!detail.value) return
  const next = !isPrintOn(col)
  try {
    await window.printpress.setColumnPrint(detail.value.id, col.key, next)
    col.printOn = next // 本地同步，不打断阅读位置
    // 同步侧栏摘要的激活数：徽标与置顶即时生效，无需重进页面
    const s = datasets.value.find((x) => x.id === detail.value.id)
    if (s) s.printCols = Math.max(0, (s.printCols || 0) + (next ? 1 : -1))
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

async function commitRename() {
  const key = editingKey.value
  editingKey.value = ''
  if (!key || !detail.value) return
  try {
    await window.printpress.renameColumn(detail.value.id, key, editingAlias.value)
    await selectDataset(detail.value.id)
  } catch (err) {
    errorMsg.value = extractError(err)
  }
}

// ---- 列显隐：入口是列头 hover 才现的「▾」，回头路是工具栏的「已隐藏 N 列」胶囊 ----
// 列头已有两个热区（点名字改名、「印」开关），显隐只能再开一个极小的热区且默认隐身，
// 否则列头会挤成三个按钮。菜单 Teleport 到 body：th 上有 overflow:hidden
// （列名过长要出省略号），留在表头里的浮层会被裁掉。
const colMenu = ref(null) // { key, x, y }
const listMenu = ref(null) // { x, y }
const colMenuEl = ref(null)
const listMenuEl = ref(null)

const menuCol = computed(
  () => columns.value.find((c) => colMenu.value && c.key === colMenu.value.key) || null)

function closeMenus() {
  colMenu.value = null
  listMenu.value = null
}

/** 贴着触发器下沿弹，左右按窗口收边（表格可横向滚动，右端的列会顶到屏幕外） */
function menuPos(rect, width) {
  return {
    x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    y: Math.min(rect.bottom + 4, window.innerHeight - 40),
  }
}

function openColMenu(col, ev) {
  if (colMenu.value && colMenu.value.key === col.key) return closeMenus()
  listMenu.value = null
  colMenu.value = { key: col.key, ...menuPos(ev.currentTarget.getBoundingClientRect(), 200) }
}

function openListMenu(ev) {
  if (listMenu.value) return closeMenus()
  colMenu.value = null
  listMenu.value = menuPos(ev.currentTarget.getBoundingClientRect(), 220)
}

/**
 * 整体替换当前数据集的隐藏集。
 * 以 hiddenSet（只含真实存在的 key）为基准，顺带把盘上的旧 key 清掉。
 */
function applyHidden(keys) {
  const id = activeId.value
  if (!id) return
  hiddenColumns.value = withHidden(hiddenColumns.value, id, keys)
  persistDisplay()
}

function hideColumn(col) {
  if (!col || !canHideMoreCols.value) return
  applyHidden([...hiddenSet.value, col.key])
  closeMenus()
}

function showOnlyColumn(col) {
  if (!col) return
  applyHidden(columns.value.filter((c) => c.key !== col.key).map((c) => c.key))
  closeMenus()
}

function restoreColumns() {
  applyHidden([])
  closeMenus()
}

function toggleColumnVisible(col) {
  // 兜底：界面上「最后一个可见列」的复选框是禁用的，这里再挡一次
  if (!hiddenSet.value.has(col.key) && !canHideMoreCols.value) return
  const cur = hiddenSet.value
  applyHidden(cur.has(col.key) ? [...cur].filter((k) => k !== col.key) : [...cur, col.key])
}

function onDocMouseDown(e) {
  if (!colMenu.value && !listMenu.value) return
  // 触发器自己要排除：否则 mousedown 先关、click 再开，看起来像「点它关不掉」
  if (e.target && e.target.closest && e.target.closest('[data-menu-trigger]')) return
  for (const el of [colMenuEl.value, listMenuEl.value]) {
    if (el && el.contains(e.target)) return
  }
  closeMenus()
}

function onDocKey(e) {
  if (e.key === 'Escape') closeMenus()
}

/** 滚动 / 改窗口大小后 fixed 定位的菜单会跟触发器脱开，直接收起（菜单自己滚动不算） */
function onViewportChange(e) {
  const t = e && e.target
  if (t instanceof Node) {
    for (const el of [colMenuEl.value, listMenuEl.value]) {
      if (el && el.contains(t)) return
    }
  }
  closeMenus()
}

onMounted(() => {
  refreshList()
  // 落盘偏好的读取已在 setup 阶段发起（见 prefsReady），这里不再重复读
  unbindImportProgress = window.printpress.onImportProgress((p) => {
    importProgress.value = p
  })
  document.addEventListener('mousedown', onDocMouseDown, true)
  document.addEventListener('keydown', onDocKey)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  if (unbindImportProgress) unbindImportProgress()
  document.removeEventListener('mousedown', onDocMouseDown, true)
  document.removeEventListener('keydown', onDocKey)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

// ---- 去补录直达：打印中心校验弹窗点「第 N 行」→ 跳页、滚动到该格、直接进入编辑 ----
const flashCell = ref(null) // { rowIndex, key } 闪烁提示当前目标格
let flashTimer = null

watch(() => cellNav.req, async (req) => {
  if (!req) return
  try {
    // 隐藏状态来自落盘，必须先读到再判断「目标列是不是被藏了」——
    // 读盘是 setup 阶段发起的，这里等它落地（详见 prefsReady）
    await prefsReady
    if (activeId.value !== req.datasetId || !detail.value) {
      await selectDataset(req.datasetId)
    }
    if (!detail.value) return
    if (!detail.value.columns.some((c) => c.key === req.key) || !detail.value.rows[req.rowIndex]) {
      errorMsg.value = '该单元格不存在（数据可能已变动），请重新校验'
      return
    }
    // 目标列被隐藏时必须先展开：否则跳过来只看到一片空白，
    // 用户会以为「跳错了」，而不是「这列被我藏起来了」
    if (hiddenSet.value.has(req.key)) {
      applyHidden([...hiddenSet.value].filter((k) => k !== req.key))
    }
    page.value = Math.floor(req.rowIndex / PAGE_SIZE)
    await nextTick()
    const el = document.querySelector(`[data-ri="${req.rowIndex}"][data-ck="${CSS.escape(req.key)}"]`)
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    beginEdit(req.rowIndex, req.key, detail.value.rows[req.rowIndex][req.key])
    flashCell.value = { rowIndex: req.rowIndex, key: req.key }
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { flashCell.value = null }, 2600)
  } catch (err) {
    errorMsg.value = extractError(err)
  } finally {
    // 消费确认：处理完（含各条提前 return 的失败分支）立刻清空请求。
    // 只在还是同一条请求时清——处理期间用户可能又点了一次跳转，
    // 那条新请求不能被这里的收尾吃掉。
    if (cellNav.req === req) ackCell()
  }
}, { immediate: true }) // 打印页点击时本组件尚未挂载，挂载后需立即消费已到达的跳转请求

</script>

<template>
  <section
    class="page"
    :data-size="tableSize"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="page-head">
      <h2 class="page-title">数据</h2>
      <div class="head-actions">
        <span v-if="errorMsg" class="error-text">{{ errorMsg }}</span>
        <button class="btn-primary" :disabled="importing" @click="startImport">
          {{ importing ? '导入中…' : '导入数据文件' }}
        </button>
      </div>
    </div>

    <div v-if="datasets.length === 0" class="empty-hint">
      <button class="dropzone" :disabled="importing" @click="startImport">
        <span class="dropzone-main">{{ importing ? '导入中…' : '把文件拖到这里，或点击选择' }}</span>
        <span class="dropzone-sub">支持 {{ IMPORT_EXTS_TEXT }} · 多工作表可选 · 自动识别 UTF-8 / GBK 编码</span>
      </button>
      <p class="hint-sub">导入后字段从真实数据自动识别，第一行表头位置也会自动检测</p>
    </div>

    <div v-else class="layout">
      <aside class="ds-list">
        <label class="batch-row" title="按导入会话切换：一次导入的所有工作簿归为一个批次">
          <span class="batch-label">导入批次</span>
          <select
            class="batch-select"
            :value="activeBatch ? activeBatch.key : ''"
            :disabled="!batches.length"
            @change="activeBatchKey = $event.target.value"
          >
            <option v-for="b in batches" :key="b.key" :value="b.key">
              {{ b.fileName }}（{{ b.count }} 个{{ b.importedAt ? ` · ${b.importedAt.slice(0, 10)}` : '' }}）
            </option>
          </select>
        </label>
        <input
          v-if="datasets.length > 6"
          v-model="dsSearch"
          class="ds-search"
          placeholder="搜索数据集…"
        />
        <button
          v-for="ds in shownDatasets"
          :key="ds.id"
          class="ds-item"
          :class="{ active: ds.id === activeId, printed: ds.printCount > 0 }"
          :title="ds.lastPrintedAt ? `最近打印：${ds.lastPrintedAt.slice(0, 10)}（共 ${ds.printCount} 次）` : ''"
          @click="selectDataset(ds.id)"
        >
          <span class="ds-name-row">
            <span class="ds-name">{{ ds.name }}</span>
            <span v-if="ds.printCount > 0" class="ds-printed-flag" title="该工作簿已打印/导出过">已打 {{ ds.printCount }}</span>
            <span v-if="ds.printCols > 0" class="ds-print-flag" title="已激活的打印字段数">印 {{ ds.printCols }}</span>
          </span>
          <span class="ds-meta">{{ ds.rowCount }} 行 × {{ ds.columnCount }} 列</span>
        </button>
        <p v-if="!shownDatasets.length" class="ds-none">无匹配的数据集</p>
        <button class="ds-dropzone" :disabled="importing" @click="startImport">
          <span class="ds-dropzone-main">{{ importing ? '导入中…' : '拖入文件到页面，或点击导入' }}</span>
          <span class="ds-dropzone-sub">.xlsx / .xls / .csv · 多工作表可选</span>
        </button>
      </aside>

      <div v-if="detail" class="ds-detail">
        <div class="detail-head">
          <div>
            <div class="detail-title">{{ activeSummary.name }}</div>
            <div class="detail-sub">
              来源 {{ detail.source.type.toUpperCase() }} · 导入于 {{ detail.source.importedAt.slice(0, 10) }}
              · 共 {{ detail.rowCount }} 行
              · <span v-if="detail.printCount > 0" class="printed-note">已打印 {{ detail.printCount }} 次，最近 {{ detail.lastPrintedAt.slice(0, 10) }}</span>
              <span v-else>尚未打印</span>
            </div>
          </div>
          <button class="btn-danger" @click="removeActiveBatch">
            {{ activeBatch && activeBatch.count > 1 ? `删除整批（${activeBatch.count} 个工作簿）` : '删除数据集' }}
          </button>
        </div>

        <h3 class="section-title">
          数据表格（点击单元格即可修改）
          <span class="grid-meta">{{ detail.rows.length }} 行 · 列头点名字改名，「印」控制字段是否进入模板设计页，「▾」控制这一列显示不显示</span>
        </h3>
        <div class="grid-toolbar">
          <span class="tb-hint">空值打印时留空，补齐后再打印即可通过校验</span>
          <span class="tb-spacer"></span>
          <button
            v-if="hiddenCount"
            class="hidden-pill"
            data-menu-trigger
            :class="{ on: listMenu }"
            title="点开可勾选要显示哪些列"
            @click="openListMenu($event)"
          >已隐藏 {{ hiddenCount }} 列 ▾</button>
          <div class="size-group" role="group" aria-label="表格字号">
            <span class="size-label">字号</span>
            <button
              v-for="opt in SIZE_OPTIONS"
              :key="opt.value"
              class="size-item"
              :class="{ on: tableSize === opt.value }"
              @click="setSize(opt.value)"
            >{{ opt.label }}</button>
          </div>
          <button class="btn-ghost" :disabled="gridBusy" @click="appendRow">＋ 添加一行</button>
        </div>
        <div class="table-scroll">
          <table class="row-table edit-grid">
            <thead>
              <tr>
                <th class="rownum-col">#</th>
                <th v-for="col in visibleColumns" :key="col.key" class="col-head">
                  <template v-if="editingKey === col.key">
                    <input
                      v-model="editingAlias"
                      class="alias-input"
                      @keyup.enter="commitRename"
                      @blur="commitRename"
                    />
                  </template>
                  <template v-else>
                    <span class="th-alias alias-text" title="点击修改列别名" @click="beginRename(col)">{{ col.alias }}</span>
                  </template>
                  <button
                    class="print-toggle"
                    :class="{ on: isPrintOn(col) }"
                    :title="isPrintOn(col) ? '已启用打印：点击取消启用' : '未启用：点击启用打印（字段将出现在模板设计页）'"
                    @click.stop="togglePrint(col)"
                  >印</button>
                  <button
                    class="col-menu-btn"
                    data-menu-trigger
                    :class="{ on: colMenu && colMenu.key === col.key }"
                    title="显示 / 隐藏这一列"
                    @click.stop="openColMenu(col, $event)"
                  >▾</button>
                </th>
                <th class="op-col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in pagedRows" :key="pageStart + idx">
                <td class="rownum-col">{{ pageStart + idx + 1 }}</td>
                <td
                  v-for="col in visibleColumns"
                  :key="col.key"
                  class="cell"
                  :class="{
                    empty: !String(row[col.key]).trim(),
                    editing: editingCell && editingCell.rowIndex === pageStart + idx && editingCell.key === col.key,
                    flash: flashCell && flashCell.rowIndex === pageStart + idx && flashCell.key === col.key,
                  }"
                  :data-ri="pageStart + idx"
                  :data-ck="col.key"
                  :title="String(row[col.key] || '（空）点击填写')"
                  @click="beginEdit(pageStart + idx, col.key, row[col.key])"
                >
                  <input
                    v-if="editingCell && editingCell.rowIndex === pageStart + idx && editingCell.key === col.key"
                    v-model="editingValue"
                    class="cell-input"
                    autofocus
                    @keyup.enter="commitEdit"
                    @keyup.esc="cancelEdit"
                    @blur="commitEdit"
                  />
                  <template v-else>{{ row[col.key] }}</template>
                </td>
                <td class="op-col">
                  <button class="row-del" :disabled="gridBusy" title="删除此行" @click="removeRow(pageStart + idx)">删</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="pageCount > 1" class="pager">
          <button class="btn-ghost" :disabled="page === 0" @click="goPage(page - 1)">上一页</button>
          <span class="pager-info">第 {{ page + 1 }} / {{ pageCount }} 页</span>
          <button class="btn-ghost" :disabled="page >= pageCount - 1" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
    </div>

    <!-- 拖拽遮罩 -->
    <div v-if="dragDepth > 0" class="drag-mask">
      <div class="drag-box">
        <span class="drag-main">松开导入</span>
        <span class="drag-sub">支持 {{ IMPORT_EXTS_TEXT }}</span>
      </div>
    </div>

    <!-- 工作表选择弹窗 -->
    <div v-if="sheetPicker" class="onboard-mask">
      <div class="sheet-dialog">
        <div class="sheet-head">
          <div>
            <div class="sheet-title">{{ sheetPicker.fileName }}</div>
            <div class="sheet-sub">共 {{ sheetItems.length }} 个工作表，勾选要导入的部分，表头行可手动修正</div>
          </div>
          <div class="mode-group">
            <label class="mode-item" :class="{ on: importMode === 'split' }">
              <input v-model="importMode" type="radio" value="split" /> 每表一个数据集
            </label>
            <label class="mode-item" :class="{ on: importMode === 'merge' }">
              <input v-model="importMode" type="radio" value="merge" /> 合并为一个（加来源列）
            </label>
          </div>
        </div>

        <div class="sheet-toolbar">
          <input v-model="sheetSearch" class="sheet-search" placeholder="搜索工作表名称…" />
          <span class="sheet-count">已选 {{ checkedCount }} / {{ sheetItems.length }}</span>
        </div>

        <div class="sheet-list">
          <div v-for="s in filteredSheets" :key="s.name" class="sheet-row" :class="{ on: s.checked }">
            <label class="sheet-check">
              <input v-model="s.checked" type="checkbox" />
              <span class="sheet-name" :title="s.name">{{ s.name }}</span>
            </label>
            <span class="sheet-meta">{{ s.dataRows }} 行 × {{ s.colCount }} 列</span>
            <span v-if="s.headerPreview.length" class="sheet-preview" :title="s.headerPreview.join(' | ')">
              表头：{{ s.headerPreview.join(' · ') }}
            </span>
            <label class="sheet-hr" title="表头所在行（0 = 自动检测）；从该行起为表头+数据">
              表头
              <input v-model.number="s.headerInput" type="number" min="-1" class="hr-input" />
            </label>
          </div>
          <div v-if="!filteredSheets.length" class="sheet-none">无匹配的工作表</div>
        </div>

        <div v-if="sheetBusy && importProgress" class="import-progress">
          <div class="progress-head">
            <span class="progress-label">{{ importProgress.label }}</span>
            <span class="progress-pct">{{ importProgress.pct }}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: importProgress.pct + '%' }"></div>
          </div>
        </div>

        <div class="sheet-foot">
          <span v-if="pickerError" class="error-text">{{ pickerError }}</span>
          <span class="tb-spacer"></span>
          <button class="btn-ghost" :disabled="sheetBusy" @click="closeSheetPicker">取消</button>
          <button class="btn-primary" :disabled="sheetBusy || !checkedCount" @click="confirmImport">
            {{ sheetBusy ? '导入中…' : `导入 ${checkedCount} 个表` }}
          </button>
        </div>
      </div>
    </div>

    <!-- 危险操作确认（删除数据集/行） -->
    <ConfirmDialog
      v-if="pendingConfirm"
      title="确认删除"
      :message="pendingConfirm.message"
      confirm-text="删除"
      @confirm="onConfirmConfirmed"
      @cancel="pendingConfirm = null"
    />

    <!-- 列显隐菜单：Teleport 到 body —— th 上有 overflow:hidden，留在表头里会被裁掉 -->
    <Teleport to="body">
      <div
        v-if="colMenu && menuCol"
        ref="colMenuEl"
        class="col-menu"
        :style="{ left: colMenu.x + 'px', top: colMenu.y + 'px' }"
      >
        <button
          class="cm-item"
          :disabled="!canHideMoreCols"
          :title="canHideMoreCols ? '' : '至少要保留一列'"
          @click="hideColumn(menuCol)"
        >隐藏此列</button>
        <button
          class="cm-item"
          :disabled="columns.length < 2"
          @click="showOnlyColumn(menuCol)"
        >只看此列</button>
        <button v-if="hiddenCount" class="cm-item" @click="restoreColumns">
          恢复全部隐藏的列（{{ hiddenCount }}）
        </button>
        <div class="cm-hint">仅隐藏显示，不影响「印」与打印</div>
      </div>

      <div
        v-if="listMenu"
        ref="listMenuEl"
        class="col-menu list-menu"
        :style="{ left: listMenu.x + 'px', top: listMenu.y + 'px' }"
      >
        <div class="cm-title">显示哪些列（取消勾选即隐藏）</div>
        <label v-for="col in columns" :key="col.key" class="cm-check">
          <input
            type="checkbox"
            :checked="!hiddenSet.has(col.key)"
            :disabled="!hiddenSet.has(col.key) && !canHideMoreCols"
            @change="toggleColumnVisible(col)"
          />
          <span class="cm-check-label" :title="col.alias">{{ col.alias }}</span>
          <span v-if="isPrintOn(col)" class="cm-print-flag" title="该列已激活打印字段">印</span>
        </label>
        <button class="cm-item cm-restore" :disabled="!hiddenCount" @click="restoreColumns">全部显示</button>
      </div>
    </Teleport>
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

.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.error-text {
  font-size: 12px;
  color: var(--cinnabar);
}

.btn-primary {
  padding: 8px 20px;
  border: 1px solid var(--cinnabar);
  border-radius: 6px;
  background: var(--cinnabar);
  color: #fff;
  font-size: 14px;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn-danger {
  padding: 6px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--cinnabar);
  font-size: 12px;
}

.btn-danger:hover {
  border-color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: 12vh;
}

.hint-main { font-size: 15px; color: var(--ink-2); }
.hint-sub { font-size: 12px; color: var(--stone); margin: 0; }

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 460px;
  padding: 44px 24px;
  border: 2px dashed var(--line-strong);
  border-radius: 12px;
  background: var(--paper-card);
  transition: border-color 0.15s, background 0.15s;
}

.dropzone:hover {
  border-color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.dropzone-main { font-size: 15px; color: var(--ink); font-weight: 600; }
.dropzone-sub { font-size: 12px; color: var(--stone); }

.drag-mask {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(30, 26, 20, 0.55);
  pointer-events: none; /* 让 drop 落到下层根节点，遮罩只作视觉提示 */
}

.drag-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 72px;
  border: 2px dashed var(--cinnabar);
  border-radius: 14px;
  background: var(--paper-card);
}

.drag-main { font-size: 18px; font-weight: 700; color: var(--cinnabar); }
.drag-sub { font-size: 12px; color: var(--ink-2); }

.sheet-dialog {
  display: flex;
  flex-direction: column;
  width: 640px;
  max-height: 78vh;
  background: var(--paper-card);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  padding: 20px 22px;
  box-shadow: var(--shadow);
}

.sheet-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.sheet-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-sub { font-size: 12px; color: var(--stone); margin-top: 4px; }

.mode-group { display: flex; flex-direction: column; gap: 4px; }

.mode-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.mode-item.on {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.sheet-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.sheet-search {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 13px;
}

.sheet-count { font-size: 12px; color: var(--ink-2); flex-shrink: 0; }

.sheet-list {
  flex: 1;
  min-height: 160px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.sheet-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}

.sheet-row.on { background: var(--cinnabar-soft); }

.sheet-check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 190px;
  cursor: pointer;
}

.sheet-name {
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-meta { flex-shrink: 0; color: var(--stone); }

.sheet-preview {
  flex: 1;
  min-width: 0;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-hr { display: flex; align-items: center; gap: 6px; color: var(--ink-2); flex-shrink: 0; }

.hr-input {
  width: 56px;
  padding: 2px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
}

.sheet-none { padding: 28px; text-align: center; color: var(--stone); font-size: 13px; }

.import-progress {
  margin-top: 14px;
}

.progress-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}

.progress-label {
  font-size: 12px;
  color: var(--ink-2);
}

.progress-pct {
  font-size: 12px;
  color: var(--cinnabar);
  font-variant-numeric: tabular-nums;
}

.progress-track {
  height: 6px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--cinnabar);
  transition: width 0.25s ease;
}

.sheet-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.tb-spacer { flex: 1; }

.btn-ghost {
  padding: 6px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink-2);
  font-size: 13px;
}

.btn-ghost:hover { border-color: var(--ink-2); }

.layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.ds-list {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ds-search {
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
}

.batch-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.batch-label {
  font-size: 11px;
  color: var(--stone);
}

.batch-select {
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
  width: 100%;
}

.ds-none {
  margin: 0;
  padding: 12px 0;
  text-align: center;
  font-size: 12px;
  color: var(--stone);
}

.ds-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  padding: 16px 12px;
  border: 1.5px dashed var(--line-strong);
  border-radius: 8px;
  background: var(--paper);
  transition: border-color 0.15s, background 0.15s;
}

.ds-dropzone:hover {
  border-color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.ds-dropzone-main { font-size: 13px; color: var(--ink-2); font-weight: 600; }
.ds-dropzone-sub { font-size: 11px; color: var(--stone); }

.ds-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
  text-align: left;
}

.ds-item:hover { border-color: var(--line-strong); }

.ds-item.active {
  border-color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.ds-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}

.ds-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-print-flag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: var(--cinnabar);
  line-height: 1.5;
}

.ds-meta { font-size: 11px; color: var(--stone); }

/* 已打印过的工作簿：淡赭弱化底色——打过的不用再看，未打的保持白纸显眼（遗漏一眼可辨） */
.ds-item.printed { background: var(--ok-soft); }

.ds-printed-flag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ok);
  border: 1px solid var(--ok);
  line-height: 1.5;
}

.ds-detail { flex: 1; min-width: 0; }

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.detail-title { font-size: 16px; font-weight: 600; color: var(--ink); }
.detail-sub { font-size: 12px; color: var(--stone); margin-top: 4px; }
.printed-note { color: var(--ok); }

.section-title {
  font-size: 14px;
  color: var(--ink);
  margin: 20px 0 8px;
  padding-left: 8px;
  border-left: 3px solid var(--line-strong);
}

.alias-text {
  cursor: pointer;
  color: var(--ink);
  border-bottom: 1px dashed var(--line-strong);
}

.alias-text:hover { color: var(--cinnabar); }

.alias-input {
  padding: 2px 6px;
  border: 1px solid var(--cinnabar);
  border-radius: 4px;
  font-size: 12px;
  width: 90px;
  background: var(--paper-card);
  color: var(--ink);
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper-card);
}

.row-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.row-table th, .row-table td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-table th {
  color: var(--ink-2);
  background: var(--paper);
  font-weight: 600;
  position: sticky;
  top: 0;
}

.row-table td.empty { color: var(--stone); font-style: italic; }
.row-table td.empty::before { content: '空'; opacity: 0.6; }

/* ---- 可编辑数据表格 ---- */
.section-title { display: flex; align-items: baseline; gap: 10px; }
.grid-meta { font-size: 12px; font-weight: 400; color: var(--stone); }

.grid-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.tb-hint { font-size: 12px; color: var(--stone); }

.edit-grid td.cell {
  cursor: text;
  min-width: 80px;
  transition: background 0.12s;
}
.edit-grid td.cell:hover { background: var(--cinnabar-soft); }
.edit-grid td.cell.editing { padding: 2px 4px; }
.edit-grid td.cell.editing::before { content: none; }
.edit-grid td.cell.editing { font-style: normal; color: var(--ink); }

/* 去补录直达：目标格闪烁提示（朱砂描边脉动两次） */
.edit-grid td.cell.flash {
  animation: cell-flash 1.2s ease-in-out 2;
}
@keyframes cell-flash {
  0%, 100% { box-shadow: inset 0 0 0 0 transparent; }
  50% { box-shadow: inset 0 0 0 2px var(--cinnabar); }
}

.cell-input {
  width: 100%;
  min-width: 90px;
  padding: 2px 6px;
  border: 1px solid var(--cinnabar);
  border-radius: 4px;
  background: var(--paper-card);
  color: var(--ink);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.rownum-col, .op-col {
  width: 44px;
  text-align: center !important;
  color: var(--stone);
  background: var(--paper);
  font-size: 11px;
}

/* ---- 列级打印开关 + 列显隐 ---- */
.col-head { white-space: nowrap; }
/* 列名必须出省略号：th 有 max-width + overflow:hidden，名字一长就会把后面的
   「印」和「▾」挤出可视区，两个开关都点不到 */
.th-alias {
  display: inline-block;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  margin-right: 6px;
}

.print-toggle {
  padding: 1px 7px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--stone);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  opacity: 0.7; /* 灰度态 = 未启用 */
  transition: color 0.12s, border-color 0.12s, background 0.12s, opacity 0.12s;
}
.print-toggle:hover { border-color: var(--cinnabar); color: var(--cinnabar); opacity: 1; }
.print-toggle.on {
  border-color: var(--cinnabar);
  background: var(--cinnabar);
  color: #fff;
  opacity: 1;
  font-weight: 600;
}

/* 列头「▾」：默认隐身，hover 才现——列头已有「改名 / 印」两个热区，
   第三个只该在需要时出现。opacity 而非 display，避免 hover 时列宽抖动 */
.col-menu-btn {
  margin-left: 2px;
  padding: 0 3px;
  border: none;
  background: transparent;
  color: var(--stone);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
}
.col-head:hover .col-menu-btn,
.col-menu-btn.on,
.col-menu-btn:focus-visible { opacity: 0.75; }
.col-menu-btn:hover { color: var(--cinnabar); opacity: 1; }

/* 工具栏的回头路：只在真有隐藏列时出现，是用户唯一的「找回列」入口 */
.hidden-pill {
  padding: 4px 10px;
  border: 1px solid var(--cinnabar);
  border-radius: 12px;
  background: var(--cinnabar-soft);
  color: var(--cinnabar);
  font-size: 12px;
}
.hidden-pill:hover { background: var(--cinnabar); color: #fff; }

/* 浮层菜单（Teleport 到 body）：th 的 overflow:hidden 会裁掉留在表头里的浮层 */
.col-menu {
  position: fixed;
  z-index: 200;
  min-width: 200px;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--paper-card);
  box-shadow: var(--shadow);
}
.cm-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  text-align: left;
}
.cm-item:hover:not(:disabled) { background: var(--cinnabar-soft); color: var(--cinnabar); }
.cm-item:disabled { color: var(--stone); cursor: default; }
.cm-hint {
  margin-top: 4px;
  padding: 6px 10px 4px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--stone);
}
.list-menu { max-height: 320px; overflow-y: auto; }
.cm-title { padding: 6px 10px 4px; font-size: 11px; color: var(--stone); }
.cm-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
}
.cm-check:hover { background: var(--cinnabar-soft); }
.cm-check-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 在菜单里就标出哪些列已激活「印」：免得用户为了看一眼又得关掉菜单 */
.cm-print-flag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--cinnabar);
  color: #fff;
  font-size: 10px;
  line-height: 1.5;
}
.cm-restore { margin-top: 4px; }

.row-del {
  padding: 1px 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--stone);
  font-size: 11px;
  cursor: pointer;
}
.row-del:hover { color: var(--cinnabar); border-color: var(--cinnabar); }

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 12px;
}
.pager-info { font-size: 12px; color: var(--ink-2); }

/* ---- 表格字号档位（阅读体验用户自调） ---- */
.size-group {
  display: flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  overflow: hidden;
}
.size-label {
  padding: 4px 8px;
  font-size: 12px;
  color: var(--stone);
  background: var(--paper);
}
.size-item {
  padding: 4px 10px;
  border: none;
  border-left: 1px solid var(--line);
  background: var(--paper-card);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}
.size-item:hover { color: var(--cinnabar); }
.size-item.on {
  background: var(--cinnabar-soft);
  color: var(--cinnabar);
  font-weight: 600;
}

.page[data-size='s'] .edit-grid { font-size: 11px; }
.page[data-size='m'] .edit-grid { font-size: 12px; }
.page[data-size='l'] .edit-grid { font-size: 14px; }
.page[data-size='xl'] .edit-grid { font-size: 16px; }

.page[data-size='l'] .edit-grid td.cell { min-width: 100px; }
.page[data-size='xl'] .edit-grid td.cell { min-width: 120px; }
.cell-input { font-size: inherit; }
.size-item, .row-del { font-size: 12px; }
</style>

<script setup>
/**
 * 打印中心：批量发起（数据集 × 模板）→ 出口校验弹窗（可中断可放行）
 * → 导出 PDF / 直接送打印 → 打印历史留痕与归档件回看。
 * 预览用 iframe srcdoc 直接承载渲染引擎输出的批量 HTML。
 */
import { ref, computed, watch, onActivated, onDeactivated, onBeforeUnmount, nextTick } from 'vue'
import CustomSelect from '../components/CustomSelect.vue'
import { isNonFunctionalArea } from '../lib/interaction-area.js'
import PageHeader from '../components/PageHeader.vue'
import AppIcon from '../components/AppIcon.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { gotoCell } from '../lib/cell-nav.js'
import { resolveReprintScope, layoutFallbackText, filterRowIndexes } from '../lib/print-scope.cjs'
import { formatBytes } from '../lib/format-bytes.cjs'
import { toUserMessage } from '../../electron/user-error.cjs'
import { FORMATS } from '../../electron/export-formats.cjs'
import { designerNav, openDesigner } from '../lib/designer-nav.js'
import { openSinglePhoto, photoNav } from '../lib/photo-nav.js'

defineOptions({ name:'PrintCenterView' })

const datasets = ref([])
const templates = ref([])
const jobs = ref([])
const historyOpen = ref(false)
const selectedJobIds = ref([])
const historyDeleting = ref(false)
const allHistorySelected = computed(() => jobs.value.length > 0 && jobs.value.every(job => selectedJobIds.value.includes(job.id)))
const selDs = ref('')
const selTpl = ref('')
const previewHtml = ref('')
const previewInfo = ref(null)
const zoom = ref('75')
const busy = ref(false)
const previewPage = ref(0)
const previewFrame = ref(null)
const photoEdit = ref(null)
const photoEditActive = ref(false)
const photoEditBusy = ref(false)
const photoEditError = ref('')
const photoInteraction = ref(false)
const photoEditDirty = computed(() => {
  const edit = photoEdit.value
  return !!edit && (edit.resetRequested || edit.fit !== edit.initialFit || ['x', 'y'].some(k => edit.position[k] !== edit.initialPosition[k] || edit.focal[k] !== edit.initialFocal[k]) || ['w', 'h'].some(k => edit.size[k] !== edit.initialSize[k]))
})
const previewPageInput = ref('1')
const previewPageCount = computed(() => Math.max(1, Number(previewInfo.value?.pageCount) || 1))
const previewPagingDisabled = computed(() => busy.value || previewLoading.value || photoEditBusy.value || photoEditDirty.value || photoInteraction.value)
watch(previewPage, page => { previewPageInput.value = String(page + 1) })

function jumpToPreviewPage() {
  const input = previewPageInput.value.trim()
  if (!previewPagingDisabled.value && /^\d+$/.test(input)) {
    const page = Number(input)
    if (Number.isSafeInteger(page)) previewPage.value = Math.max(1, Math.min(previewPageCount.value, page)) - 1
  }
  previewPageInput.value = String(previewPage.value + 1)
}

function stepPreviewPage(step) {
  if (previewPagingDisabled.value) return
  previewPage.value = Math.max(0, Math.min(previewPageCount.value - 1, previewPage.value + step))
}

function onPreviewPageKey(event) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
  if (!previewInfo.value || previewPagingDisabled.value || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
  if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="listbox"], [role="menu"], [role="tablist"]')) return
  if (document.querySelector('.modal-mask, .cd-mask, .onboard-mask, [role="dialog"], [role="alertdialog"], .custom-select .cs-menu')) return
  event.preventDefault()
  stepPreviewPage(event.key === 'ArrowLeft' ? -1 : 1)
}
const recordDesignRow = ref(null), recordDesignInfo = ref(null), recordDesignBusy = ref(false)
const singlePhotoBusy = ref(false)
let recordDesignSeq = 0
let returnedPhotoRowId = ''
let photoEditSeq = 0
let photoDrag = null
let photoKeyTimer = null
let photoFocusSign = 1
onBeforeUnmount(() => { if (photoKeyTimer) finishPhotoKeys() })
/**
 * 出片分辨率（契约 I-49）。值域与后端权威 `OUTPUT_DPI_VALUES` 一致，
 * 「原图」用 `'original'`——后端把它归一化成 `null`。
 *
 * 为什么是**字符串**而不是数字：CustomSelect 的 value 要能表达「原图」这个非数字档位，
 * 且字符串不会在 v-model 里被 Number 转换吃掉。
 */
const outputDpi = ref('300')
const outputDpiOptions = [
  { value: '150', label: '150 dpi（省体积）' },
  { value: '300', label: '300 dpi（推荐）' },
  { value: '600', label: '600 dpi（高精）' },
  { value: 'original', label: '原图（不压缩）' },
]
const previewLoading = ref(false)
const activeJobKey = ref('')
const taskProgress = ref(null)
const cancelRequested = ref(false)
const cancelable = computed(() => activeJobKey.value && !activeJobKey.value.startsWith('images-') && !cancelRequested.value && !['single', 'merge', 'publish', 'finished'].includes(taskProgress.value?.phase))
const progressText = computed(() => {
  const p = taskProgress.value
  if (cancelRequested.value) return '正在取消，等待当前批次结束；已提交的打印内容无法撤回。'
  if (!p) return '正在准备出片…'
  if (p.phase === 'merge') return '正在合并 PDF…'
  if (p.phase === 'publish') return 'PDF 已生成，正在保存归档…'
  if (p.phase === 'image-done') return `已导出 ${p.index} / ${p.total} 张图片`
  if (p.phase === 'single') return '正在输出当前批次…'
  if (p.phase === 'batch-start') return `正在导出第 ${p.index} / ${p.batches} 批`
  if (p.phase === 'batch-done') return `已完成 ${p.index} / ${p.batches} 批`
  if (p.phase === 'submit-start') return `正在提交第 ${p.index} / ${p.batches} 批打印`
  if (p.phase === 'submit-done') return `已提交 ${p.submitted} 批打印`
  return '正在准备出片…'
})
const offPrintProgress = window.printpress.onPrintProgress(p => {
  if (p.jobKey === activeJobKey.value) taskProgress.value = p
})
onBeforeUnmount(offPrintProgress)
async function cancelOutput() {
  if (!cancelable.value) return
  try {
    const r = await window.printpress.printCancel(activeJobKey.value)
    if (r.ok) cancelRequested.value = true
  } catch (err) { say(`取消失败：${toUserMessage(err)}`) }
}
const toast = ref('')
const outputRecordWarning = ref('')
/** 预览请求序号：晚到的旧响应据此丢弃（见 rebuildPreview） */
let previewSeq = 0

// 出口校验弹窗：pendingAction 记录用户最初想执行的动作
const showValidate = ref(false)
const validateResult = ref(null)
const pendingAction = ref('')
const pendingPhotoFingerprint = ref('')
const photoPreflight = ref(null)
const photoPreflightLoading = ref(false)
const photoPreflightError = ref('')
const photoIssueFilter = ref('')
const photoIssuesOpen = ref(false)
let photoPreflightSeq = 0
const visiblePhotoIssues = computed(() => photoPreflight.value?.issues.filter(item => !photoIssueFilter.value || item.status === photoIssueFilter.value) || [])
const photoStatusLabel = { missing: '缺图', ambiguous: '同名冲突', invalid: '名称无效', broken: '坏图' }
/** 字段缺失是结构性错误，放行只会白版——弹窗中不可「仍要继续」 */
const hasMissingIssue = computed(() =>
  Boolean(validateResult.value?.issues.some((i) => i.missing)))
/** 其中「已取消『印』」这一类：出路是回数据页激活，不是改模板 */
const hasUnprintableIssue = computed(() =>
  Boolean(validateResult.value?.issues.some((i) => i.missing && i.reason === 'not-printable')))

const dsOptions = computed(() =>
  datasets.value.map((d) => ({ value: d.id, label: `${d.name}（${d.rowCount} 行）` })))
// 只挡「画布上一个字段都没有」的半成品模板；无底图的白纸版式（多联证卡/对折桌牌）是合法可打的，
// v0.1 起误加 hasBackground 条件把这类模板全部挡在下拉外，v0.2.3 修正
const tplOptions = computed(() =>
  templates.value
    .filter((t) => t.fieldCount > 0 || t.photoCount > 0)
    .map((t) => ({ value: t.id, label: t.datasetName ? `${t.name} × ${t.datasetName}` : t.name,
      badge: t.photoCount > 0 ? '变量图' : '' })))
const ready = computed(() => Boolean(selDs.value && selTpl.value))
const dsTotalRows = computed(() => datasets.value.find((d) => d.id === selDs.value)?.rowCount ?? 0)
/** 当前选中模板（含绑定信息） */
const boundTpl = computed(() => templates.value.find((t) => t.id === selTpl.value) || null)

// 当前数据集的打印统计（从历史留痕聚合）：对照工作簿，遗漏一眼可辨
const dsPrintStats = computed(() => {
  if (!selDs.value) return null
  const ds = datasets.value.find((d) => d.id === selDs.value)
  if (!ds) return null
  const mine = jobs.value.filter((j) => j.datasetId === selDs.value && j.status === 'ok')
  // 主口径只算全量出片（与数据页侧栏「已打」徽标一致）；补打单独统计，不混进主数字
  const full = mine.filter((j) => !j.partial)
  const part = mine.filter((j) => j.partial)
  return {
    name: ds.name,
    rowCount: ds.rowCount,
    times: full.length,
    pages: full.reduce((s, j) => s + (j.recordCount || 0), 0),
    partialTimes: part.length,
    partialRows: part.reduce((s, j) => s + (j.recordCount || 0), 0),
    last: mine[0]?.createdAt || '',
  }
})
/** 模板绑定的数据集已被删除：打印链路走不通，须显式告知出路 */
const boundDsMissing = computed(() =>
  Boolean(boundTpl.value && boundTpl.value.datasetId
    && !datasets.value.some((d) => d.id === boundTpl.value.datasetId)))

// ---- 行级出片范围（不变量「留痕必全，状态只认全量」）----
// selRows = null 表示全量；数组为 0 基索引集合（基于数据集全量行序）。
// 部分出片不回写数据集「已打」状态，避免「打了 3 个人却显示整份已打」。
const selRows = ref(null)
const selRowsMeta = ref(null) // { dsId, recordIds }：以人员身份追踪选择
const scopeNeedsReview = ref(false)
const dsDetail = ref(null)    // 当前数据集完整数据（行选择面板用）
const imageNameField1 = ref('')
const imageNameField2 = ref('')
const imageFormat = ref('png')
const imageQuality = ref(90)
const imageFormatOptions = Object.keys(FORMATS).map(value => ({ value, label: value === 'jpeg' ? 'JPG / JPEG' : value.toUpperCase() }))
const imageFormatLabel = computed(() => imageFormat.value === 'jpeg' ? 'JPG' : imageFormat.value.toUpperCase())
watch(imageFormat, value => { imageQuality.value = FORMATS[value]?.quality ?? 90 }, { flush: 'sync' })
const imageNameFieldOptions = computed(() => (dsDetail.value?.columns || []).map(column => ({
  value: column.key, label: column.label || column.name || column.key,
})))
const scopeOpen = ref(false)
const scopeSearch = ref('')
const scopePicked = ref(new Set())
const SCOPE_RENDER_CAP = 300  // 面板最多渲染行数（大表防卡顿，搜索仍作用于全量）

const dsRowCount = computed(() => dsDetail.value?.rows.length ?? 0)
const scopeLabel = computed(() =>
  (selRows.value ? `已选 ${selRows.value.length} / ${dsRowCount.value} 行` : `全部 ${dsRowCount.value} 行`))

/**
 * 搜索命中行（匹配任一列的值，大小写不敏感）。
 * 输入防抖 150ms：5000 行的表每次击键都要全表扫，
 * 一边打字一边出结果会把输入框卡到掉帧。
 */
const scopeSearchDebounced = ref('')
let scopeSearchTimer = null
watch(scopeSearch, (v) => {
  clearTimeout(scopeSearchTimer)
  scopeSearchTimer = setTimeout(() => { scopeSearchDebounced.value = v }, 150)
})
onBeforeUnmount(() => clearTimeout(scopeSearchTimer))

const scopeFiltered = computed(() =>
  filterRowIndexes(dsDetail.value?.rows, scopeSearchDebounced.value))
const scopeVisible = computed(() => scopeFiltered.value.slice(0, SCOPE_RENDER_CAP))

function rowPreview(row) {
  const cols = dsDetail.value?.columns || []
  const vals = cols.slice(0, 4).map((c) => String(row[c.key] ?? '').trim()).filter(Boolean)
  return vals.join(' · ') || '（空行）'
}

const pageRecordIndexes = computed(() => {
  const rows = selRows.value || Array.from({ length:dsDetail.value?.rows?.length || 0 }, (_, i) => i)
  if (!previewInfo.value) return rows
  const perPage = previewInfo.value?.layout?.perPage || 1
  return rows.slice(previewPage.value * perPage, (previewPage.value + 1) * perPage)
})
watch(pageRecordIndexes, indexes => { if (dsDetail.value && !indexes.includes(recordDesignRow.value)) recordDesignRow.value = indexes[0] ?? null })
watch([recordDesignRow, selDs, selTpl, dsDetail], async () => {
  const seq = ++recordDesignSeq
  recordDesignInfo.value = null
  const rowId = dsDetail.value?.recordIds?.[recordDesignRow.value]
  if (!rowId || !selDs.value || !selTpl.value) return
  try { const info = await window.printpress.getRecordDesign({ datasetId:selDs.value, templateId:selTpl.value, rowId }); if (seq === recordDesignSeq) recordDesignInfo.value = info } catch { /* template or preview will explain unavailable input */ }
})
async function editRecordDesign() {
  if (recordDesignBusy.value || recordDesignRow.value === null) return
  const rowId = dsDetail.value?.recordIds?.[recordDesignRow.value]
  if (!rowId) { say('人员记录已变化，请重新预览'); return }
  recordDesignBusy.value = true
  try {
    const info = await window.printpress.getRecordDesign({ datasetId:selDs.value, templateId:selTpl.value, rowId })
    openDesigner({ ...info, origin:'print' })
  } catch (err) { say(`无法打开单人底图：${toUserMessage(err)}`) }
  finally { recordDesignBusy.value = false }
}
async function editSinglePhoto() {
  if (singlePhotoBusy.value || recordDesignRow.value === null) return
  const datasetId = selDs.value, templateId = selTpl.value, rowId = dsDetail.value?.recordIds?.[recordDesignRow.value]
  if (!rowId) { say('人员记录已变化，请重新预览'); return }
  singlePhotoBusy.value = true
  try {
    const detail = await window.printpress.getDataset(datasetId), rowIndex = detail.recordIds?.indexOf(rowId) ?? -1
    if (rowIndex < 0 || !detail.photoMatchColumn) throw new Error('人员记录或配图设置已变化，请重新预览')
    const report = await window.printpress.photoReport({ datasetId, column: detail.photoMatchColumn, rows: [rowIndex] })
    if (report.results.find(row => row.rowIndex === rowIndex)?.status !== 'matched') throw new Error('此人没有可用的匹配照片，请先在变量照片页检查')
    if (datasetId !== selDs.value || templateId !== selTpl.value) return
    openSinglePhoto({ origin: 'print', datasetId, templateId, rowId, label: rowPreview(detail.rows[rowIndex]) })
  } catch (err) { say(`无法打开单张照片：${toUserMessage(err)}`) }
  finally { singlePhotoBusy.value = false }
}
watch(() => photoNav.result, result => {
  if (!result || result.origin !== 'print' || result.datasetId !== selDs.value || result.templateId !== selTpl.value) return
  photoEditSeq++; photoEdit.value = null; photoDrag = null; photoInteraction.value = false
  returnedPhotoRowId = result.rowId
  // Returning activates this kept-alive view; onActivated reloads preview and preflight.
  if (result.changed) say('已更新此人的照片，其他人员保持原样')
})
async function clearRecordDesign() {
  const rowId = dsDetail.value?.recordIds?.[recordDesignRow.value]
  if (!rowId || recordDesignBusy.value) return
  recordDesignBusy.value = true
  try {
    await window.printpress.clearRecordDesign({ datasetId:selDs.value, templateId:selTpl.value, rowId })
    photoEditSeq++; photoEdit.value = null; photoDrag = null; photoInteraction.value = false
    recordDesignInfo.value = await window.printpress.getRecordDesign({ datasetId:selDs.value, templateId:selTpl.value, rowId })
    await Promise.all([rebuildPreview(), loadPhotoPreflight()])
    say('已恢复此人的模板默认底图')
  } catch (err) { say(`恢复失败：${toUserMessage(err)}`) }
  finally { recordDesignBusy.value = false }
}
watch(() => designerNav.result, async result => {
  if (!result || result.origin !== 'print' || result.datasetId !== selDs.value || result.templateId !== selTpl.value) return
  photoEditSeq++; photoEdit.value = null; photoDrag = null; photoInteraction.value = false
  await Promise.all([rebuildPreview(), loadPhotoPreflight()])
  if (result.rowId) {
    try { recordDesignInfo.value = await window.printpress.getRecordDesign({ datasetId:selDs.value, templateId:selTpl.value, rowId:result.rowId }) } catch { recordDesignInfo.value = null }
  }
  if (!result.canceled) say('已保存此人的独立底图，其他人员保持原模板')
})

async function loadDetail() {
  dsDetail.value = null
  if (!selDs.value) return
  try { dsDetail.value = await window.printpress.getDataset(selDs.value) } catch { /* 预览/打印会兜底报错 */ }
}

/** 设置出片范围：null = 全量；数组 = 部分。同时记录行数快照供漂移守卫比对 */
function setScope(rows) {
  selRows.value = Array.isArray(rows) && rows.length ? [...rows].sort((a, b) => a - b) : null
  selRowsMeta.value = selRows.value ? { dsId: selDs.value, recordIds: selRows.value.map(index => dsDetail.value?.recordIds?.[index]) } : null
  scopeNeedsReview.value = Boolean(selRowsMeta.value?.recordIds.some(id => !id))
}

/** 重新按稳定人员 ID 定位，删除所选人员时要求用户重新确认范围。 */
async function guardScope() {
  if (!selRows.value || !selRowsMeta.value) return
  try {
    const cur = await window.printpress.getDataset(selRowsMeta.value.dsId)
    const resolved = resolveReprintScope({ partial: true, selection: selRows.value, selectionIds: selRowsMeta.value.recordIds }, cur.recordIds)
    if (resolved.reason) throw new Error(resolved.reason)
    if (resolved.rows.some((row, i) => row !== selRows.value[i])) selRows.value = resolved.rows
  } catch (err) {
    selRows.value = null
    selRowsMeta.value = null
    scopeNeedsReview.value = true
    say('名单或所选人员已变化，请重新选择打印范围')
  }
}

function openScope() {
  if (!dsDetail.value) return
  clearTimeout(scopeSearchTimer)
  scopeSearch.value = ''
  scopeSearchDebounced.value = '' // 同步清防抖值，否则面板会带着上次的过滤结果打开
  scopePicked.value = new Set(selRows.value || Array.from({ length: dsRowCount.value }, (_, i) => i))
  scopeOpen.value = true
}

function toggleScopeRow(i) {
  const s = new Set(scopePicked.value)
  if (s.has(i)) s.delete(i); else s.add(i)
  scopePicked.value = s
}

function scopeSelectAll() { scopePicked.value = new Set(Array.from({ length: dsRowCount.value }, (_, i) => i)) }
function scopeSelectNone() { scopePicked.value = new Set() }
function scopeAddFiltered() {
  const s = new Set(scopePicked.value)
  for (const i of scopeFiltered.value) s.add(i)
  scopePicked.value = s
}

function confirmScope() {
  const picked = [...scopePicked.value].sort((a, b) => a - b)
  if (!picked.length) { say('请至少勾选一行'); return }
  // 勾满全部 = 全量：走默认路径，仍回写数据集状态（与不变量口径一致）
  setScope(picked.length === dsRowCount.value ? null : picked)
  scopeOpen.value = false
  say(selRows.value
    ? `出片范围：已选 ${selRows.value.length} / ${dsRowCount.value} 行（部分出片，不改数据集状态）`
    : '出片范围：全部行')
}

// ---- 换绑数据集：模板 × 数据集字段匹配校验（缺失即阻止） ----
const rebindShow = ref(false)
const rebindDsId = ref('')
const rebindResult = ref(null)
const rebindBusy = ref(false)
const rebindOptions = computed(() =>
  datasets.value
    .filter((d) => d.id !== boundTpl.value?.datasetId)
    .map((d) => ({ value: d.id, label: `${d.name}（${d.rowCount} 行）` })))

const zoomOptions = [
  { value: '25', label: '25%' },
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
  { value: '100', label: '100%' },
  { value: '125', label: '125%' },
]
const zoomK = computed(() => Number(zoom.value) / 100)

/**
 * 底图输出清晰度的分级样式：≥300dpi 正常、150–300 提醒、<150 警示。
 * 判定用**取整后**的值——纸张毫米是整数，A4@300dpi 的 2480px 底图算出来是 299.96，
 * 不取整会让标准的 300dpi 图被判成「偏低」，而界面上同时还写着「约 300 dpi」，自相矛盾。
 * 与 src/lib/template-layout.cjs 的 computeBgDpi 用同一口径。
 */
function dpiClass(dpi) {
  if (!dpi) return ''
  const n = Math.round(dpi)
  if (n >= 300) return 'dpi-good'
  if (n >= 150) return 'dpi-ok'
  return 'dpi-low'
}

// 页面毫米 → px（96dpi），iframe 视口 = 内容全宽（毫米换算像素），transform 只负责显示缩放
const frameW = computed(() => previewInfo.value ? Math.round(previewInfo.value.page.w * 96 / 25.4) : 794)
const frameH = computed(() => previewInfo.value ? Math.round(previewInfo.value.page.h * 96 / 25.4) : 1123)
// iframe 高度铺满全部页数 +8px 余量：内部出现任何滚动条都会吃掉宽度造成横向裁边。
// 注意用 pageCount（纸张页数）而非 recordCount——多联下一页装多条记录，用记录数会把 iframe 撑高
const frameTotalH = computed(() => frameH.value * (previewInfo.value?.renderedPageCount || 1) + 8)

/**
 * 多联回退提示文案。仅在 layout.enabled === false 且原mode 是 grid/fold 时给文案：
 * 单页版式本来就是 enabled:false，不该被当成「出问题了」。
 */
const layoutFallback = computed(() => layoutFallbackText(previewInfo.value?.layout))

function say(msg) {
  toast.value = msg
  setTimeout(() => { if (toast.value === msg) toast.value = '' }, 4000)
}

watch(jobs, (items) => { const valid = new Set(items.map(job => job.id)); selectedJobIds.value = selectedJobIds.value.filter(id => valid.has(id)) })

async function refreshAll() {
  // 三个清单各自独立 catch：任何一个失败都不该让整页空白（onMounted 直调，
  // 一次 reject 就是白屏），也不该把「IPC 没连通」伪装成「还没导入任何数据」
  try {
    datasets.value = await window.printpress.listDatasets()
  } catch (err) {
    say(`数据集清单读取失败：${toUserMessage(err)}`)
  }
  try {
    templates.value = await window.printpress.listTemplates()
  } catch (err) {
    say(`模板清单读取失败：${toUserMessage(err)}`)
  }
  try {
    jobs.value = await window.printpress.listJobs()
  } catch (err) {
    say(`打印历史读取失败：${toUserMessage(err)}`)
  }
  if (!datasets.value.some((d) => d.id === selDs.value)) selDs.value = ''
  if (!templates.value.some((t) => t.id === selTpl.value)) selTpl.value = ''
  await guardScope()
}

async function rebuildPreview() {
  const seq = ++previewSeq
  if (!ready.value) {
    previewHtml.value = ''
    previewInfo.value = null
    previewLoading.value = false
    return
  }
  // 竞态守卫：快速连切模板/数据集时，先发的请求可能后到，不做序号校验就会
  // 让旧模板的预览盖掉新选择——用户看到的是A 模板的版式，导出的却是 B。
  // 同文件 matchDataset 的 mismatchSeq 是同一范式。
  previewLoading.value = true
  try {
    const built = await window.printpress.printGenerate({ ...buildPayload(), previewPage: previewPage.value })
    if (seq !== previewSeq) return
    previewHtml.value = built.html
    previewInfo.value = built
    // 新选择预览成功：旧选择的失败提示已过时，立即清掉不让它挂在界面上
    if (toast.value) toast.value = ''
  } catch (err) {
    if (seq !== previewSeq) return
    previewHtml.value = ''
    previewInfo.value = null
    say(`预览失败：${toUserMessage(err)}`)
  } finally { if (seq === previewSeq) previewLoading.value = false }
}

/** 统一的打印请求载荷：数据集 × 模板 × 出片范围（rows=null 即全量，作用于全部行） */
function buildPayload() {
  return {
    datasetId: selDs.value,
    templateId: selTpl.value,
    // rows 必须是普通数组：Vue 响应式数组是 Proxy，经 IPC 结构化克隆会抛
    // 「An object could not be cloned.」，故显式拷贝一份再传
    rows: selRows.value ? [...selRows.value] : null,
    // 出片分辨率（I-49）：后端 normalizeOutputDpi 认数字与 'original'，
    // 非法值直接报错而不是静默回退到 300
    outputDpi: outputDpi.value === 'original' ? 'original' : Number(outputDpi.value),
  }
}

async function loadPhotoPreflight() {
  const seq = ++photoPreflightSeq
  photoPreflight.value = null
  photoPreflightError.value = ''
  if (!ready.value) { photoPreflightLoading.value = false; return null }
  photoPreflightLoading.value = true
  try {
    const result = await window.printpress.printPhotoPreflight(buildPayload())
    if (seq !== photoPreflightSeq) return null
    photoPreflight.value = result
    return result
  } catch (err) {
    if (seq === photoPreflightSeq) photoPreflightError.value = toUserMessage(err)
    return null
  } finally {
    if (seq === photoPreflightSeq) photoPreflightLoading.value = false
  }
}

function showPhotoIssues(status) {
  photoIssueFilter.value = status
  photoIssuesOpen.value = true
}

function goPhotoIssue(item) {
  if (photoPreflight.value?.photoColumn) gotoCell(selDs.value, item.rowIndex, photoPreflight.value.photoColumn)
}

function previewPhotoRow(img) {
  const cell = img.closest('.cell')
  const within = cell ? [...cell.parentElement.children].filter(item => item.classList.contains('cell')).indexOf(cell) : 0
  const perPage = previewInfo.value?.layout?.perPage || 1
  const position = (previewInfo.value?.previewPage ?? previewPage.value) * perPage + within
  return selRows.value?.[position] ?? position
}

function syncPhotoPreview() {
  const doc = previewFrame.value?.contentDocument, edit = photoEdit.value
  if (!doc || !edit || !Number.isFinite(edit.position.x) || !Number.isFinite(edit.position.y) || !Number.isFinite(edit.size.w) || !Number.isFinite(edit.size.h)) return
  doc.querySelectorAll('img[data-photo-layer-id]').forEach(img => {
    const layer = img.closest('[data-design-layer]')
    if (!layer) return
    const selected = img.dataset.photoLayerId === edit.layerId && previewPhotoRow(img) === edit.rowIndex
    layer.querySelectorAll('[data-photo-resize]').forEach(handle => { handle.style.display = selected && photoEditActive.value ? 'block' : 'none' })
    if (selected) { layer.style.left = `${edit.position.x}mm`; layer.style.top = `${edit.position.y}mm`; layer.style.width = `${edit.size.w}mm`; layer.style.height = `${edit.size.h}mm`; layer.style.outline = photoEditActive.value ? '2px solid #d34f32' : ''; layer.style.outlineOffset = '-1px'; img.style.objectFit = edit.fit; img.style.objectPosition = `${edit.focal.x * 100}% ${edit.focal.y * 100}%` }
  })
}

function clearPhotoPreview() {
  const doc = previewFrame.value?.contentDocument, edit = photoEdit.value
  if (!doc || !edit) return
  doc.querySelectorAll('img[data-photo-layer-id]').forEach(img => {
    if (img.dataset.photoLayerId !== edit.layerId || previewPhotoRow(img) !== edit.rowIndex) return
    const layer = img.closest('[data-design-layer]')
    if (layer) { layer.style.left = `${edit.initialPosition.x}mm`; layer.style.top = `${edit.initialPosition.y}mm`; layer.style.width = `${edit.initialSize.w}mm`; layer.style.height = `${edit.initialSize.h}mm`; layer.style.outline = ''; img.style.objectFit = edit.initialFit; img.style.objectPosition = `${edit.initialFocal.x * 100}% ${edit.initialFocal.y * 100}%`; layer.querySelectorAll('[data-photo-resize]').forEach(handle => { handle.style.display = 'none' }) }
  })
}

function closePhotoEdit() {
  if (photoKeyTimer) finishPhotoKeys()
  if (photoEditBusy.value) return
  if (photoEditDirty.value) { photoEditActive.value = false; syncPhotoPreview(); return }
  photoEditSeq++
  clearPhotoPreview()
  photoEdit.value = null
  photoEditActive.value = false
  photoDrag = null
  photoInteraction.value = false
}

function finishPhotoEditOnBlank() {
  if (photoDrag) return
  if (photoKeyTimer) finishPhotoKeys()
  if (photoEditBusy.value) { photoEditActive.value = false; syncPhotoPreview(); return }
  if (photoEdit.value) closePhotoEdit()
  else if (!photoInteraction.value) photoEditSeq++
}

function discardPhotoEdit() {
  if (photoEditBusy.value || photoInteraction.value) return
  clearPhotoPreview()
  photoEditSeq++
  photoEdit.value = null
  photoEditActive.value = false
  photoEditError.value = ''
}

function resetPhotoEdit() {
  const edit = photoEdit.value
  if (!edit || photoEditBusy.value || photoInteraction.value) return
  edit.position = { ...edit.defaultPosition }
  edit.size = { ...edit.defaultSize }
  edit.fit = edit.defaultFit
  edit.focal = { ...edit.defaultFocal }
  edit.resetRequested = true
  photoEditError.value = ''
  syncPhotoPreview()
}

function onBlankPointerDown(event) {
  if (event.button !== 0) return
  if (isNonFunctionalArea(event.target, '.photo-edit, .preview-frame')) finishPhotoEditOnBlank()
}

function onPreviewFrameLoad(event) {
  let doc
  try { doc = event.target.contentDocument } catch { return }
  if (!doc) return
  doc.addEventListener('click', event => {
    if (event.detail !== 0 || photoDrag) return
    const img = event.target.closest?.('img[data-photo-layer-id]')
    if (!img) return
    const rowIndex = previewPhotoRow(img)
    if (photoEdit.value?.rowIndex !== rowIndex || photoEdit.value?.layerId !== img.dataset.photoLayerId) {
      if (photoEditDirty.value) { photoEditError.value = '请先保存或撤销当前照片调整'; return }
      openPhotoEdit(rowIndex, img.dataset.photoLayerId)
    } else { photoEditActive.value = true; syncPhotoPreview() }
  })
  doc.addEventListener('pointerdown', event => {
    const handle = event.target.closest?.('[data-photo-resize]')
    const img = handle ? handle.parentElement.querySelector('img[data-photo-layer-id]') : event.target.closest?.('img[data-photo-layer-id]'), edit = photoEdit.value
    if (event.button !== 0) return
    if (!img) {
      if (!event.target.closest?.('button, input, textarea, select, a, label, [contenteditable="true"]')) finishPhotoEditOnBlank()
      return
    }
    if (photoEditBusy.value || busy.value) return
    if (photoKeyTimer) { finishPhotoKeys(); return }
    event.preventDefault()
    const rowIndex = previewPhotoRow(img), layerId = img.dataset.photoLayerId
    const same = edit?.rowIndex === rowIndex && edit?.layerId === layerId
    if (!same && photoEditDirty.value) { photoEditError.value = '请先保存或撤销当前照片调整'; return }
    if (same) { photoEditActive.value = true; syncPhotoPreview() }
    photoFocusSign = img.closest('.fold-half.flip') ? -1 : 1
    img.focus({ preventScroll:true })
    const drag = { pointerId:event.pointerId, x:event.clientX, y:event.clientY, lastX:event.clientX, lastY:event.clientY,
      position:same ? { ...edit.position } : null, size:same ? { ...edit.size } : null, rotation:same ? edit.rotation : 0,
      mode:handle ? 'resize' : 'move', handle:handle?.dataset.photoResize || '', sign:photoFocusSign, ended:false, moved:false }
    photoDrag = drag
    photoInteraction.value = true
    event.target.setPointerCapture(event.pointerId)
    if (!same) openPhotoEdit(rowIndex, layerId).then(() => {
      if (photoDrag !== drag) return
      if (photoEdit.value?.rowIndex !== rowIndex || photoEdit.value?.layerId !== layerId) { photoDrag = null; photoInteraction.value = false; return }
      drag.position = { ...photoEdit.value.position }
      drag.size = { ...photoEdit.value.size }; drag.rotation = photoEdit.value.rotation
      applyPhotoDrag(drag)
      if (drag.ended) { photoDrag = null; photoInteraction.value = false }
    })
  })
  doc.addEventListener('pointermove', event => {
    if (!photoDrag || photoDrag.pointerId !== event.pointerId) return
    photoDrag.lastX = event.clientX; photoDrag.lastY = event.clientY
    if (Math.abs(photoDrag.lastX-photoDrag.x) + Math.abs(photoDrag.lastY-photoDrag.y) > 1) photoDrag.moved = true
    applyPhotoDrag(photoDrag)
  })
  const stopDrag = event => { if (photoDrag?.pointerId === event.pointerId) { if (photoDrag.position) { photoDrag = null; photoInteraction.value = false } else photoDrag.ended = true } }
  doc.addEventListener('pointerup', stopDrag)
  doc.addEventListener('pointercancel', stopDrag)
  doc.addEventListener('keydown', handlePhotoKey)
  doc.addEventListener('keydown', onPreviewPageKey)
  doc.querySelectorAll('img[data-photo-layer-id]').forEach(img => {
    img.style.cursor = 'grab'; img.style.userSelect = 'none'; img.title = '拖动照片移动，拖动控制点缩放，方向键微调'; img.draggable = false; img.tabIndex = 0
    const layer = img.closest('[data-design-layer]')
    if (layer) for (const [position, x, y, cursor] of [['nw','5px','5px','nwse-resize'],['n','50%','5px','ns-resize'],['ne','calc(100% - 5px)','5px','nesw-resize'],['e','calc(100% - 5px)','50%','ew-resize'],['se','calc(100% - 5px)','calc(100% - 5px)','nwse-resize'],['s','50%','calc(100% - 5px)','ns-resize'],['sw','5px','calc(100% - 5px)','nesw-resize'],['w','5px','50%','ew-resize']]) {
      const handle = doc.createElement('span'); handle.dataset.photoResize = position; handle.title = '拖动调整照片大小'
      handle.style.cssText = `display:none;position:absolute;left:${x};top:${y};transform:translate(-50%,-50%);width:10px;height:10px;background:#fff;border:2px solid #d34f32;box-sizing:border-box;border-radius:2px;cursor:${cursor};z-index:10;touch-action:none`
      layer.appendChild(handle)
    }
  })
  syncPhotoPreview()
  if (photoEdit.value && photoEditActive.value && document.activeElement === previewFrame.value) {
    const target = [...doc.querySelectorAll('img[data-photo-layer-id]')].find(img => img.dataset.photoLayerId === photoEdit.value.layerId && previewPhotoRow(img) === photoEdit.value.rowIndex && Boolean(img.closest('.fold-half.flip')) === (photoFocusSign === -1))
    target?.focus({ preventScroll:true })
  }
}

function finishPhotoKeys() {
  if (!photoKeyTimer) return
  clearTimeout(photoKeyTimer); photoKeyTimer = null
  photoInteraction.value = false
}

function handlePhotoKey(event) {
  if (!photoEdit.value || !photoEditActive.value || photoEditBusy.value || busy.value || photoDrag || event.ctrlKey || event.metaKey || event.altKey) return
  const directions = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] }
  const direction = directions[event.key]
  if (!direction || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return
  event.preventDefault()
  const step = (event.shiftKey ? 1 : .1) * photoFocusSign
  const clamp = n => Math.max(-10000, Math.min(10000, Math.round(n*100)/100))
  photoEdit.value.position.x = clamp(photoEdit.value.position.x + direction[0]*step)
  photoEdit.value.position.y = clamp(photoEdit.value.position.y + direction[1]*step)
  photoEdit.value.resetRequested = false
  syncPhotoPreview()
  photoInteraction.value = true
  clearTimeout(photoKeyTimer)
  photoKeyTimer = setTimeout(finishPhotoKeys, 220)
}

function applyPhotoDrag(drag) {
  if (!drag.position || !photoEdit.value) return
  const mmPerPixel = 25.4 / 96 * drag.sign
  const clamp = value => Math.max(-10000, Math.min(10000, Math.round(value * 100) / 100))
  const dx = (drag.lastX - drag.x) * mmPerPixel, dy = (drag.lastY - drag.y) * mmPerPixel
  if (drag.mode === 'resize') {
    const angle = drag.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
    const sx = drag.handle.includes('e') ? 1 : drag.handle.includes('w') ? -1 : 0
    const sy = drag.handle.includes('s') ? 1 : drag.handle.includes('n') ? -1 : 0
    const w = Math.max(.01, Math.min(10000, Math.round((drag.size.w + sx*(cos*dx + sin*dy))*100)/100))
    const h = Math.max(.01, Math.min(10000, Math.round((drag.size.h + sy*(-sin*dx + cos*dy))*100)/100))
    const dw = w-drag.size.w, dh = h-drag.size.h
    photoEdit.value.size.w = w; photoEdit.value.size.h = h
    photoEdit.value.position.x = clamp(drag.position.x + (cos*sx*dw - sin*sy*dh - dw)/2)
    photoEdit.value.position.y = clamp(drag.position.y + (sin*sx*dw + cos*sy*dh - dh)/2)
  } else {
    photoEdit.value.position.x = clamp(drag.position.x + dx)
    photoEdit.value.position.y = clamp(drag.position.y + dy)
  }
  if (drag.moved) photoEdit.value.resetRequested = false
  syncPhotoPreview()
}

async function openPhotoEdit(rowIndex, layerId) {
  const seq = ++photoEditSeq
  clearPhotoPreview()
  photoEdit.value = null
  photoEditError.value = ''
  try {
    const detail = await window.printpress.getDataset(selDs.value)
    const rowId = detail.recordIds?.[rowIndex]
    if (!rowId) throw new Error('人员记录已变化，请重新预览')
    const key = { datasetId: selDs.value, templateId: selTpl.value, rowId, layerId }
    const current = await window.printpress.getPhotoOverride(key)
    if (seq !== photoEditSeq) return
    if (!current.assetId) throw new Error('当前人员没有可调整的匹配照片')
    recordDesignRow.value = rowIndex
    photoEdit.value = { ...key, rowIndex, label: rowPreview(detail.rows[rowIndex]), assetId: current.assetId,
      displayAssetId: current.displayAssetId || current.assetId, state: current.state, fit: current.fit, initialFit: current.fit, focal: { ...current.focal }, initialFocal: { ...current.focal }, position: { ...current.position }, initialPosition: { ...current.position }, size:{...current.size}, initialSize:{...current.size}, defaultPosition: { ...current.defaultPosition }, defaultSize: { ...current.defaultSize }, defaultFit: current.defaultFit, defaultFocal: { ...current.defaultFocal }, resetRequested: false, rotation:current.rotation }
    photoEditActive.value = true
    syncPhotoPreview()
  } catch (err) { if (seq === photoEditSeq) photoEditError.value = toUserMessage(err) }
}

async function savePhotoEdit() {
  if (!photoEdit.value || photoEditBusy.value) return
  if (!Number.isFinite(photoEdit.value.position.x) || !Number.isFinite(photoEdit.value.position.y) || Math.abs(photoEdit.value.position.x)>10000 || Math.abs(photoEdit.value.position.y)>10000 || !Number.isFinite(photoEdit.value.size.w) || !Number.isFinite(photoEdit.value.size.h) || photoEdit.value.size.w<.01 || photoEdit.value.size.h<.01 || photoEdit.value.size.w>10000 || photoEdit.value.size.h>10000) { photoEditError.value = '请输入有效的位置和宽高'; return }
  photoEditBusy.value = true
  photoEditError.value = ''
  const { datasetId, templateId, rowId, layerId } = photoEdit.value
  const restore = photoEdit.value.resetRequested
  try {
    let current
    if (restore) {
      await window.printpress.clearPhotoOverride({ datasetId, templateId, rowId, layerId })
      current = await window.printpress.getPhotoOverride({ datasetId, templateId, rowId, layerId })
    } else current = await window.printpress.setPhotoOverride({ datasetId, templateId, rowId, layerId,
      fit: photoEdit.value.fit, focal: { x: photoEdit.value.focal.x, y: photoEdit.value.focal.y }, position: { x: photoEdit.value.position.x, y: photoEdit.value.position.y }, size:{ w:photoEdit.value.size.w, h:photoEdit.value.size.h } })
    if (photoEdit.value?.rowId === rowId && photoEdit.value?.layerId === layerId) {
      Object.assign(photoEdit.value, { state: current.state, fit: current.fit, initialFit: current.fit, focal: { ...current.focal }, initialFocal: { ...current.focal }, position: { ...current.position }, initialPosition: { ...current.position }, size: { ...current.size }, initialSize: { ...current.size }, defaultPosition: { ...current.defaultPosition }, defaultSize: { ...current.defaultSize }, defaultFit: current.defaultFit, defaultFocal: { ...current.defaultFocal }, resetRequested: false, rotation: current.rotation })
      syncPhotoPreview()
    }
    loadPhotoPreflight()
    say(restore ? '已恢复此人的默认照片位置' : '已保存此人的照片位置')
  } catch (err) { photoEditError.value = toUserMessage(err) }
  finally { photoEditBusy.value = false }
}

/**
 * 预览栏的两条读数。**必须带「约」字**——体积是模型不是预言（见 output-dpi 顶部），
 * 导出完成后会用真实字节数覆盖。
 * 文案要短：这两条与页数、缩放挤在同一行，写全了会把缩放控件顶出去。
 * 完整说法放 `title`（悬停可见），短文案只留判断所需的那几个数。
 */
const designHint = computed(() => {
  const d = previewInfo.value?.designInfo
  if (!d) return null
  const dpi = d.minDpi == null ? null : Math.round(d.minDpi)
  return {
    tone: dpi == null ? '' : dpiClass(d.minDpi),
    text: `底图 · ${dpi == null ? '无位图' : `最低 ${dpi} dpi`}`,
    title: `图层底图「${d.name}」· 第 ${d.revision} 版 · ${d.layerCount} 个图层 · ${dpi == null ? '文字与形状直接输出，不受分辨率限制' : `图片最低约 ${dpi} dpi（低于 300 印出来可能发虚）`}`,
  }
})

const outputHint = computed(() => {
  const o = previewInfo.value?.output
  if (!o) return null
  const original = previewInfo.value.outputOriginalEstimateBytes
  const partial = previewInfo.value.outputEstimateIncomplete ? '部分照片信息不全，未估体积' : ''
  if (o.dpi == null) {
    const parts = ['原图出片']
    if (original) parts.push(`约 ${formatBytes(original)}`)
    if (partial) parts.push(partial)
    return {
      tone: '',
      text: parts.join(' · '),
      title: `照片按原件嵌入，不做降采样${original ? `；所选范围照片预计约 ${formatBytes(original)}` : ''}${partial ? `；${partial}` : ''}`,
    }
  }
  const parts = [`${o.dpi}dpi`]
  if (o.optimized) parts.push(`${o.optimized} 张${o.encoded ? '已降采样' : '待降采样'}`)
  if (o.keptOriginal) parts.push(`${o.keptOriginal} 张原件`)
  if (o.failed) parts.push(`${o.failed} 张${o.encoded ? '失败留原件' : '未估算'}`)
  if (partial) parts.push(partial)
  const est = previewInfo.value.outputEstimateBytes
  if (est) parts.push(`约 ${formatBytes(est)}${original ? `（原 ${formatBytes(original)}）` : ''}`)
  return {
    tone: 'dpi-good',
    text: parts.join(' · '),
    title: `出片 ${o.dpi}dpi：照片先按图框毫米 × 目标 DPI 降采样，原件不动${o.optimized ? `；本次 ${o.optimized} 张${o.encoded ? '已降到' : '预计降到'}目标像素` : ''}${o.keptOriginal ? `；${o.keptOriginal} 张保持原件` : ''}${o.failed ? `；${o.failed} 张${o.encoded ? '处理失败，保留原件' : '暂无法估算'}` : ''}${partial ? `；${partial}` : ''}${est ? `；所选范围照片预计约 ${formatBytes(est)}${original ? `（原图约 ${formatBytes(original)}）` : ''}` : ''}`,
  }
})

// 模板切换 → 自动带出绑定的数据集（模板保存时已绑定；旧模板未绑定时才需手选）
watch(selTpl, () => {
  const tpl = templates.value.find((t) => t.id === selTpl.value)
  selDs.value = (tpl && tpl.datasetId && datasets.value.some((d) => d.id === tpl.datasetId))
    ? tpl.datasetId
    : ''
})

// 模板字段 × 绑定数据集匹配检查：缺失是结构性错误（导出必白版），前置警告并阻断。
// 竞态守卫：快速连切模板时，旧请求的慢响应不得覆盖新选择的结果。
let mismatchSeq = 0
const mismatch = ref(null)
const mismatched = computed(() => Boolean(mismatch.value && !mismatch.value.ok))
watch([selTpl, selDs], async () => {
  mismatch.value = null
  if (!selTpl.value || !selDs.value) return
  const tpl = templates.value.find((t) => t.id === selTpl.value)
  if (!tpl || !tpl.datasetId || tpl.datasetId !== selDs.value) return // 兼容路径（临时选择）不在此检
  const seq = ++mismatchSeq
  try {
    const r = await window.printpress.matchDataset(selTpl.value, selDs.value)
    if (seq === mismatchSeq) mismatch.value = r
  } catch { /* 校验失败不阻塞预览，导出时 validateBatch 仍会兜底 */ }
})

function openRebind() {
  rebindDsId.value = ''
  rebindResult.value = null
  rebindShow.value = true
}

/** 选择候选数据集后即时做字段匹配预检，结果直接展示 */
watch(rebindDsId, async () => {
  rebindResult.value = null
  if (!rebindDsId.value || !selTpl.value) return
  try {
    rebindResult.value = await window.printpress.matchDataset(selTpl.value, rebindDsId.value)
  } catch (err) {
    say(`匹配校验失败：${toUserMessage(err)}`)
  }
})

async function confirmRebind() {
  if (!rebindResult.value?.ok || rebindBusy.value) return
  rebindBusy.value = true
  try {
    const r = await window.printpress.rebindDataset(selTpl.value, rebindDsId.value)
    rebindShow.value = false
    // 换绑持久化成功：切到新数据集（触发 selDs/selTpl watch 重建预览）
    selDs.value = r.datasetId
    await refreshAll()
    say(`已换绑到「${r.datasetName}」`)
  } catch (err) {
    say(`换绑失败：${toUserMessage(err)}`)
  } finally {
    rebindBusy.value = false
  }
}

// 数据集变化 → 清空行级范围（旧索引对新数据集无意义）并重载行数据
watch(selDs, async () => {
  setScope(null)
  await loadDetail()
  const keys = imageNameFieldOptions.value.map(option => option.value)
  if (!keys.includes(imageNameField1.value)) imageNameField1.value = keys[0] || ''
  if (!keys.includes(imageNameField2.value) || imageNameField2.value === imageNameField1.value) {
    imageNameField2.value = keys.find(key => key !== imageNameField1.value) || ''
  }
})
watch(imageNameField1, value => {
  if (imageNameField2.value === value) {
    imageNameField2.value = imageNameFieldOptions.value.find(option => option.value !== value)?.value || ''
  }
})
// 范围变化同样要重建预览（预览与出片共用同一份范围）
watch([selDs, selTpl, selRows], () => {
  if (previewPage.value !== 0) previewPage.value = 0
  else rebuildPreview()
  photoIssuesOpen.value = false
  photoEdit.value = null
  photoEditError.value = ''
  photoEditSeq++
  photoInteraction.value = false
  loadPhotoPreflight()
})
// 换档位要重算预览里的体积读数。这里**只规划不编码**（后端 encodeDerivatives:false），
// 所以切档位不会触发 500 张照片的首编码，可以放心即时刷新。
watch(outputDpi, () => rebuildPreview())
watch(previewPage, () => { photoEditSeq++; photoEdit.value = null; photoDrag = null; photoInteraction.value = false; rebuildPreview() })

async function exportIndividualImages() {
  if (!ready.value || busy.value || mismatched.value || scopeNeedsReview.value) return
  if (!imageNameField1.value || !imageNameField2.value || imageNameField1.value === imageNameField2.value) {
    say('请选择两个不同的数据字段作为图片名称')
    return
  }
  busy.value = true
  outputRecordWarning.value = ''
  try {
    const photo = await loadPhotoPreflight()
    if (!photo || !photo.canOutput) {
      if (photo && !photo.canOutput) showPhotoIssues('')
      say(photoPreflightError.value || '照片预检未通过，请先处理问题后导出')
      return
    }
    const jobKey = `images-${Date.now()}-${Math.random().toString(36).slice(2)}`
    activeJobKey.value = jobKey
    const r = await window.printpress.printExportImages({
      ...buildPayload(), field1: imageNameField1.value, field2: imageNameField2.value,
      outputDpi: outputDpi.value === 'original' ? 300 : Number(outputDpi.value),
      format: imageFormat.value, quality: FORMATS[imageFormat.value].quality === null ? undefined : imageQuality.value,
      preflightFingerprint: photo.fingerprint, jobKey,
    })
    outputRecordWarning.value = r.recordWarning || ''
    if (r.canceled) say('已取消选择保存文件夹')
    else say(`已导出 ${r.count} 张 ${r.format === 'jpeg' ? 'JPG' : String(r.format || 'png').toUpperCase()} 图片（${r.dpi} dpi），保存到：${r.directory}`)
  } catch (err) {
    say(`图片导出失败：${toUserMessage(err)}`)
  } finally {
    activeJobKey.value = ''
    taskProgress.value = null
    busy.value = false
  }
  try {
    jobs.value = await window.printpress.listJobs()
    datasets.value = await window.printpress.listDatasets()
  } catch (err) { console.warn('[打印中心] 刷新图片导出记录失败', err) }
}

/** 校验 → 有空值先弹窗（可中断可放行），字段缺失不可放行；无问题直接执行 */
async function runAction(action) {
  if (!ready.value || busy.value || mismatched.value || scopeNeedsReview.value) return
  busy.value = true
  try {
    const photo = await loadPhotoPreflight()
    if (!photo) { say(photoPreflightError.value || '出片范围已变化，请重新检查'); return }
    if (!photo.canOutput) {
      showPhotoIssues('')
      say('选中范围内有照片冲突或坏图，请先处理问题行')
      return
    }
    const v = await window.printpress.printValidate(buildPayload())
    if (v.issues.length > 0 || (v.duplicates && v.duplicates.length)) {
      validateResult.value = v
      pendingAction.value = action
      pendingPhotoFingerprint.value = photo.fingerprint
      showValidate.value = true
      return
    }
    await execute(action, photo.fingerprint)
  } catch (err) {
    // 不允许静默失败：守卫之外的任何异常都要给用户可见反馈
    say(`操作失败：${toUserMessage(err)}`)
  } finally {
    busy.value = false
  }
}

async function confirmProceed() {
  if (busy.value || !pendingAction.value) return
  showValidate.value = false
  const action = pendingAction.value
  pendingAction.value = ''
  validateResult.value = null
  busy.value = true
  try {
    const photo = await loadPhotoPreflight()
    if (!photo || !photo.canOutput || photo.fingerprint !== pendingPhotoFingerprint.value) {
      if (photo && !photo.canOutput) showPhotoIssues('')
      say('照片预检结果已变化，请重新检查后出片')
      return
    }
    await execute(action, photo.fingerprint)
  } finally {
    pendingPhotoFingerprint.value = ''
    busy.value = false
  }
}

function cancelProceed() {
  showValidate.value = false
  pendingAction.value = ''
  pendingPhotoFingerprint.value = ''
  validateResult.value = null
  say('已中断，可先回数据页补全空值')
}

/** 去补录直达：关闭校验弹窗 → 跳数据页对应单元格聚焦编辑 */
function goFixCell(issue, cell) {
  showValidate.value = false
  pendingAction.value = ''
  validateResult.value = null
  gotoCell(selDs.value, cell.rowIndex, issue.key)
}

/** 字段缺失的两种成因要给不同出路：不存在 → 换绑/改模板；取消「印」 → 去数据页激活 */
function missingText(i) {
  return i.reason === 'not-printable'
    ? `已取消「印」，${i.total} 行该列都不会输出`
    : '字段在数据集中不存在'
}

function missingFlag(i) {
  return i.reason === 'not-printable' ? '未激活打印' : '字段缺失'
}

/** 校验问题格的悬浮说明（空值 / 疑似占位 / 超宽） */
function cellHint(kind) {
  if (kind === 'placeholder') return '疑似占位值，点击去核对'
  if (kind === 'overlong') return '文字可能超出版面被裁切，点击去核对'
  return '空值，点击去填写'
}

/** 重复行直达：重复是行级问题，落到该行第一列进入编辑即可 */
function goDupRow(rowIndex) {
  const key = dsDetail.value?.columns?.[0]?.key
  if (!key) return
  showValidate.value = false
  pendingAction.value = ''
  validateResult.value = null
  gotoCell(selDs.value, rowIndex, key)
}

/**
 * 出片结果的如实描述（I-49 的「不静默」）。用的是**真实统计**，不是估算。
 * 只描述照片这一项——底图分辨率是另一件事（预览栏的 bgDpi 读数），不混在一句话里。
 */
function outputResultText(stats) {
  if (!stats) return ''
  if (stats.dpi == null) return '；出片分辨率：原图'
  const parts = [`${stats.dpi}dpi`]
  if (stats.optimized) parts.push(`照片降采样 ${stats.optimized} 张`)
  if (stats.failed) parts.push(`${stats.failed} 张读取失败已回原件`)
  return `；${parts.join('，')}`
}

async function execute(action, preflightFingerprint) {
  const payload = buildPayload()
  payload.preflightFingerprint = preflightFingerprint
  activeJobKey.value = `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
  payload.jobKey = activeJobKey.value
  taskProgress.value = null
  cancelRequested.value = false
  outputRecordWarning.value = ''
  try {
    if (action === 'pdf') {
      const r = await window.printpress.printExportPdf(payload)
      outputRecordWarning.value = r.recordWarning || ''
      if (r.canceled) { say('已取消导出'); return }
      // 体积用**真实字节数**报（估算只是模型，见 I-49）；页数分批时以实际合并结果为准
      const pages = r.pages ?? previewInfo.value?.pageCount ?? '?'
      say(`PDF 已导出（${pages} 页${r.bytes ? ` · ${formatBytes(r.bytes)}` : ''}）${outputResultText(r.output)}`)
    } else {
      const r = await window.printpress.printSend(payload)
      outputRecordWarning.value = r.recordWarning || ''
      if (r.ok) say(`已发送打印机${outputResultText(r.output)}`)
      // Chromium 的 print 回调给的是英文（'Print job canceled' / 'Invalid printer settings'），
      // 不能直接贴给用户；给一个贴合场景的兜底（I-48）
      else say(toUserMessage(r.error, '打印没有完成，可能被取消或打印机不可用。'))
    }
  } catch (err) {
    // 用户自己点了取消不算「失败」，别加前缀吓人；只洗一次，别洗两遍
    const msg = toUserMessage(err)
    say(`${msg.includes('已取消') ? '' : '执行失败：'}${msg}`)
  } finally { activeJobKey.value = ''; taskProgress.value = null; cancelRequested.value = false }
  // 成功打印/导出会回写数据集状态（侧栏「已打 N」变色），两处清单都要刷新。
  // 刷新放回 try里：这两行原本在 try 之外，一次刷新失败（IPC 断开/库被锁）
  // 就会变成未处理的 rejection，顶掉上面刚报给用户的执行结果——
  // 用户看到「没反应」，而实际纸已经打了或导出已经完成了。
  try {
    jobs.value = await window.printpress.listJobs()
    datasets.value = await window.printpress.listDatasets()
  } catch (err) {
    console.warn('[打印中心] 刷新清单失败', err)
  }
}

async function openSnapshot(jobId) {
  try {
    await window.printpress.openSnapshot(jobId)
  } catch (err) {
    say(`打开失败：${toUserMessage(err)}`)
  }
}

// ---- 打印历史管理：删除（应用内确认弹窗） ----
const pendingDelete = ref(null)
function toggleHistoryJob(id, event) {
  selectedJobIds.value = event.target.checked ? [...new Set([...selectedJobIds.value, id])] : selectedJobIds.value.filter(value => value !== id)
}
function toggleAllHistory(event) { selectedJobIds.value = event.target.checked ? jobs.value.map(job => job.id) : [] }
function requestDeleteJobs(targets) {
  if (!targets.length || historyDeleting.value) return
  const count = targets.length
  const message = count === 1
    ? '\u5220\u9664\u6253\u5370\u4efb\u52a1\u300c' + targets[0].templateName + ' × ' + targets[0].recordCount + ' \u4efd\uff08' + fmtTime(targets[0].createdAt) + '\uff09\u300d\uff1f\n\u5f52\u6863\u5feb\u7167\u53ca\u5f52\u6863\u7167\u7247\u526f\u672c\u5c06\u4e00\u5e76\u5220\u9664\uff0c\u4e14\u65e0\u6cd5\u6062\u590d\u3002\u5df2\u5bfc\u51fa\u7684 PDF/PNG\u3001\u7167\u7247\u5e93\u539f\u4ef6\u548c\u540d\u5355\u6253\u5370\u72b6\u6001\u4f1a\u4fdd\u7559\u3002'
    : '\u786e\u5b9a\u5220\u9664\u9009\u4e2d\u7684 ' + count + ' \u6761\u6253\u5370\u5386\u53f2\u8bb0\u5f55\u5417\uff1f\n\u6bcf\u6761\u8bb0\u5f55\u7684\u5f52\u6863\u5feb\u7167\u53ca\u5f52\u6863\u7167\u7247\u526f\u672c\u5c06\u4e00\u5e76\u5220\u9664\uff0c\u4e14\u65e0\u6cd5\u6062\u590d\u3002\u5df2\u5bfc\u51fa\u7684 PDF/PNG\u3001\u7167\u7247\u5e93\u539f\u4ef6\u548c\u540d\u5355\u6253\u5370\u72b6\u6001\u4f1a\u4fdd\u7559\u3002'
  pendingDelete.value = { jobs: targets, message }
}
function deleteJob(job) { requestDeleteJobs([job]) }
function deleteSelectedJobs() { requestDeleteJobs(jobs.value.filter(job => selectedJobIds.value.includes(job.id))) }
async function confirmDelete() {
  const request = pendingDelete.value
  if (!request || historyDeleting.value) return
  pendingDelete.value = null; historyDeleting.value = true
  let deleted = 0, archiveWarnings = 0, backupWarnings = 0
  const failures = []
  try {
    for (const job of request.jobs) {
      try {
        const result = await window.printpress.deleteJob(job.id)
        deleted++
        if (result.archiveRemoved === false) archiveWarnings++
        if (result.backupUpdated === false) backupWarnings++
      } catch (err) { failures.push(toUserMessage(err)) }
    }
    jobs.value = await window.printpress.listJobs()
    selectedJobIds.value = selectedJobIds.value.filter(id => jobs.value.some(job => job.id === id))
    if (failures.length) say('\u5df2\u5220\u9664 ' + deleted + ' \u6761\uff0c\u5931\u8d25 ' + failures.length + ' \u6761\uff1a' + failures[0])
    else if (archiveWarnings) say('\u5df2\u5220\u9664 ' + deleted + ' \u6761\u8bb0\u5f55\uff0c\u4f46\u6709 ' + archiveWarnings + ' \u4e2a\u5f52\u6863\u76ee\u5f55\u672a\u6e05\u7406\u5b8c\u6210\u3002')
    else if (backupWarnings) say('\u5df2\u5220\u9664 ' + deleted + ' \u6761\u8bb0\u5f55\uff0c\u5386\u53f2\u6062\u590d\u526f\u672c\u66f4\u65b0\u5931\u8d25\u3002')
    else say('\u5df2\u5220\u9664 ' + deleted + ' \u6761\u6253\u5370\u5386\u53f2\u8bb0\u5f55\u53ca\u5bf9\u5e94\u5f52\u6863\u4ef6\u3002')
  } catch (err) { say('\u5237\u65b0\u5386\u53f2\u8bb0\u5f55\u5931\u8d25\uff1a' + toUserMessage(err)) }
  finally { historyDeleting.value = false }
}

async function reprint(job) {
  if (busy.value) return
  if (!templates.value.some((t) => t.id === job.templateId)) {
    say('原模板已删除，无法重打')
    return
  }
  const tpl = templates.value.find((t) => t.id === job.templateId)
  const datasetId = job.datasetId || tpl.datasetId || ''
  if (!datasetId || !datasets.value.some((d) => d.id === datasetId)) {
    say('原名单已删除，无法按原记录补打')
    return
  }
  if (tpl.datasetId && tpl.datasetId !== datasetId) {
    say('原模板已换绑到其他名单，无法安全补打这条历史记录')
    return
  }
  let rows = null
  if (job.partial) {
    try {
      const current = await window.printpress.getDataset(datasetId)
      const resolved = resolveReprintScope(job, current.recordIds)
      if (resolved.reason) { say(resolved.reason); return }
      rows = resolved.rows
    } catch (err) {
      say(`读取原名单失败：${toUserMessage(err)}`)
      return
    }
  }
  historyOpen.value = false
  selTpl.value = job.templateId
  selDs.value = datasetId
  await nextTick()
  await loadDetail()
  // 部分历史按稳定 ID 解析；旧记录缺少 ID 或名单有人被删除时已在上面拦下。
  setScope(rows)
  if (job.mode === 'images') {
    if (job.imageNameFields?.length === 2) {
      imageNameField1.value = job.imageNameFields[0]
      imageNameField2.value = job.imageNameFields[1]
    }
    outputDpi.value = String(job.outputDpi || 300)
    imageFormat.value = Object.hasOwn(FORMATS, job.imageFormat) ? job.imageFormat : 'png'
    if (FORMATS[imageFormat.value].quality !== null && Number.isInteger(job.imageQuality) && job.imageQuality >= 1 && job.imageQuality <= 100) imageQuality.value = job.imageQuality
    await nextTick()
    await exportIndividualImages()
    return
  }
  runAction(job.mode === 'print' ? 'print' : 'pdf')
}

function fmtTime(iso) {
  return String(iso || '').replace('T', ' ').slice(0, 19)
}

const modeLabel = { pdf: '导出 PDF', print: '打印', images: '导出图片', grouped: '分组导出（已下线）' }
const statusLabel = { ok: '完成', failed: '失败', canceled: '取消' }

onActivated(async () => {
  window.addEventListener('pointerdown', onBlankPointerDown, true)
  window.addEventListener('keydown', onPreviewPageKey)
  await refreshAll()
  if (!ready.value) return
  await loadDetail()
  const row = returnedPhotoRowId ? dsDetail.value?.recordIds?.indexOf(returnedPhotoRowId) : -1
  if (row >= 0 && pageRecordIndexes.value.includes(row)) recordDesignRow.value = row
  returnedPhotoRowId = ''
  rebuildPreview(); loadPhotoPreflight()
})
onDeactivated(() => {
  window.removeEventListener('pointerdown', onBlankPointerDown, true)
  window.removeEventListener('keydown', onPreviewPageKey)
  finishPhotoEditOnBlank()
})
</script>

<template>
  <section class="page">
    <PageHeader class="print-header" title="打印中心" description="预览 · 导出 · 打印">
      <template #actions>
        <div class="toolbar-actions" aria-label="出片操作">
          <button class="btn" :disabled="!ready || busy || mismatched || scopeNeedsReview || photoEditBusy || photoEditDirty || photoInteraction || imageNameFieldOptions.length < 2" @click="exportIndividualImages"><AppIcon name="image" /> {{ busy && activeJobKey.startsWith('images-') ? '正在导出图片…' : `逐条导出 ${imageFormatLabel}` }}</button>
          <button class="btn" :disabled="!ready || busy || mismatched || scopeNeedsReview || photoEditBusy || photoEditDirty || photoInteraction" @click="runAction('print')"><AppIcon name="print" /> 直接打印</button>
          <button class="btn btn-primary" :disabled="!ready || busy || mismatched || scopeNeedsReview || photoEditBusy || photoEditDirty || photoInteraction" @click="runAction('pdf')"><AppIcon name="download" /> 导出 PDF</button>
        </div>
        <button class="btn btn-mini history-trigger" @click="historyOpen = true"><AppIcon name="history" /> 打印历史<span>{{ jobs.length }}</span></button>
      </template>
    </PageHeader>

    <div v-if="outputRecordWarning" class="scope-bar mismatch-bar" role="alert">
      <span class="scope-note">{{ outputRecordWarning }}</span>
      <button class="btn btn-mini" @click="outputRecordWarning = ''">知道了</button>
    </div>

    <div class="toolbar">
      <div class="toolbar-row toolbar-row-template">
        <div class="toolbar-control">
          <span class="tb-label">模板</span>
          <CustomSelect v-model="selTpl" :disabled="busy || photoEditBusy || photoEditDirty || photoInteraction" :options="tplOptions" placeholder="选择模板" width="240px" />
        </div>
        <!-- 模板已绑定数据集：直接显示关联关系，不可错配 -->
        <template v-if="boundTpl && boundTpl.datasetId">
          <span class="bound-ds">关联数据集：{{ boundTpl.datasetName || '（已删除）' }}（{{ dsTotalRows }} 行）</span>
          <button class="btn btn-mini" :disabled="busy || photoEditBusy || photoEditDirty || photoInteraction" @click="openRebind">更换数据集</button>
        </template>
        <!-- 旧模板未绑定：兼容路径，允许临时选择 -->
        <div v-else-if="selTpl" class="toolbar-control">
          <span class="tb-label">数据集</span>
          <CustomSelect v-model="selDs" :disabled="busy || photoEditBusy || photoEditDirty || photoInteraction" :options="dsOptions" placeholder="选择数据集" width="200px" />
          <span class="scope-note">旧模板未绑定数据集，建议回模板工坊保存一次完成绑定</span>
        </div>
      </div>

      <details class="output-settings" data-testid="print-output-settings">
        <summary>出片设置 <span>· {{ outputDpi === 'original' ? 'PDF/打印：原图，图片：300 DPI' : `${outputDpi} DPI` }} · {{ imageFormatLabel }}{{ imageFormat === 'webp' ? '（无 DPI 元数据）' : '' }}<template v-if="imageNameField1 && imageNameField2"> · 文件名：{{ imageNameFieldOptions.find(item => item.value === imageNameField1)?.label }} + {{ imageNameFieldOptions.find(item => item.value === imageNameField2)?.label }}</template></span></summary>
        <div class="toolbar-row toolbar-row-output">
        <!-- 出片分辨率（I-49）：默认 300，可选原图、150、300 或 600 dpi。 -->
        <div class="toolbar-control">
          <span class="tb-label">出片分辨率</span>
          <CustomSelect v-model="outputDpi" :disabled="busy" :options="outputDpiOptions" width="170px" />
        </div>
        <div class="toolbar-control" data-testid="print-image-format">
          <span class="tb-label">图片格式</span>
          <CustomSelect v-model="imageFormat" :disabled="busy" :options="imageFormatOptions" width="130px" />
        </div>
        <label v-if="FORMATS[imageFormat].quality !== null" class="toolbar-control image-quality">图片质量 <input v-model.number="imageQuality" data-testid="print-image-quality" :disabled="busy" type="number" min="1" max="100" step="1" aria-label="图片质量（1到100）"></label>
        <div class="toolbar-control toolbar-name-control">
          <span class="tb-label">图片名称</span>
          <div class="toolbar-name-fields">
            <CustomSelect v-model="imageNameField1" :disabled="busy" :options="imageNameFieldOptions" width="135px" />
            <span class="toolbar-name-plus" aria-hidden="true">+</span>
            <CustomSelect v-model="imageNameField2" :disabled="busy" :options="imageNameFieldOptions.filter(option => option.value !== imageNameField1)" width="135px" />
          </div>
        </div>
        </div>
        <p v-if="imageFormat === 'webp' || outputDpi === 'original'" class="format-note"><span v-if="outputDpi === 'original'">逐条图片按 300 DPI 出图；原图选项用于 PDF 和打印。 </span><span v-if="imageFormat === 'webp'">WebP 文件不写入 DPI 元数据，像素尺寸仍按出图分辨率计算。</span></p>
      </details>
    </div>

    <!-- 模板绑定的数据集已被删除：结构断链，给可读出路而非让预览静默失败 -->
    <div v-if="boundDsMissing" class="scope-bar mismatch-bar">
      <span class="det-flag st-failed">数据集已删除</span>
      <span class="scope-note">
        模板「{{ boundTpl.name }}」关联的数据集已被删除，无法预览和打印——
        点「更换数据集」换绑一张表，或回「模板工坊」重新选择数据集
      </span>
    </div>

    <!-- 字段错配警告：模板字段在绑定数据集中不存在，导出必然白版，须先解决 -->
    <div v-if="mismatched" class="scope-bar mismatch-bar">
      <span class="det-flag st-failed">字段不匹配</span>
      <span class="scope-note">
        模板「{{ mismatch.templateName }}」的
        {{ mismatch.missing.map((x) => x.label).join('、') }}
        在「{{ mismatch.datasetName }}」中不存在或未激活打印——
        回「模板工坊」把字段换成该数据集的列（如 选手姓名/组别/奖项），或点「更换数据集」选匹配的表
      </span>
    </div>

    <!-- 出片范围和照片检查合并显示，问题仍可展开处理。 -->
    <div v-if="ready" class="print-summary">
    <div class="scope-bar range-bar">
      <span class="det-flag" :class="selRows ? 'st-partial' : 'st-ok'">
        {{ selRows ? '部分出片' : '全量出片' }}
      </span>
      <span class="scope-note">
        出片范围：{{ scopeLabel }}
        <template v-if="selRows">· 不改数据集「已打」状态，仅留痕</template>
      </span>
      <span v-if="photoPreflight" class="scope-note range-count">本次 {{ photoPreflight.recordCount }} 人 · 预计 {{ photoPreflight.pageCount }} 页</span>
      <span v-if="scopeNeedsReview" class="photo-preflight-error">名单或所选人员已变化，请重新选择打印范围</span>
      <span class="tb-spacer"></span>
      <button class="btn btn-mini" :disabled="busy || !dsDetail || photoEditBusy || photoEditDirty || photoInteraction" @click="openScope">选择打印行</button>
      <button v-if="selRows" class="btn btn-mini" :disabled="busy || photoEditBusy || photoEditDirty || photoInteraction" @click="setScope(null)">恢复全量</button>
    </div>

    <div v-if="photoPreflightLoading || photoPreflightError || photoPreflight?.photoLayerCount || dsPrintStats" class="photo-preflight" data-testid="print-photo-preflight">
      <span v-if="photoPreflightLoading" class="scope-note">正在检查本次范围的照片…</span>
      <span v-else-if="photoPreflightError" class="photo-preflight-error">照片预检失败：{{ photoPreflightError }}</span>
      <template v-else-if="photoPreflight">
        <template v-if="photoPreflight.photoLayerCount">
          <span v-if="!photoPreflight.photoEnabled" class="scope-note">配图已关闭，{{ photoPreflight.recordCount }} 人的照片留白</span>
          <template v-else>
            <span class="scope-note">已配图 {{ photoPreflight.counts.matched }} 人 · 空值 {{ photoPreflight.counts.empty }} 人</span>
            <span v-if="photoPreflight.photoLayerCount > 1" class="scope-note">{{ photoPreflight.photoLayerCount }} 个变量图框 · 共 {{ photoPreflight.photoFrameCount }} 个位置</span>
            <button v-for="status in ['missing', 'ambiguous', 'invalid', 'broken']" :key="status"
              v-show="photoPreflight.counts[status]" class="photo-count" :class="{ blocking: status !== 'missing' }"
              @click="showPhotoIssues(status)">{{ photoStatusLabel[status] }} {{ photoPreflight.counts[status] }} 人</button>
            <span v-if="photoPreflight.counts.missing || photoPreflight.counts.empty" class="scope-note">缺图和空值出片留白</span>
            <span v-if="!photoPreflight.canOutput" class="photo-preflight-error">冲突、无效或坏图需先处理</span>
          </template>
        </template>
      </template>
      <template v-if="dsPrintStats">
        <span class="det-flag" :class="dsPrintStats.times ? 'st-ok' : 'st-failed'">{{ dsPrintStats.times ? '有记录' : '无记录' }}</span>
        <span class="scope-note" data-testid="print-dataset-stats">
          「{{ dsPrintStats.name }}」（共 {{ dsPrintStats.rowCount }} 行）：
          <template v-if="dsPrintStats.times">已打印/导出 {{ dsPrintStats.times }} 次 · 累计 {{ dsPrintStats.pages }} 份 · 最近 {{ fmtTime(dsPrintStats.last) }}</template>
          <template v-else>尚无全量打印或导出记录——如果这份名单本来就要出片，这里就是遗漏提醒</template>
          <template v-if="dsPrintStats.partialTimes">（另有补打 {{ dsPrintStats.partialTimes }} 次 · {{ dsPrintStats.partialRows }} 行，不计入全量）</template>
        </span>
      </template>
      <details v-if="photoPreflight?.warnings?.length" class="photo-issues" data-testid="print-photo-quality"><summary>{{ photoPreflight.warnings.length }} 人有清晰度、人物对齐或裁切提示（建议输出前检查）</summary><div class="photo-issues-list"><div v-for="item in photoPreflight.warnings" :key="item.rowIndex" class="photo-issue-row"><button class="btn btn-mini" @click="goPhotoIssue(item)">第 {{ item.rowIndex + 1 }} 行</button><span>{{ item.name }}</span><span class="scope-note">{{ item.reasons.join('；') }}</span></div></div></details>
      <div v-if="photoIssuesOpen && visiblePhotoIssues.length" class="photo-issues">
        <div class="photo-issues-head">
          <strong>{{ photoIssueFilter ? photoStatusLabel[photoIssueFilter] : '照片问题' }} · {{ visiblePhotoIssues.length }} 人</strong>
          <button class="btn btn-mini" @click="photoIssuesOpen = false">收起</button>
        </div>
        <div class="photo-issues-list">
          <div v-for="item in visiblePhotoIssues" :key="item.rowIndex" class="photo-issue-row">
            <button class="btn btn-mini" @click="goPhotoIssue(item)">第 {{ item.rowIndex + 1 }} 行</button>
            <span>{{ item.name || '（空值）' }}</span>
            <span>{{ photoStatusLabel[item.status] }}</span>
            <span v-if="item.reason" class="scope-note">{{ item.reason }}</span>
          </div>
        </div>
      </div>
    </div>
    </div>

    <div v-if="!ready" class="empty-hint">
      <p class="hint-main">选择模板后自动带出关联数据集，开始批量出片</p>
      <p class="hint-sub">模板需已添加字段并关联数据集（在「模板工坊」制作）；底图可选，无底图的版式同样能打</p>
    </div>

    <div v-else class="preview-wrap">
      <div v-if="activeJobKey" class="output-progress" role="status" data-testid="print-progress">
        <span>{{ progressText }}</span>
        <button v-if="!activeJobKey.startsWith('images-')" class="btn" :disabled="!cancelable" data-testid="print-cancel" @click="cancelOutput">{{ cancelRequested ? '正在取消…' : '取消出片' }}</button>
      </div>
      <div class="preview-bar">
        <span v-if="previewInfo" class="preview-meta">
          {{ previewInfo.page.name }}
          <template v-if="previewInfo.layout?.fold"> · 对折桌牌</template>
          <template v-else-if="previewInfo.layout?.enabled">
            · {{ previewInfo.layout.cols }}×{{ previewInfo.layout.rows }} 多联
          </template>
        </span>
        <span class="tb-spacer"></span>
        <div v-if="previewInfo" class="preview-paging" data-testid="print-preview-paging">
          <label for="preview-page-input">第</label>
          <input id="preview-page-input" v-model="previewPageInput" class="preview-page-input" data-testid="print-preview-page-input" type="text" inputmode="numeric" :disabled="previewPagingDisabled" :aria-label="`跳转到第几页，共 ${previewPageCount} 页`" title="输入页码，按 Enter 跳转" @focus="$event.target.select()" @keydown.enter.prevent="jumpToPreviewPage" @keydown.esc.prevent="previewPageInput = String(previewPage + 1)" @blur="jumpToPreviewPage">
          <span>/ {{ previewPageCount }} 页</span>
        </div>
        <label v-if="pageRecordIndexes.length > 1" class="preview-paging">当前人员 <select v-model.number="recordDesignRow" aria-label="选择要单独编辑的人员" data-testid="print-record-design-row"><option v-for="index in pageRecordIndexes" :key="index" :value="index">第 {{ index + 1 }} 行 · {{ rowPreview(dsDetail?.rows?.[index] || {}) }}</option></select></label>
        <button v-if="pageRecordIndexes.length" class="btn" data-testid="print-record-design-edit" :disabled="busy || recordDesignBusy || previewLoading || photoEditBusy || photoEditDirty || photoInteraction" @click="editRecordDesign">编辑此人底图</button>
        <button v-if="pageRecordIndexes.length && dsDetail?.photoMatchColumn && previewHtml.includes('data-photo-layer-id=')" class="btn" data-testid="print-single-photo-edit" :disabled="busy || singlePhotoBusy || previewLoading || photoEditBusy || photoEditDirty || photoInteraction" @click="editSinglePhoto">精修此人照片</button>
        <button v-if="recordDesignInfo?.hasOverride" class="btn" data-testid="print-record-design-reset" :disabled="busy || recordDesignBusy || photoEditBusy || photoEditDirty || photoInteraction" @click="clearRecordDesign">恢复此人默认底图</button>
        <span v-if="designHint" class="preview-dpi" :class="designHint.tone" :title="designHint.title" data-testid="print-design-dpi">
          {{ designHint.text }}
        </span>
        <span v-if="previewInfo?.bgDpi" class="preview-dpi" :class="dpiClass(previewInfo.bgDpi.dpi)"
          :title="`底图 ${previewInfo.bgDpi.width}×${previewInfo.bgDpi.height}px，按成品尺寸换算输出约 ${Math.round(previewInfo.bgDpi.dpi)} dpi${previewInfo.bgDpi.stretched ? '；底图比例与成品不符，会被拉伸' : ''}`">
          底图 · 约 {{ Math.round(previewInfo.bgDpi.dpi) }} dpi
          <template v-if="previewInfo.bgDpi.stretched"> · 比例不符</template>
        </span>
        <!-- 出片分辨率读数（I-49）。预览只做规划不编码，所以这里的张数与体积是「预计」，
             导出完成后用真实字节数覆盖（见 execute）。不静默：档位与结果都摆在明面上。 -->
        <span v-if="outputHint" class="preview-dpi" :class="outputHint.tone" :title="outputHint.title" data-testid="print-output-dpi">
          {{ outputHint.text }}
        </span>
        <span class="tb-label">缩放</span>
        <CustomSelect v-model="zoom" :options="zoomOptions" width="90px" />
      </div>

      <p v-if="photoEditError" class="photo-preflight-error photo-edit-error">照片调整：{{ photoEditError }}</p>
      <div v-if="photoEdit" class="photo-edit" data-testid="print-photo-edit">
        <strong class="photo-edit-person" :title="photoEdit.label">第 {{ photoEdit.rowIndex + 1 }} 行 · {{ photoEdit.label }}</strong>
        <span class="photo-edit-hint">拖动照片或控制点调整，方向键微调（Shift 加速）。</span>
        <span v-if="photoEdit.state === 'stale'" class="photo-preflight-error">照片已变化，旧调整未应用</span>
        <span class="photo-edit-status" role="status">{{ photoEditBusy ? '正在保存…' : photoEditDirty ? '未保存' : '已保存' }}</span>
        <div class="photo-edit-controls"><button v-if="photoEditDirty" class="btn btn-mini btn-primary" :disabled="photoEditBusy || photoInteraction" @click="savePhotoEdit()">保存调整</button><button v-if="photoEditDirty" class="btn btn-mini" :disabled="photoEditBusy || photoInteraction" @click="discardPhotoEdit">撤销未保存调整</button><button class="btn btn-mini" data-testid="print-photo-reset" :disabled="photoEditBusy || photoInteraction" @click="resetPhotoEdit">恢复默认</button><button v-if="photoEditActive" class="btn btn-mini" :disabled="photoEditBusy || photoInteraction" @click="closePhotoEdit">完成</button></div>
      </div>

      <!-- 多联回退提示：配了多联却放不下时已自动按单页出片。这不是错误，但结果与
           预期不符（页数暴涨、版式不对），必须常驻告知，不能只靠一闪而过的 toast。 -->
      <p v-if="layoutFallback" class="layout-warn">
        <span class="lw-tag">已按单页出片</span>{{ layoutFallback }}
      </p>
      <div class="preview-stage" :class="{ 'has-paging': previewInfo }" :style="previewInfo ? { width: `${frameW * zoomK + 134}px` } : {}">
        <button v-if="previewInfo" type="button" class="preview-page-arrow" data-testid="print-preview-previous" aria-label="上一页" title="上一页" :disabled="previewPagingDisabled || previewPage === 0" @click="stepPreviewPage(-1)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg></button>
      <div class="preview-scroll">
        <!-- scale 缩放：iframe 布局尺寸=纸张全宽（内视口完整容纳内容，不裁边），
             transform 只做视觉缩放，外层 holder 定缩放后的占位尺寸 -->
        <div
          v-if="previewHtml"
          class="preview-holder"
          :style="{ width: frameW * zoomK + 'px', height: frameTotalH * zoomK + 'px' }"
        >
          <iframe
            ref="previewFrame"
            class="preview-frame"
            :style="{ width: frameW + 4 + 'px', height: frameTotalH + 'px', transform: 'scale(' + zoomK + ')' }"
            :srcdoc="previewHtml"
            title="打印预览"
            sandbox="allow-same-origin"
            @load="onPreviewFrameLoad"
          ></iframe>
        </div>
      </div>
        <button v-if="previewInfo" type="button" class="preview-page-arrow" data-testid="print-preview-next" aria-label="下一页" title="下一页" :disabled="previewPagingDisabled || previewPage + 1 >= previewPageCount" @click="stepPreviewPage(1)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
      </div>
    </div>

    <div v-if="historyOpen" class="modal-mask history-mask" @click.self="historyOpen = false" @keydown.esc.window="historyOpen = false">
      <section class="modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header class="history-head">
          <div>
            <h3 id="history-title" class="modal-title">打印历史</h3>
            <p class="history-count">&#x5171; {{ jobs.length }} &#x6761; &#x5DF2;&#x9009; {{ selectedJobIds.length }} &#x6761;</p>
            <button class="btn btn-mini job-del" data-testid="history-delete-selected" :disabled="!selectedJobIds.length || historyDeleting" @click="deleteSelectedJobs">&#x5220;&#x9664;&#x6240;&#x9009; ({{ selectedJobIds.length }})</button>
          </div>
          <button class="btn btn-mini" @click="historyOpen = false">关闭</button>
        </header>
        <div class="history-table-wrap">
          <table v-if="jobs.length" class="job-table">
            <thead>
              <tr><th class="history-select"><input type="checkbox" aria-label="Select all print history" :checked="allHistorySelected" :disabled="historyDeleting || !jobs.length" @change="toggleAllHistory($event)"></th><th>时间</th><th>模板</th><th>数据集</th><th>方式</th><th>份数</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="j in jobs" :key="j.id"><td class="history-select"><input type="checkbox" :aria-label="'Select ' + j.templateName + ' history'" :checked="selectedJobIds.includes(j.id)" :disabled="historyDeleting" @change="toggleHistoryJob(j.id, $event)"></td>
                <td>{{ fmtTime(j.createdAt) }}</td>
                <td>{{ j.templateName }}</td>
                <td>{{ j.datasetName }}</td>
                <td>
                  {{ j.mode === 'images' ? `导出 ${j.imageFormat === 'jpeg' ? 'JPG' : String(j.imageFormat || 'png').toUpperCase()}` : (modeLabel[j.mode] || j.mode) }}
                  <span v-if="j.partial" class="partial-tag" :title="`仅出片 ${j.recordCount} 行，数据集共 ${j.totalRows} 行；不影响「已打」状态`">部分 {{ j.recordCount }}/{{ j.totalRows }}</span>
                </td>
                <td :title="j.mode === 'images' && j.status === 'failed' ? `已保存 ${j.completedCount || 0} 张，计划 ${j.recordCount} 张` : ''">
                  <template v-if="j.mode === 'images' && j.status === 'failed'">{{ j.completedCount || 0 }}/{{ j.recordCount }}</template>
                  <template v-else>{{ j.recordCount }}</template>
                </td>
                <td><span class="det-flag" :class="'st-' + j.status">{{ statusLabel[j.status] || j.status }}</span></td>
                <td class="row-actions">
                  <button v-if="j.snapshot" class="btn btn-mini" @click="openSnapshot(j.id)">查看</button>
                  <button class="btn btn-mini" :disabled="busy" @click="reprint(j)">重打</button>
                  <button class="btn btn-mini job-del" @click="deleteJob(j)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="hint-sub history-empty">暂无打印记录</p>
        </div>
      </section>
    </div>

    <!-- 出口校验弹窗：可中断可放行 -->
    <div v-if="showValidate" class="modal-mask">
      <div class="modal">
        <h3 class="modal-title">打印前校验发现问题</h3>
        <p v-if="hasMissingIssue" class="modal-sub">
          <template v-if="hasUnprintableIssue">
            存在<b>已取消「印」</b>的字段——对应位置会全部留白。请回数据页把该列的「印」重新打开后再打印：
          </template>
          <template v-else>
            存在<b>字段缺失</b>（模板字段在数据集中不存在）——补值无法解决，请回模板工坊调整字段后再打印：
          </template>
        </p>
        <p v-else class="modal-sub">空值位置将留白打印；疑似占位值（括号包裹、纯符号等形态）按原样打印；超出版面的文字可能被裁掉：</p>
        <div class="issue-list">
          <div v-for="i in validateResult.issues" :key="i.key" class="det-row">
            <span class="issue-label">{{ i.label }}</span>
            <span class="det-stats">
              <template v-if="i.missing">{{ missingText(i) }}</template>
              <template v-else>
                <template v-if="i.empty">空 {{ i.empty }}</template>
                <template v-if="i.empty && (i.placeholder || i.overlong)"> · </template>
                <template v-if="i.placeholder">疑似占位 {{ i.placeholder }}</template>
                <template v-if="i.placeholder && i.overlong"> · </template>
                <template v-if="i.overlong">超出版面 {{ i.overlong }}</template>
                / {{ i.total }} 行
              </template>
            </span>
            <span v-if="i.missing" class="det-flag st-failed">{{ missingFlag(i) }}</span>
            <span v-else-if="i.empty === i.total" class="det-flag st-failed">整列为空</span>
          </div>
          <!-- 去补录直达：点行号 → 数据页对应单元格聚焦编辑 -->
          <template v-for="i in validateResult.issues" :key="'fix-' + i.key">
            <div v-if="!i.missing && i.cells && i.cells.length" class="fix-row">
              <span class="fix-label">{{ i.label }}</span>
              <button
                v-for="c in i.cells"
                :key="c.rowIndex"
                class="fix-chip"
                :class="{ ph: c.kind === 'placeholder', ov: c.kind === 'overlong' }"
                :title="cellHint(c.kind)"
                @click="goFixCell(i, c)"
              >第 {{ c.rowIndex + 1 }} 行</button>
              <span v-if="i.cellsTotal > i.cells.length" class="fix-more">共 {{ i.cellsTotal }} 处，仅列前 {{ i.cells.length }}</span>
            </div>
          </template>
          <!-- 重复行：整行内容完全一致，多为误粘贴；只提示不拦截（同名多份是合法需求） -->
          <template v-if="validateResult.duplicates && validateResult.duplicates.length">
            <div class="det-row">
              <span class="issue-label">重复行</span>
              <span class="det-stats">
                名单中有 {{ validateResult.duplicates.length }} 组内容完全相同的行（共 {{ validateResult.duplicateTotal }} 行）——若非有意重复请核对：
              </span>
              <span class="det-flag st-partial">重复</span>
            </div>
            <div v-for="(g, gi) in validateResult.duplicates" :key="'dup-' + gi" class="fix-row">
              <span class="fix-label">{{ g.preview }}</span>
              <button
                v-for="ri in g.rowIdx"
                :key="ri"
                class="fix-chip"
                title="内容完全相同的行，点击去查看"
                @click="goDupRow(ri)"
              >第 {{ ri + 1 }} 行</button>
              <span v-if="g.count > g.rowIdx.length" class="fix-more">共 {{ g.count }} 行，仅列前 {{ g.rowIdx.length }}</span>
            </div>
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="cancelProceed">{{ hasMissingIssue ? '返回调整' : '返回补全' }}</button>
          <button
            class="btn btn-primary"
            :disabled="hasMissingIssue"
            :title="hasMissingIssue ? '字段缺失无法通过放行解决，导出只会白版' : ''"
            @click="confirmProceed"
          >仍要继续</button>
        </div>
      </div>
    </div>

    <!-- 换绑数据集：模板字段 × 新数据集激活字段匹配预检，缺失即阻止 -->
    <div v-if="rebindShow" class="modal-mask">
      <div class="modal">
        <h3 class="modal-title">更换数据集</h3>
        <p class="modal-sub">
          模板「{{ boundTpl?.name }}」的 {{ boundTpl?.fieldCount }} 个字段将与新数据集匹配：
          每个字段都必须在新数据集列头激活「印」，否则不能换绑。
        </p>
        <CustomSelect v-model="rebindDsId" :options="rebindOptions" placeholder="选择新数据集" width="100%" />
        <div v-if="rebindResult" class="rebind-result" :class="{ ok: rebindResult.ok }">
          <template v-if="rebindResult.ok">
            <span class="det-flag st-ok">匹配通过</span>
            <span class="det-stats">模板 {{ rebindResult.fieldCount }} 个字段全部在「{{ rebindResult.datasetName }}」已激活的 {{ rebindResult.activatedCount }} 个字段中</span>
          </template>
          <template v-else>
            <span class="det-flag st-failed">匹配失败</span>
            <span class="det-stats">
              缺失 {{ rebindResult.missing.length }}/{{ rebindResult.fieldCount }}：
              {{ rebindResult.missing.map((x) => x.label).join('、') }}
            </span>
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="rebindShow = false">取消</button>
          <button class="btn btn-primary" :disabled="!rebindResult?.ok || rebindBusy" @click="confirmRebind">确认换绑</button>
        </div>
      </div>
    </div>

    <!-- 行级出片范围选择：默认全选，可取消后搜索勾选（补打 / 分批） -->
    <div v-if="scopeOpen" class="modal-mask">
      <div class="modal modal-wide">
        <h3 class="modal-title">选择打印行</h3>
        <p class="modal-sub">
          默认全选；可「取消全选」后搜索、逐个勾选。仅作用于本次出片，不写入数据集状态。
        </p>
        <div class="scope-toolbar">
          <input v-model="scopeSearch" class="scope-input" placeholder="搜索姓名 / 机构等任意列内容…" />
          <button class="btn btn-mini" @click="scopeSelectAll">全选</button>
          <button class="btn btn-mini" @click="scopeSelectNone">取消全选</button>
          <button v-if="scopeSearchDebounced.trim()" class="btn btn-mini" @click="scopeAddFiltered">勾选命中项</button>
        </div>
        <div class="scope-list">
          <label v-for="i in scopeVisible" :key="i" class="scope-row" :class="{ on: scopePicked.has(i) }">
            <input type="checkbox" :checked="scopePicked.has(i)" @change="toggleScopeRow(i)" />
            <span class="scope-no">第 {{ i + 1 }} 行</span>
            <span class="scope-text" :title="rowPreview(dsDetail.rows[i])">{{ rowPreview(dsDetail.rows[i]) }}</span>
          </label>
          <p v-if="!scopeFiltered.length" class="hint-sub">没有匹配的行</p>
          <p v-else-if="scopeFiltered.length > SCOPE_RENDER_CAP" class="hint-sub">
            共 {{ scopeFiltered.length }} 行命中，仅列出前 {{ SCOPE_RENDER_CAP }} 行；请用搜索缩小范围
          </p>
        </div>
        <div class="modal-actions">
          <span class="scope-count">已选 {{ scopePicked.size }} / 共 {{ dsRowCount }} 行</span>
          <span class="tb-spacer"></span>
          <button class="btn" @click="scopeOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="!scopePicked.size" @click="confirmScope">确定</button>
        </div>
      </div>
    </div>

    <!-- 删除打印任务确认：应用内统一风格，替代原生 confirm -->
    <ConfirmDialog
      v-if="pendingDelete"
      :title="pendingDelete.jobs.length > 1 ? '删除打印历史' : '删除打印任务'"
      :message="pendingDelete.message"
      confirm-text="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </section>
</template>

<style scoped>
.output-progress{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;margin:12px 0;border:1px solid var(--line);border-radius:8px;background:var(--paper-card)}
.preview-paging{display:flex;gap:8px;align-items:center;font-size:12px}
.preview-page-input { width: 58px; padding: 5px 6px; box-sizing: border-box; border: 1px solid var(--line-strong); border-radius: 5px; background: var(--input-bg); color: var(--ink); font: inherit; text-align: center; }
.preview-page-input:focus-visible { outline: 2px solid var(--cinnabar); outline-offset: 1px; }
.preview-page-input:disabled { opacity: .5; }

/* 这排按钮（逐条导出 / 直接打印 / 导出 PDF / 打印历史）与顶栏贴得太紧，读起来像顶栏的一部分。
   只在本页加顶部留白，与底图制作页同口径——PageHeader 是全局组件，改它会连带其他页。 */
.print-header { margin-top: 14px; margin-bottom: 8px; }
.print-header :deep(.page-header__text) { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; }
.print-header :deep(.page-header__desc) { margin: 0; padding: 0; line-height: 1.4; }
.print-header :deep(.page-header__actions) { gap: 8px; }

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper-card);
}

.toolbar-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  min-width: 0;
}

.toolbar-row-output {
  padding: 10px 0 2px;
}

.toolbar-row-template { flex: 1 1 380px; }
.output-settings { min-width: 0; max-width: 100%; }
.output-settings:not([open]) { flex: 0 1 auto; }
.output-settings[open] { flex: 1 0 100%; border-top: 1px solid var(--line); padding-top: 8px; }
.output-settings summary { cursor: pointer; padding: 5px 9px; border: 1px solid var(--cinnabar); border-radius: 6px; background: var(--cinnabar-soft); color: var(--accent-ink); font-size: 12px; font-weight: 600; }
.output-settings summary:hover { filter: brightness(.96); }
.output-settings summary:focus-visible { outline: 2px solid var(--cinnabar); outline-offset: 2px; }
.output-settings:not([open]) summary { max-width: min(42vw, 520px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.output-settings summary span { color: var(--stone); font-weight: 400; }
.output-settings .format-note { padding-top: 8px; }

.toolbar-control {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.toolbar-name-fields,
.toolbar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.toolbar-name-plus { color: var(--stone); font-size: 13px; }
.toolbar-actions { margin-left: 0; }
.image-quality { font-size: 13px; color: var(--stone); }
.image-quality input { width: 60px; box-sizing: border-box; padding: 6px; border: 1px solid var(--line-strong); border-radius: 5px; color: var(--ink); background: var(--paper-card); }
.format-note { margin: 0; color: var(--stone); font-size: 12px; }

.tb-label {
  font-size: 13px;
  color: var(--stone);
}

.scope-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper-card);
}

.scope-note { font-size: 12px; color: var(--stone); }
.range-count { color: var(--ink-2); font-weight: 600; }
.tb-spacer { flex: 1; }

.print-summary{display:flex;align-items:center;flex-wrap:wrap;gap:0;margin-bottom:8px;border:1px solid var(--line);border-radius:8px;background:var(--paper-card)}
.print-summary .range-bar{margin:0;border:0;background:transparent;flex:0 1 auto}
.print-summary .range-bar .tb-spacer{display:none}
.photo-preflight{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;min-width:0;flex:1 1 auto;border-left:1px solid var(--line)}
.photo-preflight-error{font-size:12px;color:var(--danger)}
.photo-count{padding:2px 8px;border:1px solid var(--line-strong);border-radius:6px;background:var(--paper);color:var(--ink);font-size:12px;cursor:pointer}
.photo-count.blocking{border-color:var(--danger);color:var(--danger)}
.photo-issues{flex-basis:100%;border-top:1px solid var(--line);padding-top:8px}
.photo-issues-head{display:flex;align-items:center;justify-content:space-between;font-size:12px}
.photo-issues-list{max-height:230px;overflow:auto;margin-top:6px}
.photo-issue-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-top:1px solid var(--line);font-size:12px;overflow-wrap:anywhere}
.photo-edit-error{padding:8px 12px;margin:0}
.photo-edit{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--paper)}
.photo-edit-person{font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.photo-edit-hint,.photo-edit-status{font-size:12px;color:var(--stone)}
.photo-edit-status{margin-left:auto;white-space:nowrap}
.photo-edit-controls{display:flex;align-items:center;gap:6px}

.bound-ds {
  font-size: 13px;
  color: var(--ink-2);
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
}

.rebind-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: var(--danger-soft);
}

.rebind-result.ok {
  border-color: var(--ok);
  background: var(--ok-soft);
}

.mismatch-bar {
  border-color: var(--danger);
  background: var(--danger-soft);
  align-items: flex-start;
}

.btn {
  padding: 6px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  border-color: var(--cinnabar);
  color: var(--accent-ink);
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.btn-primary {
  background: var(--accent-solid);
  border-color: var(--accent-solid);
  color: var(--on-accent);
}

.btn-primary:hover:not(:disabled) { color: var(--on-accent); }
.btn-primary:active:not(:disabled) { background: var(--accent-active); border-color: var(--accent-active); color: var(--on-accent-active); }

@media (max-width: 1120px) {
  .toolbar-actions { margin-left: 0; }
}

@media (max-width: 680px) {
  .toolbar { padding: 10px; }
  .toolbar-row { align-items: flex-start; }
  .toolbar-control { align-items: flex-start; flex-direction: column; }
  .toolbar-actions { width: 100%; }
  .toolbar-actions .btn { flex: 1 1 auto; }
  .photo-preflight { border-left:0; border-top:1px solid var(--line); flex-basis:100%; }
  .photo-edit-status { margin-left:0; }
}

.btn-mini {
  padding: 3px 10px;
  font-size: 12px;
}

.row-actions {
  white-space: nowrap;
}

.row-actions .btn-mini + .btn-mini {
  margin-left: 6px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 10vh;
}

.hint-main {
  font-size: 15px;
  color: var(--ink-2);
}

.hint-sub {
  font-size: 12px;
  color: var(--stone);
}

.preview-wrap {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper-card);
  overflow: hidden;
}

.preview-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.preview-meta {
  font-size: 13px;
  color: var(--ink-2);
}

/* 底图输出分辨率：出片前唯一能提前判断「印出来清不清」的数 */
.preview-dpi {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  color: var(--stone);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-dpi.dpi-good { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
.preview-dpi.dpi-ok { color: var(--stone); }
.preview-dpi.dpi-low { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }

.preview-stage { display: grid; min-width: 0; max-width: 100%; margin: 0 auto; align-items: center; background: var(--paper); }
.preview-stage.has-paging { grid-template-columns: 50px minmax(0, 1fr) 50px; }
.preview-page-arrow { display: grid; place-items: center; justify-self: center; width: 36px; height: 44px; padding: 6px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper-card); color: var(--ink-2); cursor: pointer; }
.preview-page-arrow svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.preview-page-arrow:hover:not(:disabled) { color: var(--accent-ink); border-color: var(--cinnabar); }
.preview-page-arrow:focus-visible { outline: 2px solid var(--cinnabar); outline-offset: 2px; }
.preview-page-arrow:disabled { opacity: .35; cursor: default; }
.preview-scroll {
  max-height: calc(100vh - 200px);
  overflow: auto;
  padding: 16px;
  background: var(--paper);
}

.preview-holder {
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  background: #fff;
  box-shadow: var(--shadow);
}

.preview-frame {
  display: block;
  background: #fff;
  transform-origin: top left;
}

.history-trigger { display: inline-flex; align-items: center; gap: 7px; }
.history-trigger span { min-width: 18px; padding: 1px 5px; border-radius: 9px; background: var(--cinnabar-soft); color: var(--accent-ink); text-align: center; font-size: 11px; }
.modal-mask.history-mask { z-index: 110; }
.modal.history-modal { width: min(1120px, calc(100vw - 32px)); max-height: 86vh; }
.history-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.history-head .modal-title { margin: 0; }
.history-count { margin: 4px 0 0; color: var(--stone); font-size: 12px; }
.history-table-wrap { min-height: 0; overflow: auto; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.history-table-wrap .job-table { min-width: 940px; }
.history-select { width: 38px; text-align: center !important; }
.history-select input { width: 15px; height: 15px; accent-color: var(--cinnabar); }
.history-empty { padding: 20px; text-align: center; }

.job-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.job-table th {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 2px solid var(--line-strong);
  color: var(--stone);
  font-weight: 500;
}

.job-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-2);
}

.job-del { color: var(--danger); }

.det-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}

.det-stats {
  font-size: 12px;
  color: var(--stone);
}

.det-flag {
  display: inline-block;        /* 让 padding/border 生效可预测；inline-block 不会换行成块 */
  white-space: nowrap;         /* 关键：禁止徽标文本被拆行；
                                       否则窗口缩小、表格列压到一字宽时，「完成」会拆成「完」/「成」两行 */
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 4px;
  border: 1px solid var(--line-strong);
  color: var(--ink-2);
  vertical-align: middle;
}

.st-ok {
  color: var(--ok);
  border-color: var(--ok);
}

.st-failed {
  color: var(--danger);
  border-color: var(--danger);
}

.st-canceled {
  color: var(--stone);
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 26, 20, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  width: 460px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--paper-card);
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  padding: 20px 22px;
  box-shadow: var(--shadow);
}

.modal-title {
  margin: 0 0 6px;
  font-size: 16px;
  color: var(--accent-ink);
}

.modal-sub {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--ink-2);
}

.issue-list {
  overflow-y: auto;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 4px 2px;
  margin-bottom: 14px;
}

.issue-label {
  font-size: 13px;
  color: var(--ink);
  min-width: 90px;
}

/* 去补录直达：出错单元格行号 chips */
.fix-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 2px 6px 14px;
  border-bottom: 1px dashed var(--line);
}
.fix-row:last-child { border-bottom: none; }

.fix-label {
  font-size: 12px;
  color: var(--stone);
  min-width: 78px;
}

.fix-chip {
  padding: 2px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--paper);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}
.fix-chip:hover {
  border-color: var(--cinnabar);
  color: var(--accent-ink);
}
.fix-chip.ph { border-style: dashed; }
.fix-chip.ov { border-style: dotted; }

.fix-more {
  font-size: 12px;
  color: var(--stone);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

/* ---- 出片范围（行级勾选） ---- */
.st-partial {
  color: var(--accent-ink);
  border-color: var(--cinnabar);
}

.partial-tag {
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--cinnabar);
  border-radius: 8px;
  font-size: 11px;
  color: var(--accent-ink);
  white-space: nowrap;
}

/* ---- 多联回退提示（配了多联但纸张放不下，已自动按单页出片） ---- */
.layout-warn {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-2);
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  border-radius: 4px;
}

.lw-tag {
  flex: none;
  padding: 0 6px;
  font-size: 11px;
  color: var(--warn);
  border: 1px solid var(--warn-line);
  border-radius: 8px;
  white-space: nowrap;
}

.modal-wide { width: 560px; }

.scope-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.scope-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 13px;
}

.scope-list {
  overflow-y: auto;
  max-height: 46vh;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 4px 2px;
  margin-bottom: 14px;
}

.scope-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
}

.scope-row:hover { background: var(--paper); }
.scope-row.on { background: var(--cinnabar-soft); }

.scope-no {
  flex-shrink: 0;
  min-width: 64px;
  font-size: 12px;
  color: var(--stone);
  font-variant-numeric: tabular-nums;
}

.scope-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scope-count {
  font-size: 12px;
  color: var(--stone);
}

.toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: 8px;
  background: var(--ink);
  color: var(--paper);
  font-size: 13px;
  z-index: 120;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

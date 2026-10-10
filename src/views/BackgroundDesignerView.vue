<script setup>
import { ref, computed, watch, nextTick, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import DesignSurface from '../components/DesignSurface.vue'
import AssetLibrarySidebar from '../components/AssetLibrarySidebar.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { designerNav } from '../lib/designer-nav.js'
import { normalizeDesign, imageDpi, normalizeFamily, DEFAULT_FONT_STACK } from '../../electron/design-layout.cjs'
import {
  expandSelection, editableSelection, selectLayer as selectGroupedLayer, groupForLayer,
  createGroup, ungroupSelection, duplicateSelection, removeSelection, reorderSelection,
} from '../../electron/design-editor.cjs'

defineOptions({ name: 'BackgroundDesignerView' })

const DRAFT_KEY = 'printpress-background-designer-draft-v1'
const clone = (value) => JSON.parse(JSON.stringify(value))
const uid = (prefix = 'layer') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
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
// 属性面板（工程与画布/检查器）也是浮层：不占网格列，画布始终满宽；
// 默认展开保持原有工作流，收起后给画布让出整个右侧。
// 注意它**不做事 关闭**——点画布选图层是主工作流，只走开关按钮。
const showInspector = ref(true)
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
    message.value = '已加入素材库：这张图受管理，删除图层不会清理原件'
  } catch (err) { fail(err) }
  finally { busy.value = false }
}
/** 行内排序：让被点的行（或其所在组整体）成为当前选择，再走统一 reorder */
function reorderRow(row, direction) {
  selectedIds.value = row.group ? [...row.group.layerIds] : [row.id]
  reorder(direction)
}
const fonts = ref({ system: [], uploaded: [] })
const context = ref(null)
const pending = ref(null)
const stage = ref(null)
const zoom = ref(1)
const snap = ref(true)
const keepRatio = ref(true)
const guides = ref({ x: null, y: null })
const guidesVisible = ref(true)
const newGuideAxis = ref('x')
const newGuidePosition = ref(50)
const visibleGuides = computed(() => guidesVisible.value ? (design.value.guides || []).filter(guide => guide.position >= 0 && guide.position <= design.value.artboard[guide.axis === 'x' ? 'w' : 'h']) : [])
const showExport = ref(false)
const exportDpi = ref(300)
const exportTransparent = ref(false)
const exportError = ref('')
/**
 * 最近一次成功导出的结果（含绝对路径），用来给出「打开所在文件夹 / 用系统程序打开」。
 *
 * 存结果、不存路径字符串本身：这两个动作**不接受参数**，真正被打开的路径由主进程
 * 记着（最近一次写出的 PNG）。渲染层手里这份只用于显示与按钮开关。
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
const inputEpoch = ref(0)
const canvasWidth = computed(() => 720 * zoom.value)
const pxPerMm = computed(() => canvasWidth.value / design.value.artboard.w)
const canvasHeight = computed(() => design.value.artboard.h * pxPerMm.value)
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

function fail(err) { error.value = err?.message || String(err); message.value = '' }
function formatColor(value) { return value === 'transparent' ? '透明' : String(value || '').toUpperCase() }
function clearFeedback() { error.value = ''; message.value = '' }
function record(before) {
  if (fingerprint(before) === fingerprint(design.value)) return
  history.value.push(before)
  if (history.value.length > 80) history.value.shift()
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
  future.value.push(clone(design.value))
  restoreHistory(history.value.pop())
}
function redo() {
  endGesture(); finishKeyboardMove()
  if (!future.value.length) return
  history.value.push(clone(design.value))
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
  if (busy.value) return
  if (dirty.value) pending.value = { title: '切换底图工程', message: '当前底图有未保存的修改。继续将放弃这些修改，请先保存需要保留的内容。', confirmText: '放弃修改并继续', action, cancel }
  else action()
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
  protectDraft(async () => {
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

function persistDraft() {
  clearTimeout(draftTimer)
  try {
    if (dirty.value) localStorage.setItem(DRAFT_KEY, JSON.stringify({ design: design.value, savedFingerprint: savedFingerprint.value, context: context.value }))
    else localStorage.removeItem(DRAFT_KEY)
  } catch (err) { fail(`本地恢复草稿无法写入，请及时保存工程：${err.message || err}`) }
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
function openExport() { if (!busy.value) { exportError.value = ''; showExport.value = true } }
async function exportPng() {
  if (busy.value || exportSizeError.value) return
  endGesture(); finishKeyboardMove()
  busy.value = true
  exportError.value = ''
  try {
    const result = await window.printpress.exportDesignPng({
      design: normalizeDesign(clone(design.value)), dpi: Number(exportDpi.value), transparent: exportTransparent.value,
    })
    if (result.canceled) return
    showExport.value = false
    clearFeedback()
    // 不再走通用 message：导出成功要带「打开所在文件夹 / 用系统程序打开」两个动作，
    // 那条提示条承载不了按钮，所以单独渲染一个带按钮的完成条。
    lastExport.value = result
  } catch (err) { exportError.value = err?.message || String(err) }
  finally { busy.value = false }
}
/**
 * 打开刚导出的 PNG。
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
  if (!active || pending.value || showExport.value) return
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
  if (pending.value || showExport.value) return
  dropDepth += 1
  dropActive.value = true
}

function onDragOver(event) {
  if (pending.value || showExport.value) return
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
  if (pending.value || showExport.value) return
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
function toggleLayer(layer, key) { commit((doc) => { const target = doc.layers.find((item) => item.id === layer.id); target[key] = !target[key] }) }
function removeSelected() {
  if (!editable.value.length) return
  let result
  let orphanedIds = []
  if (commit(doc => {
    result = removeSelection(doc, selectedIds.value, { expandGroups: false })
    Object.assign(doc, result.design)
    // 删图层后不再被任何图层引用的图片原件，从文档里一并撤引用（I-33）：
    // 不撤的话磁盘扫描永远判「仍被引用」，临时件永远删不掉。
    // library 来源的原件撤引用后仍留在素材库，不受影响。
    const used = new Set(doc.layers.filter((layer) => layer.type === 'image' && layer.assetId).map((layer) => layer.assetId))
    orphanedIds = Object.keys(doc.assets).filter((id) => !used.has(id))
    for (const id of orphanedIds) delete doc.assets[id]
  })) {
    selectedIds.value = result.selectedIds
    if (orphanedIds.length) discardOrphanedEphemeral(orphanedIds)
  }
}

/**
 * 图层删除后的后台同步清理（I-33，与模板页上传同一逻辑）：
 * template 来源（粘贴 / 拖入 / 「＋ 图片」对话框直接加入）且再无任何引用的原件
 * 当场删文件；library 来源（已点「加入素材库」）保留。
 * 真删了文件就清空撤销 / 重做栈——撤销快照会把图层复活，可文件已经没了（碎图）；
 * 「文件生死不进撤销栈」，此步不可撤销，界面会明说。
 */
async function discardOrphanedEphemeral(ids) {
  // 双保险：撤完引用后再核对一遍序列化文档里确实再无任何引用形状（未知字段也不怕）
  const serialized = JSON.stringify(design.value)
  const safeIds = ids.filter((id) => !serialized.includes(id))
  let removedAny = false
  for (const id of safeIds) {
    try {
      const res = await window.printpress.discardEphemeralAsset(id, design.value.id || undefined)
      if (res && res.removed) removedAny = true
    } catch { /* 单个失败不阻塞界面：原件留在磁盘，后续 I-32 孤儿清理兜底 */ }
  }
  if (removedAny) {
    history.value = []
    future.value = []
    message.value = '已删除所选图层，未加入素材库的原图已同步清理（此步不可撤销）'
  }
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

function pointerDown(event, layer, resize = false) {
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
  if (!resize) {
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
  if (!resize && (event.shiftKey || event.ctrlKey || event.metaKey)) { selectLayer(layer, event); return }
  if (!selectedIds.value.includes(layer.id)) selectLayer(layer)
  if (!resize) selectedIds.value = expandSelection(design.value, selectedIds.value)
  if (layer.locked || !editable.value.some(item => item.id === layer.id)) return
  finishKeyboardMove(); endGesture()
  gesture = { before: clone(design.value), type: resize ? 'resize' : 'move', startX: event.clientX, startY: event.clientY, layerId: layer.id, ids: new Set(editable.value.map((item) => item.id)), ratio: keepRatio.value && layer.type === 'image' }
  window.addEventListener('pointermove', pointerMove)
  window.addEventListener('pointerup', endGesture, { once: true })
  window.addEventListener('pointercancel', cancelGesture, { once: true })
}
function snapDelta(originals, dx, dy) {
  const moving = union(originals)
  const xTargets = [0, design.value.artboard.w / 2, design.value.artboard.w]
  const yTargets = [0, design.value.artboard.h / 2, design.value.artboard.h]
  for (const guide of visibleGuides.value) (guide.axis === 'x' ? xTargets : yTargets).push(guide.position)
  for (const layer of design.value.layers.filter((layer) => layer.visible && !gesture.ids.has(layer.id))) {
    const box = bounds(layer)
    xTargets.push(box.x, box.x + box.w / 2, box.x + box.w)
    yTargets.push(box.y, box.y + box.h / 2, box.y + box.h)
  }
  function nearest(values, targets) {
    let found = { distance: 6 / pxPerMm.value, delta: 0, guide: null }
    for (const value of values) for (const target of targets) {
      const delta = target - value
      if (Math.abs(delta) < found.distance) found = { distance: Math.abs(delta), delta, guide: target }
    }
    return found
  }
  const x = nearest([moving.x + dx, moving.x + moving.w / 2 + dx, moving.x + moving.w + dx], xTargets)
  const y = nearest([moving.y + dy, moving.y + moving.h / 2 + dy, moving.y + moving.h + dy], yTargets)
  guides.value = { x: x.guide, y: y.guide }
  return { dx: dx + x.delta, dy: dy + y.delta }
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
    let w = Math.max(0.2, original.w + dx * cos + dy * sin)
    let h = original.type === 'line' ? original.h : Math.max(0.2, original.h - dx * sin + dy * cos)
    if (original.type !== 'line' && (gesture.ratio || event.shiftKey)) {
      const factor = Math.max(w / original.w, h / original.h)
      w = original.w * factor; h = original.h * factor
    }
    const dw = w - original.w, dh = h - original.h
    layer.x = round(original.x + (dw * cos - dh * sin - dw) / 2)
    layer.y = round(original.y + (dw * sin + dh * cos - dh) / 2)
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
  if (!active || pending.value || showExport.value || event.isComposing) return
  const input = event.target?.closest?.('input,textarea,select,[contenteditable="true"]')
  const modifier = event.ctrlKey || event.metaKey
  // 就地编辑要先落定再存盘，否则「改完字按 Ctrl+S」会把旧文字存下去
  if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); finishTextEdit(); event.target?.blur?.(); save(); return }
  if (input) return
  if (event.key === 'Escape') { cancelGesture(); selectedIds.value = []; return }
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
  finishTextEdit()
  endGesture(); finishKeyboardMove(); persistDraft()
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
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
    if (draft?.design) {
      design.value = normalizeDesign(draft.design)
      savedFingerprint.value = typeof draft.savedFingerprint === 'string' ? draft.savedFingerprint : ''
      context.value = draft.context || null
      message.value = '已恢复上次未保存的底图草稿。'
    }
  } catch (err) { fail(`恢复草稿失败：${err.message || err}`) }
  try {
    // 内置预设必须**在这里**也刷一次，不能只靠 activate()：首次进入本页时
    // onActivated 早于 onMounted 的这轮 await 跑完（那时 initialized 还是 false），
    // activate() 里那句被 initialized 门控的 refreshPresets 会被整个跳过——
    // 结果是「常用模板」下拉一直空着且禁用，用户以为没有这个功能，
    // 得先切到别的页再切回来才出现。属于「看不见的失败」。
    const results = await Promise.allSettled([refreshProjects(), refreshFonts(), refreshPresets()])
    if (results[0].status === 'rejected') fail(results[0].reason)
    if (results[1].status === 'rejected') fail(results[1].reason)
    if (results[2].status === 'rejected') fail(results[2].reason)
  } catch (err) { fail(err) }
  initialized = true
  refreshAdopted()
  if (designerNav.request) consumeRequest(designerNav.request)
})
onActivated(activate)
onDeactivated(deactivate)
onBeforeUnmount(() => { deactivate(); clearTimeout(draftTimer); for (const face of fontFaces) document.fonts.delete(face) })
</script>

<template>
  <section class="designer-view">
    <div class="designer-heading">
      <div><h2>底图制作</h2><p>图片、固定文字与形状分别编辑，保存后用于打印模板。</p></div>
      <div class="heading-actions">
        <button data-testid="design-new" :disabled="busy" @click="newDesign">新建底图</button>
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
        <button data-testid="design-toggle-inspector" :class="{ on: showInspector }" :disabled="busy" :title="showInspector ? '隐藏属性面板（画布满宽）' : '显示属性面板（工程与画布、图层属性）'" @click="showInspector = !showInspector">属性</button>
        <button data-testid="design-export-png" :disabled="busy" @click="openExport">导出 PNG</button>
        <button data-testid="design-save" class="primary" :disabled="busy" @click="save()">{{ busy ? '处理中…' : '保存工程' }}</button>
        <button v-if="context" data-testid="design-apply" class="primary" :disabled="busy || dimensionMismatch" @click="save(false, true)">保存并应用到模板</button>
      </div>
    </div>
    <div v-if="error" class="notice error" role="alert">{{ error }}<button @click="error = ''">关闭</button></div>
    <div v-else-if="message" class="notice success" role="status">{{ message }}</div>
    <!--
      导出完成条：刻意排在通用提示条**之后**——`.notice.success` 的选择器要优先命中
      通用提示（既有验收就是这么取文案的），抢在前面会把那些断言指错元素。
      它说的是「磁盘上那个文件」，所以不跟编辑状态走：改了工程也不消失，直到下次导出或手动关掉。
    -->
    <div v-if="lastExport" class="notice success export-done" role="status">
      <span class="export-done-text">PNG 已导出：{{ lastExport.width }} × {{ lastExport.height }} px · {{ lastExport.dpi }} DPI<code class="export-done-path" :title="lastExport.filePath">{{ lastExport.filePath }}</code></span>
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
    <div class="designer-workspace">
      <aside class="designer-panel tools-panel">
        <h3>添加内容</h3>
        <div class="tool-grid">
          <button data-testid="design-add-image" :disabled="busy" title="也可以 Ctrl+V 粘贴截图，或把图片文件拖进画布" @click="addImage">＋ 图片</button>
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
              <span v-if="row.layer.editorOnly" class="layer-flag" title="仅编辑可见：打印、PDF 与 PNG 导出里都不会出现">仅编辑</span>
              <span class="layer-row-actions" @click.stop>
                <template v-if="row.layer.type === 'image' && row.layer.assetId">
                  <button v-if="!adoptedIds.has(row.layer.assetId)" class="icon-button" title="加入素材库：收藏这张原图，之后删除图层不会清理它" @click.stop="adoptLayerAsset(row.layer)">＋</button>
                  <span v-else class="adopted-flag" title="已在素材库（受管理，删除图层不会清理）">★</span>
                </template>
                <button class="icon-button" :title="hasPartialGroup ? '先选择完整分组再调整层级' : '上移一层'" :aria-label="`上移一层：${row.layer.name}`" :disabled="!editable.length || hasPartialGroup" @click.stop="reorderRow(row, 'up')">↑</button>
                <button class="icon-button" :title="hasPartialGroup ? '先选择完整分组再调整层级' : '下移一层'" :aria-label="`下移一层：${row.layer.name}`" :disabled="!editable.length || hasPartialGroup" @click.stop="reorderRow(row, 'down')">↓</button>
                <button class="icon-button" title="置顶" :aria-label="`置顶：${row.layer.name}`" :disabled="!editable.length || hasPartialGroup" @click.stop="reorderRow(row, 'top')">⤒</button>
                <button class="icon-button" title="置底" :aria-label="`置底：${row.layer.name}`" :disabled="!editable.length || hasPartialGroup" @click.stop="reorderRow(row, 'bottom')">⤓</button>
              </span>
              <button class="icon-button" :title="row.layer.locked ? '解锁图层' : '锁定图层'" :aria-label="row.layer.locked ? '锁定图层' : '解锁图层'" @click.stop="toggleLayer(row.layer, 'locked')">{{ row.layer.locked ? '锁' : '开' }}</button>
            </div>
          </template>
        </div>
        <div class="tool-grid">
          <button data-testid="design-group-copy" :disabled="!selected.length" @click="duplicate">{{ selectedGroup ? '复制整组' : '复制所选' }}</button><button data-testid="design-group-delete" :disabled="!editable.length" @click="removeSelected">{{ selectedGroup ? '删除整组' : '删除所选' }}</button>
        </div>
        <p v-if="design.groups?.length" class="muted">点组名或画布选择整组；点列表中的成员可单独编辑属性。</p>
      </aside>
      <AssetLibrarySidebar v-if="showAssets" @insert="insertLibraryAsset" />
      <div class="canvas-column" :class="{ 'inspector-open': showInspector }">
        <div class="canvas-toolbar">
          <button data-testid="design-undo" :disabled="!history.length" title="Ctrl+Z" @click="undo">撤销</button>
          <button data-testid="design-redo" :disabled="!future.length" title="Ctrl+Shift+Z" @click="redo">重做</button>
          <label class="inline"><input v-model="snap" type="checkbox"> 吸附</label>
          <span class="toolbar-spacer"></span>
          <button title="缩小" @click="zoom = Math.max(0.25, round(zoom - 0.25))">−</button>
          <button title="恢复预览大小" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button>
          <button title="放大" @click="zoom = Math.min(3, round(zoom + 0.25))">＋</button>
        </div>
        <div class="canvas-scroll" :class="{ 'drop-active': dropActive }" @pointerdown.self="selectedIds = []" @dragenter.prevent="onDragEnter" @dragover.prevent="onDragOver" @dragleave.prevent="onDragLeave" @drop.prevent="onDrop">
          <div ref="stage" data-testid="design-stage" class="design-stage" :style="{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }" @pointerdown.self="selectedIds = []">
            <DesignSurface :design="surfaceDesign" :width="canvasWidth" :height="canvasHeight" :show-editor-only="true" @error="fail" />
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
              <button v-if="single?.id === layer.id && editable.some(item => item.id === layer.id)" class="resize-handle" :class="{ 'line-resize-handle': layer.type === 'line' }" :aria-label="layer.type === 'line' ? '调整直线长度' : '调整图层大小'" :title="layer.type === 'line' ? '拖动线段末端调整长度' : '拖动调整大小；Shift 保持比例'" @pointerdown.stop="pointerDown($event, layer, true)"></button>
            </div>
            <div v-for="guide in visibleGuides" :key="guide.id" :data-guide-line="guide.id" class="persistent-guide" :class="guide.axis === 'x' ? 'vertical' : 'horizontal'" :style="guide.axis === 'x' ? { left: `${guide.position * pxPerMm}px` } : { top: `${guide.position * pxPerMm}px` }"></div>
            <div v-if="guides.x !== null" class="snap-guide vertical" :style="{ left: `${guides.x * pxPerMm}px` }"></div>
            <div v-if="guides.y !== null" class="snap-guide horizontal" :style="{ top: `${guides.y * pxPerMm}px` }"></div>
            <div v-if="dropActive" class="drop-hint" aria-hidden="true">松开鼠标，把图片加为图层</div>
          </div>
        </div>
        <div class="canvas-status"><span>{{ design.artboard.w }} × {{ design.artboard.h }} mm · {{ selected.length ? `已选 ${selected.length} 个图层` : '未选中图层' }}</span><span :class="{ unsaved: dirty }">{{ dirty ? '未保存' : design.id ? `已保存 · v${design.revision}` : '空白工程' }}</span></div>
        <p class="shortcut-note">Ctrl+V 粘贴截图 / 拖入图片即加图层 · 双击文字直接改字 · Shift / Ctrl 点击多选 · 方向键移动 0.1 mm，Shift 加速 · Alt 拖动暂停吸附 · Ctrl+S 保存</p>
      </div>
      <aside v-if="showInspector" class="designer-panel inspector">
        <h3>工程与画布</h3>
        <label>工程名称<input data-testid="design-name" :value="design.name" maxlength="120" @change="setDoc('name', $event.target.value)"></label>
        <div class="property-grid">
          <label>宽度 mm<input type="number" min="1" step="0.1" :value="design.artboard.w" :disabled="!!context" @change="setArtboard('w', $event.target.value)"></label>
          <label>高度 mm<input type="number" min="1" step="0.1" :value="design.artboard.h" :disabled="!!context" @change="setArtboard('h', $event.target.value)"></label>
        </div>
        <label class="color-field" @click="openColorPicker"><span>画布背景</span><span class="color-control"><input type="color" :value="design.artboard.background === 'transparent' ? '#ffffff' : design.artboard.background" aria-label="选择画布背景颜色" @input="colorInput('background', $event.target.value, 'artboard')" @change="colorChange('background', $event.target.value, 'artboard')"><code class="color-value">{{ formatColor(design.artboard.background) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label>
        <details class="guide-panel" open>
          <summary>参考线 <span>{{ design.guides?.length || 0 }}</span></summary>
          <label class="inline"><input v-model="guidesVisible" data-testid="design-guides-visible" type="checkbox"> 显示并吸附参考线</label>
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
        <h3>{{ selectedGroup ? '分组属性' : selected.length > 1 ? `多选 ${selected.length} 个图层` : single ? '图层属性' : '排版属性' }}</h3>
        <template v-if="selectedGroup">
          <label>分组名称<input data-testid="design-group-name" :value="selectedGroup.name" maxlength="120" @change="renameGroup($event.target.value)"></label>
          <p class="muted">{{ selectedGroup.layerIds.length }} 个图层整体移动与对齐。分组不支持整体缩放或旋转；请在列表选择成员分别调整。</p>
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
            <template v-else-if="single.type === 'image'">
              <label class="inline"><input v-model="keepRatio" type="checkbox"> 缩放与裁切保持图片比例</label>
              <div class="tool-grid"><button @click="setLayer('flipX', !single.flipX)">{{ single.flipX ? '取消水平翻转' : '水平翻转' }}</button><button @click="setLayer('flipY', !single.flipY)">{{ single.flipY ? '取消垂直翻转' : '垂直翻转' }}</button></div>
              <h4>裁切范围（原图百分比）</h4>
              <div class="property-grid"><label v-for="[key, label] in [['x','左侧 %'],['y','顶部 %'],['w','宽度 %'],['h','高度 %']]" :key="key">{{ label }}<input :data-testid="`design-crop-${key}`" type="number" min="0" max="100" step="1" :value="round(single.crop[key] * 100)" @change="setCrop(key, $event.target.value)"></label></div>
              <button @click="resetCrop">恢复完整图片范围</button>
              <p class="muted">原图 {{ design.assets[single.assetId]?.width }} × {{ design.assets[single.assetId]?.height }} px · 当前约 {{ dpiText }} DPI</p>
            </template>
            <template v-else>
              <label v-if="single.type !== 'line'" class="color-field" @click="openColorPicker"><span>填充颜色</span><span class="color-control"><input type="color" :value="single.fill === 'transparent' ? '#ffffff' : single.fill" aria-label="选择填充颜色" @input="colorInput('fill', $event.target.value)" @change="colorChange('fill', $event.target.value)"><code class="color-value">{{ formatColor(single.fill) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label>
              <label v-if="single.type !== 'line'" class="inline"><input type="checkbox" :checked="single.fill === 'transparent'" @change="setLayer('fill', $event.target.checked ? 'transparent' : '#ead9bf')"> 无填充</label>
              <div class="property-grid"><label class="color-field" @click="openColorPicker"><span>描边颜色</span><span class="color-control"><input type="color" :value="single.stroke === 'transparent' ? '#000000' : single.stroke" aria-label="选择描边颜色" @input="colorInput('stroke', $event.target.value)" @change="colorChange('stroke', $event.target.value)"><code class="color-value">{{ formatColor(single.stroke) }}</code><span class="color-open" aria-hidden="true">⌄</span></span></label><label>描边 mm<input type="number" min="0" step="0.1" :value="single.strokeWidth" @change="setLayer('strokeWidth', $event.target.value, true)"></label></div>
              <label v-if="single.type === 'rect'">圆角 mm<input type="number" min="0" step="0.5" :value="single.radius" @change="setLayer('radius', $event.target.value, true)"></label>
            </template>
          </fieldset>
        </template>
      </aside>
    </div>
    <div v-if="showExport" class="export-mask" @click.self="!busy && (showExport = false)">
      <section data-testid="design-export-dialog" class="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-heading">
        <h3 id="export-heading">导出 PNG 底图</h3>
        <p>导出当前编辑内容，包含所有可见图层（「仅编辑可见」的参考框不会导出，和打印保持一致）。</p>
        <label>输出分辨率<select v-model.number="exportDpi" data-testid="design-export-dpi" :disabled="busy"><option :value="150">150 DPI</option><option :value="300">300 DPI</option><option :value="600">600 DPI</option></select></label>
        <label class="inline"><input v-model="exportTransparent" data-testid="design-export-transparent" type="checkbox" :disabled="busy"> 透明背景（不绘制画布背景色）</label>
        <p class="export-dimensions" data-testid="design-export-size">{{ exportSize.width.toLocaleString() }} × {{ exportSize.height.toLocaleString() }} 像素 · {{ (exportSize.width * exportSize.height / 1000000).toFixed(1) }} 百万像素</p>
        <p class="muted">图片保持现有可见细节；提高 DPI 不会增加原图细节。图层工程可继续编辑。</p>
        <p v-if="exportSizeError || exportError" class="export-error" role="alert">{{ exportSizeError || exportError }}</p>
        <div class="export-actions"><button :disabled="busy" @click="showExport = false">取消</button><button data-testid="design-export-confirm" class="primary" :disabled="busy || !!exportSizeError" @click="exportPng">{{ busy ? '正在导出…' : '选择位置并导出' }}</button></div>
      </section>
    </div>
    <ConfirmDialog v-if="pending" :title="pending.title" :message="pending.message" :confirm-text="pending.confirmText" @confirm="confirmPending" @cancel="cancelPending" />
  </section>
</template>

<style scoped>
.designer-view { min-width: 960px; }
.designer-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; }
h2 { font-size: 20px; margin: 0 0 5px; } .designer-heading p { color: var(--ink-2); margin: 0; font-size: 12px; }
button { border: 1px solid var(--line-strong); background: var(--paper-card); color: var(--ink); border-radius: 5px; padding: 6px 9px; font-size: 12px; }
button:hover:not(:disabled) { border-color: var(--cinnabar); color: var(--cinnabar); }
button:disabled { opacity: .42; cursor: default; }
button.primary { color: #fff; background: var(--cinnabar); border-color: var(--cinnabar); }
button.primary:hover:not(:disabled) { color: #fff; filter: brightness(1.07); }
.heading-actions { display: flex; gap: 8px; flex-wrap: wrap; }
/* 下拉里塞了「名称 — 说明」，收起来时按固定宽度截断；展开的列表仍是完整文案 */
.preset-picker { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-2); }
.preset-picker select { max-width: 230px; border: 1px solid var(--line-strong); background: var(--paper-card); color: var(--ink); border-radius: 5px; padding: 6px 6px; font-size: 12px; }
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
.heading-actions button.on { border-color: var(--cinnabar); color: var(--cinnabar); background: var(--paper-card); }
.designer-workspace { display: grid; grid-template-columns: 176px minmax(450px, 1fr); gap: 12px; align-items: start; position: relative; }
/* 素材库抽屉：浮在画布左侧（覆盖而非占列），打开不再挤压画布；内部自行滚动；点外部收起 */
.designer-panel.asset-library { position: absolute; top: 0; bottom: 0; left: 188px; width: 256px; z-index: 40; box-shadow: 0 6px 24px rgba(43, 38, 34, 0.22); }
/* 属性面板抽屉：浮在画布右侧，只走「属性」开关（点画布选图层不能关它）；
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
.canvas-column { min-width: 0; }
.canvas-toolbar { display: flex; align-items: center; gap: 7px; background: var(--paper-card); border: 1px solid var(--line); padding: 8px; border-radius: 8px 8px 0 0; }
.toolbar-spacer { flex: 1; }
.canvas-scroll { overflow: auto; min-height: 430px; height: calc(100vh - 295px); max-height: 880px; padding: 30px; background-color: var(--line); background-image: radial-gradient(var(--stone) .6px, transparent .6px); background-size: 12px 12px; }
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
.resize-handle { position: absolute; padding: 0; width: 10px; height: 10px; right: -5px; bottom: -5px; background: #fff; border: 1px solid #b03a2e; border-radius: 1px; cursor: nwse-resize; touch-action: none; }
.resize-handle.line-resize-handle { top: 50%; right: -5px; bottom: auto; transform: translateY(-50%); cursor: ew-resize; }
.snap-guide { position: absolute; pointer-events: none; z-index: 10; }
.snap-guide.vertical { top: 0; bottom: 0; border-left: 1px dashed #d02775; } .snap-guide.horizontal { left: 0; right: 0; border-top: 1px dashed #d02775; }
.persistent-guide { position: absolute; pointer-events: none; z-index: 9; }
.persistent-guide.vertical { top: 0; bottom: 0; border-left: 1px solid #2689c9; }
.persistent-guide.horizontal { left: 0; right: 0; border-top: 1px solid #2689c9; }
.canvas-status { display: flex; justify-content: space-between; gap: 12px; padding: 9px; background: var(--paper-card); border: 1px solid var(--line); border-radius: 0 0 8px 8px; font-size: 11px; color: var(--ink-2); }
.unsaved { color: var(--cinnabar); } .shortcut-note { font-size: 11px; color: var(--stone); line-height: 1.7; margin: 8px 0; }
.inspector label { display: flex; flex-direction: column; gap: 5px; color: var(--ink-2); font-size: 11px; margin-bottom: 9px; }
.inspector input, .inspector select, .inspector textarea { width: 100%; min-width: 0; border: 1px solid var(--line-strong); background: var(--input-bg); color: var(--ink); border-radius: 4px; padding: 6px; font: inherit; font-size: 12px; }
.inspector .color-field { gap: 6px; }
.inspector .color-control { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 40px; padding: 4px 10px 4px 5px; box-sizing: border-box; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--input-bg); transition: border-color .15s, box-shadow .15s; }
.inspector .color-control:focus-within { border-color: var(--cinnabar); box-shadow: 0 0 0 2px var(--cinnabar-soft); }
.inspector .color-control input[type="color"] { flex: 0 0 34px; width: 34px; height: 30px; padding: 2px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper-card); cursor: pointer; }
.inspector .color-value { color: var(--ink); font: 11px ui-monospace, Consolas, monospace; letter-spacing: .04em; }
.inspector .color-open { margin-left: auto; color: var(--stone); font-size: 16px; line-height: 1; }
.inspector textarea { resize: vertical; line-height: 1.6; }
label.inline { display: flex; flex-direction: row; align-items: center; gap: 4px; font-size: 11px; margin: 0; }
label.inline input { width: auto; margin: 3px; } .inspector label.inline { margin: 8px 0; }
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
.export-dialog select { border: 1px solid var(--line-strong); background: var(--input-bg); color: var(--ink); border-radius: 5px; padding: 6px 25px 6px 8px; }
.export-dialog .export-dimensions { font-size: 14px; font-weight: 600; color: var(--ink); padding: 10px 12px; background: var(--paper); border-radius: 6px; margin: 18px 0 12px; }
.export-dialog .export-error { color: var(--warn); background: var(--warn-soft); padding: 8px 10px; border-radius: 5px; }
.export-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
@media (max-width: 1180px) { .designer-workspace { grid-template-columns: 160px minmax(400px, 1fr); gap: 8px; } .designer-panel.asset-library { left: 168px; width: 230px; } .designer-panel.inspector { width: 236px; } .canvas-column.inspector-open .canvas-toolbar, .canvas-column.inspector-open .canvas-status { padding-right: 248px; } .designer-panel { padding: 9px; } .designer-heading { align-items: flex-start; } }
</style>

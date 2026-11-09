<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { EDIT_LIMITS, normalizeErasures, erasureMask } from '../../electron/design-image-edit.cjs'
import { repairImagePixels } from '../lib/image-repair.cjs'
import AppIcon from './AppIcon.vue'

const props = defineProps({ layer: { type: Object, required: true }, asset: { type: Object, required: true }, restoreAsset: { type: Object, default: null }, mode: { type: String, default: 'crop' }, applyError: { type: String, default: '' }, busy: { type: Boolean, default: false } })
const emit = defineEmits(['apply', 'cancel'])
const copy = value => JSON.parse(JSON.stringify(value))
const dialog = ref(null), board = ref(null), imageViewport = ref(null), sourceImage = ref(null)
const tool = ref(props.mode === 'mask' ? 'maskErase' : props.mode === 'erase' ? 'brush' : 'crop')
const restoreImage = ref(null), restoreLoaded = ref(false), maskSoftness = ref(.5)
const maskTool = computed(() => tool.value === 'maskErase' || tool.value === 'maskRestore')
const editTitle = computed(() => tool.value === 'maskErase' ? '精细擦除' : tool.value === 'maskRestore' ? '恢复主体' : tool.value === 'crop' ? '裁剪图片' : tool.value === 'clone' ? '仿制图章' : tool.value ? '图片修补' : '图片编辑')
const redraw = ref(true)
const pendingCrop = ref(copy(props.layer.crop))
// Previous transparent edits stay independent of the new repair selection.
const previousErasures = ref(copy(props.layer.erasures || []))
const erasures = ref([])
const cloneStrokes = ref([])
const cloneSource = ref(null)
const pickingCloneSource = ref(false)
const previewUrl = ref(''), previewBlob = ref(null), processing = ref(false), notice = ref('')
// Keep the last finished image visible while a new stroke is being repaired.
const renderedMarks = shallowRef([]), renderedCloneStrokes = shallowRef([])
const editHistory = shallowRef([]), renderedActions = shallowRef([]), renderedBakesPrevious = ref(false)
let renderedCanvas = null, renderedPreviousKey = ''
const pendingMarks = computed(() => {
  if (!previewUrl.value) return erasures.value
  let same = 0
  while (same < erasures.value.length && same < renderedMarks.value.length && erasures.value[same] === renderedMarks.value[same]) same++
  return erasures.value.slice(same)
})
const pendingCloneStrokes = computed(() => {
  if (!previewUrl.value) return cloneStrokes.value
  let same = 0
  while (same < cloneStrokes.value.length && same < renderedCloneStrokes.value.length && cloneStrokes.value[same] === renderedCloneStrokes.value[same]) same++
  return cloneStrokes.value.slice(same)
})
const hasEdits = computed(() => erasures.value.length > 0 || cloneStrokes.value.length > 0)
const draggingRect = ref(false)
let disposed = false, repairRevision = 0, applyAfterPreview = false, refreshRequested = false, encoding = false
const rect = ref({ x: props.layer.crop.x * props.asset.width, y: props.layer.crop.y * props.asset.height, w: props.layer.crop.w * props.asset.width, h: props.layer.crop.h * props.asset.height })
const zoom = ref(1), size = ref(Math.min(8, Math.max(props.asset.width, props.asset.height)))
const cursor = ref(null), error = ref(''), loaded = ref(false)
const recognizing = ref(props.mode === 'erase')
const viewport = ref({ w: window.innerWidth, h: window.innerHeight })
const fit = computed(() => Math.min(1, Math.max(1, viewport.value.w) / props.asset.width, Math.max(1, viewport.value.h) / props.asset.height))
const scale = computed(() => fit.value * zoom.value)
const brushDiameter = computed(() => Math.min(Math.max(props.asset.width, props.asset.height), Math.max(1, Number(size.value) || 1)))
const source = computed(() => `pp://media/${props.asset.path.split('/').map(encodeURIComponent).join('/')}`)
const maskStyle = computed(() => { const mask = erasureMask(previousErasures.value, props.asset.width, props.asset.height); return mask && !(previewUrl.value && renderedBakesPrevious.value) ? { maskImage: mask, WebkitMaskImage: mask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : {} })
const handles = computed(() => ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(id => ({ id, x: rect.value.x + (id.includes('w') ? 0 : id.includes('e') ? rect.value.w : rect.value.w / 2), y: rect.value.y + (id.includes('n') ? 0 : id.includes('s') ? rect.value.h : rect.value.h / 2) })))
const pointCount = computed(() => erasures.value.reduce((n, s) => n + (s.points?.length || 0), 0))
let drag = null, capturedPointer = null
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const round = n => Math.round(n * 1000) / 1000
async function imageLoaded() {
  if (props.mode !== 'erase') { loaded.value = true; return }
  try {
    // Earlier non-destructive erasures already make an opaque original transparent.
    let transparent = previousErasures.value.length > 0
    if (!transparent && props.asset.mime !== 'image/jpeg') {
      const canvas = document.createElement('canvas'), side = 1024
      const ctx = canvas.getContext('2d', { willReadFrequently:true })
      if (!ctx) throw new Error('无法读取图片透明度')
      for (let y = 0; y < props.asset.height && !transparent; y += side) {
        for (let x = 0; x < props.asset.width && !transparent; x += side) {
          if (disposed) return
          canvas.width = Math.min(side, props.asset.width-x); canvas.height = Math.min(side, props.asset.height-y)
          ctx.drawImage(sourceImage.value, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { transparent = true; break }
          // Yield between tiles so large opaque PNGs do not freeze the editor.
          if (!transparent) await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
    }
    if (!disposed && tool.value) tool.value = transparent ? 'maskErase' : 'brush'
  } catch {
    if (!disposed) error.value = '无法自动识别图片透明度，请手动选择魔法擦除或精细擦除。'
  } finally {
    if (!disposed) { recognizing.value = false; loaded.value = true }
  }
}
function point(event) {
  const r = board.value.getBoundingClientRect()
  return { x: round(clamp((event.clientX - r.left) * props.asset.width / r.width, 0, props.asset.width)), y: round(clamp((event.clientY - r.top) * props.asset.height / r.height, 0, props.asset.height)) }
}
function validRect(r) { return Object.values(r).every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= props.asset.width + 1e-7 && r.y + r.h <= props.asset.height + 1e-7 }
function setRect(key, event) {
  const next = { ...rect.value, [key]: Number(event.target.value) }
  if (!validRect(next)) { error.value = '选区必须在原图内，宽高至少为 1 像素。'; event.target.value = round(rect.value[key]); return false }
  rect.value = next; redraw.value = false; error.value = ''
  return true
}
function down(event) {
  if (event.button !== 0 || !tool.value || !loaded.value || drag || encoding || props.busy) return
  event.preventDefault()
  dialog.value?.focus({ preventScroll: true })
  applyAfterPreview = false
  if (processing.value) refreshRequested = true
  const p = point(event)
  const handle = event.target.closest?.('[data-handle]')?.dataset.handle
  if (tool.value === 'clone' && pickingCloneSource.value) {
    cloneSource.value = p
    pickingCloneSource.value = false
    notice.value = `取样点：X ${round(p.x)}，Y ${round(p.y)} px；可在目标位置涂抹复制。`
    error.value = ''
    return
  }
  if (tool.value === 'clone' && !cloneSource.value) {
    pickingCloneSource.value = true
    error.value = '请先选择图章取样点，再在要修补的位置涂抹。'
    return
  }
  if (tool.value === 'brush') {
    if (erasures.value.length >= EDIT_LIMITS.strokes || pointCount.value >= EDIT_LIMITS.points) { error.value = '擦除笔迹已达上限，请撤销部分笔迹后重试。'; return }
    drag = { id: event.pointerId, kind: 'brush', count: erasures.value.length }
    const stroke = { type: 'brush', size: brushDiameter.value, points: [p] }
    erasures.value.push(stroke); editHistory.value = [...editHistory.value, { kind: 'erase', stroke }]
  } else if (tool.value === 'clone' || maskTool.value) {
    if (cloneStrokes.value.length >= EDIT_LIMITS.strokes || pointCount.value + clonePointCount.value >= EDIT_LIMITS.points) { error.value = '图章笔迹已达上限，请撤销部分笔迹后重试。'; return }
    if (tool.value === 'maskRestore' && !restoreLoaded.value) { error.value = '正在读取可恢复的原色图片，请稍后。'; return }
    const stroke = { source: { ...cloneSource.value }, size: brushDiameter.value, points: [p], ...(maskTool.value ? { mask: tool.value, softness: maskSoftness.value } : {}) }
    drag = { id: event.pointerId, kind: 'clone', count: cloneStrokes.value.length }
    cloneStrokes.value.push(stroke); editHistory.value = [...editHistory.value, { kind: maskTool.value ? 'mask' : 'clone', stroke }]
  } else {
    const kind = tool.value === 'rect' ? 'draw' : (handle || (!redraw.value && event.target.dataset.move !== undefined ? 'move' : 'draw'))
    drag = { id: event.pointerId, kind, start: p, before: { ...rect.value } }
    if (tool.value === 'rect') draggingRect.value = true
    if (kind === 'draw') rect.value = { ...p, w: 0, h: 0 }
  }
  error.value = ''
  try { board.value.setPointerCapture(event.pointerId); capturedPointer = event.pointerId } catch { /* Synthetic pointer events have no active pointer to capture. */ }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancelDrag)
  window.addEventListener('blur', cancelDrag)
}
function move(event) {
  if (!drag || event.pointerId !== drag.id) return
  const p = point(event); cursor.value = p
  if (drag.kind === 'brush') {
    const stroke = erasures.value[erasures.value.length - 1], last = stroke.points.at(-1)
    if (Math.hypot(p.x - last.x, p.y - last.y) < Math.max(0.5, stroke.size / 8)) return
    if (pointCount.value >= EDIT_LIMITS.points) { error.value = '擦除笔迹已达上限。'; return }
    stroke.points.push(p)
    return
  }
  if (drag.kind === 'clone') {
    const stroke = cloneStrokes.value[cloneStrokes.value.length - 1], last = stroke.points.at(-1)
    if (Math.hypot(p.x - last.x, p.y - last.y) < Math.max(0.5, stroke.size / 8)) return
    if (pointCount.value + clonePointCount.value >= EDIT_LIMITS.points) { error.value = '图章笔迹已达上限。'; return }
    stroke.points.push(p)
    return
  }
  const b = drag.before, dx = p.x - drag.start.x, dy = p.y - drag.start.y
  if (drag.kind === 'move') {
    rect.value = { ...b, x: round(clamp(b.x + dx, 0, props.asset.width - b.w)), y: round(clamp(b.y + dy, 0, props.asset.height - b.h)) }; return
  }
  let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h
  if (drag.kind === 'draw') { x1 = drag.start.x; y1 = drag.start.y; x2 = p.x; y2 = p.y }
  else {
    if (drag.kind.includes('w')) x1 = clamp(b.x + dx, 0, x2 - 1)
    if (drag.kind.includes('e')) x2 = clamp(b.x + b.w + dx, x1 + 1, props.asset.width)
    if (drag.kind.includes('n')) y1 = clamp(b.y + dy, 0, y2 - 1)
    if (drag.kind.includes('s')) y2 = clamp(b.y + b.h + dy, y1 + 1, props.asset.height)
  }
  const left = Math.min(x1, x2), top = Math.min(y1, y2)
  rect.value = { x: left, y: top, w: Math.min(props.asset.width - left, Math.abs(x2 - x1)), h: Math.min(props.asset.height - top, Math.abs(y2 - y1)) }
}
function detach() {
  window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
  window.removeEventListener('pointercancel', cancelDrag); window.removeEventListener('blur', cancelDrag)
  if (capturedPointer !== null && board.value?.hasPointerCapture(capturedPointer)) board.value.releasePointerCapture(capturedPointer)
  capturedPointer = null
}
function lostCapture(event) { if (drag?.id === event.pointerId) cancelDrag() }
function up(event) {
  if (!drag || event.pointerId !== drag.id) return
  move(event)
  const kind = drag.kind
  let valid = true
  if (kind !== 'brush' && kind !== 'clone') {
    if (!validRect(rect.value)) { rect.value = drag.before; valid = false }
    else redraw.value = false
  }
  drag = null; draggingRect.value = false; detach()
  if (kind === 'brush' || kind === 'clone') requestPreview()
  else if (tool.value === 'rect' && valid) eraseRect()
}
function cancelDrag() {
  if (drag?.kind === 'brush') { erasures.value.splice(drag.count); editHistory.value = editHistory.value.slice(0, -1) }
  else if (drag?.kind === 'clone') { cloneStrokes.value.splice(drag.count); editHistory.value = editHistory.value.slice(0, -1) }
  else if (drag) rect.value = drag.before
  drag = null; draggingRect.value = false; detach()
  if (!disposed && hasEdits.value && (processing.value || !previewBlob.value)) requestPreview()
}
function currentCrop() { const r = rect.value; return { x: r.x / props.asset.width, y: r.y / props.asset.height, w: r.w / props.asset.width, h: r.h / props.asset.height } }
function onBlankPointerDown(event) {
  if (event.button !== 0 || !tool.value || encoding || props.busy) return
  if (event.target.closest?.('.image-board, button, input, select, textarea, label, a, [role="button"]')) return
  cancelDrag()
  if (tool.value === 'crop' && validRect(rect.value)) pendingCrop.value = currentCrop()
  tool.value = null
  pickingCloneSource.value = false
  cursor.value = null
}
function changeTool(value) {
  if (encoding || props.busy) return
  cancelDrag()
  if (tool.value === 'crop') pendingCrop.value = currentCrop()
  if (value === 'crop') { const c = pendingCrop.value; rect.value = { x: c.x * props.asset.width, y: c.y * props.asset.height, w: c.w * props.asset.width, h: c.h * props.asset.height } }
  tool.value = value; redraw.value = true; cursor.value = null; error.value = ''
  pickingCloneSource.value = value === 'clone' && !cloneSource.value
  if (value === 'clone') notice.value = cloneSource.value ? '取样点已设定；可涂抹要复制到的位置，也可重新取样。' : '先在图片上点选要复制的源区域。'
}
function chooseCloneSource() {
  if (encoding || processing.value || props.busy) return
  tool.value = 'clone'; pickingCloneSource.value = true; cursor.value = null; error.value = ''
  notice.value = '请在图片上点击要复制的源区域。'
}
function setCloneSourceCoordinate(key, event) {
  if (!cloneSource.value) return
  const value = Number(event.target.value)
  const dimension = key === 'x' ? props.asset.width : props.asset.height
  if (!Number.isFinite(value) || value < 0 || value > dimension) {
    event.target.value = round(cloneSource.value[key]); error.value = '取样点必须位于原图范围内。'; return
  }
  cloneSource.value = { ...cloneSource.value, [key]: round(value) }; error.value = ''
}
function eraseRect() {
  if (encoding || props.busy) return
  if (!validRect(rect.value)) { error.value = '选区必须在原图内，宽高至少为 1 像素。'; return }
  if (erasures.value.length >= EDIT_LIMITS.strokes) { error.value = '擦除操作已达 200 笔上限。'; return }
  const stroke = { type: 'rect', ...rect.value }
  erasures.value.push(stroke); editHistory.value = [...editHistory.value, { kind: 'erase', stroke }]; error.value = ''; redraw.value = true
  requestPreview()
}
const clonePointCount = computed(() => cloneStrokes.value.reduce((n, s) => n + s.points.length, 0))
function undoEdit() {
  if (processing.value || props.busy || !editHistory.value.length) return
  const action = editHistory.value.at(-1)
  editHistory.value = editHistory.value.slice(0, -1)
  const strokes = action.kind === 'erase' ? erasures.value : cloneStrokes.value
  const index = strokes.indexOf(action.stroke)
  if (index >= 0) strokes.splice(index, 1)
  requestPreview()
}
function clearEdits() {
  if (processing.value || props.busy) return
  erasures.value = []; cloneStrokes.value = []; editHistory.value = []
}
function restorePreviousErasures() { previousErasures.value = []; requestPreview() }
function requestPreview() {
  if (disposed) return
  if (!hasEdits.value) {
    refreshRequested = false
    if (applyAfterPreview) { applyAfterPreview = false; nextTick(apply) }
    return
  }
  if (processing.value || drag) { refreshRequested = true; return }
  refreshRequested = false
  makePreview()
}
function invalidatePreview() {
  repairRevision++
  previewBlob.value = null; notice.value = ''
  if (!hasEdits.value || disposed) {
    const oldUrl = previewUrl.value
    previewUrl.value = ''; renderedMarks.value = []; renderedCloneStrokes.value = []; renderedActions.value = []; renderedBakesPrevious.value = false; renderedCanvas = null
    if (oldUrl) nextTick(() => URL.revokeObjectURL(oldUrl))
  }
}
watch([erasures, cloneStrokes, previousErasures], invalidatePreview, { deep: true, flush: 'sync' })
function selectionBounds(strokes) {
  let left = props.asset.width, top = props.asset.height, right = 0, bottom = 0
  for (const stroke of strokes) {
    if (stroke.type === 'rect') {
      left = Math.min(left, stroke.x); top = Math.min(top, stroke.y)
      right = Math.max(right, stroke.x + stroke.w); bottom = Math.max(bottom, stroke.y + stroke.h)
    } else for (const p of stroke.points) {
      const radius = stroke.size / 2 + 1 + (stroke.softness || 0) * stroke.size * .5
      left = Math.min(left, p.x - radius); top = Math.min(top, p.y - radius)
      right = Math.max(right, p.x + radius); bottom = Math.max(bottom, p.y + radius)
    }
  }
  left = Math.max(0, Math.floor(left) - 2); top = Math.max(0, Math.floor(top) - 2)
  right = Math.min(props.asset.width, Math.ceil(right) + 2); bottom = Math.min(props.asset.height, Math.ceil(bottom) + 2)
  return { x: left, y: top, w: right - left, h: bottom - top }
}
function traceErasures(context, strokes) {
  context.fillStyle = '#000'; context.strokeStyle = '#000'; context.lineCap = 'round'; context.lineJoin = 'round'
  for (const stroke of strokes) {
    if (stroke.type === 'rect') context.fillRect(stroke.x, stroke.y, stroke.w, stroke.h)
    else {
      context.lineWidth = stroke.size
      context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y)
      if (stroke.points.length === 1) { context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, 2 * Math.PI); context.fill() }
      else { for (const p of stroke.points.slice(1)) context.lineTo(p.x, p.y); context.stroke() }
    }
  }
}
function applyCloneStroke(context, sourceCanvas, stroke) {
  const radius = stroke.size / 2 + 1
  const dx = stroke.points[0].x - stroke.source.x, dy = stroke.points[0].y - stroke.source.y
  const left = Math.max(0, Math.floor(Math.min(...stroke.points.map(p => p.x)) - radius))
  const top = Math.max(0, Math.floor(Math.min(...stroke.points.map(p => p.y)) - radius))
  const right = Math.min(props.asset.width, Math.ceil(Math.max(...stroke.points.map(p => p.x)) + radius))
  const bottom = Math.min(props.asset.height, Math.ceil(Math.max(...stroke.points.map(p => p.y)) + radius))
  const sx = Math.max(0, Math.floor(left - dx)), sy = Math.max(0, Math.floor(top - dy))
  const ex = Math.min(props.asset.width, Math.ceil(right - dx)), ey = Math.min(props.asset.height, Math.ceil(bottom - dy))
  const sw = ex - sx, sh = ey - sy, dw = right - left, dh = bottom - top
  if (sw < 1 || sh < 1 || dw < 1 || dh < 1) return
  const stamp = document.createElement('canvas'); stamp.width = dw; stamp.height = dh
  const stampContext = stamp.getContext('2d')
  stampContext.drawImage(sourceCanvas, sx, sy, sw, sh, sx + dx - left, sy + dy - top, sw, sh)
  const mask = document.createElement('canvas'); mask.width = dw; mask.height = dh
  const maskContext = mask.getContext('2d'); maskContext.strokeStyle = '#fff'; maskContext.fillStyle = '#fff'; maskContext.lineCap = 'round'; maskContext.lineJoin = 'round'; maskContext.lineWidth = stroke.size
  maskContext.beginPath(); maskContext.moveTo(stroke.points[0].x - left, stroke.points[0].y - top)
  if (stroke.points.length === 1) { maskContext.arc(stroke.points[0].x - left, stroke.points[0].y - top, stroke.size / 2, 0, 2 * Math.PI); maskContext.fill() }
  else { for (const p of stroke.points.slice(1)) maskContext.lineTo(p.x - left, p.y - top); maskContext.stroke() }
  stampContext.globalCompositeOperation = 'destination-in'; stampContext.drawImage(mask, 0, 0)
  context.drawImage(stamp, left, top)
}
function applyMaskStroke(context, stroke) {
  const box = selectionBounds([stroke])
  const maskCanvas = document.createElement('canvas'); maskCanvas.width = box.w; maskCanvas.height = box.h
  const brush = maskCanvas.getContext('2d', { willReadFrequently: true })
  brush.filter = `blur(${stroke.size * stroke.softness * .15}px)`
  brush.translate(-box.x, -box.y); traceErasures(brush, [{ type: 'brush', ...stroke }])
  const mask = brush.getImageData(0, 0, box.w, box.h).data
  const image = context.getImageData(box.x, box.y, box.w, box.h)
  let original
  if (stroke.mask === 'maskRestore') {
    const canvas = document.createElement('canvas'); canvas.width = box.w; canvas.height = box.h
    const source = canvas.getContext('2d'); source.drawImage(restoreImage.value, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
    original = source.getImageData(0, 0, box.w, box.h).data
  }
  for (let i = 0; i < mask.length; i += 4) {
    const amount = mask[i + 3] / 255
    if (!original) image.data[i + 3] *= 1 - amount
    else {
      const before = image.data[i + 3] * (1 - amount), restored = original[i + 3] * amount, alpha = before + restored
      for (let c = 0; c < 3; c++) image.data[i + c] = alpha ? (image.data[i + c] * before + original[i + c] * restored) / alpha : 0
      image.data[i + 3] = alpha
    }
  }
  context.putImageData(image, box.x, box.y)
}
async function makePreview() {
  if (processing.value || props.busy || !hasEdits.value || !loaded.value) return false
  const revision = repairRevision
  processing.value = true; error.value = ''; notice.value = ''
  let succeeded = false
  try {
    const markRefs = erasures.value.slice()
    const cloneRefs = cloneStrokes.value.slice()
    const actions = editHistory.value.slice()
    const snapshots = actions.map(action => ({ kind: action.kind, stroke: action.kind === 'erase' ? normalizeErasures([copy(action.stroke)], props.asset.width, props.asset.height)[0] : copy(action.stroke) }))
    const previousKey = JSON.stringify(previousErasures.value)
    const reuse = renderedCanvas && renderedPreviousKey === previousKey && renderedActions.value.length <= actions.length && renderedActions.value.every((action, index) => action === actions[index])
    let previousBaked = reuse ? renderedBakesPrevious.value : false
    if (props.asset.width * props.asset.height > 40000000) throw new Error('\u56fe\u7247\u8d85\u8fc7 4000 \u4e07\u50cf\u7d20\uff0c\u8bf7\u5148\u7f29\u5c0f\u539f\u56fe\u540e\u518d\u4fee\u590d\u3002')
    const output = document.createElement('canvas'); output.width = props.asset.width; output.height = props.asset.height
    const out = output.getContext('2d', { willReadFrequently: true }); out.drawImage(reuse ? renderedCanvas : sourceImage.value, 0, 0)
    // Replay edits in the order the user made them. Append new strokes to the last
    // finished frame; undo rebuilds from the original rather than mixing tools.
    for (let index = reuse ? renderedActions.value.length : 0; index < snapshots.length; index++) {
      if (disposed || revision !== repairRevision) return false
      const action = snapshots[index]
      if (action.kind === 'clone' || action.kind === 'mask') {
        // Bake the legacy transparency at the first clone action, after earlier
        // repairs, so switching tools cannot change those repairs retroactively.
        if (!previousBaked) {
          out.save(); out.globalCompositeOperation = 'destination-out'; traceErasures(out, previousErasures.value); out.restore()
          previousBaked = true
        }
        if (action.kind === 'mask') applyMaskStroke(out, action.stroke)
        else applyCloneStroke(out, output, action.stroke)
        continue
      }
      const strokes = [action.stroke]
      const box = selectionBounds(strokes)
      if (box.w * box.h > 12000000) throw new Error('\u9009\u533a\u8fc7\u5927\uff0c\u8bf7\u7f29\u5c0f\u9009\u533a\u6216\u5206\u591a\u6b21\u4fee\u590d\u3002')
      const image = out.getImageData(box.x, box.y, box.w, box.h)
      const maskCanvas = document.createElement('canvas'); maskCanvas.width = box.w; maskCanvas.height = box.h
      const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })
      maskContext.translate(-box.x, -box.y); traceErasures(maskContext, strokes)
      const rgbaMask = maskContext.getImageData(0, 0, box.w, box.h).data
      const mask = new Uint8Array(box.w * box.h)
      for (let i = 0; i < mask.length; i++) mask[i] = rgbaMask[i * 4 + 3]
      image.data.set(await repairImagePixels(image.data, mask, box.w, box.h, { canceled: () => disposed || revision !== repairRevision }))
      if (disposed || revision !== repairRevision) return false
      // Source-over would repaint every translucent pixel in the bounding box,
      // including pixels outside the selection, and cannot remove old opacity.
      out.putImageData(image, box.x, box.y)
    }
    if (disposed || revision !== repairRevision) return false
    const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('\u65e0\u6cd5\u751f\u6210\u4fee\u590d\u9884\u89c8')), 'image/png'))
    if (disposed || revision !== repairRevision) return false
    if (blob.size > 64 * 1024 * 1024) throw new Error('\u4fee\u590d\u540e\u7684\u56fe\u7247\u8d85\u8fc7 64MB\uff0c\u8bf7\u5148\u7f29\u5c0f\u539f\u56fe\u540e\u518d\u4fee\u590d\u3002')
    const nextUrl = URL.createObjectURL(blob)
    try {
      const decoded = new Image(); decoded.src = nextUrl
      await decoded.decode()
      if (disposed || revision !== repairRevision) { URL.revokeObjectURL(nextUrl); return false }
      const oldUrl = previewUrl.value
      previewBlob.value = blob; previewUrl.value = nextUrl; renderedMarks.value = markRefs; renderedCloneStrokes.value = cloneRefs
      renderedCanvas = output; renderedActions.value = actions; renderedBakesPrevious.value = previousBaked; renderedPreviousKey = previousKey
      if (oldUrl) nextTick(() => URL.revokeObjectURL(oldUrl))
    } catch (err) { URL.revokeObjectURL(nextUrl); throw err }
    notice.value = snapshots.some(action => action.kind === 'mask') ? '蒙版预览已更新，可继续擦除或恢复主体。' : cloneRefs.length ? '\u56fe\u7ae0\u9884\u89c8\u5b8c\u6210\uff0c\u53ef\u7ee7\u7eed\u53d6\u6837\u3001\u6d82\u62b9\u6216\u6309 Enter \u5e94\u7528\u3002' : '\u4fee\u590d\u5b8c\u6210\uff0c\u53ef\u7ee7\u7eed\u64e6\u9664\u6216\u6309 Enter \u5e94\u7528\u3002'
    succeeded = true
    return true
  } catch (err) { if (!disposed && revision === repairRevision) error.value = err.message || '\u56fe\u7247\u4fee\u590d\u5931\u8d25'; return false }
  finally {
    processing.value = false
    if (refreshRequested) {
      if (!drag && !disposed) requestPreview()
    } else if (applyAfterPreview) { applyAfterPreview = false; if (succeeded && !disposed) nextTick(apply) }
  }
}
async function apply() {
  if (drag || !loaded.value || props.busy || encoding) return
  if (processing.value) { applyAfterPreview = true; notice.value = '修复完成后将自动应用。'; return }
  let reading = false
  try {
    if (tool.value === 'crop' && !validRect(rect.value)) throw new Error('选区必须在原图内，宽高至少为 1 像素。')
    const { width, height } = props.asset
    if (hasEdits.value && !previewBlob.value && !await makePreview()) return
    let base64 = ''
    if (previewBlob.value) {
      processing.value = true; encoding = true; reading = true
      const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取修复结果失败')); reader.readAsDataURL(previewBlob.value) })
      if (disposed) return
      base64 = String(url).split(',')[1]
    }
    emit('apply', { crop: tool.value === 'crop' ? currentCrop() : pendingCrop.value, erasures: renderedBakesPrevious.value ? [] : normalizeErasures(previousErasures.value, width, height), base64 })
  } catch (err) { error.value = err.message }
  finally { if (reading) { processing.value = false; encoding = false } }
}
function keydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drag ? cancelDrag() : emit('cancel'); return }
  const input = event.target.closest?.('input,select')
  if (!input && !event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!drag) undoEdit(); return }
  if (event.key === 'Enter' && !event.isComposing && !event.target.closest?.('select,button')) {
    event.preventDefault()
    const key = event.target.dataset?.selectionKey
    if (key && !setRect(key, event)) return
    if (tool.value === 'rect' && key) eraseRect()
    else apply()
    return
  }
  if (event.key === 'Tab') {
    const items = [...dialog.value.querySelectorAll('button:not(:disabled),input:not(:disabled),select')]
    if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === dialog.value)) { event.preventDefault(); items.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
  }
}
function resize() { if (imageViewport.value) viewport.value = { w: imageViewport.value.clientWidth - 32, h: imageViewport.value.clientHeight - 32 } }
let previousFocus, observer
onMounted(() => {
  previousFocus = document.activeElement
  nextTick(() => { dialog.value?.focus(); resize(); observer = new ResizeObserver(resize); observer.observe(imageViewport.value) })
})
onBeforeUnmount(() => { disposed = true; cancelDrag(); invalidatePreview(); observer?.disconnect(); previousFocus?.focus?.() })
</script>

<template>
  <div class="image-editor-mask" @pointerdown="onBlankPointerDown">
    <section ref="dialog" class="image-editor" role="dialog" aria-modal="true" aria-labelledby="image-edit-title" tabindex="-1" data-testid="design-image-editor" @keydown="keydown">
      <header><h3 id="image-edit-title"><AppIcon :name="tool === 'crop' ? 'crop' : 'brush'" :size="20" /> {{ editTitle }}</h3><button class="icon-only" aria-label="&#x5173;&#x95ED;&#x56FE;&#x7247;&#x7F16;&#x8F91;" title="&#x5173;&#x95ED;" @click="$emit('cancel')"><AppIcon name="close" /></button></header>
      <div class="image-tools">
        <div class="tool-switch" role="group" aria-label="图片编辑工具">
          <button data-testid="image-tool-mask-erase" :disabled="!loaded" :aria-pressed="tool === 'maskErase'" @click="changeTool('maskErase')">精细擦除</button>
          <button v-if="restoreAsset" data-testid="image-tool-mask-restore" :aria-pressed="tool === 'maskRestore'" :disabled="!loaded || !restoreLoaded" @click="changeTool('maskRestore')">恢复主体</button>
          <button :disabled="!loaded" :aria-pressed="tool === 'crop'" title="裁剪图片" @click="changeTool('crop')"><AppIcon name="crop" /> 裁剪</button>
          <button data-testid="image-tool-brush" :disabled="!loaded" :aria-pressed="tool === 'brush'" title="用周围画面修补涂抹区域" @click="changeTool('brush')"><AppIcon name="brush" /> 魔法擦除</button>
          <button data-testid="image-tool-clone" :disabled="!loaded" :aria-pressed="tool === 'clone'" title="&#x70B9;&#x9009;&#x6E90;&#x533A;&#x57DF;&#xFF0C;&#x5728;&#x76EE;&#x6807;&#x4F4D;&#x7F6E;&#x6D82;&#x62B9;&#x590D;&#x5236;" @click="changeTool('clone')">&#x4EFF;&#x5236;&#x56FE;&#x7AE0;</button>
          <button data-testid="image-tool-rect" :disabled="!loaded" :aria-pressed="tool === 'rect'" title="框选矩形区域修补" @click="changeTool('rect')"><AppIcon name="rect" /> 矩形修补</button>
        </div>
        <button v-if="tool === 'crop'" :aria-pressed="redraw" title="重新绘制裁剪框" @click="redraw = true"><AppIcon name="rect" /> 重画</button>
        <label v-if="tool === 'brush' || tool === 'clone' || maskTool">画笔直径 px <input v-model="size" data-testid="image-brush-size" type="number" min="1" step="1" :max="Math.max(asset.width, asset.height)" @change="size = brushDiameter"></label>
        <label v-if="maskTool">柔边 {{ Math.round(maskSoftness * 100) }}%<input v-model.number="maskSoftness" data-testid="image-mask-softness" type="range" min="0" max="1" step=".05"></label>
        <div v-if="tool === 'clone'" class="clone-source-tools">
          <button type="button" data-testid="clone-pick-source" @click="chooseCloneSource">{{ pickingCloneSource ? '\u70b9\u56fe\u9009\u6e90' : '\u91cd\u9009\u6e90\u70b9' }}</button>
          <template v-if="cloneSource"><label>X <input data-testid="clone-source-x" type="number" min="0" :max="asset.width" step="1" :value="cloneSource.x" @change="setCloneSourceCoordinate('x', $event)"></label><label>Y <input data-testid="clone-source-y" type="number" min="0" :max="asset.height" step="1" :value="cloneSource.y" @change="setCloneSourceCoordinate('y', $event)"></label></template>
        </div>
        <label>缩放 <select v-model.number="zoom" data-testid="image-edit-zoom"><option :value="1">适合窗口</option><option :value="2">放大 2 倍</option><option :value="4">放大 4 倍</option><option :value="8">放大 8 倍</option><option :value="16">放大 16 倍</option></select></label>
      </div>
      <p v-if="recognizing" class="hint">正在识别图片透明区域…</p>
      <p v-else-if="maskTool" class="hint">{{ tool === 'maskRestore' ? '从同位置的原色图恢复误删内容。' : '涂抹区域变透明，可清理抠图残留。' }}柔边控制笔触边缘；可以撤销并与裁剪、图章交替使用。</p>
      <p v-else-if="!tool" class="hint">选择上方工具继续编辑，已完成的修改仍然保留。</p>
      <p v-else class="hint">原图 {{ asset.width }} × {{ asset.height }} px（按原图方向编辑） · {{ tool === 'crop' ? '\u62d6\u52a8\u88c1\u526a\u6846\uff0c\u6309 Enter \u786e\u8ba4\uff1bEsc \u53d6\u6d88\u3002' : tool === 'clone' ? (pickingCloneSource ? '\u5148\u70b9\u9009\u53d6\u6837\u6e90\uff1b\u53ef\u8f93\u5165\u5750\u6807\u7cbe\u786e\u8bbe\u7f6e\u3002' : '\u5728\u76ee\u6807\u4f4d\u7f6e\u62d6\u52a8\u6d82\u62b9\u590d\u5236\uff1bEnter \u5e94\u7528\u3002') : '\u62d6\u52a8\u64e6\u9664\uff0c\u677e\u5f00\u9f20\u6807\u81ea\u52a8\u4fee\u590d\uff1bEnter \u5e94\u7528\uff0cEsc \u53d6\u6d88\u3002' }}</p>
      <div ref="imageViewport" class="image-viewport">
        <div ref="board" class="image-board" :style="{ width: `${asset.width * scale}px`, height: `${asset.height * scale}px` }" @pointerdown="down" @pointermove="cursor = point($event)" @pointerleave="cursor = null" @lostpointercapture="lostCapture" @contextmenu.prevent>
          <img ref="sourceImage" v-show="!previewUrl" :src="source" :style="maskStyle" crossorigin="anonymous" draggable="false" alt="待编辑原图" @load="imageLoaded" @error="error = '图片无法加载，请检查原图文件。'; loaded = false; recognizing = false">
          <img v-if="restoreAsset" ref="restoreImage" :src="`pp://media/${restoreAsset.path.split('/').map(encodeURIComponent).join('/')}`" style="display:none" crossorigin="anonymous" alt="" @load="restoreLoaded = true" @error="error = '可恢复的原色图无法加载'; restoreLoaded = false">
          <img v-if="previewUrl" :src="previewUrl" :style="maskStyle" draggable="false" alt="修复效果预览">
          <svg :viewBox="`0 0 ${asset.width} ${asset.height}`" :width="asset.width * scale" :height="asset.height * scale" data-testid="image-edit-overlay">
            <g v-if="pendingMarks.length" fill="rgba(255,86,63,.45)" stroke="rgba(255,86,63,.45)" pointer-events="none">
              <template v-for="(mark, index) in pendingMarks" :key="index">
                <rect v-if="mark.type === 'rect'" :x="mark.x" :y="mark.y" :width="mark.w" :height="mark.h" stroke="none"/>
                <circle v-else-if="mark.points.length === 1" :cx="mark.points[0].x" :cy="mark.points[0].y" :r="mark.size / 2" stroke="none"/>
                <polyline v-else :points="mark.points.map(p => `${p.x},${p.y}`).join(' ')" fill="none" :stroke-width="mark.size" stroke-linecap="round" stroke-linejoin="round"/>
              </template>
            </g>
            <g v-if="pendingCloneStrokes.length" fill="none" stroke="#28c7d0" pointer-events="none">
              <template v-for="(stroke, index) in pendingCloneStrokes" :key="'clone-' + index">
                <circle v-if="stroke.points.length === 1" :cx="stroke.points[0].x" :cy="stroke.points[0].y" :r="stroke.size / 2" fill="#28c7d055"/>
                <polyline v-else :points="stroke.points.map(p => `${p.x},${p.y}`).join(' ')" :stroke-width="stroke.size" stroke-linecap="round" stroke-linejoin="round"/>
              </template>
            </g>
            <g v-if="tool === 'clone' && cloneSource" fill="none" stroke="#ffcf40" pointer-events="none">
              <circle :cx="cloneSource.x" :cy="cloneSource.y" :r="Math.max(4, 6 / scale)" :stroke-width="1.5 / scale"/>
              <path :d="`M${cloneSource.x - 9 / scale} ${cloneSource.y}H${cloneSource.x + 9 / scale} M${cloneSource.x} ${cloneSource.y - 9 / scale}V${cloneSource.y + 9 / scale}`" :stroke-width="1 / scale"/>
            </g>
            <template v-if="tool === 'crop' || (tool === 'rect' && draggingRect)">
              <path v-if="tool === 'crop'" :d="`M0 0H${asset.width}V${asset.height}H0Z M${rect.x} ${rect.y}v${rect.h}h${rect.w}v${-rect.h}Z`" fill="rgba(0,0,0,.48)" fill-rule="evenodd" pointer-events="none"/>
              <rect data-move data-testid="image-selection" :x="rect.x" :y="rect.y" :width="rect.w" :height="rect.h" fill="transparent" stroke="#ff563f" :stroke-width="2 / scale" :style="{ cursor: redraw ? 'crosshair' : 'move' }"/>
              <rect v-for="h in tool === 'crop' ? handles : []" :key="h.id" :data-handle="h.id" :x="h.x - 5 / scale" :y="h.y - 5 / scale" :width="10 / scale" :height="10 / scale" fill="white" stroke="#ff563f" :stroke-width="1 / scale" :style="{ cursor: `${h.id}-resize` }"/>
            </template>
            <circle v-if="(tool === 'brush' || tool === 'clone' || maskTool) && cursor" :cx="cursor.x" :cy="cursor.y" :r="brushDiameter / 2" :fill="tool === 'clone' ? 'rgba(40,199,208,.15)' : 'rgba(255,86,63,.15)'" :stroke="tool === 'clone' ? '#28c7d0' : '#ff563f'" :stroke-width="1 / scale" pointer-events="none"/>
          </svg>
        </div>
      </div>
      <div v-if="tool === 'crop' || tool === 'rect'" class="image-coordinates">
        <label v-for="[key, label] in [['x','左侧 X'],['y','顶部 Y'],['w','宽度'],['h','高度']]" :key="key">{{ label }} px <input :data-testid="`image-selection-${key}`" :data-selection-key="key" type="number" :min="key === 'w' || key === 'h' ? 1 : 0" step="1" :value="round(rect[key])" @change="setRect(key, $event)"></label>
        <button v-if="tool === 'crop'" title="选取完整图片" @click="rect = { x: 0, y: 0, w: asset.width, h: asset.height }"><AppIcon name="image" /> 全图</button>
        <span v-else class="coordinate-tip">输入坐标后按 Enter 擦除</span>
      </div>
      <footer>
        <span aria-live="polite">{{ processing ? (tool === 'clone' ? '\u751f\u6210\u56fe\u7ae0\u9884\u89c8\u2026' : '\u6b63\u5728\u4fee\u590d\u2026') : cursor ? `X ${round(cursor.x)} / Y ${round(cursor.y)} px` : notice || '\u5750\u6807\u4e0e\u753b\u7b14\u5927\u5c0f\u5747\u4ee5\u539f\u56fe\u50cf\u7d20\u4e3a\u51c6' }}</span>
        <button class="icon-only" :disabled="!editHistory.length || processing || busy" data-testid="image-erase-undo" aria-label="&#x64A4;&#x9500;&#x4E0A;&#x4E00;&#x7B14;" title="&#x64A4;&#x9500;&#x4E0A;&#x4E00;&#x7B14; (Ctrl+Z)" @click="undoEdit"><AppIcon name="undo" /></button>
        <button class="icon-only" :disabled="!hasEdits || processing || busy" aria-label="&#x6E05;&#x9664;&#x672C;&#x6B21;&#x4FEE;&#x6539;" title="&#x6E05;&#x9664;&#x672C;&#x6B21;&#x4FEE;&#x6539;" @click="clearEdits"><AppIcon name="trash" /></button>
        <button v-if="previousErasures.length" :disabled="processing || busy" @click="restorePreviousErasures">恢复以前的透明擦除</button>
        <button :disabled="busy" @click="$emit('cancel')"><AppIcon name="close" /> 取消</button><button class="primary" data-testid="image-edit-apply" :disabled="!loaded || busy" @click="apply"><AppIcon name="check" /> {{ busy ? '正在应用…' : '完成' }}</button>
      </footer>
      <p class="edit-error" role="alert">{{ error || applyError }}</p>
    </section>
  </div>
</template>

<style scoped>
.image-editor-mask { position: fixed; inset: 0; z-index: 2200; display: grid; place-items: center; background: #17130f88; }
.image-editor { width: min(1060px, calc(100vw - 48px)); max-height: calc(100vh - 32px); overflow: auto; padding: 18px; box-sizing: border-box; border-radius: 12px; background: var(--paper-card, #fff); color: var(--ink, #222); box-shadow: 0 16px 60px #0005; outline: none; }
header, .image-tools, .image-coordinates, footer { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
header { justify-content: space-between; } h3 { margin: 0; font-size: 17px; }
.image-tools { margin-top: 14px; } label { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.clone-source-tools { display: inline-flex; align-items: center; gap: 6px; }
.tool-switch { display: inline-flex; gap: 3px; padding: 3px; border-radius: 8px; background: #8882; }
.tool-switch button { border-color: transparent; background: transparent; }
.tool-switch button[aria-pressed="true"] { background: var(--paper-card, #fff); box-shadow: 0 1px 4px #0002; }
.icon-only { display: inline-grid; place-items: center; min-width: 34px; min-height: 32px; padding: 5px; }
.coordinate-tip { font-size: 12px; color: var(--stone, #777); }
input { width: 76px; } input, select { padding: 5px; color: inherit; background: var(--paper-card, #fff); border: 1px solid var(--line-strong, #bbb); border-radius: 4px; }
button { padding: 6px 10px; background: var(--paper-card, #fff); color: inherit; border: 1px solid var(--line-strong, #bbb); border-radius: 5px; cursor: pointer; }
button[aria-pressed="true"] { border-color: var(--cinnabar, #b03a2e); color: var(--cinnabar, #b03a2e); background: #b03a2e0a; } button:disabled { opacity: .4; cursor: default; }
button.primary { background: var(--cinnabar, #b03a2e); color: white; border-color: transparent; }
.hint { font-size: 12px; color: var(--stone, #777); margin: 12px 0; }
.image-viewport { overflow: auto; height: max(160px, calc(100vh - 340px)); background: #383838; border-radius: 6px; padding: 16px; box-sizing: border-box; }
.image-board { position: relative; margin: auto; flex-shrink: 0; background: repeating-conic-gradient(#eee 0% 25%, #ccc 0% 50%) 0 0 / 16px 16px; touch-action: none; user-select: none; cursor: crosshair; }
.image-board img, .image-board svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; } .image-board img { pointer-events: none; }
.selection { cursor: move; } .image-coordinates { margin-top: 12px; } footer { margin-top: 14px; } footer span { flex: 1; font-size: 12px; color: var(--stone, #777); }
.edit-error { box-sizing: border-box; height: 20px; margin: 4px 0 0; color: #b03a2e; font-size: 12px; line-height: 20px; white-space: nowrap; overflow: auto; }
</style>

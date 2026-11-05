<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { EDIT_LIMITS, normalizeErasures, erasureMask } from '../../electron/design-image-edit.cjs'
import { repairImagePixels } from '../lib/image-repair.cjs'
import AppIcon from './AppIcon.vue'

const props = defineProps({ layer: { type: Object, required: true }, asset: { type: Object, required: true }, mode: { type: String, default: 'crop' }, applyError: { type: String, default: '' }, busy: { type: Boolean, default: false } })
const emit = defineEmits(['apply', 'cancel'])
const copy = value => JSON.parse(JSON.stringify(value))
const dialog = ref(null), board = ref(null), imageViewport = ref(null), sourceImage = ref(null)
const tool = ref(props.mode === 'erase' ? 'brush' : 'crop')
const redraw = ref(true)
const pendingCrop = ref(copy(props.layer.crop))
// Previous transparent edits stay independent of the new repair selection.
const previousErasures = ref(copy(props.layer.erasures || []))
const erasures = ref([])
const previewUrl = ref(''), previewBlob = ref(null), processing = ref(false), notice = ref('')
// Keep the last finished image visible while a new stroke is being repaired.
const renderedMarks = shallowRef([])
const pendingMarks = computed(() => {
  if (!previewUrl.value) return erasures.value
  let same = 0
  while (same < erasures.value.length && same < renderedMarks.value.length && erasures.value[same] === renderedMarks.value[same]) same++
  return erasures.value.slice(same)
})
const draggingRect = ref(false)
let disposed = false, repairRevision = 0, applyAfterPreview = false, refreshRequested = false, encoding = false
const rect = ref({ x: props.layer.crop.x * props.asset.width, y: props.layer.crop.y * props.asset.height, w: props.layer.crop.w * props.asset.width, h: props.layer.crop.h * props.asset.height })
const zoom = ref(1), size = ref(Math.min(20, Math.max(props.asset.width, props.asset.height)))
const cursor = ref(null), error = ref(''), loaded = ref(false)
const viewport = ref({ w: window.innerWidth, h: window.innerHeight })
const fit = computed(() => Math.min(1, Math.max(1, viewport.value.w) / props.asset.width, Math.max(1, viewport.value.h) / props.asset.height))
const scale = computed(() => fit.value * zoom.value)
const brushDiameter = computed(() => Math.min(Math.max(props.asset.width, props.asset.height), Math.max(1, Number(size.value) || 1)))
const source = computed(() => `pp://media/${props.asset.path.split('/').map(encodeURIComponent).join('/')}`)
const maskStyle = computed(() => { const mask = erasureMask(previousErasures.value, props.asset.width, props.asset.height); return mask ? { maskImage: mask, WebkitMaskImage: mask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : {} })
const handles = computed(() => ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(id => ({ id, x: rect.value.x + (id.includes('w') ? 0 : id.includes('e') ? rect.value.w : rect.value.w / 2), y: rect.value.y + (id.includes('n') ? 0 : id.includes('s') ? rect.value.h : rect.value.h / 2) })))
const pointCount = computed(() => erasures.value.reduce((n, s) => n + (s.points?.length || 0), 0))
let drag = null
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const round = n => Math.round(n * 1000) / 1000
function point(event) {
  const r = board.value.getBoundingClientRect()
  return { x: round(clamp((event.clientX - r.left) / scale.value, 0, props.asset.width)), y: round(clamp((event.clientY - r.top) / scale.value, 0, props.asset.height)) }
}
function validRect(r) { return Object.values(r).every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= props.asset.width + 1e-7 && r.y + r.h <= props.asset.height + 1e-7 }
function setRect(key, event) {
  const next = { ...rect.value, [key]: Number(event.target.value) }
  if (!validRect(next)) { error.value = '选区必须在原图内，宽高至少为 1 像素。'; event.target.value = round(rect.value[key]); return false }
  rect.value = next; redraw.value = false; error.value = ''
  return true
}
function down(event) {
  if (event.button !== 0 || !loaded.value || drag || encoding || props.busy) return
  event.preventDefault()
  dialog.value?.focus({ preventScroll: true })
  applyAfterPreview = false
  if (processing.value) refreshRequested = true
  const p = point(event)
  const handle = event.target.closest?.('[data-handle]')?.dataset.handle
  if (tool.value === 'brush') {
    if (erasures.value.length >= EDIT_LIMITS.strokes || pointCount.value >= EDIT_LIMITS.points) { error.value = '擦除笔迹已达上限，请撤销部分笔迹后重试。'; return }
    drag = { id: event.pointerId, kind: 'brush', count: erasures.value.length }
    erasures.value.push({ type: 'brush', size: brushDiameter.value, points: [p] })
  } else {
    const kind = tool.value === 'rect' ? 'draw' : (handle || (!redraw.value && event.target.dataset.move !== undefined ? 'move' : 'draw'))
    drag = { id: event.pointerId, kind, start: p, before: { ...rect.value } }
    if (tool.value === 'rect') draggingRect.value = true
    if (kind === 'draw') rect.value = { ...p, w: 0, h: 0 }
  }
  error.value = ''
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
}
function up(event) {
  if (!drag || event.pointerId !== drag.id) return
  move(event)
  const kind = drag.kind
  let valid = true
  if (drag.kind !== 'brush') {
    if (!validRect(rect.value)) { rect.value = drag.before; valid = false }
    else redraw.value = false
  }
  drag = null; draggingRect.value = false; detach()
  if (kind === 'brush') requestPreview()
  else if (tool.value === 'rect' && valid) eraseRect()
}
function cancelDrag() {
  if (drag?.kind === 'brush') erasures.value.splice(drag.count)
  else if (drag) rect.value = drag.before
  drag = null; draggingRect.value = false; detach()
  if (!disposed && erasures.value.length && (processing.value || !previewBlob.value)) requestPreview()
}
function currentCrop() { const r = rect.value; return { x: r.x / props.asset.width, y: r.y / props.asset.height, w: r.w / props.asset.width, h: r.h / props.asset.height } }
function changeTool(value) {
  if (encoding || props.busy) return
  cancelDrag()
  if (tool.value === 'crop') pendingCrop.value = currentCrop()
  if (value === 'crop') { const c = pendingCrop.value; rect.value = { x: c.x * props.asset.width, y: c.y * props.asset.height, w: c.w * props.asset.width, h: c.h * props.asset.height } }
  tool.value = value; redraw.value = true; cursor.value = null; error.value = ''
}
function eraseRect() {
  if (encoding || props.busy) return
  if (!validRect(rect.value)) { error.value = '选区必须在原图内，宽高至少为 1 像素。'; return }
  if (erasures.value.length >= EDIT_LIMITS.strokes) { error.value = '擦除操作已达 200 笔上限。'; return }
  erasures.value.push({ type: 'rect', ...rect.value }); error.value = ''; redraw.value = true
  requestPreview()
}
function undoErase() {
  if (processing.value || props.busy || !erasures.value.length) return
  erasures.value.pop()
  if (erasures.value.length) requestPreview()
}
function requestPreview() {
  if (disposed) return
  if (!erasures.value.length) {
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
  if (!erasures.value.length || disposed) {
    const oldUrl = previewUrl.value
    previewUrl.value = ''; renderedMarks.value = []
    if (oldUrl) nextTick(() => URL.revokeObjectURL(oldUrl))
  }
}
watch(erasures, invalidatePreview, { deep: true, flush: 'sync' })
function selectionBounds(strokes) {
  let left = props.asset.width, top = props.asset.height, right = 0, bottom = 0
  for (const stroke of strokes) {
    if (stroke.type === 'rect') {
      left = Math.min(left, stroke.x); top = Math.min(top, stroke.y)
      right = Math.max(right, stroke.x + stroke.w); bottom = Math.max(bottom, stroke.y + stroke.h)
    } else for (const p of stroke.points) {
      const radius = stroke.size / 2 + 1
      left = Math.min(left, p.x - radius); top = Math.min(top, p.y - radius)
      right = Math.max(right, p.x + radius); bottom = Math.max(bottom, p.y + radius)
    }
  }
  left = Math.max(0, Math.floor(left) - 2); top = Math.max(0, Math.floor(top) - 2)
  right = Math.min(props.asset.width, Math.ceil(right) + 2); bottom = Math.min(props.asset.height, Math.ceil(bottom) + 2)
  return { x: left, y: top, w: right - left, h: bottom - top }
}
async function makePreview() {
  if (processing.value || props.busy || !erasures.value.length || !loaded.value) return false
  const revision = repairRevision
  processing.value = true; error.value = ''; notice.value = ''
  let succeeded = false
  try {
    const markRefs = erasures.value.slice()
    const strokes = normalizeErasures(copy(markRefs), props.asset.width, props.asset.height)
    const box = selectionBounds(strokes)
    if (box.w * box.h > 12000000) throw new Error('选区过大，请缩小选区或分多次修复。')
    if (props.asset.width * props.asset.height > 40000000) throw new Error('图片超过 4000 万像素，请先缩小原图后再修复。')
    const patch = document.createElement('canvas'); patch.width = box.w; patch.height = box.h
    const context = patch.getContext('2d', { willReadFrequently: true })
    context.drawImage(sourceImage.value, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
    const image = context.getImageData(0, 0, box.w, box.h)
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = box.w; maskCanvas.height = box.h
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })
    maskContext.translate(-box.x, -box.y); maskContext.fillStyle = '#fff'; maskContext.strokeStyle = '#fff'
    maskContext.lineCap = 'round'; maskContext.lineJoin = 'round'
    for (const stroke of strokes) {
      if (stroke.type === 'rect') maskContext.fillRect(stroke.x, stroke.y, stroke.w, stroke.h)
      else {
        maskContext.lineWidth = stroke.size
        maskContext.beginPath(); maskContext.moveTo(stroke.points[0].x, stroke.points[0].y)
        if (stroke.points.length === 1) { maskContext.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, 2 * Math.PI); maskContext.fill() }
        else { for (const p of stroke.points.slice(1)) maskContext.lineTo(p.x, p.y); maskContext.stroke() }
      }
    }
    const rgbaMask = maskContext.getImageData(0, 0, box.w, box.h).data
    const mask = new Uint8Array(box.w * box.h)
    for (let i = 0; i < mask.length; i++) mask[i] = rgbaMask[i * 4 + 3]
    image.data.set(await repairImagePixels(image.data, mask, box.w, box.h, { canceled: () => disposed || revision !== repairRevision }))
    if (disposed || revision !== repairRevision) return false
    context.putImageData(image, 0, 0)
    const output = document.createElement('canvas'); output.width = props.asset.width; output.height = props.asset.height
    const out = output.getContext('2d'); out.drawImage(sourceImage.value, 0, 0); out.putImageData(image, box.x, box.y)
    const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('无法生成修复预览')), 'image/png'))
    if (disposed || revision !== repairRevision) return false
    if (blob.size > 64 * 1024 * 1024) throw new Error('修复后的图片超过 64MB，请先缩小原图后再修复。')
    // Decode the replacement before swapping it into the image element. This avoids
    // showing a blank frame while Chromium decodes the new PNG.
    const nextUrl = URL.createObjectURL(blob)
    try {
      const decoded = new Image(); decoded.src = nextUrl
      await decoded.decode()
      if (disposed || revision !== repairRevision) { URL.revokeObjectURL(nextUrl); return false }
      const oldUrl = previewUrl.value
      previewBlob.value = blob; previewUrl.value = nextUrl; renderedMarks.value = markRefs
      if (oldUrl) nextTick(() => URL.revokeObjectURL(oldUrl))
    } catch (err) { URL.revokeObjectURL(nextUrl); throw err }
    notice.value = '修复完成，可继续擦除或按 Enter 应用。'
    succeeded = true
    return true
  } catch (err) { if (!disposed && revision === repairRevision) error.value = err.message || '图片修复失败'; return false }
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
    if (!validRect(rect.value)) throw new Error('选区必须在原图内，宽高至少为 1 像素。')
    const { width, height } = props.asset
    if (erasures.value.length && !previewBlob.value && !await makePreview()) return
    let base64 = ''
    if (previewBlob.value) {
      processing.value = true; encoding = true; reading = true
      const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取修复结果失败')); reader.readAsDataURL(previewBlob.value) })
      if (disposed) return
      base64 = String(url).split(',')[1]
    }
    emit('apply', { crop: tool.value === 'crop' ? currentCrop() : pendingCrop.value, erasures: normalizeErasures(previousErasures.value, width, height), base64 })
  } catch (err) { error.value = err.message }
  finally { if (reading) { processing.value = false; encoding = false } }
}
function keydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drag ? cancelDrag() : emit('cancel'); return }
  const input = event.target.closest?.('input,select')
  if (!input && !event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!drag) undoErase(); return }
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
  <div class="image-editor-mask" @pointerdown.self="$emit('cancel')">
    <section ref="dialog" class="image-editor" role="dialog" aria-modal="true" aria-labelledby="image-edit-title" tabindex="-1" data-testid="design-image-editor" @keydown="keydown">
      <header><h3 id="image-edit-title"><AppIcon :name="tool === 'crop' ? 'crop' : 'brush'" :size="20" /> {{ tool === 'crop' ? '剪切（裁剪图片）' : '魔法擦除' }}</h3><button class="icon-only" aria-label="关闭图片编辑" title="关闭" @click="$emit('cancel')"><AppIcon name="close" /></button></header>
      <div class="image-tools">
        <div class="tool-switch" role="group" aria-label="图片编辑工具">
          <button :aria-pressed="tool === 'crop'" title="裁剪图片" @click="changeTool('crop')"><AppIcon name="crop" /> 裁剪</button>
          <button data-testid="image-tool-brush" :aria-pressed="tool === 'brush'" title="拖动画笔擦除" @click="changeTool('brush')"><AppIcon name="brush" /> 画笔</button>
          <button data-testid="image-tool-rect" :aria-pressed="tool === 'rect'" title="框选矩形区域擦除" @click="changeTool('rect')"><AppIcon name="rect" /> 矩形</button>
        </div>
        <button v-if="tool === 'crop'" :aria-pressed="redraw" title="重新绘制裁剪框" @click="redraw = true"><AppIcon name="rect" /> 重画</button>
        <label v-if="tool === 'brush'">画笔直径 px <input v-model="size" data-testid="image-brush-size" type="number" min="1" :max="Math.max(asset.width, asset.height)" @change="size = brushDiameter"></label>
        <label>缩放 <select v-model.number="zoom" data-testid="image-edit-zoom"><option :value="1">适合窗口</option><option :value="2">放大 2 倍</option><option :value="4">放大 4 倍</option><option :value="8">放大 8 倍</option></select></label>
      </div>
      <p class="hint">原图 {{ asset.width }} × {{ asset.height }} px（按原图方向编辑） · {{ tool === 'crop' ? '拖动裁剪框，按 Enter 确认；Esc 取消。' : '拖动擦除，松开鼠标自动修复；Enter 应用，Esc 取消。' }}</p>
      <div ref="imageViewport" class="image-viewport">
        <div ref="board" class="image-board" :style="{ width: `${asset.width * scale}px`, height: `${asset.height * scale}px` }" @pointerdown="down" @pointermove="cursor = point($event)" @pointerleave="cursor = null" @contextmenu.prevent>
          <img ref="sourceImage" v-show="!previewUrl" :src="source" :style="maskStyle" crossorigin="anonymous" draggable="false" alt="待编辑原图" @load="loaded = true" @error="error = '图片无法加载，请检查原图文件。'; loaded = false">
          <img v-if="previewUrl" :src="previewUrl" :style="maskStyle" draggable="false" alt="修复效果预览">
          <svg :viewBox="`0 0 ${asset.width} ${asset.height}`" :width="asset.width * scale" :height="asset.height * scale" data-testid="image-edit-overlay">
            <g v-if="pendingMarks.length" fill="rgba(255,86,63,.45)" stroke="rgba(255,86,63,.45)" pointer-events="none">
              <template v-for="(mark, index) in pendingMarks" :key="index">
                <rect v-if="mark.type === 'rect'" :x="mark.x" :y="mark.y" :width="mark.w" :height="mark.h" stroke="none"/>
                <circle v-else-if="mark.points.length === 1" :cx="mark.points[0].x" :cy="mark.points[0].y" :r="mark.size / 2" stroke="none"/>
                <polyline v-else :points="mark.points.map(p => `${p.x},${p.y}`).join(' ')" fill="none" :stroke-width="mark.size" stroke-linecap="round" stroke-linejoin="round"/>
              </template>
            </g>
            <template v-if="tool === 'crop' || (tool === 'rect' && draggingRect)">
              <path v-if="tool === 'crop'" :d="`M0 0H${asset.width}V${asset.height}H0Z M${rect.x} ${rect.y}v${rect.h}h${rect.w}v${-rect.h}Z`" fill="rgba(0,0,0,.48)" fill-rule="evenodd" pointer-events="none"/>
              <rect data-move data-testid="image-selection" :x="rect.x" :y="rect.y" :width="rect.w" :height="rect.h" fill="transparent" stroke="#ff563f" :stroke-width="2 / scale" :style="{ cursor: redraw ? 'crosshair' : 'move' }"/>
              <rect v-for="h in tool === 'crop' ? handles : []" :key="h.id" :data-handle="h.id" :x="h.x - 5 / scale" :y="h.y - 5 / scale" :width="10 / scale" :height="10 / scale" fill="white" stroke="#ff563f" :stroke-width="1 / scale" :style="{ cursor: `${h.id}-resize` }"/>
            </template>
            <circle v-if="tool === 'brush' && cursor" :cx="cursor.x" :cy="cursor.y" :r="brushDiameter / 2" fill="rgba(255,86,63,.15)" stroke="#ff563f" :stroke-width="1 / scale" pointer-events="none"/>
          </svg>
        </div>
      </div>
      <div v-if="tool !== 'brush'" class="image-coordinates">
        <label v-for="[key, label] in [['x','左侧 X'],['y','顶部 Y'],['w','宽度'],['h','高度']]" :key="key">{{ label }} px <input :data-testid="`image-selection-${key}`" :data-selection-key="key" type="number" :min="key === 'w' || key === 'h' ? 1 : 0" step="1" :value="round(rect[key])" @change="setRect(key, $event)"></label>
        <button v-if="tool === 'crop'" title="选取完整图片" @click="rect = { x: 0, y: 0, w: asset.width, h: asset.height }"><AppIcon name="image" /> 全图</button>
        <span v-else class="coordinate-tip">输入坐标后按 Enter 擦除</span>
      </div>
      <footer>
        <span aria-live="polite">{{ processing ? '正在修复…' : cursor ? `X ${round(cursor.x)} · Y ${round(cursor.y)} px` : notice || '坐标与画笔大小均以原图像素为准' }}</span>
        <button class="icon-only" :disabled="!erasures.length || processing || busy" data-testid="image-erase-undo" aria-label="撤销上一笔" title="撤销上一笔（Ctrl+Z）" @click="undoErase"><AppIcon name="undo" /></button>
        <button class="icon-only" :disabled="!erasures.length || processing || busy" aria-label="清除本次擦除" title="清除本次擦除" @click="erasures = []"><AppIcon name="trash" /></button>
        <button v-if="previousErasures.length" :disabled="processing || busy" @click="previousErasures = []">恢复以前的透明擦除</button>
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

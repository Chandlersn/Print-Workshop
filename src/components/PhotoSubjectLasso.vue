<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { normalizeProtectPolygon } from '../../electron/photo-processing-pixels.cjs'

const props = defineProps({ src: { type: String, required: true }, initial: { type: Array, default: null } })
const emit = defineEmits(['apply', 'cancel'])
const board = ref(null), points = ref(props.initial ? props.initial.map(p => ({ ...p })) : [])
const error = ref(''), drawing = ref(false), loaded = ref(false)
let pointerId = null
const outline = computed(() => points.value.map(p => `${p.x},${p.y}`).join(' '))
function point(event) {
  const r = board.value.getBoundingClientRect()
  return { x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) }
}
function down(event) {
  if (event.button !== 0 || !loaded.value || drawing.value) return
  event.preventDefault(); error.value = ''; points.value = [point(event)]; drawing.value = true; pointerId = event.pointerId
  try { board.value.setPointerCapture(pointerId) } catch { /* synthetic input */ }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelDraw); window.addEventListener('blur', cancelDraw)
}
function move(event) {
  if (!drawing.value || event.pointerId !== pointerId) return
  const p = point(event), last = points.value.at(-1), r = board.value.getBoundingClientRect()
  if (Math.hypot((p.x - last.x) * r.width, (p.y - last.y) * r.height) < 2) return
  // Keep recording long outlines without exceeding the saved-polygon limit.
  if (points.value.length >= 512) points.value = points.value.filter((_, index) => index % 2 === 0 || index === points.value.length - 1)
  points.value.push(p)
}
function detach() {
  window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelDraw); window.removeEventListener('blur', cancelDraw)
  const captured = pointerId
  pointerId = null; drawing.value = false
  if (captured !== null && board.value?.hasPointerCapture(captured)) board.value.releasePointerCapture(captured)
}
function up(event) {
  if (!drawing.value || event.pointerId !== pointerId) return
  move(event); detach()
  try { normalizeProtectPolygon(points.value) } catch (err) { error.value = err.message; points.value = [] }
}
function cancelDraw() { if (drawing.value) { detach(); points.value = [] } }
function apply() {
  try { emit('apply', normalizeProtectPolygon(points.value)) } catch (err) { error.value = err.message }
}
function key(event) { if (event.key === 'Escape') { event.preventDefault(); emit('cancel') } }
onMounted(() => window.addEventListener('keydown', key))
onBeforeUnmount(() => { detach(); window.removeEventListener('keydown', key) })
</script>

<template>
  <div class="lasso-backdrop" @click.self="emit('cancel')">
    <section class="lasso-dialog" role="dialog" aria-modal="true" aria-label="自由拉索圈定人物">
      <header><strong>自由拉索圈定人物</strong><button @click="emit('cancel')">关闭</button></header>
      <p>在原始照片上按住鼠标，沿整个人物外围大致画一圈，松开后自动闭合。给头发、手脚和衣服留一点余量；模型会根据圈选范围重新识别主体，并继续去除范围内的背景。</p>
      <div class="lasso-viewport">
        <div ref="board" class="lasso-board" data-testid="photo-lasso-board" @pointerdown="down" @lostpointercapture="cancelDraw">
          <img :src="src" alt="圈选主体的原始照片" draggable="false" @load="loaded = true" @error="error = '原始照片加载失败，请重试。'">
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><polygon v-if="points.length > 2 && !drawing" :points="outline"/><polyline v-else-if="points.length" :points="outline"/></svg>
        </div>
      </div>
      <p v-if="error" class="lasso-error" role="alert">{{ error }}</p>
      <footer><button @click="points = []; error = ''">重新圈选</button><button @click="emit('cancel')">取消</button><button class="btn-primary" data-testid="photo-lasso-apply" :disabled="points.length < 3 || drawing" @click="apply">按人物范围抠图</button></footer>
    </section>
  </div>
</template>

<style scoped>
.lasso-backdrop{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:#17130fbb}.lasso-dialog{width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:12px;background:var(--paper-card);box-shadow:0 12px 40px #0005}.lasso-dialog header,.lasso-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:10px}.lasso-dialog footer{justify-content:flex-end}.lasso-dialog p{font-size:13px;line-height:1.5;margin:0}.lasso-viewport{min-height:0;overflow:auto;text-align:center;background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 0 0/16px 16px}.lasso-board{position:relative;display:inline-block;line-height:0;touch-action:none;cursor:crosshair}.lasso-board img{display:block;max-width:min(100%, 840px);max-height:60vh;width:auto;height:auto;user-select:none}.lasso-board svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}.lasso-board polygon,.lasso-board polyline{fill:#e13d3d33;stroke:#d12d2d;stroke-width:2px;vector-effect:non-scaling-stroke;stroke-dasharray:5 3}.lasso-board polyline{fill:none}.lasso-error{color:var(--danger)}
</style>

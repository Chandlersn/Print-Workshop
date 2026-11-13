<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({ modelValue: { type: String, required: true }, picking: Boolean, disabled: Boolean })
const emit = defineEmits(['input', 'change', 'pick'])
const root = ref(null), open = ref(false), hue = ref(0), saturation = ref(0), brightness = ref(0), hex = ref('')
const presets = ['#000000', '#ffffff', '#e53935', '#ff9800', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#d81b60']
let dragging = null
const clamp = value => Math.max(0, Math.min(1, value))
const color = computed(() => {
  const h = hue.value / 60, c = brightness.value * saturation.value, x = c * (1 - Math.abs(h % 2 - 1)), m = brightness.value - c
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  return '#' + rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('')
})
function sync(value) {
  const match = /^#([a-f\d]{6})$/i.exec(value)
  if (!match) return
  hex.value = value.toUpperCase()
  // Preserve the chosen hue for black/gray and during a live gesture.
  if (value.toLowerCase() === color.value) return
  const [r, g, b] = match[1].match(/../g).map(channel => parseInt(channel, 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  if (delta) hue.value = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360
  saturation.value = max ? delta / max : 0
  brightness.value = max
}
watch(() => props.modelValue, sync, { immediate: true })
watch(() => props.disabled, value => { if (value) open.value = false })
function preview() { hex.value = color.value.toUpperCase(); emit('input', color.value) }
function commit() { emit('change', color.value) }
function updateSquare(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  saturation.value = clamp((event.clientX - rect.left) / rect.width)
  brightness.value = 1 - clamp((event.clientY - rect.top) / rect.height)
  preview()
}
function down(event) {
  if (props.disabled || event.button !== 0) return
  event.preventDefault()
  dragging = event.pointerId
  event.currentTarget.setPointerCapture(event.pointerId)
  updateSquare(event)
}
function move(event) { if (event.pointerId === dragging) updateSquare(event) }
function finish(event) {
  if (event.pointerId !== dragging) return
  dragging = null
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  commit()
}
function squareKey(event) {
  const delta = event.shiftKey ? 0.1 : 0.01
  if (event.key === 'ArrowLeft') saturation.value = clamp(saturation.value - delta)
  else if (event.key === 'ArrowRight') saturation.value = clamp(saturation.value + delta)
  else if (event.key === 'ArrowUp') brightness.value = clamp(brightness.value + delta)
  else if (event.key === 'ArrowDown') brightness.value = clamp(brightness.value - delta)
  else return
  event.preventDefault(); event.stopPropagation(); preview(); commit()
}
function choose(value) { sync(value); emit('change', value) }
function applyHex() {
  let value = hex.value.trim()
  if (!value.startsWith('#')) value = '#' + value
  if (/^#[a-f\d]{3}$/i.test(value)) value = '#' + [...value.slice(1)].map(c => c + c).join('')
  if (!/^#[a-f\d]{6}$/i.test(value)) { hex.value = color.value.toUpperCase(); return }
  choose(value.toLowerCase())
}
function pick() { open.value = false; emit('pick') }
function outside(event) { if (!root.value?.contains(event.target)) open.value = false }
function escape(event) { if (open.value) { open.value = false; event.preventDefault(); event.stopPropagation() } }
onMounted(() => document.addEventListener('pointerdown', outside, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
</script>

<template>
  <div ref="root" class="text-color-picker" data-testid="text-color-picker" @keydown.esc="escape">
    <span class="field-label">文字颜色</span>
    <div class="color-entry">
      <button type="button" class="color-toggle" data-testid="text-color-toggle" aria-label="选择文字颜色" :aria-expanded="open" :disabled="disabled" @click="open = !open">
        <span class="swatch" :style="{ background: modelValue }"></span><code>{{ modelValue.toUpperCase() }}</code><span class="chevron" aria-hidden="true">⌄</span>
      </button>
      <button type="button" class="pipette" data-testid="text-pixel-pick" aria-label="从画布取色" title="从画布取色（Esc 取消）" :aria-pressed="picking" :disabled="disabled" @click="pick">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5 5 5M5 16l9-9 3 3-9 9-4 1zM14 5l2-2a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3l-2 2"/></svg>
      </button>
    </div>
    <p v-if="picking" class="pick-hint" role="status">点击画布上的像素取色，Esc 取消</p>
    <div v-if="open" class="color-panel" data-testid="text-color-panel" role="group" aria-label="文字颜色面板">
      <div class="color-square" data-testid="text-color-square" :style="{ backgroundColor: `hsl(${hue}, 100%, 50%)` }" role="slider" tabindex="0" aria-label="饱和度和亮度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(brightness * 100)" :aria-valuetext="`饱和度 ${Math.round(saturation * 100)}%，亮度 ${Math.round(brightness * 100)}%`" @pointerdown="down" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="squareKey">
        <span class="square-marker" :style="{ left: `${saturation * 100}%`, top: `${(1 - brightness) * 100}%` }"></span>
      </div>
      <input v-model.number="hue" class="hue" data-testid="text-color-hue" type="range" min="0" max="359" step="1" aria-label="色相" @input="preview" @change="commit">
      <label class="hex-field">HEX <input v-model="hex" data-testid="text-color-hex" type="text" maxlength="7" spellcheck="false" aria-label="文字颜色十六进制" @change="applyHex" @keydown.enter.prevent.stop="applyHex"></label>
      <div class="presets" aria-label="常用颜色"><button v-for="preset in presets" :key="preset" type="button" :style="{ background: preset }" :aria-label="`颜色 ${preset}`" :title="preset" @click="choose(preset)"></button></div>
    </div>
  </div>
</template>

<style scoped>
.text-color-picker { min-width: 0; display: grid; gap: 6px; font-size: 12px; }
.field-label { color: var(--ink-2); }
.color-entry { display: flex; min-width: 0; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--input-bg); overflow: hidden; }
.color-entry button { border: 0; color: var(--ink); background: transparent; cursor: pointer; }
.color-toggle { flex: 1; display: flex; align-items: center; gap: 7px; min-width: 0; min-height: 38px; padding: 5px; text-align: left; }
.swatch { width: 26px; height: 26px; flex-shrink: 0; border: 1px solid #8886; border-radius: 4px; }
code { font: 11px ui-monospace, Consolas, monospace; }
.chevron { margin-left: auto; }
.pipette { flex: 0 0 34px; display: grid; place-items: center; border-left: 1px solid var(--line) !important; padding: 4px; }
.pipette[aria-pressed="true"] { color: var(--accent-ink); background: var(--cinnabar-soft); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, .color-square:focus-visible { outline: 2px solid var(--cinnabar); outline-offset: -2px; }
.pick-hint { margin: 0; color: var(--accent-ink); line-height: 1.5; }
.color-panel { display: grid; gap: 9px; padding: 9px; background: var(--paper-card); border: 1px solid var(--line); border-radius: 7px; }
.color-square { position: relative; height: 110px; background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent); border-radius: 4px; cursor: crosshair; touch-action: none; }
.square-marker { position: absolute; width: 9px; height: 9px; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 0 1px #0009; transform: translate(-50%, -50%); pointer-events: none; }
.hue { width: 100%; height: 12px; margin: 2px 0; padding: 0; border: 0; border-radius: 8px; appearance: none; background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); cursor: pointer; }
.hue::-webkit-slider-thumb { appearance: none; width: 9px; height: 18px; border: 2px solid white; border-radius: 4px; background: transparent; box-shadow: 0 0 0 1px #0008; }
.hex-field { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.hex-field input { width: 100%; min-width: 0; box-sizing: border-box; padding: 5px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--input-bg); color: var(--ink); font: 11px ui-monospace, Consolas, monospace; }
.presets { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.presets button { width: 100%; height: 19px; padding: 0; border: 1px solid #8886; border-radius: 3px; cursor: pointer; }
</style>

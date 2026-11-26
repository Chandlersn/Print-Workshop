<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

defineProps({ disabled: Boolean })
const emit = defineEmits(['insert'])
const root = ref(null)
const trigger = ref(null)
const yearInput = ref(null)
const open = ref(false)
const year = ref(0)
const month = ref(1)
const part = ref('年月日')
const validYear = computed(() => Number.isInteger(year.value) && year.value >= 1000 && year.value <= 9999)
const days = computed(() => validYear.value ? new Date(year.value, month.value, 0).getDate() : 0)
const leading = computed(() => validYear.value ? (new Date(year.value, month.value - 1, 1).getDay() + 6) % 7 : 0)
function outside(event) {
  if (!root.value?.contains(event.target)) close()
}
function close() {
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
}
async function toggle() {
  if (open.value) return close()
  const today = new Date()
  year.value = today.getFullYear()
  month.value = today.getMonth() + 1
  open.value = true
  document.addEventListener('pointerdown', outside, true)
  await nextTick()
  yearInput.value?.focus()
}
function insert(value) {
  close()
  emit('insert', value)
}
function choose(day) {
  const parts = { 年: String(year.value), 月: String(month.value).padStart(2, '0'), 日: String(day).padStart(2, '0') }
  insert([...part.value].map(key => parts[key]).join(''))
}
function cancel(event) {
  if (!open.value) return
  event.stopPropagation()
  close()
  trigger.value?.focus()
}
onBeforeUnmount(close)
</script>

<template>
  <div ref="root" class="picker" @keydown.esc="cancel" @focusout="event => { if (event.relatedTarget && !root.contains(event.relatedTarget)) close() }">
    <button ref="trigger" type="button" :disabled="disabled" :aria-expanded="open" @click="toggle">＋ 日期</button>
    <div v-if="open" class="calendar" role="group" aria-label="选择编号日期">
      <div class="row">
        <label><input ref="yearInput" v-model.number="year" type="number" min="1000" max="9999" aria-label="年份" /> 年</label>
        <select v-model.number="month" aria-label="月份"><option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option></select>
      </div>
      <label class="row">插入内容
        <select v-model="part"><option v-for="p in ['年月日', '年月', '年', '月', '日']" :key="p">{{ p }}</option></select>
      </label>
      <div class="days">
        <span v-for="w in '一二三四五六日'" :key="w">{{ w }}</span>
        <i v-for="i in leading" :key="'blank'+i"></i>
        <button v-for="d in days" :key="d" type="button" :aria-label="year+'年'+month+'月'+d+'日'" @click="choose(d)">{{ d }}</button>
      </div>
      <p v-if="!validYear">年份请输入 1000 至 9999。</p>
      <button type="button" @click="insert('{日期}')">使用生成当天的完整日期</button>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; }
.calendar { position: absolute; z-index: 2; top: calc(100% + 4px); left: 0; width: 265px; max-width: 80vw; padding: 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper-card); box-shadow: 0 4px 16px #0002; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
input { width: 6em; }
button, input, select { background: var(--paper-card); color: var(--ink); padding: 6px; border: 1px solid var(--line-strong); border-radius: 5px; }
button { cursor: pointer; }
.days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 8px; text-align: center; }
.days span { color: var(--ink-2); font-size: 12px; }
.days button { border-color: transparent; }
button:hover { background: var(--cinnabar-soft); }
</style>

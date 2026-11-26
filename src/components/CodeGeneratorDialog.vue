<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import BaseDialog from './BaseDialog.vue'
import CodeDatePicker from './CodeDatePicker.vue'
import { toUserMessage } from '../../electron/user-error.cjs'

const props = defineProps({ open: Boolean, dataset: { type: Object, default: null } })
const emit = defineEmits(['close', 'applied'])
const format = ref('证书-{日期}-{流水号}')
const target = ref('')
const name = ref('编码')
const field = ref('')
const randomLength = ref(6)
const validRandomLength = computed(() => Number.isInteger(randomLength.value) && randomLength.value >= 1 && randomLength.value <= 16)
const start = ref(1), width = ref(4), step = ref(1)
const preview = ref(null), error = ref(''), busy = ref(false)
const previewRevision = ref(0)
const input = ref(null)
let selectionStart = 0, selectionEnd = 0
watch(() => props.open, open => {
  if (open) {
    target.value = ''
    field.value = props.dataset?.columns[0]?.key || ''
    selectionStart = selectionEnd = format.value.length
  }
})
function rememberSelection() {
  if (!input.value) return
  selectionStart = input.value.selectionStart ?? format.value.length
  selectionEnd = input.value.selectionEnd ?? selectionStart
}
async function insert(value) {
  const from = Math.min(selectionStart, format.value.length)
  const to = Math.min(selectionEnd, format.value.length)
  if (format.value.length - (to - from) + value.length > 500) { error.value = '编码规则不能超过 500 字'; return }
  format.value = format.value.slice(0, from) + value + format.value.slice(to)
  selectionStart = selectionEnd = from + value.length
  await nextTick()
  input.value?.focus()
  input.value?.setSelectionRange(selectionStart, selectionEnd)
}
function close() { if (!busy.value) emit('close') }
watch([() => props.open, () => props.dataset?.id, format, target, name, start, width, step, previewRevision], (_, __, onCleanup) => {
  preview.value = null
  error.value = ''
  if (!props.open || !props.dataset) return
  let active = true
  const timer = setTimeout(async () => {
    try {
      const result = await window.printpress.previewCodes({ datasetId: props.dataset.id, targetKey: target.value, newColumn: name.value, format: format.value, start: start.value, width: width.value, step: step.value })
      if (active) preview.value = result
    } catch (err) { if (active) error.value = toUserMessage(err) }
  }, 200)
  onCleanup(() => { active = false; clearTimeout(timer) })
}, { immediate: true, flush: 'sync' })
async function apply() {
  if (!preview.value || busy.value || !props.dataset) return
  busy.value = true
  const datasetId = props.dataset.id
  const columnName = target.value ? props.dataset.columns.find(c => c.key === target.value)?.alias : name.value.trim()
  try {
    const result = await window.printpress.applyCodes(preview.value.token)
    const firstRow = preview.value.samples[0]?.rowIndex ?? 0
    preview.value = null
    emit('applied', { ...result, datasetId, columnName: columnName || '编码', firstRow })
  } catch (err) {
    previewRevision.value++
    const message = toUserMessage(err)
    error.value = message.includes('请重新生成预览')
      ? '上次预览已失效，请核对更新后的样码，再确认写入。'
      : message
  }
  finally { busy.value = false }
}
</script>

<template>
  <BaseDialog v-if="open && dataset" title-id="code-title" :busy="busy" @close="close">
    <h3 id="code-title">生成编码</h3>
    <p>自定义规则，按当前数据集的每一行生成。重复编码会自动跳过。</p>
    <label>编码规则
      <input ref="input" v-model="format" data-dialog-initial :disabled="busy" maxlength="500" @select="rememberSelection" @click="rememberSelection" @keyup="rememberSelection" @input="rememberSelection" />
    </label>
    <div class="code-tools">
      <CodeDatePicker :disabled="busy" @insert="insert" />
      <div class="random-tool">
        <label>随机字符个数 <input v-model.number="randomLength" :disabled="busy" type="number" min="1" max="16" step="1" :aria-invalid="!validRandomLength" /></label>
        <button :disabled="busy || !validRandomLength" @mousedown.prevent @click="insert('{随机:' + randomLength + '}')">＋ {{ validRandomLength ? randomLength + '位' : '' }}随机字符</button>
      </div>
      <select v-model="field" aria-label="选择要插入的字段" :disabled="busy"><option v-for="col in dataset.columns" :key="col.key" :value="col.key">{{ col.alias }}</option></select>
      <button :disabled="busy || !field" @mousedown.prevent @click="insert('{字段:' + field + '}')">＋ 字段</button>
      <button :disabled="busy" @mousedown.prevent @click="insert('{流水号}')">＋ 流水号</button>
    </div>
    <p class="hint">在光标位置插入规则。随机字符为数字和大写字母，长度可设为 1–16。</p>
    <p v-if="format.includes('{字段:')" class="hint">字段标记对应：<span v-for="col in dataset.columns.filter(c => format.includes('{字段:' + c.key + '}'))" :key="col.key">{{ col.alias }}（{{ col.key }}） </span></p>
    <div class="settings">
      <label>流水号起始值 <input v-model.number="start" :disabled="busy" type="number" min="0" /></label>
      <label>最少位数 <input v-model.number="width" :disabled="busy" type="number" min="1" max="16" /></label>
      <label>步长 <input v-model.number="step" :disabled="busy" type="number" min="1" /></label>
    </div>
    <label>写入位置
      <select v-model="target" :disabled="busy"><option value="">新建列</option><option v-for="col in dataset.columns" :key="col.key" :value="col.key">{{ col.alias }}</option></select>
    </label>
    <label v-if="!target">新列名称 <input v-model="name" :disabled="busy" maxlength="100" /></label>
    <p class="hint">已有列只填空值；去重范围为当前数据集的目标列。新列生成后可在列头开启打印。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="preview" class="preview" aria-live="polite">
      <strong>将生成 {{ preview.count }} 条，保留 {{ preview.skipped }} 条已有内容</strong>
      <div v-for="sample in preview.samples.slice(0, 3)" :key="sample.rowIndex">第 {{ sample.rowIndex + 1 }} 行：{{ sample.value }}</div>
      <small v-if="preview.count > 3">仅预览前 3 条</small>
    </div>
    <p v-else-if="!error && !busy" class="hint" role="status">正在预览…</p>
    <div class="actions">
      <button :disabled="busy" @click="close">取消</button>
      <button class="primary" :disabled="busy || !preview" @click="apply">确认写入</button>
    </div>
  </BaseDialog>
</template>

<style scoped>
h3 { margin: 0 0 8px; }
p { margin: 8px 0; color: var(--ink-2); }
label { display: flex; flex-direction: column; gap: 5px; margin: 10px 0; }
input, select, button { padding: 7px; border: 1px solid var(--line-strong); border-radius: 5px; background: var(--paper-card); color: var(--ink); min-width: 0; }
button { cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; }
button:not(:disabled):hover { border-color: var(--ink-2); }
.primary { background: var(--cinnabar); border-color: var(--cinnabar); color: var(--on-accent, #fff); }
.code-tools, .settings, .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.random-tool, .random-tool label { display: inline-flex; flex-direction: row; align-items: center; gap: 5px; margin: 0; }
.random-tool input { width: 4em; }
.settings label { flex: 1; min-width: 100px; }
.hint { color: var(--ink-2); font-size: 12px; }
.error { color: var(--danger); font-size: 12px; }
.preview { background: var(--paper); color: var(--ink); padding: 10px; margin: 10px 0; overflow-wrap: anywhere; }
.actions { justify-content: flex-end; margin-top: 16px; }
</style>

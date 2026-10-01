<script setup>
/**
 * MultiSelect —— 多选值下拉（行筛选的值集合选择器）。
 * 与 CustomSelect 同一套宣纸墨韵视觉；选项多时自动带搜索框。
 * 选项从真实数据派生（列值清单），本组件不含任何业务语义。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  options: { type: Array, default: () => [] }, // [{ value, label, meta? }]
  placeholder: { type: String, default: '请选择' },
  width: { type: String, default: '160px' },
})

const emit = defineEmits(['update:modelValue', 'change'])

const open = ref(false)
const rootEl = ref(null)
const search = ref('')

const filtered = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return props.options
  return props.options.filter((o) => String(o.label).toLowerCase().includes(kw))
})

const label = computed(() => {
  if (!props.modelValue.length) return props.placeholder
  if (props.modelValue.length <= 2) {
    return props.modelValue
      .map((v) => props.options.find((o) => o.value === v)?.label ?? v)
      .join('、')
  }
  return `已选 ${props.modelValue.length} 项`
})

function toggleOpen() {
  open.value = !open.value
  search.value = ''
}

function isSelected(v) {
  return props.modelValue.includes(v)
}

function toggleValue(v) {
  const next = isSelected(v)
    ? props.modelValue.filter((x) => x !== v)
    : [...props.modelValue, v]
  emit('update:modelValue', next)
  emit('change', next)
}

function clearAll() {
  emit('update:modelValue', [])
  emit('change', [])
}

function onDocClick(e) {
  if (open.value && rootEl.value && !rootEl.value.contains(e.target)) open.value = false
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="rootEl" class="ms-root" :style="{ width }">
    <button class="ms-trigger" :class="{ open, active: modelValue.length }" @click.prevent="toggleOpen">
      <span class="ms-label">{{ label }}</span>
      <span class="ms-caret">▾</span>
    </button>
    <div v-if="open" class="ms-pop">
      <input
        v-if="options.length > 8"
        v-model="search"
        class="ms-search"
        placeholder="搜索…"
        @click.stop
      />
      <div class="ms-list">
        <label v-for="o in filtered" :key="o.value" class="ms-item" :class="{ on: isSelected(o.value) }">
          <input type="checkbox" :checked="isSelected(o.value)" @change="toggleValue(o.value)" />
          <span class="ms-item-label">{{ o.label }}</span>
          <span v-if="o.meta" class="ms-item-meta">{{ o.meta }}</span>
        </label>
        <div v-if="!filtered.length" class="ms-none">无匹配项</div>
      </div>
      <div v-if="modelValue.length" class="ms-foot">
        <button class="ms-clear" @click.stop="clearAll">清空已选</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ms-root { position: relative; flex-shrink: 0; }

.ms-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
}

.ms-trigger:hover, .ms-trigger.open { border-color: var(--cinnabar); }
.ms-trigger.active { border-color: var(--cinnabar); color: var(--cinnabar); }

.ms-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-caret { font-size: 10px; color: var(--stone); }

.ms-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 60;
  width: 100%;
  min-width: 200px;
  background: var(--paper-card);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.ms-search {
  width: calc(100% - 16px);
  margin: 8px;
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
}

.ms-list { max-height: 240px; overflow-y: auto; padding: 4px 0; }

.ms-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--ink);
  cursor: pointer;
}

.ms-item:hover { background: var(--paper); }
.ms-item.on { color: var(--cinnabar); }

.ms-item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-item-meta { flex-shrink: 0; font-size: 11px; color: var(--stone); }

.ms-none { padding: 16px; text-align: center; color: var(--stone); font-size: 12px; }

.ms-foot { border-top: 1px solid var(--line); padding: 6px 10px; }

.ms-clear {
  border: none;
  background: transparent;
  color: var(--cinnabar);
  font-size: 12px;
  padding: 0;
}
</style>

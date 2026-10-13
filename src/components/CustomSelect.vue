<script setup>
/**
 * 统一下拉组件：全项目禁止原生 <select>（源项目 5 处漏网教训）。
 * 支持分组：options 项可带 group 字段，相邻异组自动插入组标题行。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] }, // [{ value, label, group?, disabled?, badge? }]
  placeholder: { type: String, default: '请选择' },
  width: { type: String, default: '160px' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'change', 'open'])

const open = ref(false)
const rootEl = ref(null)

const selectedOption = computed(() => props.options.find((o) => o.value === props.modelValue))
const selectedLabel = computed(() => selectedOption.value?.label ?? props.placeholder)

// 渲染行：组标题行 + 选项行交错
const rows = computed(() => {
  const out = []
  let lastGroup = null
  for (const opt of props.options) {
    const group = opt.group || ''
    if (group && group !== lastGroup) {
      out.push({ type: 'group', label: group, id: `g-${group}` })
      lastGroup = group
    } else if (!group) {
      lastGroup = null
    }
    out.push({ type: 'option', ...opt })
  }
  return out
})

function pick(opt) {
  if (props.disabled || opt.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
  open.value = false
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) emit('open')
}

function onDocClick(e) {
  if (rootEl.value && !rootEl.value.contains(e.target)) open.value = false
}

function onKey(e) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="custom-select" :style="{ width }">
    <button type="button" class="cs-trigger" :disabled="disabled" :class="{ open, badged: selectedOption?.badge }" :title="selectedLabel" @click="toggle">
      <span class="cs-label" :class="{ placeholder: selectedLabel === placeholder }">{{ selectedLabel }}</span>
      <span v-if="selectedOption?.badge" class="cs-badge">{{ selectedOption.badge }}</span>
      <span class="cs-arrow" :class="{ open }"></span>
    </button>
    <div v-if="open" class="cs-menu">
      <template v-for="row in rows" :key="row.type === 'group' ? row.id : String(row.value)">
        <div v-if="row.type === 'group'" class="cs-group-title">{{ row.label }}</div>
        <button
          v-else
          type="button"
          class="cs-option"
          :class="{ selected: row.value === modelValue, disabled: row.disabled, badged: row.badge }"
          :disabled="row.disabled"
          @click="pick(row)"
        >
          <span class="cs-option-label">{{ row.label }}</span>
          <span v-if="row.badge" class="cs-badge">{{ row.badge }}</span>
        </button>
      </template>
      <div v-if="options.length === 0" class="cs-empty">暂无选项</div>
    </div>
  </div>
</template>

<style scoped>
.custom-select {
  position: relative;
  display: inline-block;
}

.cs-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink);
  font-size: 13px;
}

.cs-trigger:hover,
.cs-trigger.open {
  border-color: var(--cinnabar);
}

.cs-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cs-trigger.badged { border-color: var(--cinnabar); }
.cs-trigger.badged .cs-label { flex: 1; text-align: left; }
.cs-option.badged {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--cinnabar-soft);
  box-shadow: inset 3px 0 var(--cinnabar);
}
.cs-option.badged .cs-option-label { min-width: 0; }
.cs-badge {
  flex-shrink: 0;
  display: inline-block;
  padding: 2px 6px;
  border: 1px solid var(--cinnabar);
  border-radius: 4px;
  color: var(--cinnabar);
  background: var(--paper-card);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}

.cs-label.placeholder {
  color: var(--stone);
}

.cs-arrow {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--stone);
  transition: transform 0.15s;
  flex-shrink: 0;
}

.cs-arrow.open {
  transform: rotate(180deg);
}

.cs-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  box-shadow: var(--shadow);
  z-index: 50;
}

.cs-group-title {
  padding: 6px 10px 4px;
  font-size: 11px;
  color: var(--stone);
  border-bottom: 1px solid var(--line);
  background: var(--paper);
  position: sticky;
  top: 0;
}

.cs-option {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--ink);
}

.cs-option:hover {
  background: var(--cinnabar-soft);
}

.cs-option.selected {
  color: var(--cinnabar);
  font-weight: 600;
}

.cs-option.disabled {
  color: var(--stone);
  cursor: default;
}

.cs-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--stone);
  text-align: center;
}
</style>

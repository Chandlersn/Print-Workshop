<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ titleId: { type: String, required: true }, role: { type: String, default: 'dialog' }, busy: Boolean, overlayClass: { type: String, default: '' }, boxClass: { type: String, default: '' }, width: { type: String, default: '720px' } })
const emit = defineEmits(['close'])
const box = ref(null)
let previousFocus
function close() { if (!props.busy) emit('close') }
function onKeydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const items = [...box.value.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length)
  if (!items.length) { event.preventDefault(); box.value.focus(); return }
  const current = items.indexOf(document.activeElement)
  if (event.shiftKey && current <= 0) { event.preventDefault(); items[items.length - 1].focus() }
  else if (!event.shiftKey && (current === -1 || current === items.length - 1)) { event.preventDefault(); items[0].focus() }
}
onMounted(async () => {
  previousFocus = document.activeElement
  await nextTick()
  const initial = box.value?.querySelector('[data-dialog-initial]')
  ;(initial || box.value)?.focus()
})
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <Teleport to="body">
    <div class="base-dialog-mask" :class="overlayClass" @mousedown.self="close">
      <div ref="box" class="base-dialog" :class="boxClass" :style="{ maxWidth: width }" :role="role" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" @keydown="onKeydown">
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.base-dialog-mask { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(30, 26, 20, .45); }
.base-dialog { width: min(100%, 720px); max-height: 90vh; overflow: auto; background: var(--paper-card, #fffdf8); color: var(--ink, #2f2a24); border: 1px solid var(--line-strong, #d8cfc0); border-radius: 10px; padding: 20px 22px; box-shadow: 0 8px 28px rgba(30, 26, 20, .18); outline: none; }
</style>

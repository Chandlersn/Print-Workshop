<script setup>
import { ref } from 'vue'
import PhotoProcessingPanel from './PhotoProcessingPanel.vue'

defineProps({ datasetId: { type: String, required: true }, row: { type: Object, required: true }, returnToPrint: Boolean })
const emit = defineEmits(['close', 'applied'])
const editor = ref(null)
function close() { if (!editor.value?.applying) emit('close') }
</script>

<template>
  <div class="single-mask" @click.self="close">
    <section class="single-dialog" role="dialog" aria-modal="true" :aria-label="`编辑第 ${row.rowIndex + 1} 行照片`">
      <header><strong>第 {{ row.rowIndex + 1 }} 行 · {{ row.label }}</strong><button data-testid="photo-single-close" :disabled="editor?.applying" @click="close">{{ returnToPrint ? '返回打印预览' : '关闭' }}</button></header>
      <PhotoProcessingPanel :key="row.rowId" ref="editor" :dataset-id="datasetId" :row-id="row.rowId" expanded @applied="emit('applied', $event)" />
    </section>
  </div>
</template>

<style scoped>
.single-mask{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:#17130f88}.single-dialog{width:min(1080px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:var(--paper-card);border-radius:12px;padding:16px}.single-dialog header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px}
</style>

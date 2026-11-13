<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import PhotoImportPanel from '../components/PhotoImportPanel.vue'
import PhotoProcessingPanel from '../components/PhotoProcessingPanel.vue'
import PhotoReviewPanel from '../components/PhotoReviewPanel.vue'
import PhotoSingleEditor from '../components/PhotoSingleEditor.vue'
import { photoNav } from '../lib/photo-nav.js'
import { gotoCell } from '../lib/cell-nav.js'
import { activeDataset, rememberDataset } from '../lib/active-dataset.js'
import { toUserMessage } from '../../electron/user-error.cjs'
const emit = defineEmits(['navigate'])
const detail = ref(null)
const error = ref('')
const loading = ref(true)
const guidance = ref('')
const importPanel = ref(null), processingRefresh = ref(0)
const singleFromPrint = ref(null), singleChanged = ref(false)
const incoming = photoNav.request?.origin === 'print' ? { ...photoNav.request } : null
let alive = true
function returnToPrint() {
  if (!incoming) return
  singleFromPrint.value = null
  if (photoNav.request?.nonce === incoming.nonce) photoNav.request = null
  photoNav.result = { ...incoming, changed: singleChanged.value }
}
function singleApplied() { singleChanged.value = true; processingRefresh.value++; importPanel.value?.refresh() }
onBeforeUnmount(() => { alive = false; if (incoming && photoNav.request?.nonce === incoming.nonce) photoNav.request = null })
onMounted(async () => {
  try {
    const datasets = await window.printpress.listDatasets()
    if (!alive) return
    const current = datasets.find(ds => ds.id === (incoming?.datasetId || activeDataset.value))
    if (incoming && !current) { error.value = '打印预览中的名单已不存在，请返回后重新选择。'; return }
    const enabled = datasets.filter(ds => ds.photoMatchColumn)
    // Do not silently import into another list when the selected list has disabled matching.
    const target = current || (enabled.length === 1 ? enabled[0] : null)
    if (!target?.photoMatchColumn) {
      guidance.value = current ? `当前名单“${current.name}”尚未开启配图。请在数据页点击一个列头的“配图”。`
        : enabled.length > 1 ? '多份名单已开启配图，请先在数据页打开要使用的那一份，照片库会自动跟随。'
          : '请先在数据页打开名单，并点击姓名、编号或其他列头的“配图”开关。'
      return
    }
    const ds = await window.printpress.getDataset(target.id)
    if (!alive) return
    detail.value = ds
    rememberDataset(ds.id)
    if (incoming) {
      const rowIndex = ds.recordIds?.indexOf(incoming.rowId) ?? -1
      if (rowIndex < 0) error.value = '人员记录已变化，请返回打印预览后重新选择。'
      else singleFromPrint.value = { rowId: incoming.rowId, rowIndex, label: incoming.label }
    }
  } catch (err) { if (alive) error.value = toUserMessage(err) }
  finally { if (alive) loading.value = false }
})
</script>

<template>
  <section class="photo-library-view">
    <p v-if="loading" role="status">正在读取当前配图名单…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="incoming && !singleFromPrint" class="btn-ghost" data-testid="photo-return-print" @click="returnToPrint">返回打印预览</button>
    <div v-if="!loading && !detail && !error" class="empty-library"><h2>先在数据页确定配图名单</h2><p>{{ guidance }}</p><button class="btn-primary" @click="emit('navigate', 'dataset')">前往数据页</button></div>
    <div v-if="detail" class="matching-context" data-testid="photo-auto-context"><span>当前配图：<strong>{{ detail.name }}</strong> · {{ detail.columns.find(c => c.key === detail.photoMatchColumn)?.alias || detail.photoMatchColumn }}</span><button class="btn-ghost" @click="emit('navigate', 'dataset')">返回数据页</button></div>
    <PhotoProcessingPanel v-if="detail" :key="`processing-${detail.id}`" :dataset-id="detail.id" :refresh-key="processingRefresh" @applied="importPanel?.refresh()" @navigate="page => emit('navigate', page)" />
    <PhotoReviewPanel v-if="detail" :key="`review-${detail.id}`" :dataset-id="detail.id" :column="detail.photoMatchColumn" :refresh-key="processingRefresh" @applied="importPanel?.refresh()" />
    <PhotoImportPanel v-if="detail" ref="importPanel" :key="detail.id" embedded :dataset-id="detail.id" :columns="detail.columns" :match-column="detail.photoMatchColumn || ''" @report="processingRefresh++" @edit-cell="({ rowIndex, key }) => gotoCell(detail.id, rowIndex, key)" />
    <PhotoSingleEditor v-if="detail && singleFromPrint" :dataset-id="detail.id" :row="singleFromPrint" return-to-print @close="returnToPrint" @applied="singleApplied" />
  </section>
</template>

<style scoped>
/* 头部那行只剩一个「前往底图制作」按钮，已删除（切页导航本来就覆盖这件事）。
   整行去掉后顶部只剩容器自身的内边距，会读成一条空带，一并收掉让内容上移。 */
.photo-library-view{max-width:1440px;margin:auto;padding:0 16px 16px}.library-heading p,.empty-library p{color:var(--stone);line-height:1.6;margin:6px 0}.matching-context{display:flex;gap:16px;justify-content:space-between;align-items:center;margin:16px 0;padding:12px 16px;border:1px solid var(--line);border-radius:8px;background:var(--paper-card)}.empty-library{text-align:center;padding:80px 20px;border:1px dashed var(--line);border-radius:16px}
</style>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import PhotoSingleEditor from './PhotoSingleEditor.vue'
import { photoProcessingRevision } from '../lib/photo-processing.js'
import { toUserMessage } from '../../electron/user-error.cjs'
import { gotoCell } from '../lib/cell-nav.js'
const props = defineProps({ datasetId: { type: String, required: true }, column: { type: String, default: '' }, refreshKey: { type: Number, default: 0 } })
const emit = defineEmits(['applied'])
const opened = ref(false), loading = ref(false), error = ref(''), rows = ref([]), counts = ref(null), templates = ref([]), templateId = ref('')
const mode = ref('processed'), filter = ref('all'), search = ref(''), page = ref(0), previews = ref({}), editing = ref(null)
let alive = true, generation = 0, previewGeneration = 0
const filtered = computed(() => rows.value.filter(row => (filter.value === 'all' || filter.value === 'issues' && row.issues.length || filter.value === 'single' && row.individual || filter.value === 'pending' && row.processingError)
  && (!search.value.trim() || `${row.label} ${row.name} ${row.rowIndex + 1}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 24)))
const displayed = computed(() => filtered.value.slice(page.value * 24, (page.value + 1) * 24))
watch([filter, search], () => { page.value = 0 })
watch(pageCount, count => { page.value = Math.min(page.value, count - 1) })
async function refresh() {
  if (!opened.value) return
  const token = ++generation
  loading.value = true; error.value = ''
  try {
    const [review, available] = await Promise.all([window.printpress.reviewPhotoProcessing({ datasetId: props.datasetId, ...(templateId.value ? { templateId: templateId.value } : {}) }), window.printpress.listTemplates()])
    if (!alive || token !== generation) return
    rows.value = review.rows; counts.value = review.counts; templates.value = available.filter(item => item.datasetId === props.datasetId)
    await loadPreviews()
  } catch (err) { if (alive && token === generation) error.value = toUserMessage(err) }
  finally { if (alive && token === generation) loading.value = false }
}
async function loadPreviews() {
  const token = ++previewGeneration
  previews.value = {}
  if (!opened.value || mode.value !== 'template' || !templateId.value || !displayed.value.length) return
  try {
    const result = await window.printpress.reviewPhotoProcessing({ datasetId: props.datasetId, templateId: templateId.value, previewRows: displayed.value.map(row => row.rowIndex) })
    if (alive && token === previewGeneration) previews.value = Object.fromEntries(result.previews.map(item => [item.rowIndex, item]))
  } catch (err) { if (alive && token === previewGeneration) error.value = toUserMessage(err) }
}
watch(() => [opened.value, props.datasetId, props.refreshKey, templateId.value, photoProcessingRevision.value], refresh)
watch(() => [mode.value, page.value, filter.value, search.value], loadPreviews)
function applied() { emit('applied'); refresh() }
onBeforeUnmount(() => { alive = false; generation++; previewGeneration++ })
</script>

<template>
  <section class="photo-review" data-testid="photo-review-panel">
    <header><div><h2>批量效果检查</h2><p>集中查看处理结果、单张例外和输出问题，点击照片继续编辑。</p></div><button data-testid="photo-review-toggle" class="btn-ghost" @click="opened = !opened">{{ opened ? '收起检查' : '打开批量检查' }}</button></header>
    <template v-if="opened">
      <div class="review-controls">
        <label>显示<select v-model="mode" data-testid="photo-review-mode"><option value="original">原始照片</option><option value="processed">处理后</option><option value="template">套用底图与模板</option></select></label>
        <label>检查模板<select v-model="templateId" data-testid="photo-review-template"><option value="">未选择模板</option><option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label>筛选<select v-model="filter" data-testid="photo-review-filter"><option value="all">全部记录</option><option value="issues">有检查提示</option><option value="pending">待处理照片</option><option value="single">已单独修改</option></select></label>
        <label>查找<input v-model="search" data-testid="photo-review-search" placeholder="姓名、照片名或行号"></label>
        <button class="btn-ghost" :disabled="loading" @click="refresh">刷新检查</button>
      </div>
      <p v-if="counts" class="review-counts">共 {{ counts.total }} 人 · {{ counts.problems }} 人有提示 · {{ counts.blocking }} 人需处理后输出 · {{ counts.individual }} 人已单独修改</p>
      <p v-if="loading" role="status">正在检查照片…</p><p v-if="error" role="alert" class="review-error">{{ error }}</p>
      <p v-if="mode === 'template' && !templateId">选择一个模板，预览会使用与打印相同的排版和变量照片。</p>
      <div class="review-grid">
        <article v-for="row in displayed" :key="row.rowId" :data-review-row="row.rowIndex" :class="{ problematic: row.issues.length }">
          <button class="review-image" :disabled="row.status !== 'matched'" :aria-label="`编辑第 ${row.rowIndex + 1} 行照片`" @click="editing = row">
            <template v-if="mode === 'template' && templateId"><iframe v-if="previews[row.rowIndex]?.html" :srcdoc="previews[row.rowIndex].html" :style="{ height: `${previews[row.rowIndex].height}px` }" sandbox="allow-same-origin" tabindex="-1" title="此人的实际模板效果"></iframe><span v-else>{{ previews[row.rowIndex]?.error ? toUserMessage(previews[row.rowIndex].error) : '正在生成模板预览…' }}</span></template>
            <img v-else-if="row.assetId && row.status === 'matched'" :src="`pp://media/${mode === 'original' ? row.assetId : row.processedAssetId || row.assetId}`" loading="lazy" :alt="row.label">
            <span v-else>暂无可用照片</span>
          </button>
          <strong>第 {{ row.rowIndex + 1 }} 行 · {{ row.label }}</strong><small>{{ row.name }} <span v-if="row.individual">· 单张修改</span></small>
          <p v-for="issue in row.issues" :key="issue.code" class="review-issue" :class="{ blocking: issue.blocking }">{{ issue.message }}</p>
          <div class="review-row-actions"><button :disabled="row.status !== 'matched'" @click="editing = row">单张编辑</button><button @click="gotoCell(datasetId, row.rowIndex, column)">定位记录</button></div>
        </article>
      </div>
      <footer><span>{{ filtered.length }} 条 · 第 {{ page + 1 }} / {{ pageCount }} 页</span><button :disabled="page <= 0" @click="page--">上一页</button><button :disabled="page >= pageCount - 1" @click="page++">下一页</button></footer>
    </template>
    <PhotoSingleEditor v-if="editing" :dataset-id="datasetId" :row="editing" @close="editing = null" @applied="applied" />
  </section>
</template>

<style scoped>
.photo-review{margin:18px 0;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--paper-card)}header,.review-controls,footer,.review-row-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}h2{margin:0;font-size:16px}header p,.review-counts{color:var(--stone);font-size:12px}.review-controls{margin:16px 0;align-items:end}.review-controls label{display:grid;gap:5px;font-size:12px}.review-controls input,.review-controls select{padding:7px;border:1px solid var(--line);border-radius:5px;background:var(--paper-card);color:var(--ink)}.review-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}.review-grid article{min-width:0;border:1px solid var(--line);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:7px}.review-grid article.problematic{border:3px solid var(--danger)}.review-image{width:100%;min-height:180px;height:250px;display:flex;justify-content:center;align-items:center;overflow:auto;border:0;background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 0 0/16px 16px;cursor:pointer}.review-image img{max-width:100%;max-height:100%;object-fit:contain}.review-image iframe{width:240px;min-width:240px;flex-shrink:0;border:0;pointer-events:none;align-self:flex-start}.review-grid small{color:var(--stone)}.review-issue{margin:0;font-size:12px;color:var(--warn)}.review-issue.blocking,.review-error{color:var(--danger)}.review-row-actions{margin-top:auto}.review-row-actions button,footer button{font-size:12px}footer{margin-top:16px}.single-mask{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:#17130f88}.single-dialog{width:min(1080px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:var(--paper-card);border-radius:12px;padding:16px}.single-dialog header{padding:8px}
</style>

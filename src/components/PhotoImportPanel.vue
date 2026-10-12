<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({ datasetId: { type: String, required: true }, columns: { type: Array, required: true }, matchColumn: { type: String, default: '' }, embedded: Boolean })
const emit = defineEmits(['close', 'edit-cell'])
const column = computed(() => props.matchColumn || '')
const result = ref(null)
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const progress = ref(null)
const filter = ref('all')
const page = ref(0)
// Thumbnails are optional caches; fall back to the managed original once on load failure.
const photoStates = ref({})
const photoUrl = row => `pp://media/${row.assetId}`
const fileByAsset = computed(() => new Map((result.value?.files || []).filter(f => !f.error).map(f => [f.assetId, f])))
const rowPhotoUrl = row => {
  const file = fileByAsset.value.get(row.assetId)
  return file?.thumbFile && !photoStates.value[row.assetId] ? `pp://media/${file.thumbFile}` : photoUrl(row)
}
function onPhotoError(event, row) {
  // Several rows may share one photo; ignore errors from a thumbnail already replaced.
  if (event.currentTarget.src !== rowPhotoUrl(row)) return
  const file = fileByAsset.value.get(row.assetId)
  photoStates.value[row.assetId] = file?.thumbFile && !photoStates.value[row.assetId] ? 'original' : 'failed'
}
let generation = 0
let alive = true
const labels = { matched: '已匹配', empty: '未填写', missing: '找不到照片', ambiguous: '同名冲突', invalid: '名称无效', broken: '照片不可用' }
const filtered = computed(() => (result.value?.results || []).filter(row => filter.value === 'all' || row.status !== 'matched'))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 30)))
const displayed = computed(() => filtered.value.slice(page.value * 30, (page.value + 1) * 30))
const off = window.printpress.onPhotoProgress(p => {
  if (alive && p.datasetId === props.datasetId && p.column === column.value) progress.value = p
})
onBeforeUnmount(() => { alive = false; generation++; off() })

watch(() => [props.datasetId, column.value], refresh, { immediate: true })
watch(filter, () => { page.value = 0 })

async function refresh() {
  const token = ++generation
  result.value = null
  error.value = ''
  page.value = 0
  photoStates.value = {}
  if (!column.value) { loading.value = false; return }
  loading.value = true
  try {
    const report = await window.printpress.photoReport({ datasetId: props.datasetId, column: column.value })
    if (alive && token === generation) result.value = report
  } catch (err) {
    if (alive && token === generation) error.value = err.message
  } finally {
    if (alive && token === generation) loading.value = false
  }
}

async function importFolder() {
  const token = ++generation
  const payload = { datasetId: props.datasetId, column: column.value }
  busy.value = true
  error.value = ''
  progress.value = null
  try {
    const response = await window.printpress.importPhotoFolder(payload)
    if (alive && token === generation && !response.canceled) {
      result.value = response.report
      page.value = 0
      photoStates.value = {}
    }
  } catch (err) {
    if (alive && token === generation) error.value = err.message
  } finally {
    if (alive) { busy.value = false; loading.value = false }
  }
}

</script>

<template>
  <div :class="embedded ? 'photo-embedded' : 'photo-mask'" @click.self="!embedded && !busy && emit('close')">
    <section class="photo-panel" :role="embedded ? 'region' : 'dialog'" :aria-modal="embedded ? undefined : true" aria-labelledby="photo-title">
      <header><div><h2 id="photo-title">{{ embedded ? '照片与名单关联' : '变量照片库' }}</h2><p>按数据页选中的“配图”列筛选同名照片，例如姓名“张三”匹配“张三.jpg”。仅匹配成功的照片入库，未匹配、同名冲突和坏图跳过；缺图留白，原图不压缩。重新导入目录会替换这份名单的照片清单。</p></div><button v-if="!embedded" :disabled="busy" aria-label="关闭" @click="emit('close')">×</button></header>
      <div class="photo-actions">
        <strong>配图列：{{ columns.find(c => c.key === column)?.alias || column || '未选择' }}</strong>
        <button class="btn-primary" :disabled="busy || !column" @click="importFolder">{{ busy ? '正在导入…' : '选择照片文件夹' }}</button>
        <button class="btn-ghost" :disabled="busy || loading || !column" @click="refresh">重新检查</button>
      </div>
      <p v-if="!column" class="photo-note">请先到数据页，点击姓名、编号或其他列头的“配图”开关。每份名单只能启用一列；再次点击可关闭。</p>
      <p v-if="busy" role="status">{{ progress ? `已处理 ${progress.done} / ${progress.total}：${progress.name}` : '正在选择或扫描照片…' }}</p>
      <p v-if="error" class="photo-error" role="alert">{{ error }}</p>
      <p v-if="loading">正在核对照片原件…</p>
      <template v-if="result && !loading">
        <p v-if="!result.imported" class="photo-note">尚未导入照片。名单可填写 1001、1001.jpg 或 子目录/1001.jpg；同名多图会报告冲突。</p>
        <template v-else>
          <p class="photo-note">来源：{{ result.folderName }} · 匹配 {{ result.counts.matched }} / {{ result.total }} 行 · 待处理 {{ result.blocking }} 行 · 未填写 {{ result.counts.empty }} 行</p>
          <p class="photo-note">已入库 {{ result.files.filter(f => f.assetId && !f.error).length }} 张 · 已跳过 {{ result.ignored.length + result.files.filter(f => f.error).length }} 个文件。切换配图列后，新匹配的照片需重新选择文件夹导入。</p>
          <p v-if="result.duplicates.length" class="photo-warning">{{ result.duplicates.length }} 张照片被多行共用，请确认是否符合预期。<span v-for="(group, i) in result.duplicates.slice(0, 10)" :key="i"> 第 {{ group.rowIndexes.slice(0, 10).map(n => n + 1).join('、') }} 行{{ group.rowIndexes.length > 10 ? '等' : '' }}；</span></p>
          <details v-if="result.ignored.length || result.files.some(f => f.error)"><summary>查看跳过或无法导入的文件</summary><ul><li v-for="(file, i) in [...result.files.filter(f => f.error), ...result.ignored].slice(0, 100)" :key="i">{{ file.name }}：{{ file.error || file.reason }}</li></ul><p>最多显示前 100 项；重选目录会替换这列的照片清单。</p></details>
          <div class="photo-actions"><label>显示 <select v-model="filter"><option value="problems">待处理与空值</option><option value="all">全部记录</option></select></label><span>{{ filtered.length }} 行</span></div>
          <div class="photo-results">
            <table><thead><tr><th>行号</th><th>配图列的值</th><th>照片</th><th>匹配结果</th></tr></thead><tbody>
              <tr v-for="row in displayed" :key="row.rowIndex"><td><button :disabled="busy" class="photo-row" @click="emit('edit-cell', { rowIndex: row.rowIndex, key: column })">{{ row.rowIndex + 1 }}</button></td><td>{{ row.name || '（空）' }}</td><td><div class="matched-photo" :data-photo-row="row.rowIndex"><img v-if="row.status === 'matched' && photoStates[row.assetId] !== 'failed'" :key="rowPhotoUrl(row)" :src="rowPhotoUrl(row)" :alt="row.name" loading="lazy" @error="onPhotoError($event, row)"><span v-else-if="row.status === 'matched'" class="photo-unavailable">预览不可用</span></div></td><td><span>{{ labels[row.status] }}{{ ['empty','missing'].includes(row.status) ? ' · 出片留白' : '' }}</span><small v-if="row.reason || row.candidates">{{ row.reason || row.candidates.join('、') }}</small></td></tr>
            </tbody></table>
            <p v-if="!filtered.length">当前没有待处理的照片记录。</p>
          </div>
          <footer><button :disabled="page === 0" @click="page--">上一页</button><span>{{ page + 1 }} / {{ pageCount }}</span><button :disabled="page + 1 >= pageCount" @click="page++">下一页</button></footer>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.matched-photo{display:flex;align-items:center;justify-content:center;width:42px;height:52px;background:var(--paper);border:1px solid var(--line);border-radius:4px}.matched-photo img{width:100%;height:100%;object-fit:contain}
.photo-unavailable{font-size:11px;color:var(--stone);text-align:center;padding:2px}
.photo-mask{position:fixed;inset:0;z-index:2000;background:#17252a66;display:flex;align-items:center;justify-content:center;padding:24px}
.photo-embedded .photo-panel{width:100%;max-height:none;box-shadow:none;border:1px solid var(--line);box-sizing:border-box;background:var(--paper-card)}
.photo-embedded .photo-panel{padding:18px}.photo-embedded h2{font-size:18px;margin:0}.photo-embedded header p{margin:6px 0}.photo-embedded .photo-actions{margin:12px 0}

.photo-panel{width:min(880px,95vw);max-height:90vh;overflow:auto;background:var(--paper,#f6f2e9);border-radius:16px;padding:24px;box-shadow:0 24px 70px #0003;color:var(--ink)}
header{display:flex;justify-content:space-between;gap:20px}h2{margin:0 0 8px;font-size:22px}header p,.photo-note{color:var(--stone);font-size:13px;line-height:1.7}header>button{align-self:flex-start;font-size:24px}
.photo-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:16px 0}select{padding:7px 10px;max-width:250px;background:transparent;border:1px solid #c7beb0;border-radius:6px;color:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}.photo-error{color:#a92f25}.photo-warning{color:#855616;line-height:1.7;font-size:13px}
.photo-results{max-height:40vh;overflow:auto;border:1px solid #d8d0c1;border-radius:8px}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}th,td{padding:9px 12px;border-bottom:1px solid #ddd5c7;overflow-wrap:anywhere}th{position:sticky;top:0;background:#eee7d9}td:first-child{width:65px}small{display:block;color:var(--stone);margin-top:4px}.photo-row{border:0;background:transparent;color:var(--cinnabar,#ae3c30);text-decoration:underline}.photo-results>p{padding:16px}footer{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:14px}details{font-size:13px;line-height:1.8}details ul{max-height:160px;overflow:auto}
</style>

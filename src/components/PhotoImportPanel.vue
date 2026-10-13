<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { toUserMessage } from '../../electron/user-error.cjs'

const props = defineProps({ datasetId: { type: String, required: true }, columns: { type: Array, required: true }, matchColumn: { type: String, default: '' }, embedded: Boolean })
const emit = defineEmits(['close', 'edit-cell'])
const column = computed(() => props.matchColumn || '')
const result = ref(null)
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const progress = ref(null)
const taskHistory = ref([])
const pendingSelection = ref(null)
const importTaskId = ref('')
const cancelling = ref(false)
const cancelRequested = ref(false)
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
const taskLabels = { completed: '已完成', recovered: '重启后已完成收尾', 'rolled-back-after-restart': '重启后已回滚', 'rolled-back': '已回滚', canceled: '已取消', 'published-recovery-pending': '已提交，等待恢复', 'recovery-pending': '等待清理恢复', 'recovery-failed': '恢复失败' }
const latestTask = computed(() => taskHistory.value[0] || null)
const filtered = computed(() => (result.value?.results || []).filter(row => filter.value === 'all' || row.status !== 'matched'))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 30)))
const displayed = computed(() => filtered.value.slice(page.value * 30, (page.value + 1) * 30))
const off = window.printpress.onPhotoProgress(p => {
  if (alive && p.taskId === importTaskId.value && p.datasetId === props.datasetId && p.column === column.value) progress.value = p
})
onBeforeUnmount(() => {
  alive = false
  generation++
  off()
  if (pendingSelection.value?.token) window.printpress.cancelPhotoSelection(pendingSelection.value.token).catch(() => {})
})

watch(() => [props.datasetId, column.value], refresh, { immediate: true })
watch(filter, () => { page.value = 0 })

async function refresh() {
  const token = ++generation
  if (pendingSelection.value?.token) window.printpress.cancelPhotoSelection(pendingSelection.value.token).catch(() => {})
  pendingSelection.value = null
  result.value = null
  error.value = ''
  page.value = 0
  photoStates.value = {}
  taskHistory.value = []
  if (!column.value) {
    loading.value = false
    try {
      const tasks = await window.printpress.photoImportTasks(props.datasetId)
      if (alive && token === generation) taskHistory.value = tasks
    } catch { /* task history is supplementary UI */ }
    return
  }
  loading.value = true
  try {
    const [report, tasks] = await Promise.all([
      window.printpress.photoReport({ datasetId: props.datasetId, column: column.value }),
      window.printpress.photoImportTasks(props.datasetId),
    ])
    if (alive && token === generation) { result.value = report; taskHistory.value = tasks }
  } catch (err) {
    if (alive && token === generation) error.value = toUserMessage(err)
  } finally {
    if (alive && token === generation) loading.value = false
  }
}

async function importFolder(mode = 'append') {
  const token = ++generation
  if (pendingSelection.value?.token) window.printpress.cancelPhotoSelection(pendingSelection.value.token).catch(() => {})
  pendingSelection.value = null
  loading.value = true
  error.value = ''
  try {
    const response = await window.printpress.importPhotoFolder({ datasetId: props.datasetId, column: column.value, mode })
    if (response.canceled) return
    if (!alive || token !== generation) {
      if (response.token) window.printpress.cancelPhotoSelection(response.token).catch(() => {})
      return
    }
    pendingSelection.value = { token: response.token, preview: response.preview }
  } catch (err) {
    if (alive && token === generation) error.value = toUserMessage(err)
  } finally {
    if (alive && token === generation) loading.value = false
  }
}

async function commitImport() {
  const selection = pendingSelection.value
  if (!selection?.token || busy.value) return
  pendingSelection.value = null
  const token = ++generation
  const taskId = crypto.randomUUID()
  importTaskId.value = taskId
  busy.value = true
  error.value = ''
  progress.value = null
  cancelling.value = false
  cancelRequested.value = false
  try {
    const response = await window.printpress.commitPhotoFolder(selection.token, taskId)
    taskHistory.value = await window.printpress.photoImportTasks(props.datasetId)
    if (alive && token === generation && !response.canceled) {
      result.value = response.report
      page.value = 0
      photoStates.value = {}
    }
  } catch (err) {
    if (alive && token === generation) error.value = cancelRequested.value ? '导入已取消，原照片清单保持不变。' : toUserMessage(err)
    try { taskHistory.value = await window.printpress.photoImportTasks(props.datasetId) } catch { /* task history is supplementary UI */ }
  } finally {
    if (alive) { busy.value = false; loading.value = false; importTaskId.value = ''; cancelling.value = false; cancelRequested.value = false }
  }
}

async function cancelSelection() {
  const selection = pendingSelection.value
  pendingSelection.value = null
  if (selection?.token) {
    try { await window.printpress.cancelPhotoSelection(selection.token) }
    catch (err) { error.value = toUserMessage(err) }
  }
}

async function cancelImport() {
  if (!importTaskId.value || cancelling.value) return
  cancelling.value = true
  cancelRequested.value = true
  try {
    const result = await window.printpress.cancelPhotoImport(importTaskId.value)
    if (!result?.accepted) { cancelling.value = false; cancelRequested.value = false }
  } catch (err) {
    cancelling.value = false
    cancelRequested.value = false
    error.value = toUserMessage(err)
  }
}

</script>

<template>
  <div :class="embedded ? 'photo-embedded' : 'photo-mask'" @click.self="!embedded && !busy && emit('close')">
    <section class="photo-panel" :role="embedded ? 'region' : 'dialog'" :aria-modal="embedded ? undefined : true" aria-labelledby="photo-title">
      <header><div><h2 id="photo-title">{{ embedded ? '照片与名单关联' : '变量照片库' }}</h2><p>按数据页选中的“配图”列筛选同名照片，例如姓名“张三”匹配“张三.jpg”。仅匹配成功的照片入库，未匹配和冲突照片跳过；缺图留白，原图不压缩。导入默认补充缺失照片，已有有效照片会保留。</p></div><button v-if="!embedded" :disabled="busy" aria-label="关闭" @click="emit('close')">×</button></header>
      <div class="photo-actions">
        <strong>配图列：{{ columns.find(c => c.key === column)?.alias || column || '未选择' }}</strong>
        <button class="btn-primary" :disabled="busy || loading || !column" @click="importFolder('append')">{{ busy ? '正在导入…' : loading ? '正在检查…' : result?.imported ? '补充缺失照片' : '导入照片' }}</button>
        <button v-if="result?.imported" class="btn-ghost" :disabled="busy || loading || !column" @click="importFolder('replace')">替换当前名单照片</button>
        <button v-if="busy && progress?.taskId === importTaskId" class="btn-ghost" :disabled="cancelling" @click="cancelImport">{{ cancelling ? '正在取消…' : '取消导入' }}</button>
        <button class="btn-ghost" :disabled="busy || loading || !column" @click="refresh">重新检查</button>
      </div>
      <p v-if="!column" class="photo-note">请先到数据页，点击姓名、编号或其他列头的“配图”开关。每份名单只能启用一列；再次点击可关闭。</p>
      <p v-if="busy" role="status">{{ progress?.stage === 'scanning' ? '正在扫描照片目录…' : progress ? `已处理 ${progress.done} / ${progress.total}：${progress.name}` : '正在选择照片文件夹…' }}</p>
      <p v-if="loading" role="status">正在检查所选文件夹并计算关联变化，尚未写入照片…</p>
      <p v-if="latestTask" class="photo-note">最近任务：{{ taskLabels[latestTask.state] || latestTask.state }} · {{ latestTask.updatedAt?.replace('T', ' ').slice(0, 19) }}<span v-if="latestTask.error"> · {{ toUserMessage(latestTask.error) }}</span></p>
      <p v-if="error" class="photo-error" role="alert">{{ error }}</p>
      <section v-if="pendingSelection" class="photo-plan" aria-label="导入预检结果">
        <h3>{{ pendingSelection.preview.mode === 'append' ? '补充结果预览' : '替换结果预览' }}</h3>
        <p>文件夹：{{ pendingSelection.preview.folderName }} · {{ pendingSelection.preview.candidateCount }} 个匹配候选。以下按文件名和内容哈希预估；图片解码异常仍会在导入时跳过。</p>
        <p v-if="pendingSelection.preview.previousColumnChanged" class="photo-warning">当前配图列与原关联列不同，确认后会按新配图列重建关联清单。</p>
        <div class="photo-plan-grid">
          <span>新增 {{ pendingSelection.preview.counts.new }}</span>
          <span>修复 {{ pendingSelection.preview.counts.repair }}</span>
          <span v-if="pendingSelection.preview.mode === 'append'">保留已有 {{ pendingSelection.preview.counts.keep }}</span>
          <span>内容相同 {{ pendingSelection.preview.counts.same }}</span>
          <span v-if="pendingSelection.preview.mode === 'replace'">更换 {{ pendingSelection.preview.counts.replace }}</span>
          <span v-if="pendingSelection.preview.mode === 'replace'">移除关联 {{ pendingSelection.preview.counts.remove }}</span>
          <span>同名冲突 {{ pendingSelection.preview.counts.conflict }}</span>
          <span>无效候选 {{ pendingSelection.preview.counts.invalid }}</span>
          <span>未匹配 {{ pendingSelection.preview.counts.unmatched }}</span>
        </div>
        <footer>
          <button class="btn-ghost" @click="cancelSelection">取消</button>
          <button class="btn-primary" @click="commitImport">{{ pendingSelection.preview.mode === 'append' ? '开始补充' : '确认替换并导入' }}</button>
        </footer>
      </section>
      <template v-if="result && !loading">
        <p v-if="!result.imported" class="photo-note">尚未导入照片。名单可填写 1001、1001.jpg 或 子目录/1001.jpg；同名多图会报告冲突。</p>
        <template v-else>
          <p class="photo-note">来源：{{ result.folderName }} · 匹配 {{ result.counts.matched }} / {{ result.total }} 行 · 待处理 {{ result.blocking }} 行 · 未填写 {{ result.counts.empty }} 行</p>
          <p class="photo-note">已入库 {{ result.files.filter(f => f.assetId && !f.error).length }} 张 · 已跳过 {{ result.ignored.length + result.files.filter(f => f.error).length }} 个文件。切换配图列后，新匹配的照片需重新选择文件夹导入。</p>
          <p v-if="result.duplicates.length" class="photo-warning">{{ result.duplicates.length }} 张照片被多行共用，请确认是否符合预期。<span v-for="(group, i) in result.duplicates.slice(0, 10)" :key="i"> 第 {{ group.rowIndexes.slice(0, 10).map(n => n + 1).join('、') }} 行{{ group.rowIndexes.length > 10 ? '等' : '' }}；</span></p>
          <details v-if="result.ignored.length || result.files.some(f => f.error)"><summary>查看跳过或无法导入的文件</summary><ul><li v-for="(file, i) in [...result.files.filter(f => f.error), ...result.ignored].slice(0, 100)" :key="i">{{ file.name }}：{{ toUserMessage(file.error || file.reason) }}</li></ul><p>最多显示前 100 项；补充模式保留已有照片，替换操作会用本次匹配结果重建清单。</p></details>
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
.photo-plan{border:1px solid #d4c4a5;border-radius:10px;padding:16px;background:#f5efdf;margin:16px 0}.photo-plan h3{margin:0 0 8px;font-size:16px}.photo-plan p{font-size:13px;line-height:1.6;color:var(--stone)}.photo-plan-grid{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.photo-plan-grid span{padding:6px 10px;background:#fffaf0;border:1px solid #e0d5c3;border-radius:6px;font-size:13px}
</style>

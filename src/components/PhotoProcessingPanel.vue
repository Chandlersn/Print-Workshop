<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import DesignImageEditor from './DesignImageEditor.vue'
import { normalizeRecipe } from '../../electron/photo-processing-pixels.cjs'
import { photoProcessingChanged, photoProcessingDrafts, photoProcessingSample } from '../lib/photo-processing.js'
import { toUserMessage } from '../../electron/user-error.cjs'

const props = defineProps({ datasetId: { type: String, required: true }, rowId: { type: String, default: '' }, refreshKey: { type: Number, default: 0 }, expanded: Boolean })
const emit = defineEmits(['preview', 'applied', 'navigate'])
const opened = ref(props.expanded), loading = ref(false), previewing = ref(false), applying = ref(false), canceling = ref(false)
const error = ref(''), notice = ref(''), samples = ref([]), sampleId = ref(''), state = ref(null), modelReady = ref(false)
const recipe = ref(normalizeRecipe()), previewAsset = ref(null), progress = ref(null)
const photoColumn = ref('')
const presets = ref([]), presetId = ref(''), presetName = ref(''), automatic = ref(false), job = ref(null), faceReady = ref(false)
const restoreAsset = ref(null), analysis = ref(null), singleSaved = ref(null), pixelEdit = ref(null)
const query = () => ({ datasetId: props.datasetId, ...(props.rowId ? { rowId: props.rowId } : {}) })
const draftKey = computed(() => `${props.datasetId}:${props.rowId}`)
let alive = true, generation = 0, revision = 0, previewTimer, queued = false, taskId = '', initialized = false
const selected = computed(() => samples.value.find(item => item.assetId === sampleId.value))
const originalUrl = computed(() => selected.value ? `pp://media/${selected.value.assetId}` : '')
const resultUrl = computed(() => previewAsset.value ? `pp://media/${previewAsset.value.id}` : '')
const uniqueCount = computed(() => new Set(samples.value.map(item => item.assetId)).size)
const pendingCount = computed(() => state.value?.enabled ? new Set(samples.value.filter(item => !state.value.items?.[item.assetId]).map(item => item.assetId)).size : 0)
const canEdit = computed(() => !loading.value && !applying.value && job.value?.phase !== 'processing' && Boolean(selected.value))
const off = window.printpress.onPhotoProcessingProgress(payload => {
  if (!alive || payload.datasetId !== props.datasetId) return
  if (payload.automatic) {
    job.value = payload
    if (payload.phase === 'completed') { refresh(); emit('applied', null) }
  } else if (payload.taskId === taskId) progress.value = payload
})
function invalidate() {
  revision++; previewAsset.value = null; notice.value = ''
  if (!props.rowId && photoProcessingSample.value?.datasetId === props.datasetId) photoProcessingSample.value = null
  clearTimeout(previewTimer)
  if (initialized) photoProcessingDrafts[draftKey.value] = { recipe: JSON.parse(JSON.stringify(recipe.value)), sampleAssetId: sampleId.value }
  if (opened.value && initialized) previewTimer = setTimeout(preview, 500)
}
watch(recipe, invalidate, { deep: true })
watch(sampleId, invalidate)
watch(opened, value => { if (value && !previewAsset.value) preview() })
async function refresh() {
  const token = ++generation
  loading.value = true; error.value = ''
  try {
    const [detail, processing] = await Promise.all([window.printpress.getDataset(props.datasetId), window.printpress.getPhotoProcessing(query())])
    const report = detail.photoMatchColumn ? await window.printpress.photoReport({ datasetId: props.datasetId, column: detail.photoMatchColumn }) : { results: [], files: [] }
    if (!alive || token !== generation) return
    if (photoColumn.value !== detail.photoMatchColumn && photoProcessingSample.value?.datasetId === props.datasetId) photoProcessingSample.value = null
    photoColumn.value = detail.photoMatchColumn || ''
    const files = new Map(report.files.map(item => [item.assetId, item]))
    samples.value = report.results.filter(row => row.status === 'matched' && (!props.rowId || detail.recordIds[row.rowIndex] === props.rowId)).map(row => ({ ...row, ...files.get(row.assetId) }))
    state.value = processing.state; modelReady.value = processing.model.ready
    presets.value = processing.presets || []; automatic.value = Boolean(processing.options?.autoProcess); job.value = processing.job; faceReady.value = Boolean(processing.model.faceReady)
    singleSaved.value = processing.single
    if (!selected.value) sampleId.value = processing.state?.sampleAssetId && samples.value.some(row => row.assetId === processing.state.sampleAssetId) ? processing.state.sampleAssetId : samples.value[0]?.assetId || ''
    if (!initialized) {
      const draft = photoProcessingDrafts[draftKey.value]
      if (draft?.sampleAssetId && samples.value.some(row => row.assetId === draft.sampleAssetId)) sampleId.value = draft.sampleAssetId
      if (draft?.recipe || processing.single?.override?.recipe || processing.state?.recipe) recipe.value = normalizeRecipe(draft?.recipe || processing.single?.override?.recipe || processing.state.recipe)
      else if (selected.value) useSampleSize()
      initialized = true
    }
    if (opened.value && selected.value) { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 0) }
  } catch (err) { if (alive && token === generation) error.value = toUserMessage(err) }
  finally { if (alive && token === generation) loading.value = false }
}
watch(() => [props.datasetId, props.rowId, props.refreshKey], refresh, { immediate: true })
function useSampleSize() {
  if (!selected.value) return
  const factor = Math.min(1, 3200 / Math.max(selected.value.width, selected.value.height))
  recipe.value = { ...recipe.value, width: Math.max(64, Math.round(selected.value.width * factor)), height: Math.max(64, Math.round(selected.value.height * factor)) }
}
async function preview() {
  if (!alive || !opened.value || !selected.value || applying.value) return
  if (previewing.value) { queued = true; return }
  const token = revision, sourceId = sampleId.value
  let normalized
  try { normalized = normalizeRecipe(recipe.value) } catch (err) { error.value = toUserMessage(err); return }
  if (props.rowId && singleSaved.value?.asset && singleSaved.value?.override && JSON.stringify(normalized) === JSON.stringify(normalizeRecipe(singleSaved.value.override.recipe))) {
    previewAsset.value = singleSaved.value.asset; restoreAsset.value = singleSaved.value.restoreAsset; analysis.value = singleSaved.value.override.analysis; return
  }
  previewing.value = true; error.value = ''; queued = false
  try {
    const result = await window.printpress.previewPhotoProcessing({ datasetId: props.datasetId, assetId: sourceId, recipe: normalized })
    if (alive && token === revision && sourceId === sampleId.value) {
      previewAsset.value = result.asset; restoreAsset.value = result.restoreAsset; analysis.value = result.analysis
      if (!props.rowId) photoProcessingSample.value = { datasetId: props.datasetId, sourceAssetId: sourceId, column: photoColumn.value, assetId: result.asset.id }
      emit('preview', { asset: result.asset, sourceAssetId: sourceId })
    }
  } catch (err) { if (alive && token === revision) error.value = toUserMessage(err) }
  finally { if (alive) { previewing.value = false; if (queued || token !== revision) { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 0) } } }
}
async function applyAll() {
  if (!canEdit.value || previewing.value) return
  let normalized
  try { normalized = normalizeRecipe(recipe.value) } catch (err) { error.value = toUserMessage(err); return }
  if (props.rowId) { await applySingle(); return }
  applying.value = true; error.value = ''; notice.value = ''; progress.value = null
  taskId = `photos-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const result = await window.printpress.applyPhotoProcessing({ datasetId: props.datasetId, sampleAssetId: sampleId.value, recipe: normalized, taskId })
    if (!alive) return
    if (result.canceled) { notice.value = '已取消本次处理，之前的应用结果仍有效。'; return }
    if (!result.applied) { error.value = `有 ${result.failures.length} 张照片处理失败，本次设置尚未应用。${result.failures[0]?.message ? toUserMessage(result.failures[0].message) : ''}`; return }
    state.value = result.state; job.value = null; delete photoProcessingDrafts[draftKey.value]; photoProcessingChanged(); emit('applied', result.state)
    notice.value = `已应用到 ${result.total} 张不同照片，底图预览和打印将使用处理结果。`
  } catch (err) { if (alive) error.value = toUserMessage(err) }
  finally { if (alive) { applying.value = false; canceling.value = false; taskId = '' } }
}
async function cancel() {
  if (!taskId || canceling.value) return
  canceling.value = true
  try { await window.printpress.cancelPhotoProcessing({ datasetId: props.datasetId, taskId }) }
  catch (err) { error.value = toUserMessage(err); canceling.value = false }
}
async function reset() {
  if (applying.value) return
  if (props.rowId) {
    try {
      await window.printpress.clearSinglePhotoProcessing(query()); singleSaved.value = null; initialized = false; delete photoProcessingDrafts[draftKey.value]
      photoProcessingChanged(); emit('applied', null); await refresh(); notice.value = '此人已恢复统一样板。'
    } catch (err) { error.value = toUserMessage(err) }
    return
  }
  try { await window.printpress.clearPhotoProcessing(props.datasetId); state.value = null; delete photoProcessingDrafts[draftKey.value]; photoProcessingSample.value = null; photoProcessingChanged(); emit('applied', null); notice.value = '已恢复使用原始照片，单张修改也已清除。' }
  catch (err) { error.value = toUserMessage(err) }
}
function loadPreset() {
  const preset = presets.value.find(item => item.id === presetId.value)
  if (preset) { recipe.value = normalizeRecipe(preset.recipe); presetName.value = preset.name; notice.value = '已载入样板，预览确认后再应用。' }
}
async function savePreset() {
  try { const saved = await window.printpress.savePhotoProcessingPreset({ name: presetName.value, recipe: JSON.parse(JSON.stringify(recipe.value)) }); presets.value = [...presets.value, saved]; presetId.value = saved.id; notice.value = '样板已保存，可在其他名单复用。' }
  catch (err) { error.value = toUserMessage(err) }
}
async function deletePreset() {
  try { await window.printpress.deletePhotoProcessingPreset(presetId.value); presets.value = presets.value.filter(item => item.id !== presetId.value); presetId.value = ''; notice.value = '已删除保存的样板，当前照片效果保持不变。' }
  catch (err) { error.value = toUserMessage(err) }
}
async function setAutomatic(event) {
  try { const result = await window.printpress.setPhotoProcessingOptions({ datasetId: props.datasetId, autoProcess: event.target.checked }); automatic.value = result.autoProcess }
  catch (err) { error.value = toUserMessage(err) }
}
async function openPixelEdit() {
  if (!props.rowId || applying.value || previewing.value) return
  if (!previewAsset.value) await preview()
  if (previewAsset.value) pixelEdit.value = { asset: previewAsset.value, restoreAsset: restoreAsset.value, layer: { id: 'single-photo', type: 'image', x: 0, y: 0, w: 100, h: 100, crop: { x: 0, y: 0, w: 1, h: 1 } } }
}
async function applySingle(edit) {
  if (!props.rowId || applying.value) return
  applying.value = true; error.value = ''
  try {
    const result = await window.printpress.setSinglePhotoProcessing({ ...query(), assetId: sampleId.value, recipe: JSON.parse(JSON.stringify(recipe.value)),
      ...(edit ? { edit: JSON.parse(JSON.stringify({ ...edit, baseAssetId: pixelEdit.value.asset.id })) } : {}) })
    if (!alive) return
    singleSaved.value = { override: result.entry, asset: result.asset, restoreAsset: result.restoreAsset }
    previewAsset.value = result.asset; restoreAsset.value = result.restoreAsset; pixelEdit.value = null
    delete photoProcessingDrafts[draftKey.value]; photoProcessingChanged(); emit('applied', result.entry)
    notice.value = '仅此人的照片已更新，其他记录继续使用统一样板。'
  } catch (err) { if (alive) error.value = toUserMessage(err) }
  finally { if (alive) applying.value = false }
}
defineExpose({ refresh })
onBeforeUnmount(() => { alive = false; generation++; clearTimeout(previewTimer); off(); if (taskId) window.printpress.cancelPhotoProcessing({ datasetId: props.datasetId, taskId }).catch(() => {}) })
</script>

<template>
  <section class="photo-processing" data-testid="photo-processing-panel">
    <header class="processing-heading"><div><h2><AppIcon name="portrait" /> {{ rowId ? '单张照片编辑' : '变量照片自动处理' }}</h2><p>{{ rowId ? '仅修改当前记录，其他人继续使用统一样板。' : '选一张照片制作样板，将适配、抠图和柔边规则应用到整份名单。' }}</p></div><button class="btn-ghost" data-testid="photo-processing-toggle" :aria-expanded="opened" @click="opened = !opened">{{ opened ? '收起设置' : '制作样板' }}</button></header>
    <p v-if="loading" role="status">正在读取可用照片…</p>
    <p v-else-if="!samples.length" class="muted">导入并匹配照片后，即可选择样板。</p>
    <p v-if="state?.enabled && !rowId" class="applied-status">已应用自动处理 · {{ state.recipe.width }} × {{ state.recipe.height }} px <span v-if="pendingCount"> · 有 {{ pendingCount }} 张新增或更换的照片待应用</span></p>
    <label v-if="!rowId" class="check automatic-setting"><input data-testid="photo-processing-automatic" type="checkbox" :checked="automatic" @change="setAutomatic">新增或更换照片后自动沿用已应用样板（只处理变化的照片）</label>
    <p v-if="job?.phase === 'processing'" class="processing-notice" role="status">自动处理 {{ job.index || 0 }} / {{ job.total || 0 }}，完成后更新整批结果。</p>
    <p v-if="job?.phase === 'failed'" class="processing-error">自动处理未完成：{{ toUserMessage(job.message || job.failures?.[0]?.message || '照片处理失败') }}。可点击应用样板重试，已完成的计算会复用。</p>
    <div v-if="opened && samples.length" class="processing-editor">
      <div class="sample-area">
        <label>样板照片<select v-model="sampleId" data-testid="photo-processing-sample" :disabled="!canEdit"><option v-for="item in samples" :key="item.rowIndex" :value="item.assetId">第 {{ item.rowIndex + 1 }} 行 · {{ item.name }}</option></select></label>
        <div class="comparison"><figure><figcaption>原始照片</figcaption><div class="sample-frame" :style="{ aspectRatio: `${recipe.width} / ${recipe.height}` }"><img :src="originalUrl" alt="样板原始照片"></div></figure><figure><figcaption>处理效果 <span v-if="previewing" role="status">· 正在生成…</span></figcaption><div class="sample-frame" :style="{ aspectRatio: `${recipe.width} / ${recipe.height}` }"><img v-if="resultUrl" :src="resultUrl" alt="样板处理效果" data-testid="photo-processing-preview"><span v-else>{{ previewing ? '正在处理样板…' : '调整设置后预览' }}</span></div></figure></div>
        <p class="muted">{{ rowId ? '单张修改按人员记录保存；换了原照片会停用旧修改，避免套错人。' : '每张照片分别生成自己的蒙版；开启人物对齐后可统一脸部大小和眼睛高度。' }}</p>
        <p v-if="rowId && singleSaved?.override?.edited" class="muted">这张照片已有手工修补；继续打开图片编辑可接着修改，重新应用设置会按参数重新生成照片。</p>
        <button v-if="!rowId" class="btn-ghost" :disabled="!canEdit || previewing" @click="emit('navigate', 'designer')">前往底图编辑参考样图</button>
        <button v-else class="btn-primary" data-testid="photo-processing-pixel-edit" :disabled="!canEdit || previewing || !previewAsset" @click="openPixelEdit">图片编辑 · 抠图边缘修补</button>
        <p v-if="analysis?.issues?.length" class="processing-error">这张照片建议在批量检查中复核：{{ analysis.issues.includes('no-face') ? '未识别人脸' : analysis.issues.includes('multiple-faces') ? '检测到多人' : '存在裁切或放大提示' }}。</p>
      </div>
      <fieldset :disabled="!canEdit" class="processing-controls">
        <legend>样板设置</legend>
        <div class="preset-controls">
          <label>复用已保存样板<select v-model="presetId" data-testid="photo-processing-preset" @change="loadPreset"><option value="">选择样板或模板</option><option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option></select></label>
          <label>样板名称<input v-model="presetName" data-testid="photo-processing-preset-name" maxlength="100" placeholder="例如：证件人像柔边"></label>
          <div class="control-pair"><button data-testid="photo-processing-preset-save" @click="savePreset">另存样板</button><button :disabled="!presetId || presets.find(item => item.id === presetId)?.readOnly" @click="deletePreset">删除样板</button></div>
          <p class="muted">保存模板时也会带上当前已应用规则，可在其他名单的此处载入。</p>
        </div>
        <div class="control-pair"><label>宽度 px<input v-model.number="recipe.width" data-testid="photo-processing-width" type="number" min="64" max="4096" step="1"></label><label>高度 px<input v-model.number="recipe.height" data-testid="photo-processing-height" type="number" min="64" max="4096" step="1"></label></div>
        <button class="btn-ghost" data-testid="photo-processing-use-size" @click="useSampleSize">使用这张照片的尺寸</button>
        <label>适配方式<select v-model="recipe.fit"><option value="contain">等比完整显示</option><option value="cover">等比铺满裁切</option></select></label>
        <label class="check"><input v-model="recipe.cutout" data-testid="photo-processing-cutout" type="checkbox" :disabled="!modelReady"> 人像自动抠图</label>
        <p v-if="!modelReady" class="muted">本地抠图组件缺失，请安装完整安装包。</p>
        <label class="check"><input v-model="recipe.subjectFit" type="checkbox"> 按可见主体适配尺寸</label>
        <label class="check"><input v-model="recipe.faceAlign" data-testid="photo-processing-face-align" type="checkbox" :disabled="!faceReady"> 人物大小与眼睛高度自动对齐</label>
        <template v-if="recipe.faceAlign"><label>脸部高度占画面 {{ Math.round(recipe.faceHeight * 100) }}%<input v-model.number="recipe.faceHeight" data-testid="photo-processing-face-height" type="range" min=".08" max=".8" step=".01"></label><label>眼睛距顶部 {{ Math.round(recipe.eyeY * 100) }}%<input v-model.number="recipe.eyeY" data-testid="photo-processing-eye-y" type="range" min=".1" max=".75" step=".01"></label><p class="muted">仅自动对齐单人照片；无人脸或多人照片保留普通适配并标记检查。</p></template>
        <label>主体缩放 {{ Math.round(recipe.scale * 100) }}%<input v-model.number="recipe.scale" type="range" min="0.25" max="2" step="0.01"></label>
        <div class="control-pair"><label>水平位置<input v-model.number="recipe.offsetX" type="range" min="-1" max="1" step="0.01"></label><label>垂直位置<input v-model.number="recipe.offsetY" type="range" min="-1" max="1" step="0.01"></label></div>
        <label class="check"><input v-model="recipe.bottom" data-testid="photo-processing-bottom" type="checkbox"> 底部渐隐</label>
        <template v-if="recipe.bottom"><label>从高度 {{ Math.round(recipe.bottomStart * 100) }}% 开始<input v-model.number="recipe.bottomStart" type="range" min="0" max="0.99" step="0.01"></label><label>底部不透明度 {{ Math.round(recipe.bottomOpacity * 100) }}%<input v-model.number="recipe.bottomOpacity" data-testid="photo-processing-bottom-opacity" type="range" min="0" max="1" step="0.01"></label></template>
        <label class="check"><input v-model="recipe.edge" data-testid="photo-processing-edge" type="checkbox"> 四周羽化</label>
        <template v-if="recipe.edge"><label>羽化范围<select v-model="recipe.edgeTarget"><option value="frame">照片外框</option><option value="subject">人物 / 可见主体轮廓</option></select></label><label>羽化宽度 {{ Math.round(recipe.edgeWidth * 100) }}%<input v-model.number="recipe.edgeWidth" type="range" min="0.01" max="0.4" step="0.01"></label><label>边缘不透明度 {{ Math.round(recipe.edgeOpacity * 100) }}%<input v-model.number="recipe.edgeOpacity" type="range" min="0" max="1" step="0.01"></label></template>
      </fieldset>
    </div>
    <div v-if="opened && samples.length" class="processing-actions"><button class="btn-primary" data-testid="photo-processing-apply" :disabled="!canEdit || previewing || !previewAsset" @click="applyAll">{{ rowId ? '仅应用此人的设置' : `应用到全部 ${uniqueCount} 张照片` }}</button><button v-if="state?.enabled || singleSaved?.override" data-testid="photo-processing-reset" class="btn-ghost" :disabled="applying" @click="reset">{{ rowId ? '恢复统一样板' : '恢复全部原始照片' }}</button><span v-if="applying" role="status">{{ progress ? `${progress.index} / ${progress.total}` : '准备中…' }}</span><button v-if="applying && !rowId" class="btn-ghost" :disabled="canceling" @click="cancel">{{ canceling ? '当前照片完成后停止…' : '取消处理' }}</button></div>
    <p v-if="error" class="processing-error" role="alert">{{ error }}</p><p v-if="notice" class="processing-notice" role="status">{{ notice }}</p>
    <DesignImageEditor v-if="pixelEdit" :layer="pixelEdit.layer" :asset="pixelEdit.asset" :restore-asset="pixelEdit.restoreAsset" mode="mask" :busy="applying" :apply-error="error" @apply="applySingle" @cancel="!applying && (pixelEdit = null)" />
  </section>
</template>

<style scoped>
.photo-processing { margin: 18px 0; padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper-card); }
.processing-heading, .processing-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h2 { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 16px; }
.processing-heading p, .muted { margin: 6px 0; color: var(--stone); font-size: 12px; line-height: 1.6; }
.processing-editor { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 22px; margin-top: 18px; }
.sample-area { min-width: 0; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-2); }
input:not([type="checkbox"]), select { box-sizing: border-box; width: 100%; min-width: 0; padding: 7px; border: 1px solid var(--line-strong); border-radius: 5px; background: var(--input-bg); color: var(--ink); font: inherit; }
input[type="range"] { padding: 0; accent-color: var(--cinnabar); }
.comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
figure { min-width: 0; margin: 0; } figcaption { color: var(--stone); font-size: 12px; margin-bottom: 7px; }
.sample-frame { display: flex; align-items: center; justify-content: center; min-height: 120px; max-height: 430px; overflow: hidden; border: 1px solid var(--line); border-radius: 7px; background: repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 0 0 / 16px 16px; color: #777; font-size: 12px; }
.sample-frame img { width: 100%; height: 100%; max-height: 430px; object-fit: contain; }
.processing-controls { display: grid; gap: 10px; align-content: start; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
legend { padding: 0 6px; font-size: 12px; color: var(--stone); }
.control-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
label.check { flex-direction: row; align-items: center; gap: 6px; }
.check input { margin: 0; accent-color: var(--cinnabar); }
.processing-actions { justify-content: flex-start; margin-top: 16px; }
.processing-error { color: var(--cinnabar); font-size: 12px; line-height: 1.6; }
.processing-notice, .applied-status { color: var(--jade, #357456); font-size: 12px; line-height: 1.6; }
.applied-status span { color: var(--cinnabar); }
.automatic-setting { margin: 12px 0; font-size: 12px; }
.preset-controls { display: grid; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
@media (max-width: 820px) { .processing-editor { grid-template-columns: 1fr; } .processing-controls { grid-template-columns: 1fr 1fr; } }
</style>

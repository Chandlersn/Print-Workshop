<script setup>
/**
 * 打印中心：批量发起（数据集 × 模板）→ 出口校验弹窗（可中断可放行）
 * → 导出 PDF / 直接送打印 → 打印历史留痕与归档件回看。
 * 预览用 iframe srcdoc 直接承载渲染引擎输出的批量 HTML。
 */
import { ref, computed, watch, onMounted } from 'vue'
import CustomSelect from '../components/CustomSelect.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { gotoCell } from '../lib/cell-nav.js'

const datasets = ref([])
const templates = ref([])
const jobs = ref([])
const selDs = ref('')
const selTpl = ref('')
const previewHtml = ref('')
const previewInfo = ref(null)
const zoom = ref('75')
const busy = ref(false)
const toast = ref('')

// 出口校验弹窗：pendingAction 记录用户最初想执行的动作
const showValidate = ref(false)
const validateResult = ref(null)
const pendingAction = ref('')
/** 字段缺失是结构性错误，放行只会白版——弹窗中不可「仍要继续」 */
const hasMissingIssue = computed(() =>
  Boolean(validateResult.value?.issues.some((i) => i.missing)))

const dsOptions = computed(() =>
  datasets.value.map((d) => ({ value: d.id, label: `${d.name}（${d.rowCount} 行）` })))
const tplOptions = computed(() =>
  templates.value
    .filter((t) => t.hasBackground && t.fieldCount > 0)
    .map((t) => ({ value: t.id, label: t.datasetName ? `${t.name} × ${t.datasetName}` : t.name })))
const ready = computed(() => Boolean(selDs.value && selTpl.value))
const dsTotalRows = computed(() => datasets.value.find((d) => d.id === selDs.value)?.rowCount ?? 0)
/** 当前选中模板（含绑定信息） */
const boundTpl = computed(() => templates.value.find((t) => t.id === selTpl.value) || null)

// 当前数据集的打印统计（从历史留痕聚合）：对照工作簿，遗漏一眼可辨
const dsPrintStats = computed(() => {
  if (!selDs.value) return null
  const ds = datasets.value.find((d) => d.id === selDs.value)
  if (!ds) return null
  const mine = jobs.value.filter((j) => j.datasetId === selDs.value && j.status === 'ok')
  return {
    name: ds.name,
    rowCount: ds.rowCount,
    times: mine.length,
    pages: mine.reduce((s, j) => s + (j.recordCount || 0), 0),
    last: mine[0]?.createdAt || '',
  }
})
/** 模板绑定的数据集已被删除：打印链路走不通，须显式告知出路 */
const boundDsMissing = computed(() =>
  Boolean(boundTpl.value && boundTpl.value.datasetId
    && !datasets.value.some((d) => d.id === boundTpl.value.datasetId)))

// ---- 换绑数据集：模板 × 数据集字段匹配校验（缺失即阻止） ----
const rebindShow = ref(false)
const rebindDsId = ref('')
const rebindResult = ref(null)
const rebindBusy = ref(false)
const rebindOptions = computed(() =>
  datasets.value
    .filter((d) => d.id !== boundTpl.value?.datasetId)
    .map((d) => ({ value: d.id, label: `${d.name}（${d.rowCount} 行）` })))

const zoomOptions = [
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
  { value: '100', label: '100%' },
  { value: '125', label: '125%' },
]
const zoomK = computed(() => Number(zoom.value) / 100)

// 页面毫米 → px（96dpi），iframe 视口 = 内容全宽（毫米换算像素），transform 只负责显示缩放
const frameW = computed(() => previewInfo.value ? Math.round(previewInfo.value.page.w * 96 / 25.4) : 794)
const frameH = computed(() => previewInfo.value ? Math.round(previewInfo.value.page.h * 96 / 25.4) : 1123)
/** iframe 高度铺满全部页数 +8px 余量：内部出现任何滚动条都会吃掉宽度造成横向裁边 */
const frameTotalH = computed(() => frameH.value * (previewInfo.value?.recordCount || 1) + 8)

function say(msg) {
  toast.value = msg
  setTimeout(() => { if (toast.value === msg) toast.value = '' }, 4000)
}

async function refreshAll() {
  datasets.value = await window.printpress.listDatasets()
  templates.value = await window.printpress.listTemplates()
  jobs.value = await window.printpress.listJobs()
  if (!datasets.value.some((d) => d.id === selDs.value)) selDs.value = ''
  if (!templates.value.some((t) => t.id === selTpl.value)) selTpl.value = ''
}

async function rebuildPreview() {
  if (!ready.value) {
    previewHtml.value = ''
    previewInfo.value = null
    return
  }
  try {
    const built = await window.printpress.printGenerate(buildPayload())
    previewHtml.value = built.html
    previewInfo.value = built
    // 新选择预览成功：旧选择的失败提示已过时，立即清掉不让它挂在界面上
    if (toast.value) toast.value = ''
  } catch (err) {
    previewHtml.value = ''
    previewInfo.value = null
    say(`预览失败：${err.message || err}`)
  }
}

/** 统一的打印请求载荷：数据集 × 模板，始终作用于全部数据行。 */
function buildPayload() {
  return { datasetId: selDs.value, templateId: selTpl.value }
}

// 模板切换 → 自动带出绑定的数据集（模板保存时已绑定；旧模板未绑定时才需手选）
watch(selTpl, () => {
  const tpl = templates.value.find((t) => t.id === selTpl.value)
  selDs.value = (tpl && tpl.datasetId && datasets.value.some((d) => d.id === tpl.datasetId))
    ? tpl.datasetId
    : ''
})

// 模板字段 × 绑定数据集匹配检查：缺失是结构性错误（导出必白版），前置警告并阻断。
// 竞态守卫：快速连切模板时，旧请求的慢响应不得覆盖新选择的结果。
let mismatchSeq = 0
const mismatch = ref(null)
const mismatched = computed(() => Boolean(mismatch.value && !mismatch.value.ok))
watch([selTpl, selDs], async () => {
  mismatch.value = null
  if (!selTpl.value || !selDs.value) return
  const tpl = templates.value.find((t) => t.id === selTpl.value)
  if (!tpl || !tpl.datasetId || tpl.datasetId !== selDs.value) return // 兼容路径（临时选择）不在此检
  const seq = ++mismatchSeq
  try {
    const r = await window.printpress.matchDataset(selTpl.value, selDs.value)
    if (seq === mismatchSeq) mismatch.value = r
  } catch { /* 校验失败不阻塞预览，导出时 validateBatch 仍会兜底 */ }
})

function openRebind() {
  rebindDsId.value = ''
  rebindResult.value = null
  rebindShow.value = true
}

/** 选择候选数据集后即时做字段匹配预检，结果直接展示 */
watch(rebindDsId, async () => {
  rebindResult.value = null
  if (!rebindDsId.value || !selTpl.value) return
  try {
    rebindResult.value = await window.printpress.matchDataset(selTpl.value, rebindDsId.value)
  } catch (err) {
    say(`匹配校验失败：${err.message || err}`)
  }
})

async function confirmRebind() {
  if (!rebindResult.value?.ok || rebindBusy.value) return
  rebindBusy.value = true
  try {
    const r = await window.printpress.rebindDataset(selTpl.value, rebindDsId.value)
    rebindShow.value = false
    // 换绑持久化成功：切到新数据集（触发 selDs/selTpl watch 重建预览）
    selDs.value = r.datasetId
    await refreshAll()
    say(`已换绑到「${r.datasetName}」`)
  } catch (err) {
    say(`换绑失败：${err.message || err}`)
  } finally {
    rebindBusy.value = false
  }
}

watch([selDs, selTpl], rebuildPreview)

/** 校验 → 有空值先弹窗（可中断可放行），字段缺失不可放行；无问题直接执行 */
async function runAction(action) {
  if (!ready.value || busy.value || mismatched.value) return
  busy.value = true
  try {
    const v = await window.printpress.printValidate(buildPayload())
    if (v.issues.length > 0) {
      validateResult.value = v
      pendingAction.value = action
      showValidate.value = true
      return
    }
    await execute(action)
  } catch (err) {
    // 不允许静默失败：守卫之外的任何异常都要给用户可见反馈
    say(`操作失败：${err.message || err}`)
  } finally {
    busy.value = false
  }
}

async function confirmProceed() {
  showValidate.value = false
  const action = pendingAction.value
  pendingAction.value = ''
  validateResult.value = null
  busy.value = true
  try {
    await execute(action)
  } finally {
    busy.value = false
  }
}

function cancelProceed() {
  showValidate.value = false
  pendingAction.value = ''
  validateResult.value = null
  say('已中断，可先回数据页补全空值')
}

/** 去补录直达：关闭校验弹窗 → 跳数据页对应单元格聚焦编辑 */
function goFixCell(issue, cell) {
  showValidate.value = false
  pendingAction.value = ''
  validateResult.value = null
  gotoCell(selDs.value, cell.rowIndex, issue.key)
}

async function execute(action) {
  const payload = buildPayload()
  try {
    if (action === 'pdf') {
      const r = await window.printpress.printExportPdf(payload)
      if (r.canceled) { say('已取消导出'); return }
      say(`PDF 已导出（${previewInfo.value ? previewInfo.value.recordCount : '?'} 页）`)
    } else {
      const r = await window.printpress.printSend(payload)
      if (r.ok) say('已发送打印机')
      else say(`打印未完成：${r.error || ''}`)
    }
  } catch (err) {
    say(`执行失败：${err.message || err}`)
  }
  // 成功打印/导出会回写数据集状态（侧栏「已打 N」变色），两处清单都要刷新
  jobs.value = await window.printpress.listJobs()
  datasets.value = await window.printpress.listDatasets()
}

async function openSnapshot(jobId) {
  try {
    await window.printpress.openSnapshot(jobId)
  } catch (err) {
    say(`打开失败：${err.message || err}`)
  }
}

// ---- 打印历史管理：删除（应用内确认弹窗） ----
const pendingDelete = ref(null)

/** 删除打印任务：元数据 + 磁盘归档目录一并清理，不可恢复，先过确认弹窗 */
function deleteJob(job) {
  pendingDelete.value = {
    message: `删除打印任务「${job.templateName} × ${job.recordCount} 份（${fmtTime(job.createdAt)}）」？\n其归档快照也会一并删除，该操作不可恢复。`,
    job,
  }
}

async function confirmDelete() {
  const job = pendingDelete.value.job
  pendingDelete.value = null
  try {
    await window.printpress.deleteJob(job.id)
    jobs.value = await window.printpress.listJobs()
    say('已删除该打印记录及归档件')
  } catch (err) {
    say(`删除失败：${err.message || err}`)
  }
}

/** 一键重打：回填任务的模板（数据集由模板绑定自动带出），走同样的校验→执行流程 */
function reprint(job) {
  if (busy.value) return
  if (!templates.value.some((t) => t.id === job.templateId)) {
    say('原模板已删除，无法重打')
    return
  }
  const tpl = templates.value.find((t) => t.id === job.templateId)
  selTpl.value = job.templateId
  // 数据集按模板绑定设置（与 watch 语义一致，这里显式赋值避免时序问题）
  selDs.value = (tpl && tpl.datasetId && datasets.value.some((d) => d.id === tpl.datasetId))
    ? tpl.datasetId
    : ''
  runAction(job.mode === 'print' ? 'print' : 'pdf')
}

function fmtTime(iso) {
  return String(iso || '').replace('T', ' ').slice(0, 19)
}

const modeLabel = { pdf: '导出 PDF', print: '打印', grouped: '分组导出（已下线）' }
const statusLabel = { ok: '完成', failed: '失败', canceled: '取消' }

onMounted(refreshAll)
</script>

<template>
  <section class="page">
    <h2 class="page-title">打印中心</h2>

    <div class="toolbar">
      <span class="tb-label">模板</span>
      <CustomSelect v-model="selTpl" :options="tplOptions" placeholder="选择模板" width="240px" />
      <!-- 模板已绑定数据集：直接显示关联关系，不可错配 -->
      <template v-if="boundTpl && boundTpl.datasetId">
        <span class="bound-ds">关联数据集：{{ boundTpl.datasetName || '（已删除）' }}（{{ dsTotalRows }} 行）</span>
        <button class="btn btn-mini" :disabled="busy" @click="openRebind">更换数据集</button>
      </template>
      <!-- 旧模板未绑定：兼容路径，允许临时选择 -->
      <template v-else-if="selTpl">
        <span class="tb-label">数据集</span>
        <CustomSelect v-model="selDs" :options="dsOptions" placeholder="选择数据集" width="200px" />
        <span class="scope-note">旧模板未绑定数据集，建议回模板工坊保存一次完成绑定</span>
      </template>
      <span class="tb-spacer"></span>
      <button class="btn" :disabled="!ready || busy || mismatched" @click="runAction('print')">直接打印</button>
      <button class="btn btn-primary" :disabled="!ready || busy || mismatched" @click="runAction('pdf')">导出 PDF</button>
    </div>

    <!-- 模板绑定的数据集已被删除：结构断链，给可读出路而非让预览静默失败 -->
    <div v-if="boundDsMissing" class="scope-bar mismatch-bar">
      <span class="det-flag st-failed">数据集已删除</span>
      <span class="scope-note">
        模板「{{ boundTpl.name }}」关联的数据集已被删除，无法预览和打印——
        点「更换数据集」换绑一张表，或回「模板工坊」重新选择数据集
      </span>
    </div>

    <!-- 字段错配警告：模板字段在绑定数据集中不存在，导出必然白版，须先解决 -->
    <div v-if="mismatched" class="scope-bar mismatch-bar">
      <span class="det-flag st-failed">字段不匹配</span>
      <span class="scope-note">
        模板「{{ mismatch.templateName }}」的
        {{ mismatch.missing.map((x) => x.label).join('、') }}
        在「{{ mismatch.datasetName }}」中不存在或未激活打印——
        回「模板工坊」把字段换成该数据集的列（如 选手姓名/组别/奖项），或点「更换数据集」选匹配的表
      </span>
    </div>

    <!-- 打印统计：从留痕自动聚合，对照工作簿是否遗漏 -->
    <div v-if="ready && dsPrintStats" class="scope-bar stats-bar">
      <span class="det-flag" :class="dsPrintStats.times ? 'st-ok' : 'st-failed'">
        {{ dsPrintStats.times ? '有记录' : '无记录' }}
      </span>
      <span class="scope-note">
        「{{ dsPrintStats.name }}」（共 {{ dsPrintStats.rowCount }} 行）：
        <template v-if="dsPrintStats.times">已打印/导出 {{ dsPrintStats.times }} 次 · 累计 {{ dsPrintStats.pages }} 份 · 最近 {{ fmtTime(dsPrintStats.last) }}</template>
        <template v-else>尚无打印或导出记录——如果这份名单本来就要出片，这里就是遗漏提醒</template>
      </span>
    </div>

    <div v-if="!ready" class="empty-hint">
      <p class="hint-main">选择模板后自动带出关联数据集，开始批量出片</p>
      <p class="hint-sub">模板需已上传底图、添加字段并关联数据集（在「模板工坊」制作）</p>
    </div>

    <div v-else class="preview-wrap">
      <div class="preview-bar">
        <span v-if="previewInfo" class="preview-meta">
          {{ previewInfo.templateName }} × {{ previewInfo.datasetName }}
          · {{ previewInfo.recordCount }} 页 · {{ previewInfo.page.name }}
        </span>
        <span class="tb-spacer"></span>
        <span class="tb-label">缩放</span>
        <CustomSelect v-model="zoom" :options="zoomOptions" width="90px" />
      </div>
      <div class="preview-scroll">
        <!-- scale 缩放：iframe 布局尺寸=纸张全宽（内视口完整容纳内容，不裁边），
             transform 只做视觉缩放，外层 holder 定缩放后的占位尺寸 -->
        <div
          v-if="previewHtml"
          class="preview-holder"
          :style="{ width: frameW * zoomK + 'px', height: frameTotalH * zoomK + 'px' }"
        >
          <iframe
            class="preview-frame"
            :style="{ width: frameW + 4 + 'px', height: frameTotalH + 'px', transform: 'scale(' + zoomK + ')' }"
            :srcdoc="previewHtml"
            title="打印预览"
          ></iframe>
        </div>
      </div>
    </div>

    <div class="history-block">
      <h3 class="block-title">打印历史</h3>
      <table v-if="jobs.length" class="job-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>模板</th>
            <th>数据集</th>
            <th>方式</th>
            <th>份数</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in jobs" :key="j.id">
            <td>{{ fmtTime(j.createdAt) }}</td>
            <td>{{ j.templateName }}</td>
            <td>{{ j.datasetName }}</td>
            <td>{{ modeLabel[j.mode] || j.mode }}</td>
            <td>{{ j.recordCount }}</td>
            <td><span class="det-flag" :class="'st-' + j.status">{{ statusLabel[j.status] || j.status }}</span></td>
            <td class="row-actions">
              <button class="btn btn-mini" @click="openSnapshot(j.id)">归档件</button>
              <button class="btn btn-mini" :disabled="busy" @click="reprint(j)">重打</button>
              <button class="btn btn-mini job-del" @click="deleteJob(j)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint-sub">暂无打印记录</p>
    </div>

    <!-- 出口校验弹窗：可中断可放行 -->
    <div v-if="showValidate" class="modal-mask">
      <div class="modal">
        <h3 class="modal-title">打印前校验发现问题</h3>
        <p v-if="hasMissingIssue" class="modal-sub">
          存在<b>字段缺失</b>（模板字段在数据集中不存在）——补值无法解决，请回模板工坊调整字段后再打印：
        </p>
        <p v-else class="modal-sub">空值位置将留白打印；疑似占位值（括号包裹、纯符号等形态）按原样打印：</p>
        <div class="issue-list">
          <div v-for="i in validateResult.issues" :key="i.key" class="det-row">
            <span class="issue-label">{{ i.label }}</span>
            <span class="det-stats">
              <template v-if="i.missing">字段不存在</template>
              <template v-else>
                <template v-if="i.empty">空 {{ i.empty }}</template>
                <template v-if="i.empty && i.placeholder"> · </template>
                <template v-if="i.placeholder">疑似占位 {{ i.placeholder }}</template>
                / {{ i.total }} 行
              </template>
            </span>
            <span v-if="i.missing" class="det-flag st-failed">字段缺失</span>
            <span v-else-if="i.empty === i.total" class="det-flag st-failed">整列为空</span>
          </div>
          <!-- 去补录直达：点行号 → 数据页对应单元格聚焦编辑 -->
          <template v-for="i in validateResult.issues" :key="'fix-' + i.key">
            <div v-if="!i.missing && i.cells && i.cells.length" class="fix-row">
              <span class="fix-label">{{ i.label }}</span>
              <button
                v-for="c in i.cells"
                :key="c.rowIndex"
                class="fix-chip"
                :class="{ ph: c.kind === 'placeholder' }"
                :title="c.kind === 'empty' ? '空值，点击去填写' : '疑似占位值，点击去核对'"
                @click="goFixCell(i, c)"
              >第 {{ c.rowIndex + 1 }} 行</button>
              <span v-if="i.cellsTotal > i.cells.length" class="fix-more">共 {{ i.cellsTotal }} 处，仅列前 {{ i.cells.length }}</span>
            </div>
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="cancelProceed">{{ hasMissingIssue ? '返回调整' : '返回补全' }}</button>
          <button
            class="btn btn-primary"
            :disabled="hasMissingIssue"
            :title="hasMissingIssue ? '字段缺失无法通过放行解决，导出只会白版' : ''"
            @click="confirmProceed"
          >仍要继续</button>
        </div>
      </div>
    </div>

    <!-- 换绑数据集：模板字段 × 新数据集激活字段匹配预检，缺失即阻止 -->
    <div v-if="rebindShow" class="modal-mask">
      <div class="modal">
        <h3 class="modal-title">更换数据集</h3>
        <p class="modal-sub">
          模板「{{ boundTpl?.name }}」的 {{ boundTpl?.fieldCount }} 个字段将与新数据集匹配：
          每个字段都必须在新数据集列头激活「印」，否则不能换绑。
        </p>
        <CustomSelect v-model="rebindDsId" :options="rebindOptions" placeholder="选择新数据集" width="100%" />
        <div v-if="rebindResult" class="rebind-result" :class="{ ok: rebindResult.ok }">
          <template v-if="rebindResult.ok">
            <span class="det-flag st-ok">匹配通过</span>
            <span class="det-stats">模板 {{ rebindResult.fieldCount }} 个字段全部在「{{ rebindResult.datasetName }}」已激活的 {{ rebindResult.activatedCount }} 个字段中</span>
          </template>
          <template v-else>
            <span class="det-flag st-failed">匹配失败</span>
            <span class="det-stats">
              缺失 {{ rebindResult.missing.length }}/{{ rebindResult.fieldCount }}：
              {{ rebindResult.missing.map((x) => x.label).join('、') }}
            </span>
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="rebindShow = false">取消</button>
          <button class="btn btn-primary" :disabled="!rebindResult?.ok || rebindBusy" @click="confirmRebind">确认换绑</button>
        </div>
      </div>
    </div>

    <!-- 删除打印任务确认：应用内统一风格，替代原生 confirm -->
    <ConfirmDialog
      v-if="pendingDelete"
      title="删除打印任务"
      :message="pendingDelete.message"
      confirm-text="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </section>
</template>

<style scoped>
.page-title {
  margin: 0 0 16px;
  font-size: 18px;
  color: var(--ink);
  border-left: 4px solid var(--cinnabar);
  padding-left: 10px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.tb-label {
  font-size: 13px;
  color: var(--stone);
}

.tb-spacer {
  flex: 1;
}

.scope-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper-card);
}

.scope-note { font-size: 12px; color: var(--stone); }

.bound-ds {
  font-size: 13px;
  color: var(--ink-2);
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
}

.rebind-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--cinnabar);
  border-radius: 6px;
  background: var(--cinnabar-soft);
}

.rebind-result.ok {
  border-color: var(--ok);
  background: var(--ok-soft);
}

.mismatch-bar {
  border-color: var(--cinnabar);
  background: var(--cinnabar-soft);
  align-items: flex-start;
}

.btn {
  padding: 6px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.btn-primary {
  background: var(--cinnabar);
  border-color: var(--cinnabar);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  color: #fff;
  opacity: 0.9;
}

.btn-mini {
  padding: 3px 10px;
  font-size: 12px;
}

.row-actions {
  white-space: nowrap;
}

.row-actions .btn-mini + .btn-mini {
  margin-left: 6px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 10vh;
}

.hint-main {
  font-size: 15px;
  color: var(--ink-2);
}

.hint-sub {
  font-size: 12px;
  color: var(--stone);
}

.preview-wrap {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper-card);
  overflow: hidden;
}

.preview-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.preview-meta {
  font-size: 13px;
  color: var(--ink-2);
}

.preview-scroll {
  max-height: 68vh;
  overflow: auto;
  padding: 16px;
  background: var(--paper);
}

.preview-holder {
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  background: #fff;
  box-shadow: var(--shadow);
}

.preview-frame {
  display: block;
  background: #fff;
  transform-origin: top left;
}

.history-block {
  margin-top: 20px;
}

.block-title {
  margin: 0 0 10px;
  font-size: 14px;
  color: var(--ink);
}

.job-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.job-table th {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 2px solid var(--line-strong);
  color: var(--stone);
  font-weight: 500;
}

.job-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-2);
}

.job-del { color: var(--cinnabar); }

.det-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}

.det-stats {
  font-size: 12px;
  color: var(--stone);
}

.det-flag {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 4px;
  border: 1px solid var(--line-strong);
  color: var(--ink-2);
}

.st-ok {
  color: var(--ok);
  border-color: var(--ok);
}

.st-failed {
  color: var(--cinnabar);
  border-color: var(--cinnabar);
}

.st-canceled {
  color: var(--stone);
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 26, 20, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  width: 460px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--paper-card);
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  padding: 20px 22px;
  box-shadow: var(--shadow);
}

.modal-title {
  margin: 0 0 6px;
  font-size: 16px;
  color: var(--cinnabar);
}

.modal-sub {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--ink-2);
}

.issue-list {
  overflow-y: auto;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 4px 2px;
  margin-bottom: 14px;
}

.issue-label {
  font-size: 13px;
  color: var(--ink);
  min-width: 90px;
}

/* 去补录直达：出错单元格行号 chips */
.fix-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 2px 6px 14px;
  border-bottom: 1px dashed var(--line);
}
.fix-row:last-child { border-bottom: none; }

.fix-label {
  font-size: 12px;
  color: var(--stone);
  min-width: 78px;
}

.fix-chip {
  padding: 2px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--paper);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}
.fix-chip:hover {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
}
.fix-chip.ph { border-style: dashed; }

.fix-more {
  font-size: 12px;
  color: var(--stone);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: 8px;
  background: var(--ink);
  color: var(--paper);
  font-size: 13px;
  z-index: 120;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

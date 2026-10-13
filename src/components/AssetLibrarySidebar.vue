<script>
/**
 * 模块级（不是组件级）：同一批「原件已被删除」在**同一个应用会话内只提示一次**。
 * 放在组件里的话，侧栏每关一次再开就会重弹一遍，同一件事提醒 N 次等于骚扰。
 */
const reportedMissing = new Set()
</script>

<script setup>
/**
 * 本地素材库侧栏（v0.5.0 M1）。
 *
 * 只做「给人看的元数据」：搜索、标签、收藏、归档/恢复。列表只展示已收藏的
 * library 原件；工程内未收藏图片的「加入素材库」入口在父组件的图层行上
 * （2026-10 去重：同一张图不再同时出现在「图层」「当前工程的图」「素材库」三处）。
 * 原件永远从 design-assets 读，缩略图只是列表缓存（缺了也能用原件兜底）。
 * 点击素材时把 assetId 交给父组件，由它做「会话保护 + 一次性撤销」的入画板，
 * 本组件不碰 design / commit，避免两边撤销栈打架。
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { toUserMessage } from '../../electron/user-error.cjs'

const emit = defineEmits(['insert', 'error'])

const pp = window.printpress
const mediaUrl = (relative) =>
  relative ? `pp://media/${String(relative).split('/').map(encodeURIComponent).join('/')}` : ''

const items = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(60)
const allTags = ref([])
const query = ref('')
const activeTags = ref([])
const favoriteOnly = ref(false)
const includeArchived = ref(false)
const loading = ref(false)
const error = ref('')
const editing = reactive({ id: null, name: '', tags: '' })

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const hasFilters = computed(
  () => !!query.value.trim() || activeTags.value.length || favoriteOnly.value || includeArchived.value,
)

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const res = await pp.listAssets({
      query: query.value.trim() || undefined,
      tags: activeTags.value.length ? activeTags.value : undefined,
      favoriteOnly: favoriteOnly.value || undefined,
      includeArchived: includeArchived.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    })
    items.value = res.items || []
    total.value = res.total || 0
    page.value = res.page || 1
    pageSize.value = res.pageSize || pageSize.value
    noteMissing(res.missing)
  } catch (err) {
    error.value = toUserMessage(err)
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function refreshTags() {
  try {
    allTags.value = await pp.listAssetTags()
  } catch {
    allTags.value = []
  }
}

// 缩略图缺失（纯 Node 入库 / 缓存被清 / 生成失败）时，**直接让 pp://media 服务原件**：
// 主进程的 pp 协议认得 `asset_<sha256>`，会解析成 design-assets 里的真实文件，
// 不用再往渲染层搬一次路径，也不必为每张图多打一次 IPC。
// 缩略图文件本身坏掉（被清缓存）也走同一条退路；连原件都读不出才落回「图」占位。
const brokenThumbs = reactive({})    // assetId → 缩略图加载失败，改用原件
const brokenOriginals = reactive({}) // assetId → 原件也读不出，落回占位

function thumbUrl(item) {
  if (brokenOriginals[item.assetId]) return ''
  if (item.thumbFile && !brokenThumbs[item.assetId]) return mediaUrl(item.thumbFile)
  return mediaUrl(item.assetId)
}
function onThumbError(item) {
  if (item.thumbFile && !brokenThumbs[item.assetId]) { brokenThumbs[item.assetId] = true; return }
  brokenOriginals[item.assetId] = true
}

// 原件已被删除的条目：后端已把它们挡在列表外，这里只负责把「发生过什么」告诉用户。
const missingNotice = ref([])
function noteMissing(list) {
  const fresh = (Array.isArray(list) ? list : []).filter((m) => m && m.assetId && !reportedMissing.has(m.assetId))
  if (!fresh.length) return
  for (const m of fresh) reportedMissing.add(m.assetId)
  missingNotice.value = missingNotice.value.concat(fresh)
}
function dismissMissing() {
  missingNotice.value = []
}

function resetPage() {
  page.value = 1
}
function onSearch() {
  resetPage()
  refresh()
}
function toggleTag(tag) {
  const i = activeTags.value.indexOf(tag)
  if (i >= 0) activeTags.value.splice(i, 1)
  else activeTags.value.push(tag)
  resetPage()
  refresh()
}
function toggleFavorite() {
  favoriteOnly.value = !favoriteOnly.value
  resetPage()
  refresh()
}
function toggleArchived() {
  includeArchived.value = !includeArchived.value
  resetPage()
  refresh()
}
function prevPage() {
  if (page.value > 1) {
    page.value--
    refresh()
  }
}
function nextPage() {
  if (page.value < totalPages.value) {
    page.value++
    refresh()
  }
}

async function importDialog() {
  error.value = ''
  try {
    const res = await pp.importAssetDialog()
    if (res && !res.canceled) {
      await refreshTags()
      await refresh()
    }
  } catch (err) {
    error.value = toUserMessage(err)
  }
}

// 打开素材库原件文件夹（design-assets/）：路径由主进程按数据目录推导，
// 前端只发「打开」这件事本身——`shell.openPath` 会启动系统程序，不让渲染层传路径（I-28）。
async function openFolder() {
  error.value = ''
  try {
    await pp.openAssetFolder()
  } catch (err) {
    error.value = toUserMessage(err)
  }
}

// 点击素材 → 交给父组件做会话保护 + 入画板（一次性撤销）
function pick(item) {
  emit('insert', item.assetId)
}

async function toggleFavoriteItem(item) {
  try {
    await pp.updateAsset(item.assetId, { favorite: !item.favorite })
    await refresh()
  } catch (err) {
    error.value = toUserMessage(err)
  }
}
async function archiveItem(item) {
  try {
    await pp.archiveAsset(item.assetId)
    await refresh()
  } catch (err) {
    error.value = toUserMessage(err)
  }
}
async function restoreItem(item) {
  try {
    await pp.restoreAsset(item.assetId)
    await refresh()
  } catch (err) {
    error.value = toUserMessage(err)
  }
}

function startEdit(item) {
  editing.id = item.assetId
  editing.name = item.displayName || ''
  editing.tags = (item.tags || []).join('、')
}
function cancelEdit() {
  editing.id = null
  editing.name = ''
  editing.tags = ''
}
async function saveEdit(item) {
  const tags = editing.tags
    .split(/[、,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  try {
    await pp.updateAsset(item.assetId, { displayName: editing.name.trim() || item.displayName, tags })
    cancelEdit()
    await refresh()
  } catch (err) {
    error.value = toUserMessage(err)
  }
}

// 清理未引用原件（I-32）：先列出既不在工程、也不在素材库的孤立原件，确认后才删
const orphans = ref(null) // null=未扫描；{ items:[{hash,bytes}], bytes }=扫描结果
const purgePending = ref(false)
async function scanOrphans() {
  error.value = ''
  try {
    const items = (await pp.listAssetOrphans()) || []
    orphans.value = { items, bytes: items.reduce((s, i) => s + (i.bytes || 0), 0) }
    if (!items.length) {
      error.value = '没有未引用的原件，无需清理。'
      return
    }
    purgePending.value = true
  } catch (err) {
    error.value = toUserMessage(err)
  }
}
async function confirmPurge() {
  if (!orphans.value?.items.length) return
  const hashes = orphans.value.items.map((i) => i.hash)
  try {
    const res = await pp.purgeAssetOrphans(hashes)
    purgePending.value = false
    orphans.value = null
    await refresh()
    error.value = `已清理 ${res.removed} 个孤立原件${res.kept ? `，${res.kept} 个因已被引用而跳过` : ''}。`
  } catch (err) {
    error.value = toUserMessage(err)
    purgePending.value = false
  }
}
function cancelPurge() {
  purgePending.value = false
  orphans.value = null
}

onMounted(() => {
  refreshTags()
  refresh()
})
</script>

<template>
  <aside class="designer-panel asset-library" data-testid="asset-library">
    <h3>素材库 <span>{{ total }}</span></h3>

    <div class="asset-actions">
      <button data-testid="asset-import" :disabled="loading" @click="importDialog">＋ 导入图片</button>
      <button data-testid="asset-cleanup" :disabled="loading" title="扫描并清理不被任何工程或素材库引用的孤立原件" @click="scanOrphans">清理未引用</button>
      <button data-testid="asset-reset-filter" v-if="hasFilters" @click="() => { query=''; activeTags=[]; favoriteOnly=false; includeArchived=false; resetPage(); refresh() }">清除筛选</button>
      <button class="asset-open-folder" data-testid="asset-open-folder" :disabled="loading" title="在系统文件管理器里打开素材库原件所在的文件夹" @click="openFolder">打开素材库文件夹</button>
    </div>

    <input
      class="asset-search"
      data-testid="asset-search"
      type="search"
      placeholder="搜名称 / 标签"
      v-model="query"
      @input="onSearch"
    />

    <div class="asset-filters" v-if="allTags.length || true">
      <button class="chip" :class="{ on: favoriteOnly }" data-testid="asset-fav-filter" @click="toggleFavorite">★ 收藏</button>
      <button class="chip" :class="{ on: includeArchived }" data-testid="asset-archived-filter" @click="toggleArchived">含归档</button>
      <button
        v-for="t in allTags"
        :key="t.tag"
        class="chip"
        :class="{ on: activeTags.includes(t.tag) }"
        :data-testid="`asset-tag-${t.tag}`"
        :title="`${t.count} 个素材`"
        @click="toggleTag(t.tag)"
      >{{ t.tag }}</button>
    </div>

    <p v-if="error" class="asset-error" data-testid="asset-error">{{ error }}</p>
    <div v-if="purgePending && orphans?.items.length" class="asset-purge" data-testid="asset-purge">
      <p>将删除 <b>{{ orphans.items.length }}</b> 个不被任何工程或素材库引用的孤立原件，释放约 {{ (orphans.bytes / 1048576).toFixed(1) }} MB。<b>此操作不可恢复。</b></p>
      <div class="asset-purge-actions">
        <button data-testid="asset-purge-confirm" @click="confirmPurge">确认清理</button>
        <button data-testid="asset-purge-cancel" @click="cancelPurge">取消</button>
      </div>
    </div>
    <p v-if="loading" class="muted">读取素材库中…</p>
    <p v-else-if="!items.length" class="muted">还没有素材。点「导入图片」收常用图；工程里粘贴的图在图层行上点「＋」即可加入。</p>

    <div class="asset-list" v-else>
      <div
        v-for="item in items"
        :key="item.assetId"
        class="asset-card"
        :class="{ archived: !!item.archivedAt }"
        :data-testid="`asset-card-${item.assetId}`"
        @click="pick(item)"
      >
        <div class="asset-thumb">
          <img
            v-if="thumbUrl(item)"
            :src="thumbUrl(item)"
            :alt="item.displayName"
            loading="lazy"
            @error="onThumbError(item)"
          />
          <span v-else class="asset-thumb-ph">图</span>
        </div>
        <div class="asset-meta">
          <b class="asset-name" :title="item.displayName">{{ item.displayName }}</b>
          <small class="asset-tags" v-if="item.tags?.length">{{ item.tags.join('、') }}</small>
          <small class="asset-sub" v-if="item.archivedAt">已归档</small>
        </div>
        <div class="asset-card-actions" @click.stop>
          <button class="icon-button" :class="{ on: item.favorite }" :data-testid="`asset-fav-${item.assetId}`" :title="item.favorite ? '取消收藏' : '收藏'" @click="toggleFavoriteItem(item)">{{ item.favorite ? '★' : '☆' }}</button>
          <button class="icon-button" :data-testid="`asset-edit-${item.assetId}`" title="改名 / 改标签" @click="startEdit(item)">✎</button>
          <button class="icon-button" v-if="!item.archivedAt" :data-testid="`asset-archive-${item.assetId}`" title="归档（隐藏，不删原件）" @click="archiveItem(item)">⊘</button>
          <button class="icon-button" v-else :data-testid="`asset-restore-${item.assetId}`" title="恢复显示" @click="restoreItem(item)">↺</button>
        </div>

        <div class="asset-edit" v-if="editing.id === item.assetId" @click.stop>
          <label>名称<input data-testid="asset-edit-name" v-model="editing.name" maxlength="80" /></label>
          <label>标签<input data-testid="asset-edit-tags" v-model="editing.tags" placeholder="用、或空格分隔" /></label>
          <div class="asset-edit-actions">
            <button data-testid="asset-edit-save" @click="saveEdit(item)">保存</button>
            <button @click="cancelEdit">取消</button>
          </div>
        </div>
      </div>
    </div>

    <div class="asset-pager" v-if="totalPages > 1">
      <button :disabled="page <= 1" data-testid="asset-prev" @click="prevPage">上一页</button>
      <span class="muted">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" data-testid="asset-next" @click="nextPage">下一页</button>
    </div>

    <!-- 原件已被删除：告诉用户发生了什么，列表里对应的条目已经不渲染了 -->
    <div v-if="missingNotice.length" class="asset-missing-mask" @click.self="dismissMissing">
      <div class="asset-missing-box" role="alertdialog" aria-labelledby="asset-missing-title" data-testid="asset-missing-dialog">
        <h4 id="asset-missing-title" class="asset-missing-title">素材文件已被删除</h4>
        <p class="asset-missing-lead">
          以下素材的原文件已不在磁盘上，无法再插入画布，已从列表中隐藏：
        </p>
        <ul class="asset-missing-list">
          <li v-for="m in missingNotice" :key="m.assetId">{{ m.displayName }}</li>
        </ul>
        <p class="asset-missing-hint">如需继续使用，请重新导入这些图片。</p>
        <div class="asset-missing-actions">
          <button data-testid="asset-missing-ok" @click="dismissMissing">知道了</button>
        </div>
      </div>
    </div>

  </aside>
</template>

<style scoped>
.asset-library { display: flex; flex-direction: column; gap: 8px; }
.asset-actions { display: flex; gap: 7px; flex-wrap: wrap; }
.asset-actions button { flex: 1; font-size: 12px; padding: 7px 4px; }
/* 「打开素材库文件夹」独占一行全宽：256px 侧栏里 4 个按钮并排会把文字挤成两行 */
.asset-actions .asset-open-folder { flex: 1 1 100%; }
.asset-search { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: var(--ink); font-size: 13px; }
.asset-filters { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { font-size: 11px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper); color: var(--ink-2); cursor: pointer; }
.chip.on { border-color: var(--cinnabar); color: var(--cinnabar); background: var(--paper-card); }
.asset-error { color: var(--warn); font-size: 11px; }
.asset-purge { border: 1px solid var(--warn-line); background: var(--warn-soft); border-radius: 7px; padding: 9px; }
.asset-purge p { font-size: 11px; line-height: 1.6; margin: 0 0 8px; color: var(--ink-2); }
.asset-purge-actions { display: flex; gap: 7px; }
.asset-purge-actions button { flex: 1; font-size: 12px; padding: 6px; }
.asset-purge-actions button:first-child { border-color: var(--warn); color: var(--warn); background: var(--paper-card); }
.asset-list { display: flex; flex-direction: column; gap: 7px; max-height: calc(100vh - 360px); overflow: auto; }
.asset-card { display: grid; grid-template-columns: 46px 1fr auto; grid-template-areas: 'thumb meta actions' 'edit edit edit'; gap: 6px 8px; align-items: center; padding: 7px; border: 1px solid var(--line); border-radius: 7px; background: var(--paper); cursor: pointer; }
.asset-card.archived { opacity: 0.6; }
.asset-thumb { grid-area: thumb; width: 46px; height: 46px; border-radius: 5px; overflow: hidden; background: var(--paper-card); display: flex; align-items: center; justify-content: center; }
.asset-thumb img { width: 100%; height: 100%; object-fit: cover; }
.asset-thumb-ph { color: var(--stone); font-size: 16px; }
.asset-meta { grid-area: meta; min-width: 0; }
.asset-name { display: block; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-tags { display: block; font-size: 10px; color: var(--stone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-sub { display: block; font-size: 10px; color: var(--warn); }
/* 行内操作按钮 hover 才显示：平时只留缩略图 + 名称，降噪；归档件常显（要能看到「恢复」） */
.asset-card-actions { grid-area: actions; display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s; }
.asset-card:hover .asset-card-actions,
.asset-card:focus-within .asset-card-actions,
.asset-card.archived .asset-card-actions { opacity: 1; }
.asset-card-actions .icon-button.on { color: var(--cinnabar); }
.asset-edit { grid-area: edit; display: flex; flex-direction: column; gap: 5px; border-top: 1px solid var(--line); padding-top: 7px; }
.asset-edit label { display: flex; flex-direction: column; font-size: 10px; color: var(--stone); gap: 2px; }
.asset-edit input { padding: 5px 7px; border: 1px solid var(--line); border-radius: 5px; background: var(--paper); color: var(--ink); font-size: 12px; }
.asset-edit-actions { display: flex; gap: 6px; }
.asset-edit-actions button { flex: 1; font-size: 11px; padding: 5px; }
.asset-pager { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.asset-pager button { font-size: 11px; padding: 5px 9px; }
/* 「原件已被删除」提示弹窗（与 ConfirmDialog 同调的宣纸墨韵）。
   整体下移到画布工具栏那一行（撤销 / 重做 / 上移 / 下移 / 置顶 / 置底）下方：原本垂直居中，
   窗口一矮（≲720px）弹窗顶部就压到那排按钮上。给遮罩留出上方 216px 再居中 ⇒ 顶部始终 ≥216px
   （工具栏底 ≈211px）；弹窗比可用空间还高时改为滚动，也不会顶到按钮上。 */
.asset-missing-mask { position: fixed; inset: 0; background: rgba(30, 26, 20, 0.45); display: flex; align-items: center; justify-content: center; padding: 216px 20px 24px; overflow: auto; z-index: 120; }
.asset-missing-box { width: 380px; max-width: calc(100vw - 40px); background: var(--paper-card); border: 1px solid var(--line-strong); border-radius: 10px; padding: 18px 20px; box-shadow: 0 8px 28px rgba(30, 26, 20, 0.18); }
.asset-missing-title { margin: 0 0 8px; font-size: 15px; color: var(--cinnabar); }
.asset-missing-lead { margin: 0 0 8px; font-size: 13px; line-height: 1.7; color: var(--ink-2); }
.asset-missing-list { margin: 0 0 8px; padding-left: 18px; max-height: 180px; overflow: auto; font-size: 12px; line-height: 1.8; color: var(--ink); }
.asset-missing-hint { margin: 0 0 14px; font-size: 12px; color: var(--stone); }
.asset-missing-actions { display: flex; justify-content: flex-end; }
.asset-missing-actions button { padding: 6px 16px; font-size: 13px; border: 1px solid var(--line-strong); border-radius: 6px; background: transparent; color: var(--ink); cursor: pointer; }
.asset-missing-actions button:hover { background: var(--cinnabar-soft); }
</style>

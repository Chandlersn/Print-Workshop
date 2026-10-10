<script setup>
/**
 * 应用外壳：顶部品牌栏 + 三页导航。
 * 三页规模足够小，用组件切换而非 vue-router，少一层依赖。
 */
import { ref, computed, watch, onMounted } from 'vue'
import DatasetView from './views/DatasetView.vue'
import TemplateView from './views/TemplateView.vue'
import PrintCenterView from './views/PrintCenterView.vue'
import BackgroundDesignerView from './views/BackgroundDesignerView.vue'
import GuideDialog from './components/GuideDialog.vue'
import { cellNav } from './lib/cell-nav.js'
import { designerNav } from './lib/designer-nav.js'

const TABS = [
  { id: 'dataset', label: '数据', hint: '导入名单' },
  { id: 'designer', label: '底图制作', hint: '编辑图片与图层' },
  { id: 'template', label: '模板', hint: '设计版式' },
  { id: 'print', label: '打印中心', hint: '批量出片' },
]

const activeTab = ref('dataset')
const env = ref(null)
const theme = ref('light')

watch(() => designerNav.request, (request) => { if (request) activeTab.value = 'designer' })
watch(() => designerNav.result, (result) => { if (result) activeTab.value = 'template' })

// 去补录直达：打印中心校验弹窗点单元格 → 切到数据页（DatasetView 自行消费 cellNav.req）
watch(cellNav, (r) => {
  if (r && r.req) activeTab.value = 'dataset'
})

// 数据目录自定义：迁移结果与重启确认
const dataDirMsg = ref('')
const dataDirError = ref('')
const showRestart = ref(false)
const pendingReset = ref(false)

async function onChangeDataDir() {
  dataDirError.value = ''
  try {
    const r = await window.printpress.changeDataDir()
    if (r.canceled) return
    pendingReset.value = false
    showRestart.value = true
  } catch (err) {
    dataDirError.value = err.message || String(err)
  }
}

async function onResetDataDir() {
  dataDirError.value = ''
  try {
    await window.printpress.resetDataDir()
    pendingReset.value = true
    showRestart.value = true
  } catch (err) {
    dataDirError.value = err.message || String(err)
  }
}

async function onRelaunch() {
  try { await window.printpress.relaunchApp() } catch { /* 交给用户手动重启 */ }
}

async function onOpenDataDir() {
  dataDirError.value = ''
  try { await window.printpress.openDataDir() } catch (err) {
    dataDirError.value = err.message || String(err)
  }
}

// 首启三步引导
const showOnboarding = ref(false)
const onboardStep = ref(0)
const ONBOARD_STEPS = [
  { title: '第一步 · 导入名单', desc: '在「数据」页导入 Excel 或 CSV 文件，自动识别 UTF-8 / GBK 编码，字段目录从真实数据派生。' },
  { title: '第二步 · 设计模板', desc: '在「模板」页上传底图，拖拽字段到画布排版（吸附对齐、多选、撤销重做）；固定标题与边框可在「底图制作」里做成图层再引用。' },
  { title: '第三步 · 批量出片', desc: '在「打印中心」选择数据与模板，一键导出 PDF 或直接打印；打印前自动检查空值，历史可回溯。' },
]

function applyTheme(t) {
  theme.value = t
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : ''
}

function toggleTheme() {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  persistSettings({ theme: next })
}

async function persistSettings(patch) {
  try {
    const cur = await window.printpress.loadData('settings') || {}
    // license 为对外产品化预留的授权字段位，当前仅占位
    await window.printpress.saveData('settings', {
      ...cur, license: cur.license || null, ...patch,
    })
  } catch { /* 设置持久化失败不阻塞交互 */ }
}

function nextOnboardStep() {
  if (onboardStep.value < ONBOARD_STEPS.length - 1) {
    onboardStep.value++
  } else {
    showOnboarding.value = false
    persistSettings({ onboarded: true })
  }
}

function skipOnboarding() {
  showOnboarding.value = false
  persistSettings({ onboarded: true })
}

// 版本与更新：meta 来自主进程（URL 单一权威源在 electron/version-check.cjs）；
// 启动自动检测结果经 onUpdateAvailable 推送；「关于」里可手动检查（卡点可见）
const meta = ref(null)
const updateInfo = ref(null)
const showAbout = ref(false)
const showGuide = ref(false)
const checkState = ref('') // '' | checking | newer | current | unavailable
const foundVersion = ref('')

/**
 * 应用内更新（下载 + 安装）的实时状态，由主进程推送。
 *
 * 为什么需要它：早先「检查更新」只做轻量信标检测（version-check 读 latest.json），
 * 命中新版只画一个红徽标，**没有任何路径能开始下载**；真下载只发生在启动那一次。
 * 于是用户点完按钮看到「发现新版本」却什么都不动，看起来就像功能坏了。
 * 现在按钮会真正调 startUpdate()，并按下面的阶段如实显示进度与失败原因——
 * 失败再也不能只进 console（打包态没有控制台，等于把失败藏起来）。
 */
const updateState = ref({ phase: 'idle' })
const updateBusy = ref(false)
const updateMsg = ref('')

const updatePhase = computed(() => (updateState.value && updateState.value.phase) || 'idle')

const updatePhaseText = computed(() => {
  const s = updateState.value || {}
  switch (s.phase) {
    case 'checking': return '正在检测更新…'
    case 'available': return `发现新版本 v${s.version || ''}，准备下载`
    case 'downloading': return `正在后台下载 ${s.percent || 0}%`
    case 'downloaded': return `v${s.version || ''} 已下载完成，重启即可安装`
    case 'none': return '已是最新'
    default: return ''
  }
})

/** 有话说时才占一行：正在检测 / 有新版本 / 下载中 / 已下载 / 失败 / 不支持应用内更新 */
const updateRowVisible = computed(() => {
  const p = updatePhase.value
  return p === 'checking' || p === 'available' || p === 'downloading' || p === 'downloaded'
    || p === 'error' || Boolean(updateMsg.value)
})

async function onCheckUpdate() {
  checkState.value = 'checking'
  updateMsg.value = ''
  try {
    const r = await window.printpress.checkUpdate()
    if (r.status === 'newer') {
      foundVersion.value = r.info.version
      updateInfo.value = r.info
      checkState.value = 'newer'
      // 信标说「有新版本」还不够——必须真正触发更新器，否则就是「点了没反应」
      await startRealUpdate()
    } else if (r.status === 'current') {
      checkState.value = 'current'
    } else {
      checkState.value = 'unavailable'
    }
  } catch {
    checkState.value = 'unavailable'
  }
}

/** 真正开始后台下载。拿不到更新器时说清原因（并保留「前往发布页」这条出路）。 */
async function startRealUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  try {
    const r = (await window.printpress.startUpdate()) || {}
    if (!r.started) updateMsg.value = r.reason || '当前环境不支持应用内更新'
  } catch (err) {
    updateMsg.value = '无法启动更新：' + (err && err.message ? err.message : err)
  } finally {
    updateBusy.value = false
  }
}

/** 下载完成后重启安装（由主进程 quitAndInstall） */
async function onInstallUpdate() {
  try {
    const r = (await window.printpress.installUpdate()) || {}
    if (!r.ok) updateMsg.value = r.reason || '现在还不能安装更新'
  } catch (err) {
    updateMsg.value = '安装失败：' + (err && err.message ? err.message : err)
  }
}

// 系统缓存：大小查询 + 一键释放（显示与按钮二合一）
// cacheOk 区分「真的是 0」与「查询失败」：两者都让cacheSize=0，
// 但语义相反——失败时显示「已无可清理缓存」是把故障说成了成功。
const cacheSize = ref(0)
const cacheOk = ref(true)
const clearingCache = ref(false)
const cacheMsg = ref('')      // 点击后的结果文案（含「下次启动清」的如实交代）
const cacheMsgFail = ref(false)

function fmtCacheSize(bytes) {
  if (!bytes || bytes < 1024) return '0 KB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function openAbout() {
  showAbout.value = true
  cacheMsg.value = ''
  refreshCacheInfo()
}

async function refreshCacheInfo() {
  try {
    const r = await window.printpress.getCacheInfo()
    cacheSize.value = r && r.size ? r.size : 0
    cacheOk.value = true
  } catch {
    cacheSize.value = 0
    cacheOk.value = false
  }
}

/**
 * 清理缓存。
 *
 * 运行中的 GPUCache / DawnCache 删不掉（Chromium 自己持有，EPERM），
 * 主进程会把它们排队到下次启动清。所以这里必须**把结果说出来**：
 * 以前主进程 `catch {}` 静默吞掉、界面又没有任何反馈，用户点了就是「没反应」。
 */
async function onClearCache() {
  if (clearingCache.value) return
  clearingCache.value = true
  cacheMsg.value = ''
  cacheMsgFail.value = false
  try {
    const r = (await window.printpress.clearCache()) || {}
    const parts = []
    // 不足 1KB 不单独报——Chromium 的 Cache 目录里常年只有几十字节的索引文件，
    // 报一句「已清理 0 KB」纯属噪音，真正要说的在下一句。
    if (r.freed >= 1024) parts.push(`已清理 ${fmtCacheSize(r.freed)}`)
    const queued = Array.isArray(r.queued) ? r.queued : []
    if (queued.length) {
      const left = (r.failed || []).reduce((n, f) => n + (f.size || 0), 0)
      parts.push(`${fmtCacheSize(left)} 正被系统占用，将在下次启动时清理`)
    }
    if (!parts.length) parts.push('已无可清理缓存')
    cacheMsg.value = parts.join('；')
    await refreshCacheInfo()
  } catch (err) {
    cacheMsgFail.value = true
    cacheMsg.value = '清理失败：' + (err && err.message ? err.message : err)
  } finally {
    clearingCache.value = false
  }
}

onMounted(async () => {
  try {
    const settings = await window.printpress.loadData('settings') || {}
    applyTheme(settings.theme === 'dark' ? 'dark' : 'light')
    if (!settings.onboarded) showOnboarding.value = true
  } catch { applyTheme('light') }
  try {
    env.value = await window.printpress.getEnv()
  } catch (err) {
    env.value = { error: String(err) }
  }
  try { meta.value = await window.printpress.getAppMeta() } catch { /* 元信息失败不阻塞 */ }
  try {
    window.printpress.onUpdateAvailable((info) => { updateInfo.value = info })
  } catch { /* 订阅失败仅影响自动提醒，手动检查仍可用 */ }
  try {
    // 订阅应用内更新的阶段变化：启动时那次自动下载、以及「检查更新」触发的下载，
    // 进度与失败原因都经这里进界面（订阅一次，整个会话有效）
    window.printpress.onUpdateState((s) => { updateState.value = s || { phase: 'idle' } })
  } catch { /* 订阅失败仅影响进度显示，按钮仍可用 */ }
})
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-seal">批印坊</span>
        <span class="brand-sub">本地离线批量打印</span>
      </div>
      <nav class="app-nav">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="nav-item"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <span class="nav-label">{{ tab.label }}</span>
          <span class="nav-hint">{{ tab.hint }}</span>
        </button>
      </nav>
      <span class="tb-spacer"></span>
      <button class="theme-toggle" :title="theme === 'dark' ? '切换浅色' : '切换深色'" @click="toggleTheme">
        {{ theme === 'dark' ? '浅色' : '深色' }}
      </button>
      <button class="theme-toggle" @click="showGuide = true">说明</button>
      <button class="theme-toggle" @click="openAbout">关于</button>
    </header>

    <!-- 新版本横幅：启动检测到远程版本更大时出现。可一键更新（真下载 + 下载完成后重启安装），
         也可去发布页手动下载；下载进度与失败原因就地显示，不再「点了没反应」 -->
    <div v-if="updateInfo" class="update-bar">
      <span class="ub-text">
        新版本 <b>v{{ updateInfo.version }}</b> 已发布{{ updateInfo.notes ? '：' + updateInfo.notes : '' }}
      </span>
      <span v-if="updatePhaseText" class="ub-state">{{ updatePhaseText }}</span>
      <span v-else-if="updateMsg" class="ub-state">{{ updateMsg }}</span>
      <button
        v-if="updatePhase === 'downloaded'"
        class="ub-action"
        @click="onInstallUpdate"
      >立即重启安装</button>
      <button
        v-else-if="updatePhase !== 'checking' && updatePhase !== 'downloading'"
        class="ub-action"
        :disabled="updateBusy"
        @click="startRealUpdate"
      >立即更新</button>
      <a
        class="ub-link"
        :href="updateInfo.url || (meta && meta.releasesUrl) || '#'"
        target="_blank"
      >前往发布页</a>
      <button class="ub-close" @click="updateInfo = null">知道了</button>
    </div>

    <main class="app-main">
      <KeepAlive include="TemplateView,BackgroundDesignerView">
        <DatasetView v-if="activeTab === 'dataset'" />
        <TemplateView v-else-if="activeTab === 'template'" />
        <BackgroundDesignerView v-else-if="activeTab === 'designer'" />
        <PrintCenterView v-else />
      </KeepAlive>
    </main>

    <!-- 首启三步引导 -->
    <div v-if="showOnboarding" class="onboard-mask">
      <div class="onboard">
        <div class="onboard-dots">
          <span
            v-for="(s, i) in ONBOARD_STEPS"
            :key="i"
            class="dot"
            :class="{ active: i === onboardStep }"
          ></span>
        </div>
        <h3 class="onboard-title">{{ ONBOARD_STEPS[onboardStep].title }}</h3>
        <p class="onboard-desc">{{ ONBOARD_STEPS[onboardStep].desc }}</p>
        <p class="onboard-note">已为你准备了 7 套示例模板和示例名单，可直接体验</p>
        <div class="onboard-actions">
          <button class="onboard-skip" @click="skipOnboarding">跳过</button>
          <button class="onboard-next" @click="nextOnboardStep">
            {{ onboardStep < ONBOARD_STEPS.length - 1 ? '下一步' : '开始使用' }}
          </button>
        </div>
      </div>
    </div>

    <footer class="app-footer">
      <span v-if="env && env.dataDir" class="footer-meta">
        数据目录：{{ env.dataDir }}
        <span v-if="env.dataDirCustom" class="footer-badge">自定义</span>
      </span>
      <span v-else-if="env && env.error" class="footer-meta footer-error">IPC 未连通：{{ env.error }}</span>
      <span class="tb-spacer"></span>
      <span v-if="dataDirError" class="footer-error">{{ dataDirError }}</span>
      <button v-if="env && env.dataDir" class="footer-btn" @click="onOpenDataDir">打开目录</button>
      <button v-if="env && env.dataDir" class="footer-btn" @click="onChangeDataDir">更改…</button>
      <button v-if="env && env.dataDirCustom" class="footer-btn" @click="onResetDataDir">恢复默认</button>
    </footer>

    <!-- 关于：版本 / 检查更新 / 下载与反馈出口 -->
    <div v-if="showAbout" class="onboard-mask" @click.self="showAbout = false">
      <div class="onboard about">
        <h3 class="onboard-title">关于批印坊</h3>
        <p class="onboard-desc">本地离线批量打印工具 · 名单导入 → 模板设计 → 批量出片 → 留痕归档，数据全程不出本机。</p>
        <div class="about-rows">
          <div class="about-row">
            <span class="ar-label">当前版本</span>
            <b class="ar-value">v{{ meta ? meta.version : '…' }}</b>
          </div>
          <div class="about-row">
            <span class="ar-label">检查更新</span>
            <span class="ar-value check-group">
              <button class="footer-btn" :disabled="checkState === 'checking' || updateBusy" @click="onCheckUpdate">
                {{ checkState === 'checking' ? '检测中…' : '检查更新' }}
              </button>
              <span v-if="checkState === 'newer'" class="cr cr-new">发现新版本 v{{ foundVersion }}</span>
              <span v-else-if="checkState === 'current'" class="cr cr-ok">已是最新</span>
              <span v-else-if="checkState === 'unavailable'" class="cr cr-fail">检测失败（离线或网络受限）</span>
            </span>
          </div>
          <!-- 更新进度：下载状态与失败原因都必须看得见（早先只进 console，打包态等于藏起来） -->
          <div v-if="updateRowVisible" class="about-row">
            <span class="ar-label">更新进度</span>
            <span class="ar-value check-group">
              <span v-if="updatePhase === 'error'" class="cr cr-fail">更新失败：{{ updateState.message || '未知原因' }}</span>
              <span v-else-if="updateMsg" class="cr cr-warn">{{ updateMsg }}</span>
              <span v-else-if="updatePhaseText" class="cr" :class="updatePhase === 'downloaded' ? 'cr-ok' : 'cr-new'">{{ updatePhaseText }}</span>
              <button v-if="updatePhase === 'downloaded'" class="footer-btn" @click="onInstallUpdate">立即重启安装</button>
            </span>
          </div>
          <div class="about-row">
            <span class="ar-label">系统缓存</span>
            <span class="ar-value check-group">
              <button class="footer-btn" :disabled="clearingCache || (cacheOk && cacheSize === 0)" @click="onClearCache">
                {{ clearingCache ? '清理中…' : '清理缓存（' + fmtCacheSize(cacheSize) + '）' }}
              </button>
              <span v-if="!clearingCache && !cacheOk" class="cr cr-fail">缓存大小读取失败</span>
              <span v-else-if="!clearingCache && cacheMsg" class="cr" :class="cacheMsgFail ? 'cr-fail' : 'cr-warn'">{{ cacheMsg }}</span>
              <span v-else-if="!clearingCache && cacheSize === 0" class="cr cr-ok">已无可清理缓存</span>
            </span>
          </div>
          <div class="about-row">
            <span class="ar-label">下载 / 更新</span>
            <a v-if="meta && meta.releasesUrl" class="ar-link" :href="meta.releasesUrl" target="_blank">前往发布页</a>
          </div>
          <div class="about-row">
            <span class="ar-label">问题反馈</span>
            <a v-if="meta && meta.feedbackUrl" class="ar-link" :href="meta.feedbackUrl" target="_blank">提交反馈</a>
          </div>
          <div class="about-row">
            <span class="ar-label">开源协议</span>
            <span class="ar-value">MIT</span>
          </div>
        </div>
        <div class="onboard-actions">
          <span class="onboard-note">更新检测仅读取仓库中的版本号文件，不收集任何本机数据</span>
          <button class="footer-btn" @click="showAbout = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 应用内使用说明 -->
    <GuideDialog v-if="showGuide" @close="showGuide = false" />

    <!-- 数据目录迁移后的重启确认 -->
    <div v-if="showRestart" class="onboard-mask">
      <div class="onboard">
        <h3 class="onboard-title">{{ pendingReset ? '将恢复默认数据目录' : '数据已迁移到新目录' }}</h3>
        <p class="onboard-desc">
          {{
            pendingReset
              ? '重启后数据将从默认位置读取（自定义目录中的现有数据保留不动）。'
              : '现有数据已完整复制到新目录，重启后生效。原目录中的数据保留不动，可作为备份。'
          }}
        </p>
        <div class="onboard-actions">
          <button class="onboard-skip" @click="showRestart = false">稍后手动重启</button>
          <button class="onboard-next" @click="onRelaunch">立即重启</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--paper-card);
}

.tb-spacer { flex: 1; }

.theme-toggle {
  padding: 5px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink-2);
  font-size: 12px;
}

.theme-toggle:hover {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
}

/* 新版本横幅 */
.update-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 7px 24px;
  background: var(--cinnabar-soft);
  border-bottom: 1px solid var(--cinnabar);
  font-size: 13px;
}

.ub-text {
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ub-link {
  flex-shrink: 0;
  color: var(--cinnabar);
  text-decoration: underline;
}

.ub-state { flex-shrink: 0; color: var(--ink-2); }

/* 横幅里的动作按钮：与「前往发布页」区分开——那是真下载，这是外部链接 */
.ub-action {
  flex-shrink: 0;
  padding: 2px 12px;
  border: 1px solid var(--cinnabar);
  border-radius: 5px;
  background: var(--paper-card);
  color: var(--cinnabar);
  font-size: 12px;
}

.ub-action:disabled { opacity: 0.6; }

.ub-close {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: var(--paper-card);
  color: var(--ink-2);
  font-size: 12px;
}

.ub-close:hover { color: var(--cinnabar); border-color: var(--cinnabar); }

/* 关于弹窗 */
.about { width: 460px; }

.about-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 6px 0 20px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper);
}

.about-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ar-label { font-size: 13px; color: var(--stone); }

.ar-value { font-size: 13px; color: var(--ink); }

.ar-link { font-size: 13px; color: var(--cinnabar); text-decoration: underline; }

.check-group { display: flex; align-items: center; gap: 10px; }

.cr { font-size: 12px; }
.cr-ok { color: var(--ink-2); }
.cr-new { color: var(--cinnabar); font-weight: 600; }
.cr-fail { color: var(--stone); }
/* 「当场清不掉、排到下次启动」这类需要用户知情的中间态 */
.cr-warn { color: var(--warn); }

.onboard-actions .onboard-note { margin: 0; }

.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand-seal {
  font-size: 20px;
  font-weight: 700;
  color: var(--cinnabar);
  letter-spacing: 2px;
}

.brand-sub {
  font-size: 12px;
  color: var(--ink-2);
}

.app-nav {
  display: flex;
  gap: 8px;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-2);
}

.nav-item:hover {
  border-color: var(--line);
  background: var(--paper);
}

.nav-item.active {
  border-color: var(--cinnabar);
  background: var(--cinnabar-soft);
}

.nav-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.nav-item.active .nav-label {
  color: var(--cinnabar);
}

.nav-hint {
  font-size: 11px;
  color: var(--stone);
}

.app-main {
  flex: 1;
  overflow: auto;
  padding: 24px;
}

.app-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 24px;
  border-top: 1px solid var(--line);
  background: var(--paper-card);
}

.footer-meta {
  font-size: 11px;
  color: var(--stone);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border: 1px solid var(--cinnabar);
  border-radius: 8px;
  color: var(--cinnabar);
  font-size: 10px;
}

.footer-btn {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: var(--paper-card);
  color: var(--ink-2);
  font-size: 11px;
}

.footer-btn:hover {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
}

.footer-error {
  color: var(--cinnabar);
}

.onboard-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 26, 20, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.onboard {
  width: 440px;
  background: var(--paper-card);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  padding: 28px 30px 22px;
  box-shadow: var(--shadow);
}

.onboard-dots {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
}

.dot.active {
  background: var(--cinnabar);
}

.onboard-title {
  margin: 0 0 10px;
  font-size: 17px;
  color: var(--ink);
}

.onboard-desc {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--ink-2);
}

.onboard-note {
  margin: 0 0 20px;
  font-size: 12px;
  color: var(--stone);
}

.onboard-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.onboard-skip {
  border: none;
  background: transparent;
  color: var(--stone);
  font-size: 13px;
}

.onboard-skip:hover { color: var(--ink-2); }

.onboard-next {
  padding: 8px 26px;
  border: 1px solid var(--cinnabar);
  border-radius: 6px;
  background: var(--cinnabar);
  color: #fff;
  font-size: 13px;
}

.onboard-next:hover { opacity: 0.92; }
</style>

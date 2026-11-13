<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'
import guideMarkdown from '../../docs/使用说明.md?raw'
import designerMarkdown from '../../docs/底图制作使用说明.md?raw'

// Repository-owned guides are bundled at build time: the app and published docs have one source.
const emit = defineEmits(['close'])
const current = ref('general'), body = ref(null), closeButton = ref(null)
const content = computed(() => marked.parse((current.value === 'general' ? guideMarkdown : designerMarkdown).replace(/^# .+\r?\n/, ''), { gfm: true, async: false }))
let previousFocus
watch(current, () => nextTick(() => { if (body.value) body.value.scrollTop = 0 }))
function followLink(event) {
  const link = event.target.closest?.('a')
  if (!link) return
  event.preventDefault()
  const href = decodeURIComponent(link.getAttribute('href') || '')
  if (href.endsWith('底图制作使用说明.md')) current.value = 'designer'
  else if (href.endsWith('使用说明.md')) current.value = 'general'
  else if (href.startsWith('https://')) window.open(href, '_blank', 'noopener')
}
onMounted(() => { previousFocus = document.activeElement; closeButton.value?.focus() })
onBeforeUnmount(() => previousFocus?.focus?.())
</script>

<template>
  <div class="gd-mask" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
    <section class="gd-panel" role="dialog" aria-modal="true" aria-labelledby="guide-title" data-testid="guide-dialog">
      <header class="gd-head"><strong id="guide-title">使用说明</strong><span>批量制作 · 本地智能处理</span><button ref="closeButton" data-testid="guide-close" @click="emit('close')">关闭</button></header>
      <nav class="gd-tabs" aria-label="说明分类"><button data-testid="guide-general" :aria-pressed="current === 'general'" @click="current = 'general'">完整使用流程</button><button data-testid="guide-designer" :aria-pressed="current === 'designer'" @click="current = 'designer'">底图制作指南</button></nav>
      <div ref="body" class="gd-body" @click="followLink" v-html="content"></div>
    </section>
  </div>
</template>

<style scoped>
.gd-mask{position:fixed;inset:0;z-index:210;display:grid;place-items:center;background:rgba(30,26,20,.45)}
.gd-panel{width:900px;max-width:94vw;height:86vh;display:flex;flex-direction:column;background:var(--paper-card);color:var(--ink);border:1px solid var(--line-strong);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
.gd-head{display:flex;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid var(--line)}
.gd-head strong{font-size:19px;color:var(--accent-ink)}.gd-head span{font-size:12px;color:var(--stone)}.gd-head button{margin-left:auto}
.gd-tabs{display:flex;gap:10px;padding:10px 24px;border-bottom:1px solid var(--line)}
button{padding:5px 14px;border:1px solid var(--line-strong);border-radius:6px;background:var(--paper-card);color:var(--ink-2);font:inherit;font-size:12px;cursor:pointer}
button[aria-pressed=true]{border-color:var(--cinnabar);color:var(--accent-ink)}
.gd-body{flex:1;min-height:0;overflow:auto;padding:4px 28px 28px;font-size:13.5px;line-height:1.9;color:var(--ink-2)}
.gd-body :deep(h2){margin:24px 0 10px;padding-left:10px;border-left:3px solid var(--cinnabar);color:var(--accent-ink);font-size:17px}
.gd-body :deep(h3){margin:18px 0 6px;color:var(--ink);font-size:15px}.gd-body :deep(p){margin:8px 0}.gd-body :deep(li){margin:6px 0}
.gd-body :deep(a){color:var(--accent-ink);text-decoration:underline}.gd-body :deep(code){padding:1px 5px;border:1px solid var(--line);border-radius:4px;background:var(--paper);font-size:12px;overflow-wrap:anywhere}
.gd-body :deep(blockquote){margin:12px 0;padding:8px 14px;background:var(--warn-soft);border:1px solid var(--warn-line);border-radius:8px}
.gd-body :deep(table){display:block;width:100%;overflow-x:auto;margin:12px 0;border-collapse:collapse;font-size:12.5px}.gd-body :deep(th),.gd-body :deep(td){padding:8px 12px;text-align:left;vertical-align:top;border:1px solid var(--line)}
.gd-body :deep(th){background:var(--paper);color:var(--ink)}.gd-body :deep(pre){overflow:auto}.gd-body :deep(pre code){display:block;padding:12px}
</style>

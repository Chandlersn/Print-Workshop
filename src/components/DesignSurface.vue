<script setup>
import { computed, getCurrentInstance, watch } from 'vue'
import { renderDesign } from '../../electron/design-layout.cjs'

const props = defineProps({
  design: { type: Object, required: true },
  width: { type: Number, required: true },
  height: { type: Number, default: null },
})
const emit = defineEmits(['error'])
const prefix = `design-surface-${getCurrentInstance().uid}`
const assetUrl = (asset) => `pp://media/${asset.path.split('/').map(encodeURIComponent).join('/')}`
const checkedAssets = new Set()
watch(() => Object.values(props.design.assets || {}).map(assetUrl).join('\n'), () => {
  // Artwork images use CSS backgrounds. Check source loading explicitly because their errors do not bubble.
  for (const asset of Object.values(props.design.assets || {})) {
    const url = assetUrl(asset)
    if (checkedAssets.has(url)) continue
    checkedAssets.add(url)
    const picture = new Image()
    picture.onerror = () => { checkedAssets.delete(url); emit('error', `图片“${asset.name}”无法加载，请检查工程素材是否完整。`) }
    picture.src = url
  }
}, { immediate: true })
const content = computed(() => {
  try {
    return renderDesign(props.design, {
      classPrefix: prefix,
      assetUrl,
      fontFamily: (name) => String(name || '').replace(/['"\\;{}()]/g, '').trim(),
    })
  } catch (err) {
    return { html: '', css: '', error: err.message || String(err) }
  }
})
const scale = computed(() => props.width / (props.design.artboard.w * 96 / 25.4))
const surfaceStyle = computed(() => ({
  width: `${props.design.artboard.w}mm`,
  height: `${props.design.artboard.h}mm`,
  transform: `scale(${scale.value})`,
}))
function resourceError(event) {
  if (event.target?.tagName === 'IMG') emit('error', '底图素材无法加载，请检查工程图片是否完整。')
}
</script>

<template>
  <div class="design-surface" :style="height ? { height: `${height}px` } : {}" aria-hidden="true">
    <component :is="'style'">{{ content.css }}</component>
    <div class="design-surface-content" :style="surfaceStyle" @error.capture="resourceError" v-html="content.html"></div>
    <span v-if="content.error" class="design-surface-error">{{ content.error }}</span>
  </div>
</template>

<style scoped>
.design-surface { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.design-surface-content { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.design-surface-error { color: #b03a2e; font: 12px sans-serif; }
</style>

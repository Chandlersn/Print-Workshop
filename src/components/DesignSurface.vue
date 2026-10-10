<script setup>
import { computed, getCurrentInstance, watch } from 'vue'
import { renderDesign, normalizeFamily } from '../../electron/design-layout.cjs'

const props = defineProps({
  design: { type: Object, required: true },
  width: { type: Number, required: true },
  height: { type: Number, default: null },
  /**
   * 是否渲染「仅编辑可见」的图层（参考框这类对齐用标注）。
   *
   * **默认 false，且必须保持默认**：本组件同时被模板页的成品预览复用，
   * 那里看到的就该是印出来的样子。只有底图编辑器画布显式传 true。
   * 默认值就是安全值——漏传的后果是「参考框不显示」，而不是「参考框被当成成品预览」。
   */
  showEditorOnly: { type: Boolean, default: false },
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
      fontFamily: normalizeFamily,
      includeEditorOnly: props.showEditorOnly,
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
</script>

<template>
  <div class="design-surface" :style="height ? { height: `${height}px` } : {}" aria-hidden="true">
    <component :is="'style'">{{ content.css }}</component>
    <div class="design-surface-content" :style="surfaceStyle" v-html="content.html"></div>
    <span v-if="content.error" class="design-surface-error">{{ content.error }}</span>
  </div>
</template>

<style scoped>
.design-surface { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.design-surface-content { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.design-surface-error { color: #b03a2e; font: 12px sans-serif; }
</style>

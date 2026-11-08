<script setup>
import { computed } from 'vue'
import { fieldDirection, graphemes } from '../../electron/field-text.cjs'
const props = defineProps({ field: { type: Object, required: true }, text: { type: String, default: '' } })
const direction = computed(() => fieldDirection(props.field))
const chars = computed(() => graphemes(props.text))
</script>

<template>
  <span v-if="direction === 'horizontal'">{{ text }}</span>
  <span v-else class="field-vertical"><span v-for="(char, index) in chars" :key="index" class="field-glyph"><span :class="direction">{{ char }}</span></span></span>
</template>

<style scoped>
.field-vertical { display: inline-flex; flex-direction: column; vertical-align: top; }
.field-glyph { display: flex; align-items: center; justify-content: center; width: 1em; height: 1em; line-height: 1; }
.field-glyph > span { display: block; }
.field-glyph > .vertical-left { transform: rotate(-90deg); }
.field-glyph > .vertical-right { transform: rotate(90deg); }
</style>

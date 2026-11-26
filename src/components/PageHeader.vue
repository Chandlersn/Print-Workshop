<script setup>
defineProps({
  title: { type: String, required: true },
})
</script>

<template>
  <header v-if="$slots.actions" class="page-header" :aria-label="title">
    <div class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.page-header__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
@media (max-width: 720px) {
  .page-header { align-items: flex-start; }
}
</style>

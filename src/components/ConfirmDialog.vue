<!--
  通用删除/危险操作确认弹窗（宣纸墨韵风格，替代原生 window.confirm）。
  用法：<ConfirmDialog v-if="pending" :title="..." :message="..." danger @confirm="..." @cancel="pending = null" />
-->
<script setup>
import BaseDialog from './BaseDialog.vue'
defineProps({
  title: { type: String, default: '确认操作' },
  /** 支持多行（\n 自动换行） */
  message: { type: String, required: true },
  confirmText: { type: String, default: '确定删除' },
  cancelText: { type: String, default: '取消' },
  /** true 时确认按钮为朱砂实底（危险动作） */
  danger: { type: Boolean, default: true },
})
defineEmits(['confirm', 'cancel'])
</script>

<template>
  <BaseDialog title-id="confirm-dialog-title" role="alertdialog" width="400px" overlay-class="cd-mask" box-class="cd-box" @close="$emit('cancel')">
      <h3 id="confirm-dialog-title" class="cd-title">{{ title }}</h3>
      <p class="cd-msg">{{ message }}</p>
      <div class="cd-actions">
        <button class="cd-btn" data-dialog-initial @click="$emit('cancel')">{{ cancelText }}</button>
        <button class="cd-btn" :class="{ danger }" @click="$emit('confirm')">{{ confirmText }}</button>
      </div>
  </BaseDialog>
</template>

<style scoped>
.cd-title {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--danger, #a52d22);
}

.cd-msg {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-2, #5a5248);
  white-space: pre-line;
  word-break: break-all;
}

.cd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cd-btn {
  padding: 6px 16px;
  font-size: 13px;
  border: 1px solid var(--line-strong, #d8cfc0);
  border-radius: 6px;
  background: transparent;
  color: var(--ink, #2f2a24);
  cursor: pointer;
}

.cd-btn:hover { background: var(--cinnabar-soft, rgba(176, 58, 46, 0.06)); }

.cd-btn.danger {
  background: var(--danger-solid, #a52d22);
  border-color: var(--danger-solid, #a52d22);
  color: var(--on-danger, #fff);
}

.cd-btn.danger:hover { filter: brightness(1.08); }
</style>

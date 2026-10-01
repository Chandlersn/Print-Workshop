<!--
  通用删除/危险操作确认弹窗（宣纸墨韵风格，替代原生 window.confirm）。
  用法：<ConfirmDialog v-if="pending" :title="..." :message="..." danger @confirm="..." @cancel="pending = null" />
-->
<script setup>
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
  <div class="cd-mask" @click.self="$emit('cancel')">
    <div class="cd-box" role="alertdialog">
      <h3 class="cd-title">{{ title }}</h3>
      <p class="cd-msg">{{ message }}</p>
      <div class="cd-actions">
        <button class="cd-btn" @click="$emit('cancel')">{{ cancelText }}</button>
        <button class="cd-btn" :class="{ danger }" @click="$emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 26, 20, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
}

.cd-box {
  width: 400px;
  background: var(--paper-card, #fffdf8);
  border: 1px solid var(--line-strong, #d8cfc0);
  border-radius: 10px;
  padding: 20px 22px;
  box-shadow: 0 8px 28px rgba(30, 26, 20, 0.18);
}

.cd-title {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--cinnabar, #b03a2e);
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
  background: var(--cinnabar, #b03a2e);
  border-color: var(--cinnabar, #b03a2e);
  color: #fff;
}

.cd-btn.danger:hover { filter: brightness(1.08); }
</style>

<!--
  页面大标题（全项目唯一实现）。

  为什么抽出来：五个页面原先各写一套——数据/模板工坊/打印中心用 18px 的 `.page-title`
  加朱砂左杠，底图制作用 20px 无左杠的 `.designer-heading` 加副标题，变量照片库用
  **24px 的 h1** 加一个「批量人像 · 0.6 预览」眉标。于是同一个应用里五个一级页面的
  标题有三种字号、两种元素（h1/h2）、三种结构，视觉上根本不像是同一套界面。
  统一成这一个组件：一种字号、一种元素、一种结构，副标题与右侧操作都是可选的。

  用法：
    <PageHeader title="数据">
      <template #actions><button class="btn-primary">导入数据文件</button></template>
    </PageHeader>
-->
<script setup>
defineProps({
  /** 页面大标题文字 */
  title: { type: String, required: true },
  /** 副标题（一句话说明这一页做什么）；不给就不渲染那一行 */
  description: { type: String, default: '' },
})
</script>

<template>
  <header class="page-header">
    <div class="page-header__text">
      <h2 class="page-header__title">{{ title }}</h2>
      <p v-if="description" class="page-header__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
/* 朱砂左杠沿用原 `.page-title` 的 4px + 10px 内边距口径（三处原本就是这么写的），
   字号取 20px：18px 在满宽页面上偏小、24px 又压过了工具栏的层级，20px 是五处的中间值。 */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.page-header__text { min-width: 0; }
.page-header__title {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 600;
  color: var(--ink);
  border-left: 4px solid var(--cinnabar);
  padding-left: 10px;
}
/* 副标题与标题文字左缘对齐（4px 杠 + 10px 内边距），否则和标题错开一个身位 */
.page-header__desc {
  margin: 4px 0 0;
  padding-left: 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-2);
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

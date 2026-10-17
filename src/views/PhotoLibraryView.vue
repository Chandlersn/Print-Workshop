<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PhotoImportPanel from '../components/PhotoImportPanel.vue'
import { gotoCell } from '../lib/cell-nav.js'
import { activeDataset, rememberDataset } from '../lib/active-dataset.js'
import { toUserMessage } from '../../electron/user-error.cjs'
const emit = defineEmits(['navigate'])
const detail = ref(null)
const error = ref('')
const loading = ref(true)
const guidance = ref('')
let alive = true
onBeforeUnmount(() => { alive = false })
onMounted(async () => {
  try {
    const datasets = await window.printpress.listDatasets()
    if (!alive) return
    const current = datasets.find(ds => ds.id === activeDataset.value)
    const enabled = datasets.filter(ds => ds.photoMatchColumn)
    // Do not silently import into another list when the selected list has disabled matching.
    const target = current || (enabled.length === 1 ? enabled[0] : null)
    if (!target?.photoMatchColumn) {
      guidance.value = current ? `当前名单“${current.name}”尚未开启配图。请在数据页点击一个列头的“配图”。`
        : enabled.length > 1 ? '多份名单已开启配图，请先在数据页打开要使用的那一份，照片库会自动跟随。'
          : '请先在数据页打开名单，并点击姓名、编号或其他列头的“配图”开关。'
      return
    }
    const ds = await window.printpress.getDataset(target.id)
    if (!alive) return
    detail.value = ds
    rememberDataset(ds.id)
  } catch (err) { if (alive) error.value = toUserMessage(err) }
  finally { if (alive) loading.value = false }
})
</script>

<template>
  <section class="photo-library-view">
    <PageHeader title="变量照片库" description="自动跟随数据页的配图选择，在这里选择照片文件夹即可。">
      <template #actions>
        <button class="btn-ghost" @click="emit('navigate', 'designer')">前往底图制作 → 添加变量图</button>
      </template>
    </PageHeader>
    <p v-if="loading" role="status">正在读取当前配图名单…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="!loading && !detail && !error" class="empty-library"><h2>先在数据页确定配图名单</h2><p>{{ guidance }}</p><button class="btn-primary" @click="emit('navigate', 'dataset')">前往数据页</button></div>
    <div v-if="detail" class="matching-context" data-testid="photo-auto-context"><span>当前配图：<strong>{{ detail.name }}</strong> · {{ detail.columns.find(c => c.key === detail.photoMatchColumn)?.alias || detail.photoMatchColumn }}</span><button class="btn-ghost" @click="emit('navigate', 'dataset')">返回数据页</button></div>
    <PhotoImportPanel v-if="detail" :key="detail.id" embedded :dataset-id="detail.id" :columns="detail.columns" :match-column="detail.photoMatchColumn || ''" @edit-cell="({ rowIndex, key }) => gotoCell(detail.id, rowIndex, key)" />
  </section>
</template>

<style scoped>
.photo-library-view{max-width:1440px;margin:auto;padding:16px}.library-heading p,.empty-library p{color:var(--stone);line-height:1.6;margin:6px 0}.matching-context{display:flex;gap:16px;justify-content:space-between;align-items:center;margin:16px 0;padding:12px 16px;border:1px solid var(--line);border-radius:8px;background:var(--paper-card)}.empty-library{text-align:center;padding:80px 20px;border:1px dashed var(--line);border-radius:16px}
</style>

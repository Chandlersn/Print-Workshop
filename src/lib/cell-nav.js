/**
 * 跨页跳转总线：打印中心校验弹窗 → 数据页对应单元格（去补录直达）。
 * 用 reactive 单例做最小事件通道——req 带 ts 保证同格子重复点击也能再次触发 watch。
 *
 * 一次性语义：消费方处理完必须调 ackCell() 把 req 置回 null。
 * 不ack 的话，req 会一直留在单例里，而 App.vue 用 v-if 反复重建数据页组件，
 * 消费侧 watch 又带 immediate:true——于是每次切回数据页都会重放上次的跳转，
 * 把用户强行拽进编辑态、翻到那一页。要发新请求时 req 必须是 null 才不会被立即消费。
 */
import { reactive } from 'vue'

export const cellNav = reactive({ req: null }) // { datasetId, rowIndex, key, ts }

export function gotoCell(datasetId, rowIndex, key) {
  cellNav.req = { datasetId, rowIndex, key, ts: Date.now() }
}

/** 消费确认：清空请求，避免下次挂载时重放 */
export function ackCell() {
  cellNav.req = null
}

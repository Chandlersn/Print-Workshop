/**
 * 跨页跳转总线：打印中心校验弹窗 → 数据页对应单元格（去补录直达）。
 * 用 reactive 单例做最小事件通道——req 带 ts 保证同格子重复点击也能再次触发 watch。
 */
import { reactive } from 'vue'

export const cellNav = reactive({ req: null }) // { datasetId, rowIndex, key, ts }

export function gotoCell(datasetId, rowIndex, key) {
  cellNav.req = { datasetId, rowIndex, key, ts: Date.now() }
}

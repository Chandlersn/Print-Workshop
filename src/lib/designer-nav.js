import { reactive } from 'vue'

/** Template/editor navigation carries a fixed saved revision, never a live draft. */
export const designerNav = reactive({ request: null, result: null, dirty: false })

let sequence = 0
export function openDesigner(request) {
  designerNav.request = { ...request, nonce: `${Date.now()}-${++sequence}` }
}

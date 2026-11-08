import { reactive } from 'vue'

// Carry a stable record id between print preview and the shared single-photo editor.
export const photoNav = reactive({ request: null, result: null })
let sequence = 0
export function openSinglePhoto(request) {
  photoNav.request = { ...request, nonce: `${Date.now()}-${++sequence}` }
}

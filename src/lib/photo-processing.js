import { reactive, ref } from 'vue'
export const photoProcessingRevision = ref(0)
export const photoProcessingDrafts = reactive({})
export const photoProcessingSample = ref(null)
export function photoProcessingChanged() { photoProcessingRevision.value++ }
if (typeof window !== 'undefined' && window.printpress?.onPhotoProcessingProgress) {
  window.printpress.onPhotoProcessingProgress(payload => { if (payload.automatic && payload.phase === 'completed') photoProcessingChanged() })
}

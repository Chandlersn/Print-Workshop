import { ref } from 'vue'

const STORAGE_KEY = 'printpress-active-dataset'
let remembered = ''
try { remembered = localStorage.getItem(STORAGE_KEY) || '' } catch { /* Optional UI preference. */ }

/** Data selection is shared by the photo library and portrait picker. */
export const activeDataset = ref(remembered)
export function rememberDataset(id) {
  activeDataset.value = id || ''
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* Keep this session usable if preferences cannot be saved. */ }
}

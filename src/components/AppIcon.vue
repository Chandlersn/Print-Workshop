<script setup>
defineProps({ name: { type: String, required: true }, size: { type: Number, default: 18 } })
</script>
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="app-icon">
    <template v-if="name === 'crop'"><path d="M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12"/></template>
    <template v-else-if="name === 'brush'"><path d="m14 5 5-2 2 2-2 5-9 9H6v-4zM13 6l5 5M6 15l3 3"/></template>
    <template v-else-if="name === 'rect'"><rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2"/></template>
    <template v-else-if="name === 'image'"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 3-3 5 5"/></template>
    <template v-else-if="name === 'portrait'"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M7.5 18c.7-3.1 2.2-4.4 4.5-4.4s3.8 1.3 4.5 4.4"/></template>
    <template v-else-if="name === 'text'"><path d="M4 5h16M12 5v14M9 19h6"/></template>
    <template v-else-if="name === 'ellipse'"><ellipse cx="12" cy="12" rx="8" ry="6"/></template>
    <template v-else-if="name === 'line'"><path d="M4 19 20 5"/><circle cx="4" cy="19" r="1"/><circle cx="20" cy="5" r="1"/></template>
    <template v-else-if="name === 'undo'"><path d="M9 7 4 12l5 5M4 12h10a5 5 0 0 1 5 5"/></template>
    <template v-else-if="name === 'trash'"><path d="M4 7h16M10 4h4M7 7l1 13h8l1-13M10 10v7M14 10v7"/></template>
    <template v-else-if="name === 'check'"><path d="m4 12 5 5L20 6"/></template>
    <template v-else-if="name === 'close'"><path d="M5 5l14 14M19 5 5 19"/></template>
    <template v-else-if="name === 'add'"><path d="M12 4v16M4 12h16"/></template>
    <template v-else-if="name === 'copy'"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></template>
    <template v-else-if="name === 'library'"><path d="M4 5h4v14H4zM10 5h4v14h-4zM16 6l3-1 3 13-3 1z"/></template>
    <template v-else-if="name === 'download'"><path d="M12 3v11M8 10l4 4 4-4M4 17v3h16v-3"/></template>
    <template v-else-if="name === 'upload'"><path d="M12 16V5M8 9l4-4 4 4M4 17v3h16v-3"/></template>
    <template v-else-if="name === 'save'"><path d="M5 3h12l3 3v14H4V3zM8 3v6h8V3M8 20v-7h8v7"/></template>
    <template v-else-if="name === 'more'"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></template>
    <template v-else-if="name === 'history'"><path d="M4 11a8 8 0 1 1 2 6M4 5v6h6M12 7v5l3 2"/></template>
    <template v-else-if="name === 'folder'"><path d="M3 6h7l2 2h9v11H3z"/></template>
    <template v-else-if="name === 'print'"><path d="M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7zM17 11h.01"/></template>
    <template v-else-if="name === 'table'"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11M3 14h18"/></template>
    <template v-else-if="name === 'layout'"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 4v16M10 10h11"/></template>
    <template v-else-if="name === 'eye'"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.7"/></template>
    <template v-else-if="name === 'eye-off'"><path d="M3 3l18 18M10.7 6.1A11 11 0 0 1 12 6c6.1 0 9.5 6 9.5 6a14 14 0 0 1-3 3.4M6.2 7.5A15 15 0 0 0 2.5 12s3.4 6 9.5 6c1.3 0 2.5-.3 3.5-.7M10 10a2.8 2.8 0 0 0 4 4"/></template>
    <template v-else-if="name === 'lock'"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></template>
    <template v-else-if="name === 'unlock'"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-1.5M12 14v3"/></template>
    <template v-else-if="name === 'group'"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M14 3h5a2 2 0 0 1 2 2v5M10 21H5a2 2 0 0 1-2-2v-5" stroke-dasharray="2 2"/></template>
    <template v-else-if="name === 'ungroup'"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="m13 5 3-2m3 5 2-3M5 13l-2 3m5 3-3 2"/></template>
    <template v-else-if="name === 'align-left'"><path d="M4 3v18M8 6h11v4H8zM8 14h7v4H8z"/></template>
    <template v-else-if="name === 'align-center'"><path d="M12 3v18M6 6h12v4H6zM8 14h8v4H8z"/></template>
    <template v-else-if="name === 'align-right'"><path d="M20 3v18M5 6h11v4H5zM9 14h7v4H9z"/></template>
    <template v-else-if="name === 'align-top'"><path d="M3 4h18M6 8h4v11H6zM14 8h4v7h-4z"/></template>
    <template v-else-if="name === 'align-middle'"><path d="M3 12h18M6 6h4v12H6zM14 8h4v8h-4z"/></template>
    <template v-else-if="name === 'align-bottom'"><path d="M3 20h18M6 5h4v11H6zM14 9h4v7h-4z"/></template>
    <template v-else-if="name === 'move-up'"><path d="M12 20V5M6 11l6-6 6 6"/></template>
    <template v-else-if="name === 'move-down'"><path d="M12 4v15M6 13l6 6 6-6"/></template>
    <template v-else-if="name === 'move-top'"><path d="M4 4h16M12 20V8M7 13l5-5 5 5"/></template>
    <template v-else-if="name === 'move-bottom'"><path d="M4 20h16M12 4v12M7 11l5 5 5-5"/></template>
    <template v-else-if="name === 'help'"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.7v.4"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/></template>
  </svg>
</template>
<style scoped>.app-icon { display: inline-block; vertical-align: -0.22em; flex: none; }</style>

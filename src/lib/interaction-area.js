// Passive space ends temporary editing; controls retain their own interaction.
export function isNonFunctionalArea(target, extraInteractive = '') {
  if (!(target instanceof Element)) return false
  const controls = 'button, input, textarea, select, option, label, a, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menu"], [role="slider"], [role="dialog"]'
  return !target.closest(extraInteractive ? `${controls}, ${extraInteractive}` : controls)
}

/**
 * 主题配色：六个预设 + 跟随宿主 + 自选强调色。
 *
 * 只改「强调色」一族（accent / on-accent / accent-ink / accent-soft），
 * 纸面、墨色与描线仍由 theme.css 的明暗两态负责，所以切配色不会破坏
 * 宣纸墨韵的底色层次，也不会让暗色模式失去对比度。
 *
 * 主按钮前景按真实色值算 WCAG 对比度选黑/白，鲜黄这类极亮强调色
 * 也不会出现白字看不清。
 */

export const ACCENT_STORAGE_KEY = 'printpress-accent-v1'

export const ACCENT_PRESETS = Object.freeze([
  { id: 'ocean', label: '海蓝', color: '#2563eb' },
  { id: 'emerald', label: '翡翠', color: '#059669' },
  { id: 'wisteria', label: '紫藤', color: '#7c3aed' },
  { id: 'rose', label: '玫瑰', color: '#db2777' },
  { id: 'amber', label: '琥珀', color: '#d97706' },
  { id: 'coral', label: '珊瑚', color: '#e3533a' },
])

export const DEFAULT_ACCENT = Object.freeze({ accentId: 'ocean', customColor: '#2563eb' })

export function normalizeColor(value, fallback = DEFAULT_ACCENT.customColor) {
  if (typeof value !== 'string') return fallback
  const color = value.trim().toLowerCase()
  if (/^#[\da-f]{6}$/.test(color)) return color
  if (/^#[\da-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(c => c + c).join('')
  return fallback
}

export function relativeLuminance(color) {
  const hex = normalizeColor(color)
  const channels = [1, 3, 5]
    .map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

/** 强调色上用黑字还是白字：取对比度更高的一侧，保证亮色也读得清。 */
export function readableForeground(color) {
  return contrastRatio(color, '#000000') >= contrastRatio(color, '#ffffff') ? '#000000' : '#ffffff'
}

export function normalizeAccent(value) {
  const ids = [...ACCENT_PRESETS.map(item => item.id), 'custom']
  const accentId = ids.includes(value?.accentId) ? value.accentId : DEFAULT_ACCENT.accentId
  return { accentId, customColor: normalizeColor(value?.customColor) }
}

export function readAccentPreference(storage) {
  try {
    const target = storage || globalThis.localStorage
    return normalizeAccent(JSON.parse(target?.getItem(ACCENT_STORAGE_KEY) || 'null'))
  } catch {
    return { ...DEFAULT_ACCENT }
  }
}

export function saveAccentPreference(preference, storage) {
  const normalized = normalizeAccent(preference)
  try {
    const target = storage || globalThis.localStorage
    if (!target?.setItem) return false
    target.setItem(ACCENT_STORAGE_KEY, JSON.stringify(normalized))
    return true
  } catch {
    return false
  }
}

/** 解析当前强调色；跟随宿主时用调用方传入的实际色值。 */
export function resolveAccent(preference, hostAccent) {
  const { accentId, customColor } = normalizeAccent(preference)
  if (accentId === 'custom') return customColor
  return ACCENT_PRESETS.find(item => item.id === accentId).color
}

/** 在 sRGB 中混色，返回可供对比度计算的六位色。 */
function mixColor(first, second, weight) {
  const a = normalizeColor(first)
  const b = normalizeColor(second)
  const channels = [1, 3, 5].map(i => {
    const value = Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - weight) + parseInt(b.slice(i, i + 2), 16) * weight)
    return value.toString(16).padStart(2, '0')
  })
  return `#${channels.join('')}`
}

/** 沿原色向黑或白移动，直到文字在该主题的纸面、卡片和柔色底均可读。 */
export function readableAccentInk(color, theme = 'light') {
  const accent = normalizeColor(color)
  const dark = theme === 'dark'
  const paper = dark ? '#211c17' : '#f6f2e9'
  const backgrounds = [paper, dark ? '#2a241d' : '#fbf8f1', dark ? '#1c1813' : '#ffffff', mixColor(paper, accent, 0.14)]
  const target = dark ? '#ffffff' : '#000000'
  const readable = candidate => backgrounds.every(bg => contrastRatio(candidate, bg) >= 4.55)
  if (readable(accent)) return accent
  let low = 0
  let high = 1
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2
    if (readable(mixColor(accent, target, mid))) high = mid
    else low = mid
  }
  return mixColor(accent, target, high)
}

/** 同时产出两套文字色，使 data-theme 切换无需重新运行脚本。 */
export function accentVariables(preference, hostAccent) {
  const accent = resolveAccent(preference, hostAccent)
  const foreground = readableForeground(accent)
  const active = mixColor(accent, foreground, 0.16)
  return {
    '--cinnabar': accent,
    '--accent-solid': accent,
    '--accent-ink-light': readableAccentInk(accent, 'light'),
    '--accent-ink-dark': readableAccentInk(accent, 'dark'),
    '--cinnabar-soft': `color-mix(in srgb, ${accent} 14%, var(--paper))`,
    '--on-accent': foreground,
    '--accent-active': active,
    '--on-accent-active': readableForeground(active),
  }
}

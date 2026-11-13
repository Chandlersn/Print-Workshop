import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentVariables, contrastRatio, normalizeColor, readableAccentInk, readableForeground, resolveAccent } from '../src/lib/accent.js'

const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8')
const root = css.match(/:root\s*\{([^}]*)\}/)[1]
const dark = css.match(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/)[1]
function token(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))
  assert.ok(match, `missing --${name}`)
  return match[1]
}
function mix(first, second, weight) {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(first.slice(i, i + 2), 16) * (1 - weight) + parseInt(second.slice(i, i + 2), 16) * weight).toString(16).padStart(2, '0')).join('')
}
const surfaces = {
  light: [token(root, 'paper'), token(root, 'paper-card'), token(root, 'input-bg')],
  dark: [token(dark, 'paper'), token(dark, 'paper-card'), token(dark, 'input-bg')],
}

test('normalize and resolve preset and custom colors', () => {
  assert.deepEqual(ACCENT_PRESETS.map(p => p.id), ['ocean', 'emerald', 'wisteria', 'rose', 'amber', 'coral'])
  assert.deepEqual(ACCENT_PRESETS.map(p => p.color), ['#2563eb', '#059669', '#7c3aed', '#db2777', '#d97706', '#e3533a'])
  assert.equal(DEFAULT_ACCENT.accentId, 'ocean')
  assert.equal(resolveAccent({ accentId: 'cinnabar' }), '#2563eb')
  assert.equal(normalizeColor(' #AbC '), '#aabbcc')
  assert.equal(normalizeColor('not-a-color'), DEFAULT_ACCENT.customColor)
  assert.equal(resolveAccent({ accentId: 'custom', customColor: '#fff' }), '#ffffff')
  for (const preset of ACCENT_PRESETS) assert.equal(resolveAccent({ accentId: preset.id }), preset.color)
  assert.equal(contrastRatio('#000', '#fff'), 21)
})

test('solid and pressed foregrounds plus ink contrast for extreme colors and RGB samples', () => {
  const colors = [...ACCENT_PRESETS.map(p => p.color), '#000000', '#ffffff', '#ffff00', '#0000ff', '#00ff00', '#ff0000', '#00ffff', '#ff00ff', '#808080']
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    colors.push('#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join(''))
  }
  for (const color of colors) {
    const vars = accentVariables({ accentId: 'custom', customColor: color })
    assert.equal(vars['--accent-solid'], color)
    assert.equal(vars['--on-accent'], readableForeground(color))
    assert.ok(contrastRatio(vars['--on-accent'], color) >= 4.5, `${color} solid`)
    assert.ok(contrastRatio(vars['--on-accent-active'], vars['--accent-active']) >= 4.5, `${color} pressed`)
    for (const theme of ['light', 'dark']) {
      const ink = vars[`--accent-ink-${theme}`]
      assert.equal(ink, readableAccentInk(color, theme))
      for (const background of [...surfaces[theme], mix(surfaces[theme][0], color, 0.14)]) {
        assert.ok(contrastRatio(ink, background) >= 4.5, `${color} ${theme} ${ink} on ${background}`)
      }
    }
  }
})

test('defaults and semantic red remain readable in both themes', () => {
  const vars = accentVariables(DEFAULT_ACCENT)
  for (const name of ['accent-solid', 'accent-ink-light', 'accent-ink-dark', 'on-accent', 'accent-active', 'on-accent-active']) {
    assert.equal(token(root, name), vars[`--${name}`], name)
  }
  for (const [theme, block] of [['light', root], ['dark', dark]]) {
    const danger = token(block, 'danger')
    for (const background of [...surfaces[theme], token(block, 'danger-soft')]) {
      assert.ok(contrastRatio(danger, background) >= 4.5, `${theme} danger on ${background}`)
    }
  }
  assert.ok(contrastRatio(token(root, 'danger-solid'), token(root, 'on-danger')) >= 4.5)
  assert.match(css, /--accent-ink:\s*var\(--accent-ink-light\)/)
  assert.match(dark, /--accent-ink:\s*var\(--accent-ink-dark\)/)
})

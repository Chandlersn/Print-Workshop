// Shared by the editor and print renderer so grapheme clusters and directions match.
const MODES = ['horizontal', 'vertical', 'vertical-left', 'vertical-right']
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
function fieldDirection(field) {
  return MODES.includes(field.direction) ? field.direction : 'horizontal'
}
function graphemes(text) {
  const value = String(text ?? '')
  return segmenter
    ? Array.from(segmenter.segment(value), item => item.segment)
    : Array.from(value)
}
module.exports = { fieldDirection, graphemes }

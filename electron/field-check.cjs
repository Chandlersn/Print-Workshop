/**
 * 出口校验：模板上用到的每一个字段都必须有值，才能出证书。
 *
 * 为什么要在写盘之前拦：空白字段不会报错，只会在成品上留一条
 * 「指导教师：」这样的空行 —— 纸质证书发出去就改不了，只能整批重出。
 * 所以校验放在出口，而不是出完再靠人眼抽查。
 *
 * 判空口径：undefined / null / 全空白字符串都算空（'' 与 '   ' 等价）。
 */

/** 缺字段时抛的错误码，UI 与 CLI 据此把「校验没过」和「打印机坏了」分开处理 */
const FIELD_BLANK = 'FIELD_BLANK'

/** 一行里哪些字段是空的 */
function blankFieldsOf(row, keys) {
  return keys.filter(key => !String(row?.[key] ?? '').trim())
}

/** 扫描一组行，返回 [缺字段的行]（name 只用于报错指向具体是谁） */
function findBlankRows(rows, keys, nameOf) {
  const uniq = [...new Set(keys.filter(Boolean).map(String))]
  const blanks = []
  for (const row of rows || []) {
    const fields = blankFieldsOf(row, uniq)
    if (!fields.length) continue
    const name = nameOf ? String(nameOf(row) ?? '').trim() : ''
    blanks.push({ name: name || '(未命名)', fields })
  }
  return blanks
}

/** 校验不通过就抛；通过则静默返回 */
function assertFieldsFilled(rows, keys, nameOf) {
  const blanks = findBlankRows(rows, keys, nameOf)
  if (!blanks.length) return
  const sample = blanks.slice(0, 5).map(b => `${b.name} 缺 ${b.fields.join('/')}`).join('；')
  const err = new Error(
    `校验未通过：${blanks.length} 行关键字段为空，已拒绝出证书（${sample}${blanks.length > 5 ? ` …等 ${blanks.length} 行` : ''}）`
  )
  err.code = FIELD_BLANK
  err.blankRows = blanks
  throw err
}

module.exports = { FIELD_BLANK, blankFieldsOf, findBlankRows, assertFieldsFilled }

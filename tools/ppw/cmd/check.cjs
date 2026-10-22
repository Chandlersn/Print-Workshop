/* check：离线字段体检 —— 不连宿主、不写图，只回答「这批名单里谁能直接出、谁不能」。
 *
 * 存在的理由：出片是分钟级的动作，字段缺失是一秒级就能查出来的事。
 * 先跑 check 再跑 export，可以避免「跑了两小时发现 20 张是空白栏」。
 */
const path = require('path')
const fs = require('fs')
const roster = require('../roster.cjs')
const select = require('../select.cjs')
const report = require('../report.cjs')

async function run(ctx) {
  const { cfg, log, range } = ctx
  const files = select.rosterFiles(ctx)

  const rows = []
  const byUnit = new Map()
  const skipRows = []
  let total = 0
  let bad = 0
  let blockedRows = 0

  const isSkip = (sheet, name) => (cfg.skipCert || []).some(s => s.sheet === sheet && s.name === name)

  for (const file of files) {
    const r = roster.readRoster(file, cfg)
    for (const unit of r.units) {
      if (!unit.rows.length) continue
      if (unit.missingColumns.length) {
        rows.push({ 批次: r.batch, 单位: unit.sheet, 文件: '', 缺字段: `整表缺列 ${unit.missingColumns.join('/')}` })
        log.warn(`${unit.sheet} 整表缺列: ${unit.missingColumns.join(' / ')}（该单位无法校验，也不会出片）`)
        blockedRows += unit.rows.length
      }
      for (const row of unit.rows) {
        total++
        if (!row.blanks.length) continue
        const label = row.code ? `${row.code}_${row.name}` : `(编号空)${row.name}`
        // 已确认不出证书的人单列一类：字段空着也无所谓，不该混进「不能出」的计数里
        if (isSkip(unit.sheet, row.name)) {
          skipRows.push({ 批次: r.batch, 单位: unit.sheet, 文件: label, 缺字段: row.blanks.join('/') })
          continue
        }
        bad++
        rows.push({ 批次: r.batch, 单位: unit.sheet, 文件: label, 缺字段: row.blanks.join('/') })
        byUnit.set(unit.sheet, (byUnit.get(unit.sheet) || 0) + 1)
      }
    }
  }

  const out = select.outPath(ctx, `字段校验_${files.map(f => path.basename(f, path.extname(f))).join('+')}`, '.csv')
  report.writeCsv(out, ['批次', '单位', '文件', '缺字段'], [...rows, ...skipRows])

  log(`名册 ${files.length} 份 / ${total} 行；字段不全 ${bad} 行，涉及 ${byUnit.size} 个单位`)
  for (const [unit, n] of [...byUnit.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${'⛔'} ${unit}：${n} 行`)
  }
  if (skipRows.length) log(`另 ${skipRows.length} 行属「不出证书」名单，字段空着不影响（${skipRows.map(s => s.文件).join('、')}）`)
  if (blockedRows) log.warn(`另有 ${blockedRows} 行因整表缺列无法校验`)
  log(`报告: ${out}`)

  return {
    summary: bad ? `结论：${bad} 行不能出（补完字段再来）；其余可出` : '结论：全部通过，可以直接出片',
    exitCode: bad || blockedRows ? 1 : 0,
    files: files.map(f => path.basename(f)),
    totalRows: total,
    blankRows: bad,
    units: [...byUnit.entries()].map(([unit, n]) => ({ unit, rows: n })),
    report: out,
  }
}

module.exports = { run }

/* pending：待补数据清单 —— 「还差谁的数据、补完要重做还是新出」。
 *
 * 这份清单的目的很单一：让人能在 Excel 里直接把空格填掉，不用去翻对账表。
 * 所以每行必须回答三件事：哪个单位、哪一行、补完是重做还是新出。
 *
 * 已确认不出证书的人不进清单（补了也白补）；
 * 已补进数据集但 Excel 仍空的人单独标「仅需回填」，避免重复补一遍。
 */
const path = require('path')
const roster = require('../roster.cjs')
const store = require('../store.cjs')
const select = require('../select.cjs')
const report = require('../report.cjs')

/**
 * 表头不写死列名：编号列取配置里识别出来的 `cfg.idField`
 * （从必填清单里找带「编号 / 学号 / 工号 / 序号」的列）。换一批叫「学号」也能对上。
 */
function headersOf(cfg) {
  return ['单位序号', '单位名称', '批次', 'Excel行号', '姓名', cfg.idField || '编号', '缺失字段', '已出图', '处理方式']
}

async function run(ctx) {
  const { cfg, log } = ctx
  const files = select.rosterFiles(ctx)

  const rows = []
  const byUnit = new Map()

  for (const file of files) {
    const r = roster.readRoster(file, cfg)
    for (const unit of r.units) {
      if (!unit.rows.length) continue
      const scan = store.scanFolder(select.unitDir(cfg, unit.sheet))

      for (const row of unit.rows) {
        if (!row.blanks.length) continue
        if ((cfg.skipCert || []).some(s => s.sheet === unit.sheet && s.name === row.name)) continue

        const fixed = (cfg.excelPending || []).find(s => s.sheet === unit.sheet && s.name === row.name)
        const stem = roster.fileStem(row)
        const printed = stem ? scan.stems.has(stem) : scan.byName.has(row.name)

        let how
        if (fixed) how = '已补并出图，仅需回填 Excel'
        else if (printed) how = '补数据后重做这张'
        else how = '补数据后新出这张'

        rows.push({
          单位序号: unit.no,
          单位名称: unit.sheet,
          批次: r.batch,
          Excel行号: row.excelRow,
          姓名: row.name,
          [cfg.idField || '编号']: row.values[cfg.idField] || '',
          缺失字段: row.blanks.join(' / '),
          已出图: printed ? '是' : '否',
          处理方式: how,
        })
        const key = `${unit.sheet} | 缺${row.blanks.join('/')} | ${how}`
        byUnit.set(key, (byUnit.get(key) || 0) + 1)
      }
    }
  }

  rows.sort((a, b) => a.单位序号 - b.单位序号 || a.Excel行号 - b.Excel行号)

  log(`待补 ${rows.length} 行，涉及 ${new Set(rows.map(r => r.单位名称)).size} 个单位`)
  for (const [k, n] of [...byUnit.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${k}  ×${n}`)
  }

  const csv = select.outPath(ctx, '待补数据清单', '.csv')
  const headers = headersOf(cfg)
  report.writeCsv(csv, headers, rows)

  const xlsx = path.join(cfg.reportDir, '国赛证书_待补数据清单.xlsx')
  const written = report.writeXlsx(xlsx, [
    { name: '待补数据', rows: rows.length ? rows : [{ 说明: '没有待补数据，全部字段已齐' }], cols: [9, 34, 12, 9, 10, 22, 18, 8, 26] },
    { name: '按单位汇总', rows: [...byUnit.entries()].map(([k, n]) => {
      const [单位名称, 缺, 处理] = k.split(' | ')
      return { 单位名称, 缺失字段: 缺.replace(/^缺/, ''), 行数: n, 处理方式: 处理 }
    }), cols: [34, 20, 8, 26] },
  ])

  if (written.degraded) log.warn(`xlsx 原路径被占用（${written.reason}），改写为 ${written.path}`)
  log(`CSV:  ${csv}`)
  log(`XLSX: ${written.path}`)

  return {
    summary: rows.length ? `结论：还有 ${rows.length} 行要补数据` : '结论：没有待补数据',
    exitCode: 0,
    total: rows.length,
    units: new Set(rows.map(r => r.单位名称)).size,
    csv,
    xlsx: written.path,
    rows,
  }
}

module.exports = { run, headersOf }

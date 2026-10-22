/* drift：只扫「Excel 改了、数据集没变」。
 *
 * 从对账表里单独抽出来的窄命令：不改文件、不出片、不扫磁盘，
 * 只回答一个问题 —— 现在有没有人的证书会因为数据没同步而印错。
 *
 * 比 audit 快一个数量级（不扫几万张 png），适合每次改完 Excel 就跑一遍。
 */
const roster = require('../roster.cjs')
const store = require('../store.cjs')
const select = require('../select.cjs')
const report = require('../report.cjs')

async function run(ctx) {
  const { cfg, log, range } = ctx
  const files = select.rosterFiles(ctx)

  let datasets = []
  try { datasets = store.readDatasets(ctx.dataDir) } catch (err) {
    throw new Error(`读不到数据集: ${err.message}`)
  }

  const fieldKeys = cfg.requiredFields.map(f => f.key)
  const rows = []
  let scanned = 0
  let dialect = 0
  let missingDataset = 0

  for (const file of files) {
    const r = roster.readRoster(file, cfg)
    for (const unit of r.units) {
      if (!unit.rows.length || !roster.inRange(unit.no, range)) continue
      const ds = store.pickDataset(datasets, unit.sheet)
      if (!ds) {
        missingDataset++
        log.warn(`${unit.sheet} 没有数据集（这家没导入过）`)
        continue
      }
      const byCode = new Map()
      for (const d of ds.rows || []) {
        const c = String(d['1'] ?? '').trim()
        if (c && !byCode.has(c)) byCode.set(c, d)
      }

      for (const row of unit.rows) {
        if (!row.code) continue
        scanned++
        const dsRow = byCode.get(row.code)
          || (ds.rows || []).find(x => String(x['姓名'] ?? '').trim() === row.name)

        for (const k of fieldKeys) {
          const ev = String(row.values[k] ?? '').trim()
          const dv = String((dsRow || {})[k] ?? '').trim()
          if (ev === dv) continue
          if (roster.isKnownDialect(cfg, k, ev, dv)) { dialect++; continue }
          const diffs = roster.diffRow(cfg, row, dsRow, [k])
          for (const d of diffs) {
            rows.push({
              批次: r.batch, 单位: unit.sheet, 编号: row.code, 姓名: row.name,
              字段: d.field, Excel值: d.excel, 数据集值: d.dataset,
              判定: d.verdict === 'dataset-filled' ? '数据集有值·Excel已清空'
                : d.verdict === 'dataset-empty' ? '数据集为空（Excel已补）'
                  : d.verdict === 'row-missing' ? '数据集缺该行' : '值不同',
              处理: d.action,
            })
          }
        }
      }
    }
  }

  const out = select.outPath(ctx, '数据漂移', '.csv')
  report.writeCsv(out, ['批次', '单位', '编号', '姓名', '字段', 'Excel值', '数据集值', '判定', '处理'], rows)

  log(`扫 ${scanned} 行 × ${fieldKeys.length} 字段`)
  log(`真实漂移 ${rows.length} 处；已知口径（奖项简写）${dialect} 处，不计入`)
  if (missingDataset) log.warn(`${missingDataset} 家没有数据集`)
  for (const r of rows) {
    log(`  ${r.单位} ${r.编号}_${r.姓名}  ${r.字段}: Excel「${r.Excel值}」/ 数据集「${r.数据集值}」 → ${r.处理}`)
  }
  log(`报告: ${out}`)

  return {
    summary: rows.length ? `结论：${rows.length} 处数据没同步，会对不上 Excel` : '结论：两边完全一致',
    exitCode: 0,
    scanned,
    drift: rows.length,
    dialect,
    missingDataset,
    report: out,
    rows,
  }
}

module.exports = { run }

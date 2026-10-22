/* status：一眼看清「现在是什么局面」。
 *
 * 不连宿主、不写任何东西。排查问题的第一步永远是先确认
 * 「数据目录对不对、名册读到了几份、输出目录里有多少图」。
 */
const fs = require('fs')
const path = require('path')
const store = require('../store.cjs')
const roster = require('../roster.cjs')

async function run(ctx) {
  const { cfg, log, dataDir } = ctx
  const out = {
    config: cfg.__configPath || '(内置默认)',
    dataDir,
    rosterDir: cfg.rosterDir,
    outputDir: cfg.outputDir,
    templateId: cfg.templateId,
    outputDpi: cfg.outputDpi,
  }

  log(`配置     ${out.config}`)
  log(`数据目录 ${dataDir}${fs.existsSync(dataDir) ? '' : '  ⚠️  不存在'}`)
  log(`名册目录 ${cfg.rosterDir}${fs.existsSync(cfg.rosterDir) ? '' : '  ⚠️  不存在'}`)
  log(`输出目录 ${cfg.outputDir}${fs.existsSync(cfg.outputDir) ? '' : '  ⚠️  不存在'}`)
  log(`模板     ${cfg.templateId} @ ${cfg.outputDpi}dpi`)

  // 数据集
  let datasets = []
  try { datasets = store.readDatasets(dataDir) } catch (err) { log.warn(err.message) }
  const rowTotal = datasets.reduce((s, d) => s + (d.rows || []).length, 0)
  out.datasets = datasets.length
  out.datasetRows = rowTotal
  log(`数据集   ${datasets.length} 个 / ${rowTotal} 行`)

  // 名册：能读到的逐份统计，读不到只提示（不能让 status 因为一份坏文件就整个失败）
  const rosters = []
  for (const f of cfg.rosters || []) {
    const p = path.join(cfg.rosterDir, f)
    if (!fs.existsSync(p)) { rosters.push({ file: f, exists: false }); continue }
    try {
      const r = roster.readRoster(p, cfg)
      const rows = r.units.reduce((s, u) => s + u.rows.length, 0)
      rosters.push({ file: f, exists: true, units: r.units.length, rows })
      log(`名册 ${f}  ${r.units.length} 家 / ${rows} 行`)
    } catch (err) {
      rosters.push({ file: f, exists: true, error: err.message })
      log.warn(`${f} 读取失败: ${err.message}`)
    }
  }
  out.rosters = rosters

  // 输出目录
  let unitDirs = []
  try {
    unitDirs = fs.readdirSync(cfg.outputDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !/^[_\.]/.test(e.name))
      .map(e => e.name)
  } catch { /* 目录不存在 */ }
  const png = store.listPng(cfg.outputDir).length
  let unitPng = 0
  for (const d of unitDirs) unitPng += store.listPng(path.join(cfg.outputDir, d)).length
  out.unitDirs = unitDirs.length
  out.png = unitPng
  log(`成品     ${unitDirs.length} 家单位目录 / ${unitPng} 张 PNG${png ? `（根目录另有 ${png} 张）` : ''}`)

  // 备份目录里躺着的成品数量：容易被当成「缺文件」，主动报出来
  const backup = store.scanBackup(cfg.backupDir)
  out.backupStems = backup.size
  if (backup.size) log.warn(`备份目录 ${cfg.backupDir} 里有 ${backup.size} 个 stem，可能含有效成品`)

  return out
}

module.exports = { run }

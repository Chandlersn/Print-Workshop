/* export：按名册批量出片。
 *
 * 口径（与工程一致，不做猜测）：
 *   应出文件 = `<编号>_<姓名>.png`，落在 outputDir/<工作表名>/
 *   · 编号为空的行不出（这些人在补充名单里已按 5xxx 出过，重导只会造 `_姓名.png` 垃圾）
 *   · 必填字段有空值的行不出（写了也是空白栏的废纸）
 *   · 出片前逐行核对数据集与名册的「编号+姓名」，行序漂移立即中止 —— 这是唯一能
 *     挡住「数据集被重新导入导致行序变化、结果把 A 的证书发给 B」的闸门
 *   · 每个单位出完立刻回扫磁盘复核，缺行记进失败清单，不靠 API 返回值自证
 */
const fs = require('fs')
const path = require('path')
const roster = require('../roster.cjs')
const store = require('../store.cjs')
const select = require('../select.cjs')
const report = require('../report.cjs')
const { Host } = require('../host.cjs')
const { UsageError } = require('../cli.cjs')

/**
 * 算「这一批要出什么」——纯函数，不碰宿主，便于单测。
 * @returns {{tasks:Array, blocked:Array, stats:object}}
 */
function planExport(cfg, rosterObj, opts) {
  const { range = {}, allowIncomplete = false, limit = 0, includeBackup = false } = opts
  const datasets = opts.datasets || []
  // 备份目录里的图是「上一次出片的旧版」，可能已经过时，所以默认不采信。
  // 但必须报出来：不报的话用户会以为一张没出过，白白重跑一遍。
  const backupStems = opts.backupStems || new Set()

  const tasks = []
  const blocked = []
  const skippedNoCode = []
  const already = []
  const backupOnly = []
  const columnIssues = []
  let totalRows = 0

  for (const unit of rosterObj.units) {
    if (!roster.inRange(unit.no, range)) continue
    totalRows += unit.rows.length
    if (unit.missingColumns.length) columnIssues.push({ unit: unit.sheet, missing: unit.missingColumns })

    const ds = store.pickDataset(datasets, unit.sheet)
    const folder = select.unitDir(cfg, unit.sheet)
    const scan = store.scanFolder(folder)
    const missing = []

    for (const row of unit.rows) {
      if (!row.code) { skippedNoCode.push({ unit: unit.sheet, row }); continue }
      const stem = roster.fileStem(row)
      if (scan.stems.has(stem)) { already.push({ unit: unit.sheet, row }); continue }

      const inBackup = backupStems.has(stem)
      if (inBackup && includeBackup) { already.push({ unit: unit.sheet, row }); continue }
      if (inBackup) backupOnly.push({ unit: unit.sheet, row })

      if (row.blanks.length && !allowIncomplete) {
        blocked.push({ unit: unit.sheet, row, blanks: row.blanks })
        continue
      }
      missing.push(row)
    }

    if (!missing.length) continue
    tasks.push({ unit, dataset: ds, folder, rows: limit ? missing.slice(0, limit) : missing })
  }

  return {
    tasks,
    blocked,
    skippedNoCode,
    already,
    backupOnly,
    columnIssues,
    stats: {
      totalRows,
      already: already.length,
      skippedNoCode: skippedNoCode.length,
      blocked: blocked.length,
      backupOnly: backupOnly.length,
      todoRows: tasks.reduce((s, t) => s + t.rows.length, 0),
    },
  }
}

/** 核对数据集行序：missing 里每一行都必须能对上数据集同索引的编号+姓名。 */
function assertAligned(task, fileFields) {
  const [kCode, kName] = fileFields
  const dsRows = task.dataset.rows || []
  const bad = []
  for (const row of task.rows) {
    const d = dsRows[row.dataRow]
    if (!d) { bad.push(`行 ${row.dataRow}：数据集不存在`); continue }
    const c = String(d[kCode] ?? '').trim()
    const n = String(d[kName] ?? '').trim()
    if (c !== String(row.code) || n !== String(row.name)) {
      bad.push(`行 ${row.dataRow}：数据集「${c}_${n}」≠ 名册「${row.code}_${row.name}」`)
    }
  }
  if (bad.length) {
    throw new Error(`${task.unit.sheet} 数据集与名册行序不一致，拒绝出片（否则会把证书发错人）：\n  ` + bad.slice(0, 5).join('\n  '))
  }
}

async function run(ctx) {
  const { cfg, log, range, flags, dry } = ctx
  const file = select.singleRoster(ctx)
  const rosterObj = roster.readRoster(file, cfg)

  let datasets = []
  try { datasets = store.readDatasets(ctx.dataDir) } catch (err) {
    throw new Error(`读不到数据集（${err.message}）——如果这批是首次导入，先跑 import`)
  }

  const plan = planExport(cfg, rosterObj, {
    range,
    allowIncomplete: Boolean(flags['allow-incomplete']),
    limit: Number(flags.limit) || 0,
    includeBackup: Boolean(flags['include-backup']),
    datasets,
    backupStems: store.scanBackup(cfg.backupDir),
  })

  const { stats } = plan

  // ── 校验报告：拦截 + 编号空 + 整表缺列，一次写全 ──
  const reportFile = select.outPath(ctx, `字段校验_${path.basename(file, path.extname(file))}`, '.csv')
  report.writeCsv(reportFile, ['类别', '单位', 'Excel行号', '文件', '缺字段'], [
    ...plan.blocked.map(b => ({ 类别: '字段不全·已拦截', 单位: b.unit, Excel行号: b.row.excelRow, 文件: roster.fileStem(b.row), 缺字段: b.blanks.join('/') })),
    ...plan.skippedNoCode.map(s => ({ 类别: '编号为空·跳过', 单位: s.unit, Excel行号: s.row.excelRow, 文件: s.row.name, 缺字段: '' })),
    ...plan.columnIssues.map(c => ({ 类别: '整表缺列', 单位: c.unit, Excel行号: '', 文件: '', 缺字段: c.missing.join('/') })),
  ])

  log(`名册 ${rosterObj.units.length} 家 / ${stats.totalRows} 行（${path.basename(file)}）`)
  log(`已出 ${stats.already} ｜ 编号空跳过 ${stats.skippedNoCode} ｜ 字段不全拦截 ${stats.blocked} ｜ 待出 ${stats.todoRows} 行 / ${plan.tasks.length} 家`)
  if (stats.backupOnly) {
    log.warn(`${stats.backupOnly.length} 张的成品只在备份目录里（${cfg.backupDirName}），按「待出」处理。`)
    log.warn(`  那些图是上次出片的旧版，可能已过时；若确认可用，加 --include-backup 直接认它，不重出。`)
  }
  for (const b of plan.blocked.slice(0, 8)) {
    log(`  ${'⛔'} ${b.unit} · ${roster.fileStem(b.row) || b.row.name} 缺 ${b.blanks.join('/')}`)
  }
  if (plan.blocked.length > 8) log(`  ${'⛔'} …等 ${plan.blocked.length} 行，详见 ${reportFile}`)
  for (const c of plan.columnIssues) log.warn(`${c.unit} 整表缺列: ${c.missing.join(' / ')}`)

  if (!plan.tasks.length) {
    log(`无需出片${stats.blocked ? '（有拦截，补数据后可出）' : ''}`)
    return { summary: '', exitCode: stats.blocked ? 1 : 0, report: reportFile, stats }
  }

  // 全部任务先做行序核对：任何一处错位都在出第一张之前暴露
  for (const t of plan.tasks) {
    if (!t.dataset) throw new Error(`${t.unit.sheet} 没有对应数据集 —— 先跑 import`)
    assertAligned(t, cfg.fileNameFields)
  }
  log('行序核对通过（数据集与名册逐行一致）')

  if (dry) {
    for (const t of plan.tasks) {
      log(`  [dry] ${t.unit.sheet}：${t.rows.length} 行 → ${t.folder}`)
    }
    log(`DRY：计划出 ${stats.todoRows} 张，未执行`)
    return { summary: '', exitCode: 0, dry: true, stats, report: reportFile }
  }

  const host = new Host({
    repoRoot: cfg.__repoRoot,
    dataDir: ctx.dataDir,
    allowWrite: true,
    verbose: ctx.verbose,
    log,
  })
  await host.open()
  log('宿主已连接')

  // --probe：只跑第一家。改过公共逻辑后先用它验证一张再放全量，比事后回滚便宜得多
  const runTasks = flags.probe ? plan.tasks.slice(0, 1) : plan.tasks
  if (flags.probe && plan.tasks.length) log(`探针模式：只跑 ${runTasks[0].unit.sheet}`)

  let done = 0
  const failed = []
  let idx = 0
  try {
    for (const task of runTasks) {
      idx++
      const t0 = Date.now()
      log(`${'▶'} [${idx}/${runTasks.length}] ${task.unit.sheet}：${task.rows.length} 行`)
      try {
        const res = await host.callTool('pp_print_exportImages', {
          datasetId: task.dataset.id,
          templateId: cfg.templateId,
          rows: task.rows.map(r => r.dataRow),
          outputDir: task.folder,
          field1: cfg.fileNameFields[0],
          field2: cfg.fileNameFields[1],
          outputDpi: cfg.outputDpi,
        })
        done += (res && res.count) || 0

        // 不信任返回值，回扫磁盘：API 说 5 张但盘上只有 4 张的情况真实存在
        const after = store.scanFolder(task.folder)
        const short = task.rows.filter(r => !after.stems.has(roster.fileStem(r)))
        const secs = ((Date.now() - t0) / 1000).toFixed(1)
        if (short.length) {
          log(`  ${'⚠️ '} ${res.count} 张，${secs}s —— 仍缺 ${short.length} 行`)
          failed.push({ unit: task.unit.sheet, rows: short.map(r => roster.fileStem(r)) })
        } else {
          log(`  ${'✅'} ${res.count} 张，${secs}s`)
        }
      } catch (err) {
        log(`  ${'❌'} ${err.message}`)
        failed.push({ unit: task.unit.sheet, error: err.message })
      }
    }
  } finally {
    await host.close()
  }

  log(`本轮出片 ${done} 张；失败/未齐 ${failed.length} 处；字段不全拦截 ${stats.blocked} 行`)
  for (const f of failed) log(`  - ${JSON.stringify(f)}`)
  log(`校验报告: ${reportFile}`)

  return {
    summary: failed.length
      ? `结论：出 ${done} 张，有 ${failed.length} 处未完成，见上`
      : `结论：出 ${done} 张，全部落盘`,
    exitCode: failed.length || stats.blocked ? 1 : 0,
    exported: done,
    failed,
    blocked: plan.blocked.length,
    report: reportFile,
    stats,
  }
}

module.exports = { run, planExport, assertAligned }

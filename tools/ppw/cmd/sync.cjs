/* sync：把 Excel 某单位某几列的最新值同步进数据集，再整单位重出。
 *
 * 跟 fix 的分工：
 *   fix  —— 手工指定「谁、改哪个字段」（适合零星修正、也适合改姓名）
 *   sync —— 按 Excel 整列对齐同步（适合用户把一整个单位的某列补全了）
 *
 * 行对齐是硬要求：Excel 与数据集按 dataRow 一一对应，姓名对不上就整批拒绝执行。
 * 宁可不出，也不能把 A 的证书发给 B。
 */
const fs = require('fs')
const path = require('path')
const XLSX = require('xlsx')
const roster = require('../roster.cjs')
const store = require('../store.cjs')
const select = require('../select.cjs')
const { Host } = require('../host.cjs')
const { UsageError, need } = require('../cli.cjs')
const { batchLabel, matchHeader } = require('../config.cjs')

/** --cols 支持数据集字段名，也支持 Excel 表头（走 requiredFields 的匹配规则）。 */
function resolveCols(cfg, header, colArg) {
  const wanted = String(colArg).split(',').map(s => s.trim()).filter(Boolean)
  if (!wanted.length) throw new UsageError('--cols 需要至少一个列名')
  return wanted.map(name => {
    const spec = cfg.requiredFields.find(f => f.key === name)
    const i = spec ? matchHeader(header, spec.match) : header.indexOf(name)
    if (i < 0) {
      throw new UsageError(
        `Excel 里找不到列「${name}」。\n  可用字段: ${cfg.requiredFields.map(f => f.key).join(' / ')}\n  实际表头: ${header.filter(Boolean).join(' / ')}`
      )
    }
    return { key: name, index: i }
  })
}

async function run(ctx) {
  const { cfg, log, dry, flags } = ctx
  const file = select.singleRoster(ctx)
  const sheet = need(flags, 'sheet', '工作表名，如 121_惠州市艺述家艺术培训有限公司')
  const cols = need(flags, 'cols', '要同步的列，逗号分隔')

  const { grid } = roster.readGrid(file, sheet)
  if (!grid.length) throw new Error(`工作表为空: ${sheet}`)
  const header = grid[0].map(h => String(h ?? '').trim())
  const colSpecs = resolveCols(cfg, header, cols)

  const parsed = roster.parseSheet(grid, sheet, cfg)
  const iName = matchHeader(header, 'prefix:姓名')

  const datasets = store.readDatasets(ctx.dataDir)
  const ds = store.pickDataset(datasets, sheet)
  if (!ds) throw new Error(`找不到数据集: ${sheet} —— 先跑 import`)

  log(`Excel ${sheet}：${parsed.rows.length} 行 ｜ 数据集 ${ds.name}：${(ds.rows || []).length} 行`)
  log(`同步列 ${colSpecs.map(c => c.key).join(' / ')}`)

  // ── 行对齐 ──
  const misaligned = []
  for (const row of parsed.rows) {
    const d = (ds.rows || [])[row.dataRow]
    if (!d) { misaligned.push(`行 ${row.excelRow}「${row.name}」数据集不存在`); continue }
    const dn = String(d[cfg.fileNameFields[1]] ?? '').trim()
    if (dn !== row.name) misaligned.push(`行 ${row.excelRow}：Excel「${row.name}」≠ 数据集「${dn}」`)
  }
  if (misaligned.length) {
    throw new Error(`行对齐失败，拒绝同步（否则会改错人的字段）：\n  ` + misaligned.slice(0, 8).join('\n  '))
  }

  // ── 算差异 ──
  const diffs = []
  const rawGrid = grid.slice(1).filter(r => r && r.some(c => String(c ?? '').trim() !== ''))
  for (let k = 0; k < parsed.rows.length; k++) {
    const row = parsed.rows[k]
    const r = rawGrid[k]
    for (const c of colSpecs) {
      const want = String(r[c.index] ?? '').trim()
      const have = String((ds.rows[row.dataRow] || {})[c.key] ?? '').trim()
      if (want !== have) diffs.push({ dataRow: row.dataRow, name: row.name, key: c.key, from: have, to: want })
    }
  }

  log(`需要同步 ${diffs.length} 处`)
  for (const d of diffs.slice(0, 30)) log(`   行${parsed.rows.find(p => p.dataRow === d.dataRow).excelRow} ${d.name} ${d.key}: 「${d.from}」→「${d.to}」`)
  if (diffs.length > 30) log(`   …等 ${diffs.length} 处`)

  const expected = parsed.rows.filter(r => r.code)
  log(`将重出 ${expected.length} 张`)

  if (dry) {
    log('DRY：未改数据、未出片')
    return { summary: '', exitCode: 0, dry: true, diffs, willExport: expected.length }
  }

  // 没有任何差异却重出整单位，纯属浪费：19 张要一分半钟，且旧图会被挪走再生成一遍
  if (!diffs.length && !flags.force) {
    log('Excel 与数据集没有差异，跳过重出（确实想整单位重印请加 --force）')
    return { summary: '结论：无需同步，也未重出', exitCode: 0, synced: 0, exported: 0, missing: [], skipped: true }
  }

  const host = new Host({ repoRoot: cfg.__repoRoot, dataDir: ctx.dataDir, allowWrite: true, verbose: ctx.verbose, log })
  await host.open()
  log('宿主已连接')

  const result = { synced: 0, exported: 0, missing: [] }
  try {
    for (const d of diffs) {
      await host.callTool('pp_dataset_updateCell', { datasetId: ds.id, rowIndex: d.dataRow, key: d.key, value: d.to })
      result.synced++
    }
    if (diffs.length) {
      const after = store.readDatasets(ctx.dataDir)
      const ds2 = after.find(x => x.id === ds.id)
      const bad = diffs.filter(d => String(ds2.rows[d.dataRow][d.key] ?? '').trim() !== d.to)
      if (bad.length) throw new Error('回读失败: ' + bad.map(b => `${b.name}/${b.key}`).join(', '))
      log(`数据集回读确认 OK（${result.synced} 处）`)
    } else {
      log('没有需要同步的差异（Excel 与数据集已一致）')
    }

    // ── 旧图整体挪进备份，避免出片 API 加「 (2)」后缀 ──
    const folder = select.unitDir(cfg, sheet)
    const bakDir = path.join(cfg.backupDir, sheet)
    let moved = 0
    for (const e of expected) {
      const [kCode, kName] = cfg.fileNameFields
      const d = ds.rows[e.dataRow]
      const code = String(e.code || d[kCode] || '').trim()
      const t = path.join(folder, `${code}_${e.name}.png`)
      if (!fs.existsSync(t)) continue
      fs.mkdirSync(bakDir, { recursive: true })
      fs.renameSync(t, path.join(bakDir, `${code}_${e.name}.png`))
      moved++
    }
    if (moved) log(`旧图 ${moved} 张已挪到 ${path.relative(cfg.outputDir, bakDir)}/`)

    const t0 = Date.now()
    const res = await host.callTool('pp_print_exportImages', {
      datasetId: ds.id,
      templateId: cfg.templateId,
      rows: expected.map(e => e.dataRow),
      outputDir: folder,
      field1: cfg.fileNameFields[0],
      field2: cfg.fileNameFields[1],
      outputDpi: cfg.outputDpi,
    })
    result.exported = (res && res.count) || 0
    log(`出片 ${result.exported} 张，${((Date.now() - t0) / 1000).toFixed(1)}s`)

    const scan = store.scanFolder(folder)
    result.missing = expected
      .map(e => {
        const code = String(e.code || ds.rows[e.dataRow][cfg.fileNameFields[0]] || '').trim()
        return { stem: `${code}_${e.name}`, name: e.name }
      })
      .filter(x => !scan.stems.has(x.stem))
    log(result.missing.length
      ? `${'⚠️ '} 仍缺 ${result.missing.length}: ` + result.missing.map(m => m.stem).join(', ')
      : '文件数核对 OK')
  } finally {
    await host.close()
  }

  return {
    summary: result.missing.length
      ? `结论：同步 ${result.synced} 处，出 ${result.exported} 张，仍缺 ${result.missing.length}`
      : `结论：同步 ${result.synced} 处，出 ${result.exported} 张，全部落盘`,
    exitCode: result.missing.length ? 1 : 0,
    ...result,
  }
}

module.exports = { run, resolveCols }

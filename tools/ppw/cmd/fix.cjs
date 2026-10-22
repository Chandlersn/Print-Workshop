/* fix：改指定人的字段，然后重出那一张。
 *
 * 这是「Excel 改了、数据集没变」的专用解药。出片读的是数据集副本，不是 Excel 原件，
 * 所以改了 Excel 直接重出，新图和旧图 MD5 会一模一样 —— 今天在 4473_乔晨 上验证过。
 *
 * 三个必须处理好的细节：
 *  1. 目标文件已存在时，出片 API 会给新文件加「 (2)」后缀。所以先把旧图挪进备份目录。
 *  2. 改姓名会连带改文件名（871_刘郑雅文 → 871_刘郑雅雯）。旧图按旧名挪，新图按新名落，
 *     判断成败只能看新名文件，不能看脚本自己按旧名的比对结果。
 *  3. 文件名编号取数据集第一列；该列为空时（编号空的人）退而用磁盘现有文件的前缀。
 */
const fs = require('fs')
const path = require('path')
const store = require('../store.cjs')
const select = require('../select.cjs')
const { Host } = require('../host.cjs')
const { UsageError } = require('../cli.cjs')

/** 解析任务：--task '<json>' 优先；也接受 --task-file。另外支持单条 --sheet/--name/--set。 */
function readTasks(flags) {
  let raw = flags.task
  if (!raw && flags['task-file']) raw = fs.readFileSync(path.resolve(String(flags['task-file'])), 'utf-8')

  if (raw && raw !== true) {
    const text = String(raw)
    const arr = JSON.parse(text)
    if (!Array.isArray(arr) || !arr.length) throw new UsageError('--task 需要非空 JSON 数组')
    return arr
  }

  // 单条简写：--sheet 9_某单位 --name 某某 [--set 字段=值 ...]
  // --set 可以不给：那就是「不改字段、只把这一张重印一次」
  if (flags.sheet && flags.name) {
    const set = {}
    const sets = flags.set === undefined ? [] : [].concat(flags.set)
    for (const s of sets) {
      const i = String(s).indexOf('=')
      if (i < 0) throw new UsageError(`--set 需要 字段=值 形式，收到 ${JSON.stringify(s)}`)
      set[String(s).slice(0, i).trim()] = String(s).slice(i + 1)
    }
    return [{ sheet: String(flags.sheet), name: String(flags.name), set }]
  }

  throw new UsageError("缺少任务：用 --task '<json数组>' 或 --sheet/--name [--set 字段=值]")
}

/** 解析每条任务的落点：数据集、行号、文件名编号、目标文件名。纯函数。 */
function resolveTask(cfg, datasets, task) {
  const ds = store.pickDataset(datasets, task.sheet)
  if (!ds) throw new Error(`找不到数据集: ${task.sheet}`)

  const rowIndex = store.findRow(ds, { name: task.name })
  if (rowIndex < 0) throw new Error(`数据集里找不到「${task.name}」（${task.sheet}）`)

  const dsRow = ds.rows[rowIndex]
  const [kCode, kName] = cfg.fileNameFields
  const oldName = String(dsRow[kName] ?? '').trim()
  const newName = String((task.set && task.set[kName]) || oldName).trim()

  const folder = select.unitDir(cfg, task.sheet)
  let files = []
  try { files = store.listPng(folder) } catch { /* 目录不存在 */ }
  const existing = files
    .map(f => ({ file: f, stem: store.stemOf(f) }))
    .find(x => x.stem === `${String(dsRow[kCode] ?? '').trim()}_${oldName}` || x.stem.endsWith('_' + oldName))

  // 文件名里的编号：优先用 set 里新给的值（改编号也走这条路），其次数据集现值，最后磁盘前缀
  const explicit = task.set && task.set[kCode]
  const fileCode = String(explicit || dsRow[kCode] || (existing ? existing.stem.slice(0, existing.stem.indexOf('_')) : '')).trim()
  if (!fileCode) throw new Error(`无法确定文件名编号（${task.sheet} · ${task.name} 的第一列为空，磁盘上也没有同名文件）`)

  return {
    ...task,
    dataset: ds,
    rowIndex,
    folder,
    oldName,
    newName,
    expect: `${fileCode}_${newName}.png`,
    existing: existing ? existing.file : null,
    changes: Object.entries(task.set || {})
      .map(([k, v]) => ({ key: k, from: String(dsRow[k] ?? '').trim(), to: String(v).trim() }))
      .filter(c => c.from !== c.to),
  }
}

async function run(ctx) {
  const { cfg, log, dry } = ctx
  const rawTasks = readTasks(ctx.flags)
  const datasets = store.readDatasets(ctx.dataDir)

  const tasks = rawTasks.map(t => resolveTask(cfg, datasets, t))

  log(`任务 ${tasks.length} 条`);
  for (const t of tasks) {
    const chg = t.changes.length
      ? t.changes.map(c => `${c.key}:「${c.from}」→「${c.to}」`).join('；')
      : '（字段已是目标值，只重出）'
    log(`  ${t.sheet} · ${t.name}  row=${t.rowIndex}  现有=${t.existing || '(无图)'}  目标=${t.expect}`)
    log(`    ${chg}`)
  }

  if (dry) {
    log('DRY：未改数据、未出片')
    return { summary: '', exitCode: 0, dry: true, tasks: tasks.map(t => ({ sheet: t.sheet, name: t.name, changes: t.changes })) }
  }

  const host = new Host({ repoRoot: cfg.__repoRoot, dataDir: ctx.dataDir, allowWrite: true, verbose: ctx.verbose, log })
  await host.open()
  log('宿主已连接')

  const result = { changed: 0, exported: 0, failed: [] }
  try {
    // ── 写字段 ──
    for (const t of tasks) {
      for (const c of t.changes) {
        await host.callTool('pp_dataset_updateCell', {
          datasetId: t.dataset.id, rowIndex: t.rowIndex, key: c.key, value: c.to,
        })
        result.changed++
        log(`  ✎ [${t.name}] ${c.key}: 「${c.from}」→「${c.to}」`)
      }
    }

    // ── 回读确认：写成功不等于落盘成功，必须回读 ──
    if (result.changed) {
      const after = store.readDatasets(ctx.dataDir)
      for (const t of tasks) {
        const ds2 = after.find(d => d.id === t.dataset.id)
        if (!ds2) throw new Error(`回读时数据集消失: ${t.dataset.name}`)
        const bad = t.changes.filter(c => String(ds2.rows[t.rowIndex][c.key] ?? '').trim() !== c.to)
        if (bad.length) throw new Error(`回读失败（${t.name}）: ` + bad.map(b => b.key).join('/'))
      }
      log(`数据集回读确认 OK（${result.changed} 处）`)
    }

    // ── 逐条出片 ──
    for (const t of tasks) {
      const target = path.join(t.folder, t.expect)
      // 旧图必须挪走，否则新图会落成「xxx (2).png」。
      // 改姓名时旧图（旧名）与新名落点是两个路径，两个都要清。
      const toMove = new Set()
      if (t.existing) toMove.add(path.join(t.folder, t.existing))
      if (fs.existsSync(target)) toMove.add(target)

      for (const p of toMove) {
        if (!fs.existsSync(p)) continue
        const bakDir = path.join(cfg.backupDir, t.sheet)
        fs.mkdirSync(bakDir, { recursive: true })
        const bak = path.join(bakDir, `${store.stemOf(path.basename(p))}_改前.png`)
        fs.renameSync(p, bak)
        log(`  旧图 → ${path.relative(cfg.outputDir, bak)}`)
      }

      const t0 = Date.now()
      const res = await host.callTool('pp_print_exportImages', {
        datasetId: t.dataset.id,
        templateId: cfg.templateId,
        rows: [t.rowIndex],
        outputDir: t.folder,
        field1: cfg.fileNameFields[0],
        field2: cfg.fileNameFields[1],
        outputDpi: cfg.outputDpi,
      })
      result.exported += (res && res.count) || 0

      const ok = fs.existsSync(target)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      if (ok) {
        log(`  ${'✅'} [${t.newName}] ${res.count} 张，${secs}s → ${t.expect}  ${fs.statSync(target).size} B`)
      } else {
        log(`  ${'⚠️ '} [${t.newName}] ${res.count} 张，${secs}s，但没找到预期文件 ${t.expect}`)
        result.failed.push({ sheet: t.sheet, name: t.newName, expect: t.expect })
      }
    }
  } finally {
    await host.close()
  }

  return {
    summary: result.failed.length
      ? `结论：改 ${result.changed} 处，出 ${result.exported} 张，${result.failed.length} 条未落盘`
      : `结论：改 ${result.changed} 处，出 ${result.exported} 张，全部落盘`,
    exitCode: result.failed.length ? 1 : 0,
    ...result,
  }
}

module.exports = { run, resolveTask, readTasks }

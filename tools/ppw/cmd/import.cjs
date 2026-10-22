/* import：把名册按工作表拆成数据集，并点亮模板用到的列开关。
 *
 * 为什么单独一步：export 只会「找已有数据集」，不会替你导入。181-234 那批
 * 首次跑时日志写着「无需出片」，其实是一家都没导入 —— 静默跳过看着像跑完了。
 * 所以 export 现在遇到空数据集会直接报错，并提示先 import。
 *
 * 重复导入会造出同名数据集（同一单位两份），出片时取哪份变成运气问题。
 * 因此默认检测到同前缀数据集就拒绝执行，--force 才继续。
 */
const path = require('path')
const fs = require('fs')
const store = require('../store.cjs')
const select = require('../select.cjs')
const { Host } = require('../host.cjs')


async function run(ctx) {
  const { cfg, log, flags, dry } = ctx
  const file = select.singleRoster(ctx)
  // 数据集名 = 「<名单文件名>·<工作表名>」，前缀必须用完整文件名（含「合并_」），
  // 不能用 batchLabel（那是去掉「合并_」的展示用标签），否则重复导入检测永远为 0
  const prefix = path.basename(file, path.extname(file)) + '·'

  const wb = require('xlsx').readFile(file, { dense: false })
  const sheetNames = wb.SheetNames

  let before = []
  try { before = store.readDatasets(ctx.dataDir) } catch { /* 首次运行允许没有文件 */ }
  const existing = before.filter(d => String(d.name || '').startsWith(prefix))

  log(`名册 ${path.basename(file)}：${sheetNames.length} 个工作表`)
  log(`已存在同批次数据集 ${existing.length} 个（前缀 ${prefix}）`)

  if (existing.length && !flags.force) {
    throw new Error(
      `这批已经导入过 ${existing.length} 个单位数据集，重复导入会产生同名副本，出片时取哪份不确定。\n` +
      `  想只补新增的单位：先手动删掉对应数据集，或用 --force 明知会重复。\n` +
      `  只是想出片请直接跑 export。`
    )
  }

  if (dry) {
    log(`DRY：将导入 ${sheetNames.length} 个 sheet，并点亮 ${cfg.requiredFields.length} 个必填列`)
    return { summary: '', exitCode: 0, dry: true, sheets: sheetNames.length, existing: existing.length }
  }

  const host = new Host({ repoRoot: cfg.__repoRoot, dataDir: ctx.dataDir, allowWrite: true, verbose: ctx.verbose, log })
  await host.open()
  log('宿主已连接')

  const result = { sheets: sheetNames.length, created: 0, rows: 0, printOn: 0, warnings: [] }
  try {
    const t0 = Date.now()
    const res = await host.callTool('pp_dataset_importSheets', {
      filePath: file,
      selections: sheetNames.map(name => ({ name, headerRow: 0 })),
      mode: 'split',
    })
    result.created = Array.isArray(res) ? res.length : Number(res && res.count) || 0
    log(`导入完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，新建数据集 ${result.created} 个`)

    // 点亮「印」开关：只点亮模板真正用到的列，全点亮会让数据集面板噪音变大
    const created = store.readDatasets(ctx.dataDir).filter(d => String(d.name || '').startsWith(prefix))
    const wantKeys = cfg.requiredFields.map(f => f.key)
    for (const ds of created) {
      const keys = (ds.columns || []).map(c => c.key)
      const missing = wantKeys.filter(k => !keys.includes(k))
      if (missing.length) {
        result.warnings.push(`${ds.name} 缺列: ${missing.join('/')}`)
        log.warn(`${ds.name} 缺列: ${missing.join(' / ')}`)
      }
      for (const k of wantKeys.filter(k => keys.includes(k))) {
        await host.callTool('pp_dataset_setColumnPrint', { datasetId: ds.id, key: k, printOn: true })
        result.printOn++
      }
    }
    result.rows = created.reduce((s, d) => s + (d.rows || []).length, 0)
    log(`「印」开关点亮 ${result.printOn} 个；数据集 ${created.length} 个 / ${result.rows} 行`)

    // 回读验证：开关没亮全的话，出片时那一列会是空的
    const verify = store.readDatasets(ctx.dataDir).filter(d => String(d.name || '').startsWith(prefix))
    let ok = true
    for (const ds of verify) {
      const on = new Set((ds.columns || []).filter(c => c.printOn === true).map(c => c.key))
      const expect = wantKeys.filter(k => (ds.columns || []).some(c => c.key === k))
      if (!expect.every(k => on.has(k))) { ok = false; log.err(`${ds.name} 印开关异常`); }
    }
    result.verified = ok
    log(ok ? '回读验证通过' : '回读验证未通过')
    return { ...result, summary: ok ? `结论：导入 ${result.created} 家 / ${result.rows} 行` : '结论：导入完成但开关验证未通过', exitCode: ok ? 0 : 1 }
  } finally {
    await host.close()
  }
}

module.exports = { run }

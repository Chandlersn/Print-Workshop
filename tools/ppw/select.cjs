/* select：决定「这次处理哪些名册 / 哪个输出目录」。
 *
 * 每个命令都要做这件事，抽出来免得各写一遍还写得不一致。
 */
const fs = require('fs')
const path = require('path')
const { UsageError } = require('./cli.cjs')

/**
 * Excel / WPS 打开文件时会在同目录留一个「~$文件名」的锁文件。
 * 磁盘上的 mtime 只到**上一次保存**为止：用户屏幕上改了、还没按 Ctrl+S，
 * 磁盘里仍是旧值——这时任何「读名册」都读不到他的改动，而人以为已经改好了。
 * 这是唯一能提前发现的线索，必须提示，否则会出现「他说改了、你说没差别」的死循环。
 */
function warnIfOpenInEditor(ctx, files) {
  for (const f of files) {
    const lock = path.join(path.dirname(f), '~$' + path.basename(f))
    if (!fs.existsSync(lock)) continue
    let age = ''
    try {
      const min = Math.round((Date.now() - fs.statSync(lock).mtimeMs) / 60000)
      age = min >= 1 ? `（已打开约 ${min} 分钟）` : ''
    } catch { /* 拿不到时间就不说 */ }
    ctx.log.warn(`${path.basename(f)} 正被 Excel/WPS 打开${age}：`
      + `磁盘内容是「上次保存」的版本，你屏幕上的改动如果还没 Ctrl+S，我这边读不到`)
  }
}

/**
 * 名册文件选择：
 *   --roster 合并_61-120号.xlsx     单个（相对 rosterDir 解析）
 *   --roster 目录                   目录下全部 .xlsx（不含 ~$ 临时文件）
 *   --all                           配置里的 rosters
 */
function rosterFiles(ctx) {
  const { cfg, flags } = ctx
  const pick = []

  const addDir = (dir) => {
    const names = fs.readdirSync(dir)
      .filter(f => /\.xlsx?$/i.test(f) && !f.startsWith('~$') && !f.startsWith('.'))
      .sort()
    if (!names.length) throw new UsageError(`目录里没有 xlsx: ${dir}`)
    for (const n of names) pick.push(path.join(dir, n))
  }

  if (flags.all) {
    for (const f of cfg.rosters || []) {
      const p = path.isAbsolute(f) ? f : path.join(cfg.rosterDir, f)
      if (!fs.existsSync(p)) ctx.log.warn(`名册不存在，跳过: ${p}`)
      else pick.push(p)
    }
  } else if (flags.roster) {
    const p = path.isAbsolute(String(flags.roster))
      ? String(flags.roster)
      : path.join(cfg.rosterDir, String(flags.roster))
    if (!fs.existsSync(p)) throw new UsageError(`名册不存在: ${p}`)
    if (fs.statSync(p).isDirectory()) addDir(p)
    else pick.push(p)
  } else if (flags['roster-dir']) {
    addDir(cfg.rosterDir)
  }

  if (!pick.length) throw new UsageError('需要 --roster <文件|目录> 或 --all 指定名册')
  warnIfOpenInEditor(ctx, pick)
  return pick
}

/** 单份名册（export / import / sync 只处理一份，避免混批） */
function singleRoster(ctx) {
  const all = rosterFiles(ctx)
  if (all.length > 1) {
    throw new UsageError(`该命令一次只处理一份名册，当前命中 ${all.length} 份；请用 --roster 指定其中一份`)
  }
  return all[0]
}

/** 输出目录下的单位目录路径 */
function unitDir(cfg, sheet) {
  return path.join(cfg.outputDir, sheet)
}

/** 报告输出路径：--out > （csv 进 csvDir，xlsx 进 reportDir）
 *  桌面只留给人看的 xlsx；字段校验、漂移明细这类中间产物收进 _报告/ 子目录。 */
function outPath(ctx, baseName, ext) {
  if (ctx.flags.out) {
    const p = String(ctx.flags.out)
    return path.isAbsolute(p) ? p : path.resolve(p)
  }
  const dir = ext === '.csv' ? (ctx.cfg.csvDir || ctx.cfg.reportDir) : ctx.cfg.reportDir
  return path.join(dir, `${baseName}${ext}`)
}

module.exports = { rosterFiles, singleRoster, unitDir, outPath, warnIfOpenInEditor }

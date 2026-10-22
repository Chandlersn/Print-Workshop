#!/usr/bin/env node
/* ppw —— 批印坊批处理工作台（PrintPress Workflow）
 *
 * pp 走「一次 API 调用」，ppw 走「一批任务」：读名册、连宿主、按单位出片、三方对账。
 * 两者共用同一份 electron/api.cjs，业务逻辑一行都不在这里重复实现。
 *
 * 用法：node tools/ppw.cjs <命令> [参数] [选项]      详见 node tools/ppw.cjs help
 *
 * 退出码：0 成功 ｜ 1 有失败/有拦截 ｜ 2 用法错误
 */
const path = require('path')
const { parseArgs, makeLogger, UsageError, num, parseUnitSet } = require('./ppw/cli.cjs')
const config = require('./ppw/config.cjs')
const store = require('./ppw/store.cjs')

const COMMANDS = {
  status: './ppw/cmd/status.cjs',
  check: './ppw/cmd/check.cjs',
  import: './ppw/cmd/import.cjs',
  export: './ppw/cmd/export.cjs',
  fix: './ppw/cmd/fix.cjs',
  sync: './ppw/cmd/sync.cjs',
  audit: './ppw/cmd/audit.cjs',
  pending: './ppw/cmd/pending.cjs',
  drift: './ppw/cmd/drift.cjs',
  verify: './ppw/cmd/verify.cjs',
}

const HELP = `
ppw · 批印坊批处理工作台

用法
  node tools/ppw.cjs <命令> [位置参数] [选项]

离线命令（不连宿主，不写图）
  check      按必填字段体检整份名册，产出拦截明细 CSV
             --roster <文件> | --all        --unit 61,62  --from 121 --to 180
  audit      三层对账：名册×磁盘、名册×字段、名册×数据集，产出多页 XLSX
             --roster <文件|目录> | --all   --out <xlsx>
  pending    待补数据清单（缺字段的人 + 该重做还是该新出）
             --all                          --out <xlsx|csv>
  drift      只扫 Excel ↔ 数据集 的字段差异
             --roster <文件> | --all        --unit 61
  verify     校验模板要渲染的字段是否都被「印」开关点亮（关着 = 成品空白）
             --unit 61,62

出片命令（自动托管宿主进程）
  import     把名册按工作表拆成数据集，并点亮模板用到的列开关
             --roster <文件>
  export     批量出片，缺字段的行在写盘前拦下
             --roster <文件> --unit 61,62 --from 121 --to 180 --limit 2 --probe
  fix        改指定人的字段后重出单张（可一次多条）
             --task '<json>'  | --task-file <json文件>
             例：--task '[{"sheet":"59_某单位","name":"某某","set":{"所在学校必须写全名":"某某小学"}}]'
  sync       把某单位某几列的最新值从 Excel 同步进数据集，再整单位重出
             --roster <文件> --sheet 121_xxx --cols 指导老师,组别

通用选项
  --config <json>      指定配置文件（缺省找仓库根 / 当前目录的 ppw.config.json）
  --roster-dir <目录>   名册所在目录
  --output-dir <目录>   证书输出根目录
  --report-dir <目录>   报告输出目录（对账表 / 待补清单）
  --template <id>      证书模板 id
  --dpi <150|300|600>  出片分辨率，缺省 300
  --data-dir <目录>     批印坊数据目录（缺省与应用一致）
  --dry                只打印计划，不写数据、不出片、不改文件
  --json               结果以单行 JSON 输出（日志静默）
  --verbose            把宿主 stderr 也打出来
  -h, --help

必须先理解的两件事
  1. 出片读的是「批印坊数据集」，不是 Excel 原件。改完 Excel 必须 sync / fix 才会生效，
     否则重出的图和旧图一模一样（MD5 相同）。
  2. 跑批期间不要改数据集：markPrinted 会用宿主内存里的数据整份回写，改动会被覆盖。
     ppw 自己串行处理，所以只要不同时手工改就没问题。
`.trim()

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))

  if (!positional.length || flags.help || positional[0] === 'help') {
    process.stdout.write(HELP + '\n')
    return 0
  }

  const name = positional[0]
  const loader = COMMANDS[name]
  if (!loader) {
    process.stderr.write(`未知命令: ${name}\n运行 node tools/ppw.cjs help 查看全部命令\n`)
    return 2
  }

  const log = makeLogger(Boolean(flags.json))
  const cmd = require(loader)

  let cfg
  try {
    cfg = config.load(flags)
  } catch (err) {
    log.err(`配置错误: ${err.message}`)
    return 2
  }

  const dataDir = store.resolveDataDir(flags['data-dir'])

  const ctx = {
    cfg,
    flags,
    log,
    dataDir,
    positional: positional.slice(1),
    // 数值范围：--from / --to 纯数字，--unit 是集合
    range: {
      unit: parseUnitSet(flags.unit),
      from: num(flags, 'from', undefined),
      to: num(flags, 'to', undefined),
    },
    dry: Boolean(flags.dry),
    json: Boolean(flags.json),
    verbose: Boolean(flags.verbose),
  }

  if (ctx.json) {
    // --json 模式下只允许一行机器可读结果，日志全部改走 stderr
    const orig = ctx.log
    ctx.log = () => {}
    ctx.log.warn = () => {}
    ctx.log.err = orig.err
    ctx.log.raw = () => {}
  }

  try {
    const result = await cmd.run(ctx)
    if (ctx.json) process.stdout.write(JSON.stringify(result === undefined ? { ok: true } : result) + '\n')
    else if (result && result.summary) ctx.log(result.summary)
    return (result && Number.isInteger(result.exitCode)) ? result.exitCode : 0
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`用法错误: ${err.message}\n`)
      if (!ctx.json) process.stderr.write('运行 node tools/ppw.cjs help 查看用法\n')
      return 2
    }
    process.stderr.write(`失败: ${err.message}\n`)
    if (ctx.verbose && err.stack) process.stderr.write(err.stack + '\n')
    return 1
  }
}

main().then(code => process.exit(code)).catch(err => {
  process.stderr.write(`未捕获异常: ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})

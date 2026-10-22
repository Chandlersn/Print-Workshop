/* ppw 命令行公共件：argv 解析、日志、错误。
 *
 * 为什么布尔开关要显式登记：
 * `--unit 61` 与 `--dry` 长得很像，但前者带值后者不带。若靠「下一个 token 不以 - 开头就当值」，
 * `ppw export --dry 61` 会把 61 吞成 --dry 的值。显式白名单是唯一稳妥的判法。
 */

/** 不带值的开关。新增开关必须登记在这里，否则会被当成「等下个 token 当值」。 */
const BOOLEAN_FLAGS = new Set([
  'dry', 'json', 'probe', 'allow-incomplete', 'help', 'verbose', 'include-backup', 'force',
])

/** 允许重复出现并累积成数组的选项。
 *  `--set 指导老师=X --set 组别=Y` 是正常写法，若按覆盖处理会静默丢掉前一个。 */
const MULTI_FLAGS = new Set(['set'])

const ALIASES = {
  h: 'help', n: 'dry', v: 'verbose',
}

function parseArgs(argv) {
  const positional = []
  const flags = {}

  const put = (key, value) => {
    if (MULTI_FLAGS.has(key)) {
      if (!Array.isArray(flags[key])) flags[key] = []
      flags[key].push(value)
    } else flags[key] = value
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) { put(a.slice(2, eq), a.slice(eq + 1)); continue }
      const key = a.slice(2)
      if (BOOLEAN_FLAGS.has(key)) { put(key, true); continue }
      const next = argv[i + 1]
      // 下一个 token 若是「--xxx」或「-x」则视为本开关无值；否则取为值。
      // 注意不能只看首字符 -：值可能是负数（--from -1 无意义，但不要把 -1 当开关）。
      if (next !== undefined && !(next.startsWith('--') || /^-[A-Za-z]$/.test(next))) {
        put(key, next); i++
      } else put(key, true)
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const key = ALIASES[a.slice(1)] || a.slice(1)
      if (BOOLEAN_FLAGS.has(key)) put(key, true)
      continue
    }
    positional.push(a)
  }
  return { positional, flags }
}

/** 取必填字符串选项；缺了就抛，报错文案要能让调用方自己改对。 */
function need(flags, key, label) {
  const v = flags[key]
  if (v === undefined || v === true || String(v).trim() === '') {
    throw new UsageError(`缺少选项 --${key}${label ? `（${label}）` : ''}`)
  }
  return String(v)
}

function num(flags, key, fallback) {
  const v = flags[key]
  if (v === undefined || v === true) return fallback
  const n = Number(String(v))
  if (!Number.isFinite(n)) throw new UsageError(`--${key} 需要数字，收到 ${JSON.stringify(v)}`)
  return n
}

/** --unit=61,62 或 --unit=61 → [61,62]；--from / --to 是闭区间，与单位序号同口径。 */
function parseUnitSet(v) {
  if (v === undefined || v === true) return null
  const out = []
  for (const tok of String(v).split(',')) {
    const t = tok.trim()
    if (!t) continue
    const n = Number(t)
    if (!Number.isInteger(n)) throw new UsageError(`--unit 只接受整数序号，收到 ${JSON.stringify(t)}`)
    out.push(n)
  }
  return out.length ? new Set(out) : null
}

class UsageError extends Error {
  constructor(message) { super(message); this.code = 'USAGE' }
}

const pad2 = n => String(n).padStart(2, '0')

function stamp() {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 日志:默认带时间戳的前缀行。--json 时静默,只把结果 JSON 打到 stdout。 */
function makeLogger(quiet) {
  const log = (m = '') => { if (!quiet) process.stdout.write(`[${stamp()}] ${m}\n`) }
  log.warn = (m) => { if (!quiet) process.stdout.write(`[${stamp()}] ⚠️  ${m}\n`) }
  log.err = (m) => { process.stderr.write(`[${stamp()}] ❌ ${m}\n`) }
  log.raw = (m) => { process.stdout.write(m + '\n') }
  return log
}

/** 进度行:跑批时逐单位一行,用符号区分结果,便于事后 grep。 */
const MARK = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ', block: '⛔' }

module.exports = {
  BOOLEAN_FLAGS, parseArgs, need, num, parseUnitSet, UsageError, makeLogger, MARK, stamp,
}

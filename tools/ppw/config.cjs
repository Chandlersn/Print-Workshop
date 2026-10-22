/* ppw 配置：把「这批证书长什么样」从代码里挪出来。
 *
 * 原 tmp 脚本把 桌面路径 / 模板 id / 字段规则 / DPI 全写死在文件头，
 * 换一批名单就得改 8 个文件。这里统一收口成一份配置，命令行可覆盖。
 *
 * 优先级：命令行选项 > ppw.config.json > 内置默认（按这台机器的桌面布局推导）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..', '..')
const DESKTOP = path.join(os.homedir(), 'Desktop')

/** 字段匹配语法：把「怎么从表头里认出这一列」变成可序列化的字符串，
 *  这样配置能落成 JSON，而不是散落在各个脚本里的正则函数。 */
const MATCH_KINDS = {
  prefix: (h, v) => h.startsWith(v),
  eq: (h, v) => h === v,
  contains: (h, v) => h.includes(v),
}

function parseMatcher(spec) {
  const s = String(spec || '')
  const i = s.indexOf(':')
  if (i < 0) return { kind: 'eq', value: s }
  const kind = s.slice(0, i)
  const value = s.slice(i + 1)
  if (!MATCH_KINDS[kind]) throw new Error(`未知的表头匹配方式: ${JSON.stringify(kind)}（可用 prefix / eq / contains）`)
  return { kind, value }
}

/**
 * 按配置在表头里找列下标；找不到返回 -1。
 *
 * 先找与值完全相同的表头，命中就直接返回；否则才退回 prefix / contains 规则。
 * 这一层不能省：表头里常有一对长得很像的兄弟列，谁排前面谁被 contains 抢走。
 * 10.22 的教训——`contains:奖项` 抢到了「实际奖项」，于是模板真正渲染的「奖项情况」
 * 从头到尾没被读过，漂移检查对整整一列失效（5466 行里 5393 行被「已知口径」吞掉）。
 */
function matchHeader(header, spec) {
  const { kind, value } = parseMatcher(spec)
  const cells = header.map(h => String(h).trim())
  const exact = cells.indexOf(value)
  if (exact >= 0) return exact
  const hit = MATCH_KINDS[kind]
  return cells.findIndex(h => hit(h, value))
}

const DEFAULTS = {
  rosterDir: path.join(DESKTOP, '按单位序号拆分_带组别'),
  rosters: ['合并_1-60号.xlsx', '合并_61-120号.xlsx', '合并_121-180号.xlsx', '合并_181-234号.xlsx'],
  outputDir: path.join(DESKTOP, '国赛证书'),
  reportDir: DESKTOP,
  reportBaseName: '国赛证书对账表',
  templateId: 'tpl_mvhxuoj03352d1',
  outputDpi: 300,
  // 出片文件名 = `<字段一>_<字段二>.png`；字段一是名单序号列，字段二是姓名列
  fileNameFields: ['1', '姓名'],
  backupDirName: '_partial_backup',
  trashDirName: '_trash',
  /** 出口必填字段：任一为空就拒绝写盘（成品上会留一条空白栏，纸证无法补救） */
  requiredFields: [
    { key: '姓名', match: 'prefix:姓名' },
    { key: '组别', match: 'eq:组别' },
    { key: '省自治区直辖市', match: 'prefix:省' },
    { key: '所在学校必须写全名', match: 'prefix:所在学校' },
    { key: '指导老师', match: 'contains:指导' },
    { key: '证书编号', match: 'eq:证书编号' },
    { key: '奖项情况', match: 'eq:奖项情况' },
    { key: '赛项', match: 'eq:赛项' },
  ],
  /** 已确认不出证书的人：不算缺文件、不算校验不通过 */
  skipCert: [],
  /** 已补进数据集并出图，但 Excel 源表那格仍空：只提示回填，不再算待办 */
  excelPending: [],
  /** 曾经提示过、现已两边一致：不再提示，避免假待办 */
  excelSettled: [],
  /**
   * 已知口径差异：归一后相同就不算漂移，只计数。
   * 用于「Excel 写简写、数据集是完整值」这种两边都对的情况：Excel「一等奖」→
   * 数据集「个人复赛一等奖」，模板直接渲染整串，所以数据集才是对的。
   * 注意它是**归一化**不是**放行**：归一后仍不相等就是要报的真实差异。
   * （曾经因为它喂错了列，把整列差异都吞成了「已知口径」，见 matchHeader 的注释）
   */
  knownDialects: [{ field: '奖项情况', datasetIs: '个人复赛{excel}' }],
}

/**
 * 从模板读出「出片真正会渲染的字段」。
 *
 * 为什么以模板为准：模板的 `fields[].column` 就是出口校验用的那份清单
 * （electron/api.cjs 的 assertFieldsFilled 直接取它），所以它才是字段集合的第一真源。
 * 配置里的 requiredFields 只需要补上「这一列怎么从表头认出来」的匹配规则。
 *
 * 读不到就返回 null 而不是抛错：`--template` 打错字时应该由 verify/status 报出来，
 * 不该让 check / export 一起连坐。
 */
function templateColumnsOf(cfg) {
  try {
    const store = require('./store.cjs') // 延迟 require：避免与 store 的载入顺序耦合
    const file = path.join(store.resolveDataDir(cfg.dataDir), 'templates.json')
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const list = Array.isArray(raw) ? raw : raw.templates || []
    const tpl = list.find(t => t.id === cfg.templateId)
    if (!tpl) return null
    const cols = []
    for (const f of tpl.fields || []) {
      const c = String(f.column || '').trim()
      if (c && !cols.includes(c)) cols.push(c)
    }
    return cols.length ? cols : null
  } catch {
    return null
  }
}

/**
 * 必填字段 = 模板要渲染的字段 ∪ 配置里显式列出的字段。
 *
 * 这样字段数量是**跟着模板走**的：模板这次 8 个就 8 个，下次改成 5 个或 9 个，
 * 清单自动跟着变，不需要有人记得同步第二份名单。
 * 模板列的匹配规则默认取 `eq:<列名>`（matchHeader 本就优先精确同名，够用）；
 * 配置里给了同名列的 matcher 就用配置的（`prefix:所在学校` 这类必须靠人写）。
 * 配置多出来的列（模板不渲染、但业务上仍不该为空）保留，多校验一次不会误伤。
 */
function mergeRequiredFields(configured, tplCols) {
  if (!tplCols || !tplCols.length) return configured.slice()
  const byKey = new Map(configured.map(f => [f.key, f]))
  const out = tplCols.map(c => byKey.get(c) || { key: c, match: `eq:${c}` })
  for (const f of configured) if (!tplCols.includes(f.key)) out.push(f)
  return out
}

/**
 * 编号列：报告里用来指认「是哪一个人」。
 * 从必填清单里找带「编号 / 学号 / 工号 / 序号 / 号码」或以「号」结尾的列，找不到退回第一列。
 * 不写死「证书编号」——换一批数据叫「学号」「参赛号」也认得出。
 */
function pickIdField(fields) {
  const list = fields || []
  const hit = list.find(f => /编号|学号|工号|序号|号码|号$/.test(String(f.key)))
  return hit ? hit.key : (list[0] ? list[0].key : '')
}

function readJsonIfExists(p) {
  if (!p || !fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (err) {
    throw new Error(`配置文件解析失败 ${p}: ${err.message}`)
  }
}

function resolvePath(p, base) {
  if (!p) return p
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p)
}

/**
 * 载入配置。
 * @param {object} flags 命令行开关（--config / --roster-dir / --output-dir / --template / --dpi / --report-dir）
 */
function load(flags = {}) {
  const explicit = flags.config ? path.resolve(String(flags.config)) : null
  const candidates = [
    explicit,
    path.join(REPO_ROOT, 'ppw.config.json'),
    path.join(process.cwd(), 'ppw.config.json'),
  ].filter(Boolean)

  let fileCfg = null
  let configPath = null
  for (const c of candidates) {
    const got = readJsonIfExists(c)
    if (got) { fileCfg = got; configPath = c; break }
  }

  const cfg = { ...DEFAULTS, ...(fileCfg || {}) }
  const base = configPath ? path.dirname(configPath) : REPO_ROOT

  // 命令行覆盖
  if (flags['roster-dir']) cfg.rosterDir = String(flags['roster-dir'])
  if (flags['output-dir']) cfg.outputDir = String(flags['output-dir'])
  if (flags['report-dir']) cfg.reportDir = String(flags['report-dir'])
  if (flags.template) cfg.templateId = String(flags.template)
  if (flags.dpi !== undefined && flags.dpi !== true) cfg.outputDpi = Number(flags.dpi)

  cfg.rosterDir = resolvePath(cfg.rosterDir, base)
  cfg.outputDir = resolvePath(cfg.outputDir, base)
  cfg.reportDir = resolvePath(cfg.reportDir, base)
  cfg.backupDir = path.join(cfg.outputDir, cfg.backupDirName)
  // 中间产物（字段校验 / 漂移明细）不放在桌面：桌面只留两份给人看的 xlsx。
  // 跑一次校验多出三四个 csv 摆在桌面上，比没有更碍事。
  cfg.csvDir = cfg.csvDir ? resolvePath(cfg.csvDir, base) : path.join(cfg.outputDir, '_报告')

  // 必填字段：以模板为准（模板渲染什么就校验什么），配置只负责补「怎么从表头认出这一列」。
  // 字段数量跟着模板走——这批 8 个、下批 5 个都成立，代码里没有写死的清单。
  const configuredFields = Array.isArray(cfg.requiredFields) ? cfg.requiredFields : []
  const tplCols = templateColumnsOf(cfg)
  cfg.requiredFields = mergeRequiredFields(configuredFields, tplCols)
  cfg.__requiredSource = { template: tplCols ? tplCols.length : 0, configured: configuredFields.length }

  // 校验必填字段配置：至少要能定位姓名列，否则后面全乱
  if (!cfg.requiredFields.length) {
    throw new Error('必填字段为空：模板 fields 与配置 requiredFields 至少要有一处给出字段')
  }
  if (!cfg.requiredFields.some(f => f.key === '姓名')) {
    throw new Error('必填字段里必须有「姓名」：它是报错定位与文件名的基础列')
  }
  for (const f of cfg.requiredFields) {
    if (!f.key || !f.match) throw new Error(`requiredFields 条目缺 key 或 match: ${JSON.stringify(f)}`)
    parseMatcher(f.match) // 提前暴露语法错误，不要等到跑批中途
  }

  if (!cfg.idField) cfg.idField = pickIdField(cfg.requiredFields)

  cfg.__configPath = configPath
  cfg.__repoRoot = REPO_ROOT
  return cfg
}

/** 名册文件全路径；`--roster` 只给文件名时到 rosterDir 下找。 */
function rosterPath(cfg, file) {
  if (path.isAbsolute(file)) return file
  if (file.includes('/') || file.includes('\\')) return path.resolve(cfg.rosterDir, file)
  return path.join(cfg.rosterDir, file)
}

/** 名册批次标签：合并_61-120号.xlsx → 61-120号 */
function batchLabel(file) {
  return path.basename(file, path.extname(file)).replace(/^合并_/, '')
}

/** 报告落地路径。写用户可能正打开的文件一律要能降级，见 report.cjs。 */
function reportPath(cfg, ext = '.xlsx') {
  return path.join(cfg.reportDir, `${cfg.reportBaseName}${ext}`)
}

module.exports = {
  DEFAULTS, load, rosterPath, batchLabel, reportPath, parseMatcher, matchHeader,
  templateColumnsOf, mergeRequiredFields, pickIdField, REPO_ROOT, DESKTOP,
}

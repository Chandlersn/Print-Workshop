#!/usr/bin/env node
/**
 * 批印坊 CLI（pp）：给 agent / 脚本 / 批处理留的无 GUI 操作入口。
 *
 * 设计约束：
 * - 纯 Node，零第三方依赖。应用的核心卖点是「本地离线、双击即用」，
 *   给 CLI 引一堆 npm 包会把这个卖点拆掉。
 * - 业务逻辑一行都不写在这里：全部经 electron/api.cjs 转调，
 *   与应用 GUI 走同一份实现。这里只负责 argv 解析、输出格式、退出码。
 * - 输出永远是 stdout 上的一行 JSON（{ok, data} 或 {ok, error}），
 *   退出码区分成功/失败/需 GUI/需授权。agent 不需要读中文提示。
 *
 * 退出码：0 成功（含用户取消）｜1 失败｜2 需要 GUI｜3 缺少写授权
 *
 * 用法：pp <命令> [选项]   详见 pp --help
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO_ROOT = path.join(__dirname, '..')

// ══════════════════════════ 1. 先解析 argv ══════════════════════════
// 顺序不能动：store.cjs / print.cjs 在**模块加载时**读 PRINTPRESS_DATA_DIR
// （const DATA_DIR = process.env.PRINTPRESS_DATA_DIR），所以必须在 require
// api.cjs 之前把环境变量定好，否则数据目录会落到默认值上。

/**
 * 布尔开关必须显式登记（声明必须在 parseArgs 调用之前，否则 const 处于 TDZ）。
 *
 * 不能靠「下一个 token 不以 - 开头就当值」来判断：`pp --allow-write dataset list`
 * 里 dataset 不以 - 开头，会被当成 --allow-write 的值吃掉，于是命令解析失败。
 * 这类 bug 只在「开关后面跟位置参数」时出现，正是 CLI 最常见的写法。
 */
const BOOLEAN_FLAGS = new Set(['allow-write', 'pretty', 'verbose', 'silent', 'help', 'write'])

const { positional, flags } = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue }
      const next = argv[i + 1]
      // 带值的长选项：下一个 token 不是选项就当值；否则视为布尔开关
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++ }
      else flags[key] = true
      continue
    }
    if (a === '-h' || a === '--help') { flags.help = true; continue }
    if (a.startsWith('-') && a.length > 1) { flags[a.slice(1)] = true; continue }
    positional.push(a)
  }
  return { positional, flags }
}

const HELP = `
批印坊 CLI · pp —— 无 GUI 操作应用数据（与应用共用同一份数据目录）

用法
  pp <命令> [参数] [选项]

查询
  ping                                  连通性检查
  env                                   数据目录与环境信息
  ops [--write]                         列出可用操作（--write 只看写操作）
  call <操作名> [JSON]                   通用直调，任意操作名的兜底入口

数据集
  dataset list
  dataset get <id>
  dataset fields <id>                    字段目录（类型 / 填充率 / 长度提示）
  dataset inspect <文件>                 检视文件（CSV 会直接落库，见下方说明）
  dataset import <文件> [--name 名称] [--sheets 表名或序号] [--mode split|merge]
  dataset delete <id>
  dataset add-row <id>
  dataset delete-row <id> <行号>
  dataset update-cell <id> <行号> <列key> <值>
  dataset rename-column <id> <列key> [别名]
  dataset set-column-print <id> <列key> <on|off>

模板
  template list
  template get <id>
  template save <json文件>
  template match <模板id> <数据集id>
  template rebind <模板id> <数据集id>
  template delete <id>
  template upload-background <图片路径>

字体
  font list
  font upload <字体路径>
  font delete <文件名>

出片
  validate --dataset <id> --template <id> [--rows 0,2]
  render   --dataset <id> --template <id> [--rows 0,2] [--out 文件.html] [--out-snapshot 文件.html]
  export   --dataset <id> --template <id> --out 文件.pdf
  print    --dataset <id> --template <id> [--silent]
  job list
  job delete <id>

选项
  --data-dir <路径>   指定数据目录（缺省：与已安装应用一致，见 pp env）
  --allow-write       允许写操作。删除 / 导入 / 改数 / 留痕都受此管控
  --rows <0,2,4>      行级出片范围，0 基行号（与界面勾选口径一致），缺省 = 全量
  --pretty            输出缩进 JSON（缺省单行紧凑）
  --verbose           把进度事件打到 stderr
  -h, --help

关于写权限
  缺省只读。任何会改数据的命令都需要 --allow-write，这是刻意的：
  agent 误删用户名单的代价远大于多打一个参数。

关于 export / print
  这两个出口依赖 Electron 的隐藏窗口（printToPDF / webContents.print），
  纯 Node 下没有替代实现，会返回 GUI_REQUIRED（退出码 2）。
  无人值守场景请用 render 产出 HTML 再自行处理。

关于 dataset inspect
  CSV / txt 的检视即导入（inspectFile 内部直接落库建数据集），
  因此该命令也属于写操作，需要 --allow-write。
`.trim()

if (flags.help || positional.length === 0) {
  process.stdout.write(HELP + '\n')
  process.exit(0)
}

// ══════════════════════════ 2. 定数据目录 ══════════════════════════
// data-dir.cjs 是纯函数模块（不读环境变量），可以安全地提前 require。
const dataDirModule = require(path.join(REPO_ROOT, 'electron', 'data-dir.cjs'))

/** 已安装应用的 userData 目录。Electron 用 package.json 的 name（printpress），
 *  兼容历史上可能用 productName（批印坊）的情况——存在哪个用哪个。 */
const APP_DIR_NAMES = ['printpress', '批印坊']

function platformUserDataDir() {
  const home = os.homedir()
  let base
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support')
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  }
  for (const n of APP_DIR_NAMES) {
    const d = path.join(base, n)
    if (fs.existsSync(d)) return d
  }
  return path.join(base, APP_DIR_NAMES[0])
}

const USER_DATA_DIR = platformUserDataDir()

const resolved = flags['data-dir']
  ? { dataDir: path.resolve(String(flags['data-dir'])), custom: false }
  : process.env.PRINTPRESS_DATA_DIR
    ? { dataDir: path.resolve(process.env.PRINTPRESS_DATA_DIR), custom: false }
    : dataDirModule.resolveDataDir({
      // CLI 的默认目标是「已安装的应用」——agent 要操作的就是它那份数据。
      // 开发态想操作仓库 data/ 请显式 --data-dir。
      isPackaged: true,
      userDataDir: USER_DATA_DIR,
      appPath: REPO_ROOT,
    })

process.env.PRINTPRESS_DATA_DIR = resolved.dataDir
process.env.PRINTPRESS_DATA_DIR_CUSTOM = resolved.custom ? '1' : ''

// ══════════════════════════ 3. 再加载 api ══════════════════════════

const api = require(path.join(REPO_ROOT, 'electron', 'api.cjs'))
const PKG = require(path.join(REPO_ROOT, 'package.json'))

/**
 * 调用上下文。
 *
 * dialog / printer 一律 null —— 这两个就是「GUI 出口层」的全部内容。
 * 传 null 而不是传一个「会抛错的对象」，是为了让 api.cjs 的
 * assertCapabilities 能给出统一的 GUI_REQUIRED 错误，而不是各自崩在不同地方。
 */
const CTX = {
  allowWrite: Boolean(flags['allow-write']),
  app: {
    version: PKG.version,
    isPackaged: false,
    platform: process.platform,
    userDataDir: USER_DATA_DIR,
    // 刻意不提供 relaunch：CLI 重启谁？没有意义，让它走 GUI_REQUIRED。
  },
  dialog: null,
  printer: null,
  emit: (channel, payload) => {
    if (flags.verbose) process.stderr.write(`[${channel}] ${JSON.stringify(payload)}\n`)
  },
}

// ══════════════════════════ 4. 参数助手 ══════════════════════════

const badParams = (msg) => new api.ApiError('BAD_PARAMS', msg)

/** 取第 i 个位置参数，缺失即报错（报错文案要能让 agent 自己修） */
function need(rest, i, label) {
  const v = rest[i]
  if (v === undefined || v === '') {
    throw badParams(`缺少参数 <${label}>（第 ${i + 1} 个位置参数）`)
  }
  return String(v)
}

/** --rows 0,2,4 → [0,2,4]。与 API 同为 0 基，不做隐式换算。 */
function parseRows(v) {
  if (v === undefined) return undefined
  if (v === true) throw badParams('--rows 需要一个值，如 --rows 0,2,4')
  const out = []
  for (const tok of String(v).split(',')) {
    const t = tok.trim()
    if (!t) continue
    const n = Number(t)
    if (!Number.isInteger(n) || n < 0) {
      throw badParams(`--rows 只接受非负整数（0 基行号），收到: ${JSON.stringify(t)}`)
    }
    out.push(n)
  }
  if (!out.length) throw badParams('--rows 解析后为空，若要全量请省略该选项')
  return out
}

function parseOnOff(v, label) {
  const s = String(v ?? '').trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(s)) return true
  if (['off', 'false', '0', 'no'].includes(s)) return false
  throw badParams(`${label} 只接受 on / off，收到: ${JSON.stringify(v)}`)
}

/** 出片类命令共用的 payload */
function printPayload() {
  if (!flags.dataset) throw badParams('缺少 --dataset <数据集id>')
  if (!flags.template) throw badParams('缺少 --template <模板id>')
  const p = {
    datasetId: String(flags.dataset),
    templateId: String(flags.template),
  }
  const rows = parseRows(flags.rows)
  if (rows) p.rows = rows
  return p
}

// ══════════════════════════ 5. 命令表 ══════════════════════════

const COMMANDS = {

  'ping': () => api.call('app:ping', {}, CTX),
  'env': () => api.call('app:env', {}, CTX),

  'ops': () => {
    const ops = api.describe()
    return flags.write ? ops.filter((o) => o.write) : ops
  },

  'call': (rest) => {
    const name = need(rest, 0, '操作名')
    let params = {}
    if (rest[1] !== undefined) {
      try {
        params = JSON.parse(rest[1])
      } catch (err) {
        throw badParams(`参数不是合法 JSON: ${err.message}`)
      }
    }
    return api.call(name, params, CTX)
  },

  // ---------------- 数据集 ----------------

  'dataset list': () => api.call('dataset:list', {}, CTX),

  'dataset get': (rest) => api.call('dataset:get', { id: need(rest, 0, '数据集id') }, CTX),

  'dataset fields': (rest) => api.call('catalog:fields', { id: need(rest, 0, '数据集id') }, CTX),

  'dataset inspect': (rest) => api.call('dataset:inspect', {
    filePath: path.resolve(need(rest, 0, '文件路径')),
  }, CTX),

  'dataset import': (rest) => {
    const filePath = path.resolve(need(rest, 0, '文件路径'))
    if (!fs.existsSync(filePath)) throw badParams(`文件不存在: ${filePath}`)
    const ext = path.extname(filePath).toLowerCase()

    // 没指定工作表：整文件导成一个数据集（Excel 取首个工作表）
    if (flags.sheets === undefined) {
      return api.call('dataset:importFile', {
        filePath,
        name: flags.name ? String(flags.name) : undefined,
      }, CTX)
    }

    // 指定了工作表：先取清单（xlsx 分支只读，不落库），再按表名或 1 基序号选
    if (ext !== '.xlsx' && ext !== '.xls') {
      throw badParams('--sheets 只对 Excel（.xlsx / .xls）有效；CSV 请去掉该选项')
    }
    const info = api.call('dataset:inspect', { filePath }, CTX)
    const all = info.sheets || []
    if (!all.length) throw new api.ApiError('ERROR', `未读到工作表: ${filePath}`)

    const selections = String(flags.sheets).split(',').map((t) => t.trim()).filter(Boolean).map((tok) => {
      const n = Number(tok)
      const hit = (Number.isInteger(n) && n >= 1 && n <= all.length)
        ? all[n - 1]
        : all.find((s) => s.name === tok)
      if (!hit) {
        throw badParams(`工作表未找到: ${JSON.stringify(tok)}（可用: ${all.map((s) => s.name).join(' / ')}）`)
      }
      return { name: hit.name }
    })

    return api.call('dataset:importSheets', {
      filePath,
      selections,
      mode: flags.mode === 'merge' ? 'merge' : 'split',
    }, CTX)
  },

  'dataset delete': (rest) => api.call('dataset:delete', { id: need(rest, 0, '数据集id') }, CTX),

  'dataset add-row': (rest) => api.call('dataset:addRow', { id: need(rest, 0, '数据集id') }, CTX),

  'dataset delete-row': (rest) => api.call('dataset:deleteRow', {
    datasetId: need(rest, 0, '数据集id'),
    rowIndex: Number(need(rest, 1, '行号')),
  }, CTX),

  'dataset update-cell': (rest) => api.call('dataset:updateCell', {
    datasetId: need(rest, 0, '数据集id'),
    rowIndex: Number(need(rest, 1, '行号')),
    key: need(rest, 2, '列key'),
    // 第 4 个参数允许是空字符串（清空单元格），所以用 ?? 而不是 ||
    value: rest[3] ?? '',
  }, CTX),

  'dataset rename-column': (rest) => api.call('dataset:renameColumn', {
    id: need(rest, 0, '数据集id'),
    key: need(rest, 1, '列key'),
    alias: rest[2],
  }, CTX),

  'dataset set-column-print': (rest) => api.call('dataset:setColumnPrint', {
    datasetId: need(rest, 0, '数据集id'),
    key: need(rest, 1, '列key'),
    printOn: parseOnOff(rest[2], 'on|off'),
  }, CTX),

  // ---------------- 模板 ----------------

  'template list': () => api.call('template:list', {}, CTX),

  'template get': (rest) => api.call('template:get', { id: need(rest, 0, '模板id') }, CTX),

  'template save': (rest) => {
    const fp = path.resolve(need(rest, 0, 'json文件路径'))
    if (!fs.existsSync(fp)) throw badParams(`文件不存在: ${fp}`)
    let tpl
    try {
      tpl = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    } catch (err) {
      throw badParams(`模板 JSON 读取失败: ${err.message}`)
    }
    return api.call('template:save', { template: tpl }, CTX)
  },

  'template match': (rest) => api.call('template:matchDataset', {
    templateId: need(rest, 0, '模板id'),
    datasetId: need(rest, 1, '数据集id'),
  }, CTX),

  'template rebind': (rest) => api.call('template:rebindDataset', {
    templateId: need(rest, 0, '模板id'),
    datasetId: need(rest, 1, '数据集id'),
  }, CTX),

  'template delete': (rest) => api.call('template:delete', { id: need(rest, 0, '模板id') }, CTX),

  'template upload-background': (rest) => api.call('template:uploadBackground', {
    filePath: path.resolve(need(rest, 0, '图片路径')),
  }, CTX),

  // ---------------- 字体 ----------------

  'font list': () => api.call('font:list', {}, CTX),

  'font upload': (rest) => api.call('font:upload', {
    filePath: path.resolve(need(rest, 0, '字体路径')),
  }, CTX),

  'font delete': (rest) => api.call('font:delete', { file: need(rest, 0, '字体文件名') }, CTX),

  // ---------------- 出片 ----------------

  'validate': () => api.call('print:validate', printPayload(), CTX),

  /**
   * 生成批量 HTML 并落盘。
   * 刻意不把 HTML 塞进 stdout 的 JSON：一份几十页的批量 HTML 轻易上百 KB，
   * 混进 JSON 里既不可读也不好解析。需要原始 JSON（含 HTML 字符串）用 call。
   */
  'render': () => {
    const r = api.call('print:generate', printPayload(), CTX)
    const { html, snapshotHtml, ...meta } = r
    const out = {}
    const targets = [
      ['out', html, 'htmlPath'],
      ['out-snapshot', snapshotHtml, 'snapshotPath'],
    ]
    for (const [flag, content, key] of targets) {
      if (!flags[flag]) continue
      const abs = path.resolve(String(flags[flag]))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf-8')
      out[key] = abs
    }
    return {
      ...meta,
      ...out,
      htmlBytes: Buffer.byteLength(html, 'utf-8'),
      snapshotBytes: Buffer.byteLength(snapshotHtml, 'utf-8'),
      hint: out.htmlPath
        ? undefined
        : '未指定 --out / --out-snapshot，HTML 未落盘；需要文件请加 --out <路径>',
    }
  },

  'export': () => {
    const p = printPayload()
    if (!flags.out) throw badParams('缺少 --out <PDF保存路径>（无 GUI 时无法弹保存对话框）')
    return api.call('print:exportPdf', { ...p, savePath: path.resolve(String(flags.out)) }, CTX)
  },

  'print': () => api.call('print:send', {
    ...printPayload(),
    silent: Boolean(flags.silent),
  }, CTX),

  'job list': () => api.call('job:list', {}, CTX),

  'job delete': (rest) => api.call('job:delete', { id: need(rest, 0, '留痕记录id') }, CTX),
}

// ══════════════════════════ 6. 分发 ══════════════════════════

/** 先按「两段命令」匹配（dataset list），再按「一段命令」匹配（ping） */
function resolveCommand(tokens) {
  const two = tokens.slice(0, 2).join(' ')
  if (COMMANDS[two]) return { run: COMMANDS[two], rest: tokens.slice(2) }
  const one = tokens[0]
  if (COMMANDS[one]) return { run: COMMANDS[one], rest: tokens.slice(1) }
  return null
}

const EXIT_CODE = { GUI_REQUIRED: 2, WRITE_FORBIDDEN: 3 }

function emit(obj) {
  const s = flags.pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
  process.stdout.write(s + '\n')
}

async function main() {
  const found = resolveCommand(positional)
  if (!found) {
    emit({
      ok: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `未知命令: ${positional.join(' ')}`,
        hint: '运行 pp --help 查看全部命令',
      },
    })
    process.exit(1)
  }

  try {
    const data = await found.run(found.rest)
    // 用户取消不是错误：data.canceled === true 时仍然是 ok，退出码 0。
    // 调用方靠 data.canceled 判断「没做成」，而不是靠退出码。
    emit({ ok: true, data: data === undefined ? null : data })
    process.exit(0)
  } catch (err) {
    const code = (err && err.code) || 'ERROR'
    emit({
      ok: false,
      error: { code, message: String((err && err.message) || err) },
    })
    process.exit(EXIT_CODE[code] || 1)
  }
}

main()

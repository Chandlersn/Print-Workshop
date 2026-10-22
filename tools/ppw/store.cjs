/* store：批印坊数据目录 + 出片目录的只读视图。
 *
 * 这里只读不写。改数据一律走 MCP（宿主持有写锁，直接改 JSON 会被下一次
 * markPrinted 整份回写覆盖 —— 今天已经踩过一次）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 批印坊数据目录：与应用约定一致（Electron userData 下的 data/）。 */
function resolveDataDir(explicit) {
  if (explicit) return path.resolve(String(explicit))
  if (process.env.PRINTPRESS_DATA_DIR) return path.resolve(process.env.PRINTPRESS_DATA_DIR)
  const home = os.homedir()
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'))
  for (const n of ['printpress', '批印坊']) {
    const d = path.join(base, n, 'data')
    if (fs.existsSync(d)) return d
  }
  return path.join(base, 'printpress', 'data')
}

function readDatasets(dataDir) {
  const p = path.join(dataDir, 'datasets.json')
  if (!fs.existsSync(p)) throw new Error(`数据集文件不存在: ${p}`)
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return Array.isArray(raw) ? raw : (raw.datasets || [])
}

/**
 * 同一单位可能有多个数据集（重复导入过）。
 * 取「合并_」开头的那份——那是按单位拆分导入的正式副本；
 * 没有则取最后一个（最新导入的）。
 */
function pickDataset(list, sheet) {
  const cands = list.filter(d => String(d.name || '').endsWith('·' + sheet))
  if (!cands.length) return null
  return cands.find(d => String(d.name).startsWith('合并_')) || cands[cands.length - 1]
}

/** 按名册文件名前缀（合并_61-120号·）索引，避免同名单位跨批次串味。 */
function indexByPrefix(list, prefix) {
  const map = new Map()
  for (const d of list) {
    const n = String(d.name || '')
    if (!n.startsWith(prefix)) continue
    map.set(n.slice(prefix.length), d)
  }
  return map
}

function listPng(dir) {
  try {
    return fs.readdirSync(dir).filter(f => /\.png$/i.test(f))
  } catch {
    return []
  }
}

/** 去掉 .png、去掉重复副本后缀「 (2)」、去掉重出备份后缀「_改前」 */
function stemOf(fileName) {
  return String(fileName)
    .replace(/\.png$/i, '')
    .replace(/ \(\d+\)$/, '')
    .replace(/_改前$/, '')
}

/**
 * 扫描一个出片目录。
 * @returns {{files:string[], stems:Set<string>, byName:Map<string,string[]>, dups:string[]}}
 *   byName 的 key 是「_」之后的姓名部分，用来兜住编号为空的行。
 *   dups 记录同名多文件的 stem（含 (2) 副本，未去重）。
 */
function scanFolder(dir) {
  const files = listPng(dir)
  const stems = new Set()
  const byName = new Map()
  for (const f of files) {
    const stem = stemOf(f)
    stems.add(stem)
    const i = stem.indexOf('_')
    const nm = i >= 0 ? stem.slice(i + 1) : stem
    if (!byName.has(nm)) byName.set(nm, [])
    byName.get(nm).push(stem)
  }
  return { dir, files, stems, byName }
}

/**
 * 递归扫备份目录，收集「可能是有效成品」的 stem。
 *
 * 为什么必须扫：批量重出前会把旧图挪进 _partial_backup，那里面躺的是**能用的成品**，
 * 不是垃圾。只看正式目录会把它判成「缺文件」——6_啊呜 11 张就是这么被误报的。
 */
function scanBackup(backupDir) {
  const stems = new Set()
  const v = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { v(p); continue }
      if (!/\.png$/i.test(e.name)) continue
      // 「xxx_改前.png」是重出时挪走的旧版，内容明确过时，不能算「成品在备份目录」。
      // 不带这个后缀的（整目录被挪进来的那种）才是可用成品。
      if (/_改前\.png$/i.test(e.name)) continue
      stems.add(stemOf(e.name))
    }
  }
  v(backupDir)
  return stems
}

/**
 * 把磁盘文件分成三类，供对账表的「文件清理」页使用：
 *  - junk    「空值_*」历史残留（早期没拦编号空造成的）
 *  - dup     同编号重复副本（(2) 后缀），MD5 通常一致
 *  - multi   同人两场：编号不同、姓名相同，属正常，两张都该留
 */
function classifyStems(files) {
  const groups = new Map()
  for (const f of files) {
    const stem = stemOf(f)
    const i = stem.indexOf('_')
    const nm = i >= 0 ? stem.slice(i + 1) : stem
    if (!groups.has(nm)) groups.set(nm, [])
    groups.get(nm).push({ file: f, stem })
  }
  const junk = []
  const dup = []
  const multi = []
  for (const [name, list] of groups) {
    if (list.length <= 1) {
      if (list[0] && list[0].stem.startsWith('空值')) junk.push(list[0])
      continue
    }
    const real = list.filter(x => !x.stem.startsWith('空值'))
    const junkOnes = list.filter(x => x.stem.startsWith('空值'))
    if (junkOnes.length) junk.push(...junkOnes)
    const uniq = [...new Set(real.map(x => x.stem))]
    if (uniq.length < real.length) {
      const repeated = real.filter(x => x.file !== path.basename(x.stem + '.png'))
      dup.push({ name, files: real.map(x => x.file), extra: repeated.length ? repeated : [] })
    }
    if (uniq.length > 1) multi.push({ name, stems: uniq })
  }
  return { junk, dup, multi }
}

/** 数据集里按「编号」或「姓名」定位一行，返回 0 基索引。找不到 -1。 */
function findRow(ds, { code, name }) {
  const rows = ds.rows || []
  if (code) {
    const i = rows.findIndex(r => String(r['1'] ?? '').trim() === String(code))
    if (i >= 0) return i
  }
  return rows.findIndex(r => String(r['姓名'] ?? '').trim() === String(name))
}

module.exports = {
  resolveDataDir, readDatasets, pickDataset, indexByPrefix, listPng, stemOf,
  scanFolder, scanBackup, classifyStems, findRow,
}

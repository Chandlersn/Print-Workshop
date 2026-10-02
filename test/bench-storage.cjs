/**
 * 存储性能基准：JSON 扁平存储的真实拐点在哪。
 *
 * 背景假设（待验证）：开发方案里写「单数据集 > 5 万行 或 jobs > 1 万条时升 SQLite」，
 * 但这个阈值从没被测过。本脚本走**真实调用路径**（importFromFile / updateCell / createJob …）。
 *
 * 关键机制：store.cjs 是「整文件重写」——任何一次写都要 loadAll（全量 parse）+
 * persistAll（全量 stringify + 写盘）。写耗时随数据量线性增长，累计写入量则是 O(n²)。
 *
 * 运行：node test/bench-storage.cjs
 * 进度实时写入仓库根 .tmp-bench.log（stdout 会被管道缓冲，看不到中间态）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

// 临时目录放在系统 %TEMP% 下：仓库路径含中文，宿主 safe-delete shim 走 trash 时
// 会拿到乱码路径（GBK/UTF-8 混淆）而 fail-closed，导致清理阶段直接抛错。
// 本基准会生成上千个归档快照文件，必须能删干净。
const TMP = path.join(os.tmpdir(), 'pp-bench-storage')
process.env.PRINTPRESS_DATA_DIR = TMP
const LOG = path.join(os.tmpdir(), 'pp-bench-storage.log')
try { fs.unlinkSync(LOG) } catch { /* 首次无文件 */ }
function log(m) {
  try { fs.appendFileSync(LOG, m + '\n') } catch { /* 忽略 */ }
  process.stdout.write(m + '\n')
}

// BENCH_ONLY=datasets|jobs 可只跑其中一段（任务段是 O(n²)，规模太大跑很久）
const ONLY = process.env.BENCH_ONLY || ''
const ROW_SIZES = [1000, 10000, 50000]
const JOB_SIZES = [1000, 3000]

const dataset = require('../electron/dataset.cjs')
const printDomain = require('../electron/print.cjs')

function ms(fn) {
  const t0 = process.hrtime.bigint()
  const out = fn()
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out }
}
const fmt = (n) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))
const human = (b) => (b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

function genCsv(file, n) {
  const lines = ['姓名,部门,奖项,日期,备注']
  for (let i = 0; i < n; i++) {
    lines.push(`选手${i + 1},第${(i % 20) + 1}部门,${i % 3 === 0 ? '金奖' : i % 3 === 1 ? '银奖' : '铜奖'},2026-0${(i % 9) + 1}-15,备注文本${i}`)
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf-8')
  return file
}

const rows = []

function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  if (ONLY !== 'jobs') {
  log('== 数据集规模 ==')
  for (const n of ROW_SIZES) {
    log(`--- ${n} 行 ---`)
    const csv = genCsv(path.join(TMP, `n${n}.csv`), n)
    log(`  生成 CSV 完成 ${human(fs.statSync(csv).size)}`)

    const imp = ms(() => dataset.importFromFile(csv))
    const id = imp.out.id
    const fileBytes = fs.statSync(path.join(TMP, 'datasets.json')).size
    log(`  导入 ${fmt(imp.ms)}ms → datasets.json ${human(fileBytes)}`)

    const read = ms(() => dataset.getDataset(id)); log(`  读取 ${fmt(read.ms)}ms`)
    const edit = ms(() => dataset.updateCell(id, 0, '姓名', '改过的名字')); log(`  改一格 ${fmt(edit.ms)}ms`)
    const add = ms(() => dataset.addRow(id)); log(`  加一行 ${fmt(add.ms)}ms`)
    const catalog = ms(() => dataset.fieldCatalog(id)); log(`  字段目录 ${fmt(catalog.ms)}ms`)
    const list = ms(() => dataset.listDatasets()); log(`  列表 ${fmt(list.ms)}ms`)
    const del = ms(() => dataset.deleteDataset(id)); log(`  删除 ${fmt(del.ms)}ms`)

    rows.push({
      kind: '数据集', n: `${n} 行`, file: human(fileBytes),
      写入: `${fmt(imp.ms)} ms`, 读取: `${fmt(read.ms)} ms`, 改一格: `${fmt(edit.ms)} ms`,
      加一行: `${fmt(add.ms)} ms`, 字段目录: `${fmt(catalog.ms)} ms`, 列表: `${fmt(list.ms)} ms`,
      删除: `${fmt(del.ms)} ms`,
    })
    fs.unlinkSync(csv)
  }
  }

  if (ONLY !== 'datasets') {
  log('\n== 打印任务规模（整写 + 每次落一份归档快照） ==')
  for (const n of JOB_SIZES) {
    log(`--- ${n} 条 ---`)
    const mk = () => printDomain.createJob({
      templateId: 'tpl_x', templateName: '基准模板', datasetId: 'ds_x', datasetName: '基准数据集',
      mode: 'pdf', recordCount: 10, totalRows: 10, partial: false,
      snapshotHtml: '<html><body>snapshot</body></html>', status: 'ok', detail: 'bench',
    })
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < n; i++) {
      mk()
      if ((i + 1) % 500 === 0) {
        const el = Number(process.hrtime.bigint() - t0) / 1e6
        log(`  ${i + 1} 条 … 累计 ${fmt(el)}ms（均 ${fmt(el / (i + 1))}ms/条）`)
      }
    }
    const total = Number(process.hrtime.bigint() - t0) / 1e6
    const fileBytes = fs.statSync(path.join(TMP, 'print-jobs.json')).size
    const listJobs = ms(() => printDomain.listJobs())
    log(`  完成 ${n} 条：总 ${fmt(total)}ms（均 ${fmt(total / n)}ms/条）→ ${human(fileBytes)}｜列表 ${fmt(listJobs.ms)}ms`)
    rows.push({
      kind: '打印任务', n: `${n} 条`, file: human(fileBytes),
      写入: `${fmt(total / n)} ms/条`, 读取: `${fmt(listJobs.ms)} ms`,
      改一格: '—', 加一行: '—', 字段目录: '—', 列表: '—', 删除: '—',
    })
  }
  }

  log('\n== 汇总表 ==')
  const cols = ['kind', 'n', 'file', '写入', '读取', '改一格', '加一行', '字段目录', '列表', '删除']
  log('| ' + cols.join(' | ') + ' |')
  log('|' + cols.map(() => '---').join('|') + '|')
  for (const r of rows) log('| ' + cols.map((c) => r[c]).join(' | ') + ' |')
  log('BENCH_DONE')
}

try {
  main()
} catch (e) {
  log('基准异常：' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
} finally {
  rmDeep(TMP)
}

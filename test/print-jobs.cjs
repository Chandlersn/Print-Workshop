/**
 * 打印历史管理测试：createJob 留痕 → listJobs → deleteJob（元数据 + 归档目录）。
 * 隔离数据目录（PRINTPRESS_DATA_DIR 须在 require 领域模块前设置）。
 */
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

const TMP = path.join(__dirname, '.tmp-data-jobs')
rmDeep(TMP)
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

let passed = 0
let failed = 0
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

const print = require('../electron/print.cjs')

function main() {
  console.log('== createJob / listJobs ==')
  const job = print.createJob({
    templateId: 'tpl_t1',
    templateName: '测试模板',
    datasetId: 'ds_d1',
    datasetName: '测试数据集',
    mode: 'pdf',
    recordCount: 3,
    snapshotHtml: '<html>x</html>',
    status: 'ok',
    detail: 'out.pdf',
  })
  ok(job.id.startsWith('job_'), '任务 id 生成', job.id)
  ok(fs.existsSync(path.join(TMP, job.snapshot)), '快照写入归档目录')
  const jobs = print.listJobs()
  ok(jobs.length === 1 && jobs[0].id === job.id, 'listJobs 可读回')

  console.log('== resolveSnapshot ==')
  const abs = print.resolveSnapshot(job.id)
  ok(fs.existsSync(abs), '快照路径可解析')
  let threw = false
  try { print.resolveSnapshot('job_none') } catch { threw = true }
  ok(threw, '不存在的任务抛错')

  console.log('== deleteJob ==')
  const jobDir = path.join(TMP, path.dirname(job.snapshot))
  ok(fs.existsSync(jobDir), '删除前归档目录存在')
  const r = print.deleteJob(job.id)
  ok(r.ok && r.archiveRemoved, '删除返回 ok', r)
  ok(!fs.existsSync(jobDir), '归档目录已清理')
  ok(print.listJobs().length === 0, '元数据已移除')

  // 快照已被手动清理时也能删（只删元数据）
  const job2 = print.createJob({ templateName: 't2', mode: 'print', recordCount: 1, status: 'failed' })
  rmDeep(path.join(TMP, path.dirname(job2.snapshot)))
  const r2 = print.deleteJob(job2.id)
  ok(r2.ok && r2.archiveRemoved, '快照缺失时删除仍成功', r2)

  threw = false
  try { print.deleteJob('job_none') } catch { threw = true }
  ok(threw, '删除不存在的任务抛错')

  // 连续建删保持存储干净
  const j3 = print.createJob({ templateName: 't3', mode: 'pdf', recordCount: 1, status: 'ok', snapshotHtml: 'x' })
  const j4 = print.createJob({ templateName: 't4', mode: 'pdf', recordCount: 2, status: 'ok', snapshotHtml: 'y' })
  print.deleteJob(j3.id)
  ok(print.listJobs().length === 1 && print.listJobs()[0].id === j4.id, '删除不影响其他记录')

  console.log('== 取消态不落盘快照 ==')
  // 点了打印又取消：状态标 canceled，但不在磁盘写归档快照（无意义且占空间）
  const jc = print.createJob({
    templateId: 'tpl_t9',
    templateName: '测试模板',
    datasetId: 'ds_d9',
    datasetName: '测试数据集',
    mode: 'print',
    recordCount: 5,
    snapshotHtml: '<html>x</html>', // 即便传了快照内容也应被忽略
    status: 'canceled',
  })
  ok(jc.status === 'canceled', '状态标记为取消')
  ok(jc.snapshot === null, '取消态快照路径为 null', jc.snapshot)
  ok(print.listJobs().some((j) => j.id === jc.id), '取消记录仍入历史')
  // 取消态删除：无归档目录，仅删元数据且不报错
  const rc = print.deleteJob(jc.id)
  ok(rc.ok && rc.archiveRemoved, '取消态删除仍成功（无归档目录）', rc)
  ok(!print.listJobs().some((j) => j.id === jc.id), '取消记录元数据已移除')

  rmDeep(TMP)
  console.log(`\n结果: ${passed} 项断言通过, ${failed} 项失败`)
  process.exit(failed ? 1 : 0)
}

main()

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
const store = require('../electron/store.cjs')

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
  fs.mkdirSync(path.join(jobDir, 'photos'))
  fs.writeFileSync(path.join(jobDir, 'photos', 'portrait.jpg'), 'ARCHIVE COPY')
  const protectedFiles = ['export.pdf', 'datasets.json', 'templates.json', 'photo-bindings.json', 'design-assets/original.jpg', 'ephemeral-assets/original.jpg', 'design-thumbnails/thumb.png', 'asset-library.json', 'designs/project.json']
  for (const rel of protectedFiles) {
    fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true })
    fs.writeFileSync(path.join(TMP, rel), rel === 'datasets.json' ? '[{"id":"ds_d1","printCount":2}]' : 'KEEP')
  }
  ok(fs.existsSync(jobDir), '删除前归档目录存在')
  const r = print.deleteJob(job.id)
  ok(r.ok && r.archiveRemoved, '删除返回 ok', r)
  ok(!fs.existsSync(jobDir), '归档目录已清理')
  ok(print.listJobs().length === 0, '元数据已移除')
  ok(!fs.existsSync(path.join(jobDir, 'photos', 'portrait.jpg')), '归档照片副本已释放')
  ok(protectedFiles.every(rel => fs.existsSync(path.join(TMP, rel))), '外部 PDF、名单、模板、照片绑定、共享原件和缩略图均保留')
  ok(store.loadJson('datasets')[0].printCount === 2, '删除历史不回退名单累计已打状态')
  ok(r.backupUpdated && JSON.parse(fs.readFileSync(path.join(TMP, 'print-jobs.json.bak'), 'utf8')).length === 0, '恢复备份也不残留已删记录')

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

  console.log('== 失败重试及任务目录归属 ==')
  const locked = print.createJob({ templateName: 'locked', status: 'ok', snapshotHtml: 'retry' })
  const lockedDir = path.join(TMP, path.dirname(locked.snapshot))
  const originalRm = fs.rmSync
  try {
    fs.rmSync = function (target, options) {
      if (target === lockedDir) throw new Error('模拟文件占用')
      return originalRm.call(fs, target, options)
    }
    let err
    try { print.deleteJob(locked.id) } catch (e) { err = e }
    ok(err?.message.includes('记录已保留') && print.listJobs().some(j => j.id === locked.id), '归档删除失败时保留历史并明确报错')
    ok(fs.existsSync(path.join(TMP, locked.snapshot)), '清理失败没有误删快照')
  } finally { fs.rmSync = originalRm }
  ok(print.deleteJob(locked.id).archiveRemoved && !fs.existsSync(lockedDir), '解锁后重试准确清理')

  const owner = print.createJob({ templateName: 'owner', status: 'ok', snapshotHtml: 'OWNER' })
  for (const snapshot of ['design-assets/snapshot.html', `archive/${owner.snapshot.split('/')[1]}/${owner.id}/snapshot.html`, 'archive/2026-99/job_intruder/snapshot.html', 'archive/2026-10/job_intruder/../snapshot.html']) {
    const intruder = { id: 'job_intruder', snapshot }
    store.saveJson('print-jobs', [intruder, ...print.listJobs().filter(j => j.id !== intruder.id)])
    let err
    try { print.deleteJob(intruder.id) } catch (e) { err = e }
    ok(!!err && fs.existsSync(path.join(TMP, owner.snapshot)) && fs.existsSync(path.join(TMP, 'design-assets/original.jpg')), `拒绝其他任务、共享目录及非法归档路径：${snapshot}`)
  }
  store.saveJson('print-jobs', print.listJobs().filter(j => j.id !== 'job_intruder'))

  const linked = { id: 'job_linked', snapshot: 'archive/2026-10/job_linked/snapshot.html' }
  const linkedDir = path.join(TMP, 'archive', '2026-10', linked.id)
  fs.mkdirSync(path.dirname(linkedDir), { recursive: true })
  fs.symlinkSync(path.dirname(path.join(TMP, owner.snapshot)), linkedDir, 'junction')
  store.saveJson('print-jobs', [linked, ...print.listJobs()])
  let linkErr
  try { print.deleteJob(linked.id) } catch (e) { linkErr = e }
  ok(!!linkErr && fs.existsSync(path.join(TMP, owner.snapshot)), '拒绝任务目录 junction，目标归档完整保留')
  fs.unlinkSync(linkedDir)
  store.saveJson('print-jobs', print.listJobs().filter(j => j.id !== linked.id))

  // id 重复的合法目录全部清理；任一异常路径则应在任何清理开始前拒绝。
  const duplicate = { ...owner, snapshot: `archive/2020-01/${owner.id}/snapshot.html` }
  const duplicateDir = path.join(TMP, path.dirname(duplicate.snapshot))
  fs.mkdirSync(duplicateDir, { recursive: true })
  fs.writeFileSync(path.join(duplicateDir, 'snapshot.html'), 'OLD COPY')
  store.saveJson('print-jobs', [duplicate, ...print.listJobs()])
  ok(print.deleteJob(owner.id).archiveRemoved && !fs.existsSync(duplicateDir) && !fs.existsSync(path.join(TMP, owner.snapshot)), '重复 id 的两份合法归档均释放，其他记录保留')

  const backupFail = print.createJob({ status: 'canceled' })
  const originalCopy = fs.copyFileSync
  let backupResult
  try {
    fs.copyFileSync = function (source, target, ...args) {
      if (target === path.join(TMP, 'print-jobs.json.bak')) throw new Error('模拟备份被占用')
      return originalCopy.call(fs, source, target, ...args)
    }
    backupResult = print.deleteJob(backupFail.id)
  } finally { fs.copyFileSync = originalCopy }
  ok(backupResult.backupUpdated === false && !print.listJobs().some(j => j.id === backupFail.id), '恢复副本更新失败准确返回，界面可提示残留')

  console.log('== 200 条历史留存同步清理已淘汰归档 ==')
  store.saveJson('print-jobs', [])
  const firstRetainedTestJob = print.createJob({ status: 'failed', snapshotHtml: 'retention-0' })
  for (let i = 1; i < 200; i++) print.createJob({ status: 'failed', snapshotHtml: `retention-${i}` })
  ok(print.listJobs().length === 200 && fs.existsSync(path.join(TMP, firstRetainedTestJob.snapshot)),
    '达到 200 条前保留最早一份历史归档')
  const evicting = print.createJob({ status: 'failed', snapshotHtml: 'retention-200' })
  ok(print.listJobs().length === 200 && !print.listJobs().some(item => item.id === firstRetainedTestJob.id),
    '历史索引只保留最近 200 条')
  ok(!fs.existsSync(path.join(TMP, firstRetainedTestJob.snapshot)) && evicting.retentionCleanup.removedArchives === 1,
    '索引淘汰后同步释放对应快照目录')
  ok(JSON.parse(fs.readFileSync(path.join(TMP, 'print-jobs.json.bak'), 'utf8')).length === 200,
    '清理归档前先同步恢复备份，避免备份复活已清理记录')

  rmDeep(TMP)
  console.log(`\n结果: ${passed} 项断言通过, ${failed} 项失败`)
  process.exit(failed ? 1 : 0)
}

main()

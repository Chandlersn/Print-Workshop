// Deliberately avoid store.loadJson: it may recover corrupt files by writing to disk.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ID = /^asset_[a-f0-9]{64}$/
const DESIGN = /^design_[a-f0-9]{24}$/
const root = process.env.PRINTPRESS_DATA_DIR

async function references() {
  const refs = new Map(), issues = [], reads = new Map()
  const issue = (area, reason) => issues.push({ area, reason })
  async function read(relative, optional = false) {
    const file = path.join(root, ...relative.split('/'))
    try {
      const before = await fs.promises.lstat(file)
      if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024) throw Error('invalid')
      const raw = await fs.promises.readFile(file, 'utf8'), after = await fs.promises.lstat(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw Error('changed')
      reads.set(relative, { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino })
      return JSON.parse(raw)
    } catch (err) {
      if (optional && err.code === 'ENOENT') {
        // A quarantined index means the missing original is not a fresh store.
        const parent = path.dirname(file), prefix = `${path.basename(file)}.corrupt-`
        try { if ((await fs.promises.readdir(parent)).some(name => name.startsWith(prefix))) throw Error('corrupt') }
        catch (e) { if (e.message === 'corrupt' || e.code !== 'ENOENT') { issue(relative, '索引缺失或不可读取'); return null } }
        reads.set(relative, null); return []
      }
      issue(relative, '引用数据缺失、损坏或扫描时发生变化'); return null
    }
  }
  async function list(name) {
    const result = await read(`${name}.json`, true)
    if (result === null) return []
    if (!Array.isArray(result)) { issue(`${name}.json`, '索引格式无效'); return [] }
    return result
  }
  function add(id, type, name) {
    if (id == null || id === '') return
    if (typeof id !== 'string' || !ID.test(id)) { issue(type, '素材标识无效'); return }
    if (!refs.has(id)) refs.set(id, [])
    const label = String(name || '').slice(0, 120)
    if (!refs.get(id).some(item => item.type === type && item.name === label)) refs.get(id).push({ type, name: label })
  }
  const [library, datasets, bindings, overrides, cache, singles, states, jobs, heads, templates, records, printJobs] = await Promise.all([
    'asset-library', 'datasets', 'photo-bindings', 'photo-overrides', 'photo-processing-cache', 'photo-processing-singles', 'photo-processing', 'photo-processing-jobs', 'designs', 'templates', 'record-designs', 'print-jobs',
  ].map(list))
  const dsNames = new Map(datasets.map(item => [item?.id, item?.name || item?.id]))
  for (const item of library) add(item?.assetId, '素材库', item?.displayName || item?.assetId)
  for (const binding of bindings) {
    if (!Array.isArray(binding?.files)) { issue('名单照片', '照片绑定格式无效'); continue }
    for (const file of binding.files) add(file?.assetId, '名单照片', dsNames.get(binding.datasetId) || binding.datasetId)
  }
  for (const row of overrides) add(row?.assetId, '照片覆盖', dsNames.get(row?.datasetId) || row?.datasetId)
  for (const row of cache) for (const id of [row?.sourceAssetId, row?.assetId, row?.restoreAssetId]) add(id, '照片处理缓存', '')
  for (const row of singles) for (const id of [row?.sourceAssetId, row?.assetId, row?.restoreAssetId]) add(id, '单人照片修改', dsNames.get(row?.datasetId) || row?.datasetId)
  for (const row of states) {
    if (row?.items && (typeof row.items !== 'object' || Array.isArray(row.items))) { issue('照片处理', '处理结果格式无效'); continue }
    for (const id of Object.values(row?.items || {})) add(id, '照片处理结果', dsNames.get(row?.datasetId) || row?.datasetId)
  }
  for (const row of jobs) for (const id of (Array.isArray(row?.completedAssets) ? row.completedAssets : [])) add(id, '照片处理任务', dsNames.get(row?.datasetId) || row?.datasetId)
  const headMap = new Map(heads.map(row => [row?.id, row]))
  const versions = new Map()
  function addVersion(ref, type, name) {
    if (!ref || !DESIGN.test(ref.id || '') || !Number.isSafeInteger(ref.revision) || ref.revision < 1) { issue(type, '工程版本引用无效'); return }
    const head = headMap.get(ref.id)
    if (!head || !Number.isSafeInteger(head.revision) || ref.revision > head.revision) { issue(type, '引用的工程版本不存在'); return }
    const key = `${ref.id}:${ref.revision}`
    if (!versions.has(key)) versions.set(key, { ref, consumers: [] })
    versions.get(key).consumers.push({ type, name: String(name || ref.id).slice(0, 120) })
  }
  for (const head of heads) addVersion({ id: head?.id, revision: head?.revision }, '工程', head?.name)
  for (const template of templates) {
    if (typeof template?.background === 'string' && template.background.startsWith('asset_')) add(template.background, '模板底图', template.name)
    if (template?.backgroundDesign) addVersion(template.backgroundDesign, '模板固定版本', template.name)
  }
  for (const record of records) addVersion(record?.designRef, '单人底图', dsNames.get(record?.datasetId) || record?.datasetId)
  for (const { ref, consumers } of versions.values()) {
    const head = headMap.get(ref.id)
    if (head.storage != null && !['designs', 'individual-designs'].includes(head.storage)) { issue('工程', '工程存储位置无效'); continue }
    const dir = head.storage === 'individual-designs' ? 'individual-designs' : 'designs'
    try {
      for (const relative of [dir, `${dir}/${ref.id}`]) {
        const stat = await fs.promises.lstat(path.join(root, ...relative.split('/')))
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid')
      }
    } catch { issue('工程', '工程目录不可读取或类型异常'); continue }
    const doc = await read(`${dir}/${ref.id}/${ref.revision}.json`)
    if (!doc || doc.id !== ref.id || doc.revision !== ref.revision || !doc.assets || typeof doc.assets !== 'object' || Array.isArray(doc.assets)) { issue('工程', '工程版本数据无效'); continue }
    for (const id of Object.keys(doc.assets)) for (const consumer of consumers) add(id, consumer.type, consumer.name)
  }
  // Print archives own independent copies; naming a copy here does not make
  // the archive dependent on the current original or permit deleting either.
  for (const job of printJobs) {
    if (!job?.snapshot) continue
    const match = /^archive\/(\d{4}-\d{2})\/(job_[a-z0-9]+)\/snapshot\.html$/.exec(job.snapshot)
    if (!match || match[2] !== job.id) { issue('打印归档', '历史快照路径无效'); continue }
    const parts = ['archive', match[1], match[2]]
    try {
      for (let n = 1; n <= parts.length; n++) {
        const stat = await fs.promises.lstat(path.join(root, ...parts.slice(0, n)))
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid')
      }
      const snapshot = await fs.promises.lstat(path.join(root, ...parts, 'snapshot.html'))
      if (!snapshot.isFile() || snapshot.isSymbolicLink()) throw Error('invalid')
    } catch { issue('打印归档', '历史快照不可读取或类型异常'); continue }
    const photosDir = path.join(root, ...parts, 'photos')
    let names
    try {
      const st = await fs.promises.lstat(photosDir)
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error('invalid')
      names = await fs.promises.readdir(photosDir)
    } catch (err) { if (err.code !== 'ENOENT') issue('打印归档', '照片副本目录不可读取'); continue }
    for (const name of names) {
      const photo = /^([a-f0-9]{64})\.(png|jpe?g)$/.exec(name)
      if (!photo) { issue('打印归档', '照片副本名称无效'); continue }
      try {
        const file = path.join(photosDir, name), before = await fs.promises.lstat(file)
        if (!before.isFile() || before.isSymbolicLink()) throw Error('invalid')
        const digest = crypto.createHash('sha256')
        for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
        const after = await fs.promises.lstat(file)
        if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || digest.digest('hex') !== photo[1]) throw Error('changed')
        add(`asset_${photo[1]}`, '打印归档独立照片副本', job.templateName || job.datasetName || job.id)
      } catch { issue('打印归档', '照片副本损坏、不可读取或扫描时发生变化') }
    }
  }
  const staging = path.join(root, 'photo-import-staging')
  try {
    const st = await fs.promises.lstat(staging)
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('invalid')
    for (const name of await fs.promises.readdir(staging)) {
      if (!/^[a-f0-9-]{36}$/.test(name)) { issue('照片导入暂存', '任务目录名称无效'); continue }
      let taskDir
      try { taskDir = await fs.promises.lstat(path.join(staging, name)) }
      catch { issue('照片导入暂存', '任务目录不可读取'); continue }
      if (!taskDir.isDirectory() || taskDir.isSymbolicLink()) { issue('照片导入暂存', '任务目录无效'); continue }
      const journal = await read(`photo-import-staging/${name}/journal.json`)
      if (!journal || !Array.isArray(journal.assets) || !Array.isArray(journal.binding?.files)) { issue('照片导入暂存', '任务记录无效'); continue }
      for (const row of [...journal.assets, ...journal.binding.files]) add(row?.assetId, '照片导入任务', '')
    }
  } catch (err) { if (err.code !== 'ENOENT') issue('照片导入暂存', '任务目录不可读取') }
  // Indexes may be atomically replaced while this low-priority scan is running.
  for (const [relative, previous] of reads) {
    try {
      const now = await fs.promises.lstat(path.join(root, ...relative.split('/')))
      if (!previous || now.size !== previous.size || now.mtimeMs !== previous.mtimeMs || now.ino !== previous.ino) issue(relative, '扫描期间数据发生变化')
    } catch (err) { if (previous || err.code !== 'ENOENT') issue(relative, '扫描期间数据发生变化') }
  }
  return { refs, issues, printJobCount: printJobs.length }
}
module.exports = { references }

/** Photo directory import. Original bytes are shared with the existing managed asset pool. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { loadJson, saveJson } = require('./store.cjs')
const { resolveInsideDataDir } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const designs = require('./designs.cjs')
const library = require('./asset-library.cjs')
const { photoKey, photoIndex, matchPhotos, PHOTO_EXT } = require('./photo-match.cjs')

const LIMITS = Object.freeze({ entries: 10000, photos: 5000, depth: 12, bytes: 2 * 1024 ** 3, singleBytes: 64 * 1024 ** 2 })
const STAGING_DIR = 'photo-import-staging'
const ACTIVE_LOCK = `${STAGING_DIR}/active.lock`
const TASK_HISTORY = 'photo-import-tasks'
let importing = false
let activeTaskId = null
const canceledTasks = new Set()
const bindings = () => loadJson('photo-bindings', { expect: 'array' }) || []

function taskPath(taskId, relative = '') {
  if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('照片导入任务标识无效')
  return resolveInsideDataDir(`${STAGING_DIR}/${taskId}${relative ? `/${relative}` : ''}`)
}
function ensureTaskDirectory(taskId, child = '') {
  const root = resolveInsideDataDir(STAGING_DIR)
  fs.mkdirSync(root, { recursive: true })
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('照片导入暂存根目录无效')
  const dir = taskPath(taskId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir)
  const dirStat = fs.lstatSync(dir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('照片导入暂存目录无效')
  if (!child) return dir
  const childPath = taskPath(taskId, child)
  if (!fs.existsSync(childPath)) fs.mkdirSync(childPath)
  const childStat = fs.lstatSync(childPath)
  if (!childStat.isDirectory() || childStat.isSymbolicLink()) throw new Error('照片导入暂存子目录无效')
  return childPath
}
function saveTask(taskId, state) {
  ensureTaskDirectory(taskId)
  const target = taskPath(taskId, 'journal.json')
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx' })
    fs.renameSync(temp, target)
  } finally { try { fs.unlinkSync(temp) } catch { /* renamed */ } }
  const history = loadJson(TASK_HISTORY, { expect: 'array' }) || []
  const summary = {
    taskId,
    datasetId: state.datasetId,
    column: state.column,
    state: state.state,
    folderName: state.binding?.folderName || '',
    createdAt: state.createdAt || state.updatedAt || new Date().toISOString(),
    updatedAt: state.updatedAt = new Date().toISOString(),
    ...(state.counts ? { counts: state.counts } : {}),
    ...(state.error ? { error: String(state.error).slice(0, 500) } : {}),
  }
  saveJson(TASK_HISTORY, [summary, ...history.filter(item => item.taskId !== taskId)].slice(0, 100))
}
function readTask(taskId) {
  const dirStat = fs.lstatSync(taskPath(taskId))
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('照片导入暂存目录无效')
  const target = taskPath(taskId, 'journal.json')
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('照片导入任务记录无效')
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  if (!parsed || parsed.taskId !== taskId || !Array.isArray(parsed.assets) || !Array.isArray(parsed.binding?.files)) throw new Error('照片导入任务记录无效')
  return parsed
}
function removeTask(taskId) {
  const dir = taskPath(taskId)
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('照片导入暂存目录无效')
  fs.rmSync(dir, { recursive: true, force: true })
}
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}
function readActiveLock() {
  const lockPath = resolveInsideDataDir(ACTIVE_LOCK)
  let stat
  try { stat = fs.lstatSync(lockPath) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('照片导入任务锁无效')
  let lock
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { lock = null }
  if (lock && processIsAlive(Number(lock.pid))) return lock
  if (!lock && Date.now() - stat.mtimeMs < 30_000) return { taskId: null, pid: null, unknown: true }
  fs.unlinkSync(lockPath)
  return null
}
function acquireActiveLock(taskId) {
  ensureTaskDirectory(taskId)
  const lockPath = resolveInsideDataDir(ACTIVE_LOCK)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ taskId, pid: process.pid, startedAt: new Date().toISOString() })) }
      finally { fs.closeSync(fd) }
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const active = readActiveLock()
      if (active) throw new Error('另一进程正在导入照片，请等待完成')
    }
  }
  throw new Error('无法获取照片导入任务锁，请稍后重试')
}
function releaseActiveLock(taskId) {
  const lockPath = resolveInsideDataDir(ACTIVE_LOCK)
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    const stat = fs.lstatSync(lockPath)
    if (stat.isFile() && !stat.isSymbolicLink() && lock.taskId === taskId && Number(lock.pid) === process.pid) fs.unlinkSync(lockPath)
  } catch (err) { if (err.code !== 'ENOENT') console.error('[photo-import] could not release task lock') }
}
function listTasks(datasetId) {
  return (loadJson(TASK_HISTORY, { expect: 'array' }) || [])
    .filter(task => !datasetId || task.datasetId === String(datasetId))
    .slice(0, 30)
}
function referencedByPhotoBinding(assetId) {
  return bindings().some(binding => (binding.files || []).some(file => file.assetId === assetId))
}
function rollbackTask(task) {
  designs.withDesignLock(() => {
    const handled = new Set()
    for (const asset of task.assets) {
      if (handled.has(asset.assetId)) continue
      handled.add(asset.assetId)
      if (!asset.attempted) continue
      const referenced = referencedByPhotoBinding(asset.assetId)
      if (asset.libraryBefore) library.restoreImportEntry(asset.assetId, asset.libraryBefore, false)
      else if (!referenced) library.restoreImportEntry(asset.assetId, null, asset.created)
    }
  })
}

function requireColumn(datasetId, column) {
  const ds = dataset.getDataset(datasetId)
  if (!ds.columns.some(c => c.key === column)) throw new Error('照片绑定列不存在，请重新选择数据集和列')
  return ds
}
function columnFingerprint(ds, column) {
  return crypto.createHash('sha256').update(JSON.stringify(ds.rows.map(row => String(row[column] ?? '')))).digest('hex')
}

function inside(root, target) {
  const rel = path.relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('照片路径越出所选目录')
}

/** Scan before importing; never follow a link, including Windows junctions. */
function scanFolder(folder) {
  if (typeof folder !== 'string' || !folder || !fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) {
    throw new Error('请选择真实照片文件夹，不能使用符号链接')
  }
  const root = fs.realpathSync(folder)
  const files = []
  const ignored = []
  let visited = 0
  function visit(dir, depth) {
    if (depth > LIMITS.depth) throw new Error(`照片子目录不能超过 ${LIMITS.depth} 层`)
    const children = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (++visited > LIMITS.entries) throw new Error(`目录条目超过 ${LIMITS.entries} 个，请选择更小的照片目录`)
      const absolute = path.join(dir, child.name)
      const name = path.relative(root, absolute).split(path.sep).join('/')
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        if (PHOTO_EXT.test(name)) {
          files.push({ name, error: '符号链接照片不能导入' })
          if (files.length > LIMITS.photos) throw new Error(`照片超过 ${LIMITS.photos} 张，请拆分目录`)
        }
        else ignored.push({ name, reason: '跳过符号链接目录或文件' })
        continue
      }
      inside(root, fs.realpathSync(absolute))
      if (stat.isDirectory()) { visit(absolute, depth + 1); continue }
      if (!stat.isFile() || !PHOTO_EXT.test(name)) { ignored.push({ name, reason: '仅支持 PNG/JPEG 普通文件' }); continue }
      let error
      try { photoKey(name) } catch (err) { error = err.message }
      if (!stat.size || stat.size > LIMITS.singleBytes) error = '照片为空或超过 64 MiB'
      files.push({ name, absolute, size: stat.size, error })
      if (files.length > LIMITS.photos) throw new Error(`照片超过 ${LIMITS.photos} 张，请拆分目录`)
    }
  }
  visit(root, 0)
  return { root, files, ignored }
}

function readScannedFile(root, file) {
  // Verify every component again immediately before opening, including replaced directories.
  const relative = path.relative(root, file.absolute)
  inside(root, file.absolute)
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('照片目录或文件已变为符号链接')
    inside(root, fs.realpathSync(current))
  }
  const before = fs.lstatSync(file.absolute)
  const fd = fs.openSync(file.absolute, 'r')
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size <= 0 || opened.size > LIMITS.singleBytes
        || opened.size !== file.size || before.ino !== opened.ino || before.dev !== opened.dev) {
      throw new Error('照片在扫描后发生变化，请重新导入')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('照片读取不完整，请重新导入')
      offset += count
    }
    const after = fs.fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('照片在读取时发生变化，请重新导入')
    return bytes
  } finally { fs.closeSync(fd) }
}

/** Read-only filename/content preflight used to show replacement impact before commit. */
async function previewImport({ datasetId, column, folder, mode = 'append' }) {
  const ds = requireColumn(datasetId, column)
  if (ds.photoMatchColumn !== column) throw new Error('配图选择已变化，请重新选择变量照片库后导入')
  if (mode !== 'append' && mode !== 'replace') throw new Error('照片导入模式无效')
  const scanned = scanFolder(folder)
  const wanted = new Set()
  for (const row of ds.rows) { try { wanted.add(photoKey(String(row[column] ?? ''))) } catch { /* empty or invalid values */ } }
  const originalBinding = bindings().slice().reverse().find(item => item.datasetId === datasetId) || null
  const appendExisting = mode === 'append' && originalBinding?.column === column ? originalBinding : null
  const effectiveMode = mode === 'append' && (!originalBinding || originalBinding.column === column) ? 'append' : 'replace'
  const comparableBinding = originalBinding?.column === column ? originalBinding : null
  const oldGroups = new Map()
  const oldValid = new Map()
  for (const oldFile of comparableBinding?.files || []) {
    let key
    try { key = photoKey(oldFile.name) } catch { continue }
    if (!oldGroups.has(key)) oldGroups.set(key, [])
    oldGroups.get(key).push(oldFile)
  }
  for (const [key, group] of oldGroups) {
    if (group.length !== 1 || !group[0].assetId || group[0].error) continue
    try { designs.assetInfo(group[0].assetId); oldValid.set(key, group[0]) } catch { /* counted as repairable */ }
  }
  const index = photoIndex(scanned.files)
  const groups = new Map()
  let unmatched = scanned.ignored.length
  for (const file of scanned.files) {
    let key
    try { key = photoKey(file.name) } catch { /* ignored below */ }
    if (!wanted.has(key)) { unmatched++; continue }
    if (!groups.has(key)) groups.set(key, index.get(key) || [file])
  }
  const counts = { new: 0, repair: 0, keep: 0, same: 0, replace: 0, remove: 0, conflict: 0, invalid: 0, unmatched }
  const successfulKeys = new Set()
  let inspectedBytes = 0
  for (const [key, files] of groups) {
    const previous = oldValid.get(key)
    if (files.length > 1) {
      counts.conflict++
      if (previous && effectiveMode === 'append') counts.keep++
      await new Promise(resolve => setImmediate(resolve))
      continue
    }
    const file = files[0]
    if (file.error) {
      counts.invalid++
      if (previous && effectiveMode === 'append') counts.keep++
      await new Promise(resolve => setImmediate(resolve))
      continue
    }
    let assetId
    try {
      const bytes = readScannedFile(scanned.root, file)
      inspectedBytes += bytes.length
      if (inspectedBytes > LIMITS.bytes) throw new Error('匹配照片总大小超过 2 GiB，请拆分目录')
      assetId = 'asset_' + crypto.createHash('sha256').update(bytes).digest('hex')
    } catch (err) {
      if (/总大小超过/.test(err.message)) throw err
      counts.invalid++
      if (previous && effectiveMode === 'append') counts.keep++
      await new Promise(resolve => setImmediate(resolve))
      continue
    }
    successfulKeys.add(key)
    if (previous) {
      if (previous.assetId === assetId) counts.same++
      else if (effectiveMode === 'append') { counts.keep++; counts.conflict++ }
      else counts.replace++
    } else if (oldGroups.has(key)) counts.repair++
    else counts.new++
    await new Promise(resolve => setImmediate(resolve))
  }
  if (effectiveMode === 'append') {
    for (const key of oldValid.keys()) {
      if (successfulKeys.has(key)) continue
      if (wanted.has(key) && (!groups.has(key) || groups.get(key).length > 1 || groups.get(key)[0]?.error)) counts.keep++
    }
  }
  if (effectiveMode === 'replace' && originalBinding) {
    const previousKeys = new Set()
    for (const file of originalBinding.files || []) {
      try { previousKeys.add(photoKey(file.name)) } catch { /* malformed historical binding */ }
    }
    counts.remove = originalBinding.column !== column
      ? previousKeys.size
      : [...previousKeys].filter(key => !successfulKeys.has(key)).length
  }
  return {
    folderName: path.basename(scanned.root),
    requestedMode: mode,
    mode: effectiveMode,
    previousColumnChanged: Boolean(originalBinding && originalBinding.column !== column),
    candidateCount: [...groups.values()].reduce((sum, files) => sum + files.length, 0),
    counts,
  }
}

async function importFolder({ datasetId, column, folder, taskId: requestedTaskId, mode = 'append' }, { onProgress = () => {}, makeThumbnail, onCheckpoint } = {}) {
  const ds = requireColumn(datasetId, column)
  if (!ds.photoMatchColumn || ds.photoMatchColumn !== column) throw new Error('配图选择已变化，请重新选择变量照片库后导入')
  if (mode !== 'append' && mode !== 'replace') throw new Error('照片导入模式无效')
  if (importing) throw new Error('已有照片正在导入，请等待完成')
  importing = true
  const taskId = requestedTaskId || crypto.randomUUID()
  if (!/^[a-f0-9-]{36}$/.test(taskId)) { importing = false; throw new Error('照片导入任务标识无效') }
  activeTaskId = taskId
  let lockAcquired = false
  const checkpoint = name => { if (typeof onCheckpoint === 'function') onCheckpoint(name) }
  const checkCanceled = () => { if (canceledTasks.has(taskId)) throw new Error('照片导入已取消') }
  const originalBinding = bindings().slice().reverse().find(item => item.datasetId === datasetId) || null
  const task = {
    version: 1, taskId, datasetId, column, mode,
    inputFingerprint: columnFingerprint(ds, column),
    baseBindingFingerprint: crypto.createHash('sha256').update(JSON.stringify(originalBinding)).digest('hex'),
    createdAt: new Date().toISOString(), state: 'scanning', assets: [],
    binding: { datasetId, column, folderName: '', importedAt: '', files: [], ignored: [] },
  }
  try {
    acquireActiveLock(taskId)
    lockAcquired = true
    saveTask(taskId, task)
    onProgress({ taskId, done: 0, total: 0, stage: 'scanning' })
    const scanned = scanFolder(folder)
    task.binding.folderName = path.basename(scanned.root)
    task.binding.importedAt = new Date().toISOString()
    task.state = 'matching'
    saveTask(taskId, task)
    await new Promise(resolve => setImmediate(resolve))
    checkCanceled()

    const wanted = new Set()
    for (const row of ds.rows) { try { wanted.add(photoKey(String(row[column] ?? ''))) } catch { /* skip empty values */ } }
    const appendExisting = mode === 'append' && originalBinding?.column === column ? originalBinding : null
    const oldByKey = new Map()
    const oldValidByKey = new Map()
    if (appendExisting) {
      for (const oldFile of appendExisting.files || []) {
        let key
        try { key = photoKey(oldFile.name) } catch { continue }
        if (!wanted.has(key)) continue
        if (!oldByKey.has(key)) oldByKey.set(key, [])
        oldByKey.get(key).push(oldFile)
      }
      for (const [key, oldFiles] of oldByKey) {
        if (oldFiles.length !== 1) continue
        const oldFile = oldFiles[0]
        if (oldFile.assetId && !oldFile.error) {
          try { designs.assetInfo(oldFile.assetId); oldValidByKey.set(key, oldFile) }
          catch { /* a matching replacement can repair this stale reference */ }
        }
      }
    }

    const index = photoIndex(scanned.files)
    const byKey = new Map()
    const ignored = [...scanned.ignored]
    for (const file of scanned.files) {
      let key
      try { key = photoKey(file.name) } catch { /* unmatchable filename */ }
      if (!wanted.has(key)) { ignored.push({ name: file.name, reason: '未匹配当前名单，未入库' }); continue }
      const matches = index.get(key) || []
      if (!byKey.has(key)) byKey.set(key, matches.length > 1
        ? matches.map(candidate => ({ ...candidate, error: '同名冲突，未入库，请处理后重新导入' }))
        : [file])
    }
    const candidates = [...byKey.entries()].map(([key, files]) => ({ key, files }))
    if (candidates.reduce((n, group) => n + group.files.reduce((sum, file) => sum + (file.error ? 0 : file.size), 0), 0) > LIMITS.bytes) throw new Error('匹配照片总大小超过 2 GiB，请拆分目录')

    const merged = new Map(appendExisting ? oldByKey : [])
    let importedBytes = 0
    let done = 0
    for (const group of candidates) {
      checkCanceled()
      if (requireColumn(datasetId, column).photoMatchColumn !== column) throw new Error('导入期间配图选择已变化，请重新导入')
      const file = group.files[0]
      const previousValid = oldValidByKey.get(group.key)
      if (group.files.length > 1) {
        if (previousValid) ignored.push({ name: file.name, reason: '本次目录有同名冲突，补充模式保留已有照片；如需更换请使用替换当前名单照片' })
        else merged.set(group.key, group.files.map(candidate => ({ name: candidate.name, error: candidate.error })))
        done += group.files.length
        onProgress({ taskId, done, total: candidates.reduce((sum, item) => sum + item.files.length, 0), name: file.name })
        await new Promise(resolve => setImmediate(resolve))
        continue
      }
      if (file.error) {
        if (previousValid) ignored.push({ name: file.name, reason: '已有有效照片，补充模式保留旧图；如需更换请使用替换当前名单照片' })
        else merged.set(group.key, [{ name: file.name, error: file.error }])
      } else try {
        const bytes = readScannedFile(scanned.root, file)
        importedBytes += bytes.length
        if (importedBytes > LIMITS.bytes) throw new Error('照片总大小超过 2 GiB')
        const assetId = 'asset_' + crypto.createHash('sha256').update(bytes).digest('hex')
        if (previousValid) {
          if (previousValid.assetId === assetId) {
            // Same content: keep the old binding and avoid another metadata write.
          } else ignored.push({ name: file.name, reason: '已有有效照片且内容不同，补充模式保留旧图；如需更换请使用替换当前名单照片' })
        } else {
          const libraryBefore = library.snapshotImportEntry(assetId)
          let created = false
          try { designs.assetInfo(assetId) } catch {
            const hash = assetId.slice(6)
            created = !['png', 'jpg', 'jpeg'].some(ext => fs.existsSync(resolveInsideDataDir(`design-assets/${hash}.${ext}`)))
          }
          task.assets.push({ assetId, created, libraryBefore, attempted: true })
          task.state = 'staging'
          saveTask(taskId, task)
          const staged = taskPath(taskId, `content/${crypto.randomUUID()}.image`)
          ensureTaskDirectory(taskId, 'content')
          fs.writeFileSync(staged, bytes, { flag: 'wx' })
          checkCanceled()
          const asset = designs.importImageBuffer(fs.readFileSync(staged), path.basename(file.name), 'ephemeral')
          library.upsert(asset, {}, { makeThumbnail })
          merged.set(group.key, [{ name: file.name, assetId: asset.id }])
        }
      } catch (err) {
        if (previousValid) ignored.push({ name: file.name, reason: '补充失败，已保留原照片；请检查新文件后重试，或使用替换操作' })
        else merged.set(group.key, [{ name: file.name, error: err.message }])
      }
      done += group.files.length
      onProgress({ taskId, done, total: candidates.reduce((sum, item) => sum + item.files.length, 0), name: file.name })
      await new Promise(resolve => setImmediate(resolve))
    }

    checkpoint('after-assets-staged')
    checkCanceled()
    const current = requireColumn(datasetId, column)
    if (current.photoMatchColumn !== column || columnFingerprint(current, column) !== task.inputFingerprint) throw new Error('导入期间名单配图字段已变化，请重新导入')
    task.binding.files = [...merged.values()].flat()
    task.binding.ignored = [...new Map([
      ...(appendExisting?.ignored || []), ...ignored,
    ].map(item => [`${item.name}\0${item.reason}`, item])).values()]
    task.state = 'committing'
    saveTask(taskId, task)
    checkpoint('before-publish')
    rollbackTask({ ...task, assets: task.assets.filter(asset => !task.binding.files.some(file => file.assetId === asset.assetId)) })
    designs.withDesignLock(() => {
      const latest = requireColumn(datasetId, column)
      if (latest.photoMatchColumn !== column || columnFingerprint(latest, column) !== task.inputFingerprint) throw new Error('提交前名单或配图选择已变化，请重新导入')
      const currentBinding = bindings().slice().reverse().find(item => item.datasetId === datasetId) || null
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(currentBinding)).digest('hex')
      if (fingerprint !== task.baseBindingFingerprint) throw new Error('照片关联在导入期间已被其他操作修改，请重新导入')
      saveJson('photo-bindings', [...bindings().filter(item => item.datasetId !== datasetId), { ...task.binding, taskId }])
    })
    checkpoint('after-publish')
    for (const file of task.binding.files) if (file.assetId) designs.setAssetSource(file.assetId, 'managed')
    const result = await report({ datasetId, column })
    task.state = 'completed'
    task.counts = result.counts
    saveTask(taskId, task)
    removeTask(taskId)
    return result
  } catch (err) {
    try {
      if (bindings().some(binding => binding.taskId === taskId)) {
        task.state = 'published-recovery-pending'
        task.error = err.message
        saveTask(taskId, task)
      } else {
        rollbackTask(task)
        task.state = err.message === '照片导入已取消' ? 'canceled' : 'rolled-back'
        task.error = err.message
        saveTask(taskId, task)
        removeTask(taskId)
      }
    } catch (cleanupError) {
      task.state = 'recovery-pending'
      task.error = cleanupError.message
      try { saveTask(taskId, task) } catch { /* retain the last durable journal */ }
      console.error('[photo-import] cleanup deferred to startup recovery')
    }
    throw err
  } finally {
    if (lockAcquired) releaseActiveLock(taskId)
    importing = false
    activeTaskId = null
    canceledTasks.delete(taskId)
  }
}

function cancelImport(taskId) {
  if (typeof taskId !== 'string' || taskId !== activeTaskId) return { accepted: false }
  canceledTasks.add(taskId)
  return { accepted: true }
}

function recoverPendingImports() {
  const root = resolveInsideDataDir(STAGING_DIR)
  if (!fs.existsSync(root)) return { recovered: [], rolledBack: [], failed: [] }
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('照片导入暂存目录无效')
  const active = readActiveLock()
  const recovered = [], rolledBack = [], failed = []
  if (active) return { recovered, rolledBack, failed, deferred: true }
  for (const name of fs.readdirSync(root)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue
    try {
      const task = readTask(name)
      const published = bindings().some(binding => binding.taskId === task.taskId)
      if (published) {
        for (const file of task.binding.files.filter(item => item.assetId)) {
          designs.setAssetSource(file.assetId, 'managed')
          library.upsert(designs.assetInfo(file.assetId), {}, {})
        }
        rollbackTask({ ...task, assets: task.assets.filter(asset => !task.binding.files.some(file => file.assetId === asset.assetId)) })
        task.state = 'recovered'
        task.error = ''
        saveTask(name, task)
        recovered.push(name)
      } else {
        rollbackTask(task)
        task.state = 'rolled-back-after-restart'
        task.error = ''
        saveTask(name, task)
        rolledBack.push(name)
      }
      removeTask(name)
    } catch (err) {
      failed.push({ taskId: name, error: err.message })
      try {
        const task = readTask(name)
        task.state = 'recovery-failed'
        task.error = err.message
        saveTask(name, task)
      } catch { /* keep existing journal */ }
    }
  }
  return { recovered, rolledBack, failed }
}

async function report({ datasetId, column, rows } = {}) {
  const ds = dataset.getDataset(datasetId)
  column = ds.photoMatchColumn || column
  requireColumn(datasetId, column)
  const binding = bindings().slice().reverse().find(item => item.datasetId === datasetId)
  const verified = new Map()
  const files = []
  for (const file of binding?.files || []) {
    if (file.error) { files.push(file); continue }
    if (!verified.has(file.assetId)) {
      try { verified.set(file.assetId, designs.assetInfo(file.assetId)) }
      catch (err) { verified.set(file.assetId, err.message) }
      await new Promise(resolve => setImmediate(resolve))
    }
    const info = verified.get(file.assetId)
    let thumbFile
    try { thumbFile = library.getEntry(file.assetId).thumbFile } catch { /* optional cache */ }
    files.push(typeof info === 'string' ? { ...file, error: info } : { ...file, width: info.width, height: info.height, thumbFile })
  }
  return {
    ...matchPhotos(ds.rows, column, ds.photoMatchColumn ? files : [], rows),
    imported: Boolean(binding), folderName: binding?.folderName || '', importedAt: binding?.importedAt || null,
    files: files.map(({ name, assetId, width, height, thumbFile, error }) => ({ name, assetId, width, height, thumbFile, ...(error ? { error } : {}) })),
    ignored: binding?.ignored || [],
  }
}

/** Resolve only the selected records; unrelated missing photos must not block partial output. */
function prepareRows(datasetId, columns, records, rowIndexes = null) {
  const ds = dataset.getDataset(datasetId)
  const all = bindings()
  const byRecord = new Map(records.map(row => [row, Object.fromEntries(columns.map(key => [key, null]))]))
  const assets = new Set()
  const column = ds.photoMatchColumn
  if (!column || !columns.length) return { byRecord, assets: [] }
  if (!ds.columns.some(c => c.key === column)) throw new Error('配图列已不存在，请到数据页重新选择')
  const binding = all.slice().reverse().find(b => b.datasetId === datasetId)
  const result = matchPhotos(records, column, binding?.files || [])
    for (const item of result.results) {
      if (item.status === 'missing' || item.status === 'empty') continue
      if (item.status !== 'matched') throw new Error(`照片出片检查：第 ${(rowIndexes?.[item.rowIndex] ?? item.rowIndex) + 1} 行「${item.name || '空值'}」未匹配，请到变量照片库处理`)
      if (!assets.has(item.assetId)) designs.assetInfo(item.assetId)
      assets.add(item.assetId)
      for (const key of columns) byRecord.get(records[item.rowIndex])[key] = `pp://media/${item.assetId}`
    }
  return { byRecord, assets: [...assets] }
}

module.exports = { importFolder, previewImport, cancelImport, report, scanFolder, prepareRows, recoverPendingImports, listTasks, LIMITS }

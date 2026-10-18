/** Photo directory import. Original bytes are shared with the existing managed asset pool. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const XLSX = require('xlsx')
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
/** 溢出的任务记录改存归档，而不是丢进 `.slice(0, 100)` 的黑洞（I-55） */
const TASK_HISTORY_ARCHIVE = 'photo-import-tasks-archive'
const TASK_HISTORY_LIMIT = 100
const TASK_HISTORY_ARCHIVE_LIMIT = 500
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
  const next = [summary, ...history.filter(item => item.taskId !== taskId)]
  // 先把被挤出上限的记录收进归档，再写只留最近 N 条的界面列表（顺序不能反）
  archiveTaskHistoryOverflow(next.slice(TASK_HISTORY_LIMIT))
  saveJson(TASK_HISTORY, next.slice(0, TASK_HISTORY_LIMIT))
}

/**
 * 任务历史上限之外的记录改存归档（I-55）。
 *
 * 为什么：原来的 `.slice(0, 100)` 是**静默销毁**——第 101 次导入之后，最早的记录就再也找不到了。
 * 而照片导入恰好是最容易出问题的一步（同名学生、目录被改名、图缺了张），事后想回溯
 * 「那次绑的是哪个目录、匹配了多少张」就只能靠这条记录。归档只追加、按 taskId 去重，
 * 并保留最近 TASK_HISTORY_ARCHIVE_LIMIT 条防止无上限增长。
 * 目前归档只落盘、没有界面入口：它的价值是「记录还在」，不是「列表更长」。
 */
function archiveTaskHistoryOverflow(overflow) {
  if (!overflow.length) return 0
  const archived = loadJson(TASK_HISTORY_ARCHIVE, { expect: 'array' }) || []
  const known = new Set(overflow.map(item => item.taskId))
  const merged = [...overflow, ...archived.filter(item => !known.has(item.taskId))]
  saveJson(TASK_HISTORY_ARCHIVE, merged.slice(0, TASK_HISTORY_ARCHIVE_LIMIT))
  return overflow.length
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
            // 两个池子都算「已存在」（I-51）：临时池里的同内容照片不是本次导入创造的，
            // 回滚时不能删它——删了会吃掉别的绑定正在用的照片。
            created = !designs.originalExists(assetId.slice(6))
          }
          task.assets.push({ assetId, created, libraryBefore, attempted: true })
          task.state = 'staging'
          saveTask(taskId, task)
          const staged = taskPath(taskId, `content/${crypto.randomUUID()}.image`)
          ensureTaskDirectory(taskId, 'content')
          fs.writeFileSync(staged, bytes, { flag: 'wx' })
          checkCanceled()
          const asset = designs.importImageBuffer(fs.readFileSync(staged), path.basename(file.name), 'ephemeral')
          library.upsert(asset, { role: 'photo' }, { makeThumbnail })
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
          library.upsert(designs.assetInfo(file.assetId), { role: 'photo' }, {})
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

/** Verify only photos used by the selected print rows. Return original dataset row numbers. */
async function preflightRows(ds, rowIndexes) {
  const selected = rowIndexes || ds.rows.map((_, index) => index)
  const column = ds.photoMatchColumn
  if (!column) return {
    column: null, enabled: false, total: selected.length,
    counts: { matched: 0, empty: selected.length, missing: 0, ambiguous: 0, invalid: 0, broken: 0 },
    results: [], bindingRevision: null,
  }
  if (!ds.columns.some(item => item.key === column)) throw new Error('配图列已不存在，请到数据页重新选择')
  const binding = bindings().slice().reverse().find(item => item.datasetId === ds.id) || null
  const result = matchPhotos(ds.rows, column, binding?.files || [], selected)
  const verified = new Map()
  for (const item of result.results) {
    if (item.status !== 'matched') continue
    if (!verified.has(item.assetId)) {
      try { designs.assetInfo(item.assetId); verified.set(item.assetId, null) }
      catch (err) { verified.set(item.assetId, err.message) }
      await new Promise(resolve => setImmediate(resolve))
    }
    const error = verified.get(item.assetId)
    if (error) {
      item.status = 'broken'
      item.reason = error
      delete item.assetId
      result.counts.matched--
      result.counts.broken++
    }
  }
  return {
    column, enabled: true, total: result.total, counts: result.counts, results: result.results,
    bindingRevision: crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
  }
}

/** Export the selected problem rows as typed Excel strings, preserving IDs and leading zeros. */
async function exportIssues({ datasetId, column, rows, identifierKey, savePath }, { saveFile } = {}) {
  const ds = dataset.getDataset(String(datasetId))
  if (!ds.photoMatchColumn || ds.photoMatchColumn !== column) throw new Error('配图列已变化，请重新检查后导出')
  const identifier = ds.columns.find(item => item.key === identifierKey)
  if (!identifier) throw new Error('识别字段已不存在，请重新选择')
  const selected = rows == null ? ds.rows.map((_, index) => index) : rows
  if (!Array.isArray(selected) || selected.some(index => !Number.isInteger(index) || index < 0 || index >= ds.rows.length)
      || new Set(selected).size !== selected.length) throw new Error('导出行范围无效')
  const check = await preflightRows(ds, selected)
  const issues = check.results.filter(item => item.status !== 'matched')
  if (!issues.length) return { canceled: false, count: 0 }
  let target = savePath ? String(savePath) : ''
  if (!target) {
    if (typeof saveFile !== 'function') throw new Error('缺少保存路径')
    const result = await saveFile({ title: '导出照片问题清单', defaultPath: '照片问题清单.xlsx', filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    target = result.filePath
  }
  if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.xlsx') throw new Error('请指定绝对路径的 .xlsx 文件')
  const statusText = { empty: '空值', missing: '缺图', ambiguous: '同名冲突', invalid: '名称无效', broken: '坏图' }
  const cells = [
    ['原始行号', identifier.alias || identifier.key, '配图值', '问题类型', '说明'],
    ...issues.map(item => [item.rowIndex + 1, String(ds.rows[item.rowIndex][identifier.key] ?? ''),
      item.name, statusText[item.status] || item.status,
      item.reason || (item.candidates ? `候选：${item.candidates.join('、')}` : item.status === 'missing' || item.status === 'empty' ? '出片留白' : '')]),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(cells)
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!') || address[0] === 'A' && address !== 'A1') continue
    sheet[address].t = 's'
    sheet[address].v = String(sheet[address].v ?? '')
    delete sheet[address].f
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, '照片问题')
  fs.writeFileSync(target, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  return { canceled: false, count: issues.length, path: target }
}

/** Resolve only the selected records; unrelated missing photos must not block partial output. */
/**
 * 为出片准备「记录 → 列 → 照片」的映射。
 *
 * **byRecord 里存的是 assetId，不是 URL**：同一张照片在不同出片分辨率下要走不同的 URL
 * （原件 / 降采样派生件），URL 由渲染层按档位决定（见 output-dpi.cjs 与 render-engine）。
 * 存 URL 会让「降采样」变成一个必须在数据层就定死的选择。
 */
function prepareRows(datasetId, columns, records, rowIndexes = null, { estimateOnly = false, knownGeometry, templateId } = {}) {
  const ds = dataset.getDataset(datasetId)
  const all = bindings()
  const byRecord = new Map(records.map(row => [row, Object.fromEntries(columns.map(key => [key, null]))]))
  const assets = new Set()
  /**
   * assetId → { width, height, orientation, mime }（宽高是**显示坐标**，见 designs.validateImage）。
   *
   * 下面为了「照片缺失/损坏要立刻报错」本来就要读一遍原件，这里把读出来的几何顺手留下：
   * 出片分辨率（I-49）规划降采样目标只靠它，**不必再读第二遍原件**。500 张照片读两遍就是
   * 3.7 GB 的额外 I/O，且会让每次预览都卡住。
   */
  const geometry = new Map()
  let unresolved = 0
  const column = ds.photoMatchColumn
  if (!column || !columns.length) return { byRecord, assets: [], geometry, overrides: new Map() }
  if (!ds.columns.some(c => c.key === column)) throw new Error('配图列已不存在，请到数据页重新选择')
  const binding = all.slice().reverse().find(b => b.datasetId === datasetId)
  const result = matchPhotos(records, column, binding?.files || [])
  const overrides = templateId ? require('./photo-overrides.cjs').forRecords(ds, templateId, records, rowIndexes, result) : new Map()
    for (const item of result.results) {
      if (item.status === 'missing' || item.status === 'empty') continue
      if (item.status !== 'matched') {
        if (estimateOnly) { unresolved++; continue }
        throw new Error(`照片出片检查：第 ${(rowIndexes?.[item.rowIndex] ?? item.rowIndex) + 1} 行「${item.name || '空值'}」未匹配，请到变量照片库处理`)
      }
      if (!assets.has(item.assetId)) {
        try {
          const a = estimateOnly
            ? knownGeometry?.get(item.assetId) || designs.assetGeometry(item.assetId)
            : designs.assetInfo(item.assetId)
          geometry.set(item.assetId, { width: a.width, height: a.height, orientation: a.orientation, mime: a.mime })
        } catch (err) {
          if (!estimateOnly) throw err
          unresolved++
        }
      }
      assets.add(item.assetId)
      for (const key of columns) byRecord.get(records[item.rowIndex])[key] = item.assetId
    }
  return { byRecord, assets: [...assets], geometry, overrides, unresolved }
}

module.exports = { importFolder, previewImport, cancelImport, report, preflightRows, exportIssues, scanFolder, prepareRows, recoverPendingImports, listTasks, saveTask, TASK_HISTORY, TASK_HISTORY_ARCHIVE, TASK_HISTORY_LIMIT, TASK_HISTORY_ARCHIVE_LIMIT, LIMITS }

// Conservative startup maintenance: remove only old, unused thumbnail caches
// whose valid original is still present. Never delete original image bytes.
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const storage = require('./asset-storage.cjs')
const { resolveInsideDataDir } = require('./store.cjs')
const AGE_MS = 7 * 24 * 60 * 60 * 1000
const HASH = /^[a-f0-9]{64}$/
const pools = ['design-assets', 'ephemeral-assets', 'photo-assets']
let state = { phase: 'idle' }
const status = () => ({ ...state })
function skip(reason) { if (state.phase !== 'running') state = { phase: 'skipped', reason }; return status() }
function locked() {
  const holder = require('./data-lock.cjs').readHolder()
  return Boolean(holder && !holder.malformed && holder.pid === process.pid && holder.role === 'gui')
}
function libraryIds() {
  const file = resolveInsideDataDir('asset-library.json')
  let stat, rows
  try { stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error('invalid'); rows = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { throw Error('素材库索引不可读取') }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.assetId !== 'string' || !/^asset_[a-f0-9]{64}$/.test(row.assetId))) throw Error('素材库索引无效')
  return new Set(rows.map(row => row.assetId))
}
function same(a, b) { return a.isFile() && !a.isSymbolicLink() && b.isFile() && !b.isSymbolicLink() && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev }
function directory(dir) {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('目录不可读取')
}
async function run(options = {}) {
  if (state.phase === 'running') return status()
  state = { phase: 'running', removed: 0, bytes: 0, skipped: 0, failed: 0 }
  try {
    if (!locked()) throw Error('未取得数据目录锁')
    const thumbnails = resolveInsideDataDir('design-thumbnails')
    try { directory(thumbnails) } catch (err) { if (err.code === 'ENOENT') { state.phase = 'completed'; return status() }; throw err }
    // Requiring a readable index avoids deleting the last preview of a missing
    // or archived library item, including when the index has been quarantined.
    const initialIds = libraryIds()
    const roots = []
    for (const pool of pools) {
      const root = storage.poolDir(pool)
      try { directory(root); roots.push(root) }
      catch (err) { if (err.code !== 'ENOENT' || (pool === 'design-assets' && process.env.PRINTPRESS_ASSET_DIR)) throw Error('素材目录不可读取') }
    }
    for (const name of await fs.promises.readdir(thumbnails)) {
      const match = /^([a-f0-9]{64})\.png$/.exec(name)
      if (!match || !HASH.test(match[1]) || initialIds.has(`asset_${match[1]}`)) continue
      const file = path.join(thumbnails, name)
      try {
        const thumb = await fs.promises.lstat(file)
        if (!thumb.isFile() || thumb.isSymbolicLink() || Date.now() - thumb.mtimeMs < AGE_MS) { state.skipped++; continue }
        let found = null
        for (const root of roots) {
          for (const ext of ['png', 'jpg', 'jpeg']) {
            const original = path.join(root, `${match[1]}.${ext}`)
            let before
            try { before = await fs.promises.lstat(original) } catch (err) { if (err.code === 'ENOENT') continue; throw err }
            if (!before.isFile() || before.isSymbolicLink()) continue
            const digest = crypto.createHash('sha256')
            for await (const chunk of fs.createReadStream(original)) digest.update(chunk)
            const after = await fs.promises.lstat(original)
            if (same(before, after) && digest.digest('hex') === match[1]) { found = { original, stat: after, root }; break }
          }
          if (found) break
        }
        if (!found) { state.skipped++; continue }
        if (options.beforeCommit) await options.beforeCommit(match[1])
        // No await in this section: in-process imports, index updates and cache
        // replacement cannot interleave with the final checks and unlink.
        if (!locked()) throw Error('数据目录锁已失效')
        directory(thumbnails); directory(found.root)
        const ids = libraryIds(), latestThumb = fs.lstatSync(file), latestOriginal = fs.lstatSync(found.original)
        if (ids.has(`asset_${match[1]}`) || !same(thumb, latestThumb) || !same(found.stat, latestOriginal) || Date.now() - latestThumb.mtimeMs < AGE_MS) { state.skipped++; continue }
        fs.unlinkSync(file)
        state.removed++; state.bytes += latestThumb.size
      } catch { state.failed++ }
    }
    state.phase = 'completed'
  } catch (err) {
    state.phase = 'skipped'
    state.reason = ['未取得数据目录锁', '素材库索引不可读取', '素材库索引无效', '素材目录不可读取'].includes(err.message) ? err.message : '缓存目录不可读取或状态异常'
  }
  return status()
}
module.exports = { run, status, skip, AGE_MS }

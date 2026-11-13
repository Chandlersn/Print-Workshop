// Read-only inventory. Never infer that a file is safe to delete from this report.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { parentPort, workerData } = require('worker_threads')
const { poolDir } = require('./asset-storage.cjs')
const pools = ['design-assets', 'ephemeral-assets', 'photo-assets']
const send = message => { if (parentPort) parentPort.postMessage(message) }
async function audit() {
  const groups = new Map(), issues = [], stats = { files: 0, bytes: 0, checked: 0 }
  for (const pool of pools) {
    let root, names
    try {
      root = poolDir(pool)
      const st = await fs.promises.lstat(root)
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('目录不是普通目录')
      names = await fs.promises.readdir(root)
    } catch (err) {
      // Absent default pools are normal for a fresh data directory; an explicitly
      // configured managed directory is expected to exist and must be reported.
      if (err.code !== 'ENOENT' || (pool === 'design-assets' && process.env.PRINTPRESS_ASSET_DIR)) issues.push({ pool, reason: '目录不可访问' })
      continue
    }
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.(png|jpg|jpeg)$/i.exec(name)
      if (!match) continue
      const hash = match[1].toLowerCase(), file = path.join(root, name)
      try {
        const st = await fs.promises.lstat(file)
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('原件不是普通文件')
        const row = { pool, file, hash, bytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino }
        try {
          const metaPath = path.join(root, `${hash}.json`), metaStat = await fs.promises.lstat(metaPath)
          if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 1048576) throw new Error('invalid')
          const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'))
          if (meta.id !== `asset_${hash}` || meta.path !== `${pool}/${name}` || !['image/png', 'image/jpeg'].includes(meta.mime)) throw new Error('invalid')
        } catch { issues.push({ pool, hash, reason: '素材信息缺失或无效' }) }
        if (!groups.has(hash)) groups.set(hash, [])
        groups.get(hash).push(row); stats.files++; stats.bytes += st.size
      } catch { issues.push({ pool, hash, reason: '原件不可读取或类型异常' }) }
    }
    send({ phase: 'enumerating', ...stats })
  }
  const duplicates = []
  for (const [hash, rows] of groups) {
    if (new Set(rows.map(row => row.pool)).size < 2) continue
    const verified = []
    for (const row of rows) {
      try {
        const before = await fs.promises.lstat(row.file)
        if (!before.isFile() || before.isSymbolicLink() || before.size !== row.bytes || before.mtimeMs !== row.mtimeMs || before.ino !== row.ino) throw new Error('changed')
        const digest = crypto.createHash('sha256')
        for await (const chunk of fs.createReadStream(row.file)) digest.update(chunk)
        const after = await fs.promises.lstat(row.file)
        if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('changed')
        if (digest.digest('hex') !== hash) { issues.push({ pool: row.pool, hash, reason: '原件内容与文件名哈希不一致' }); continue }
        verified.push({ pool: row.pool, bytes: row.bytes })
      } catch { issues.push({ pool: row.pool, hash, reason: '校验时原件发生变化或无法读取' }) }
      stats.checked++; send({ phase: 'checking', ...stats })
    }
    if (new Set(verified.map(row => row.pool)).size >= 2) duplicates.push({ hash, copies: verified, theoreticalBytes: verified.reduce((sum, row) => sum + row.bytes, 0) - Math.max(...verified.map(row => row.bytes)) })
  }
  send({ phase: 'references', ...stats })
  const referenceResult = await require('./asset-audit-references.cjs').references()
  issues.push(...referenceResult.issues.map(item => ({ pool: item.area, reason: item.reason })))
  const assets = [...groups].map(([hash, rows]) => ({ hash, copies: rows.map(row => ({ pool: row.pool, bytes: row.bytes })), references: referenceResult.refs.get(`asset_${hash}`) || [] }))
  const noKnownReferences = assets.filter(item => item.references.length === 0).length
  for (const group of duplicates) group.references = referenceResult.refs.get(`asset_${group.hash}`) || []
  const missingReferences = [...referenceResult.refs].filter(([id, refs]) => !groups.has(id.slice(6)) && refs.some(ref => ref.type !== '打印归档独立照片副本')).length
  return { completedAt: new Date().toISOString(), complete: issues.length === 0, ...stats, assets, groups: duplicates, theoreticalBytes: duplicates.reduce((sum, item) => sum + item.theoreticalBytes, 0), issues, missingReferences, noKnownReferences, printJobCount: referenceResult.printJobCount }
}
if (parentPort && workerData?.audit) audit().then(report => send({ phase: 'completed', report })).catch(() => send({ phase: 'failed', reason: '扫描失败，请重新尝试' }))
module.exports = { audit }

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { resolveInsideDataDir } = require('./store.cjs')
const { writeFileAtomic } = require('./atomic-write.cjs')

const lifetime = 15 * 60 * 1000
const diskToken = /^cli-(\d{13})-([a-f0-9]{64})$/
const digest = text => crypto.createHash('sha256').update(text).digest('hex')
let current = null

function save(preview, persist) {
  const expires = Date.now() + lifetime
  const nonce = crypto.randomBytes(24).toString('hex')
  if (!persist) {
    current = { token: nonce, expires, preview }
    return nonce
  }

  const dir = resolveInsideDataDir('code-previews')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(dir)) {
    const match = diskToken.exec(entry)
    if (match && Number(match[1]) <= Date.now()) remove(entry)
  }
  const bytes = JSON.stringify({ nonce, expires, preview })
  const token = `cli-${expires}-${digest(bytes)}`
  writeFileAtomic(path.join(dir, token), bytes)
  return token
}

function get(token) {
  if (current && token === current.token && current.expires > Date.now()) return current.preview
  const match = diskToken.exec(token)
  if (!match) return null
  if (Number(match[1]) <= Date.now()) { remove(token); return null }
  let bytes
  try { bytes = fs.readFileSync(resolveInsideDataDir(`code-previews/${token}`)) }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
  if (digest(bytes) !== match[2]) return null
  const entry = JSON.parse(bytes)
  return entry.expires === Number(match[1]) ? entry.preview : null
}

function remove(token) {
  if (current?.token === token) current = null
  if (diskToken.test(token)) {
    // 成功写入后即使清理失败，数据集快照也会阻止同一凭证再次写入。
    try { fs.unlinkSync(resolveInsideDataDir(`code-previews/${token}`)) } catch { /* 下次预览时清理过期文件 */ }
  }
}

module.exports = { save, get, remove }

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function writeFileAtomic(target, bytes) {
  const temp = path.join(path.dirname(target), `.printpress-${crypto.randomUUID()}.tmp`)
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try { fs.writeFileSync(fd, bytes) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, target)
  } catch (err) {
    try { fs.unlinkSync(temp) } catch { /* 保留写入或替换失败的原始错误 */ }
    throw err
  }
}

module.exports = { writeFileAtomic }

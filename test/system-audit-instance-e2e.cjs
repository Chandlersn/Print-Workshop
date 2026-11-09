/** Probe normal startup with an isolated data directory and no pre-set data-dir variable. */
const { app } = require('electron')
const assert = require('assert/strict'), fs = require('fs'), path = require('path')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-audit-instance-'))
app.setPath('userData', path.join(tmp, 'userData'))
delete process.env.PRINTPRESS_DATA_DIR
const dataDir = require('../electron/data-dir.cjs')
dataDir.resolveDataDir = () => ({ dataDir: path.join(tmp, 'data'), custom: false, fallback: path.join(tmp, 'data') })
let calls = 0
app.requestSingleInstanceLock = () => { calls++; return false }
app.whenReady = () => new Promise(() => {})
require('../electron/main.cjs')
try {
  assert.equal(calls, 1, '正常启动必须检查 Electron 单实例锁')
  console.log('AUDIT_INSTANCE_OK', tmp)
  app.exit(0)
} catch (error) { console.error(error.stack); app.exit(1) }

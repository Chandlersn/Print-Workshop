/** Restart-time migration uses the latest source and keeps both directories locked. */
const { app, dialog } = require('electron')
const assert = require('assert/strict'), fs = require('fs'), path = require('path')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-audit-migration-'))
const userData = path.join(tmp, 'userData'), source = path.join(tmp, 'old'), target = path.join(tmp, 'new')
for (const dir of [userData, source, target]) fs.mkdirSync(dir, { recursive: true })
app.setPath('userData', userData)
delete process.env.PRINTPRESS_DATA_DIR
const dir = require('../electron/data-dir.cjs')
const mode = process.argv[2] || 'success'
fs.writeFileSync(path.join(source, 'marker.txt'), 'before selection')
dir.scheduleMigration(userData, source, target)
fs.writeFileSync(path.join(source, 'marker.txt'), 'after selection')
if (mode === 'conflict') fs.writeFileSync(path.join(target, 'marker.txt'), 'existing destination')
if (mode === 'locked') fs.writeFileSync(path.join(target, 'data-dir.lock.json'), JSON.stringify({ pid: process.pid, role: 'gui', beatAt: Date.now() }))
let errors = []
dialog.showErrorBox = (_title, message) => errors.push(message)
app.requestSingleInstanceLock = () => true
app.whenReady = () => new Promise(() => {})
require('../electron/main.cjs')
try {
  if (mode === 'success') {
    assert.deepEqual(errors, [])
    assert.equal(process.env.PRINTPRESS_DATA_DIR, target)
    assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'after selection')
    assert.equal(dir.readCustomDataDir(userData), target)
    assert.equal(dir.pendingMigration(userData, target), null)
  } else {
    assert.equal(errors.length, 1)
    assert.equal(process.env.PRINTPRESS_DATA_DIR, source)
    assert.equal(dir.readCustomDataDir(userData), source)
    assert.equal(dir.pendingMigration(userData, source), null)
    if (mode === 'conflict') assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'existing destination')
    else assert.equal(fs.existsSync(path.join(target, 'marker.txt')), false)
  }
  assert.equal(fs.readFileSync(path.join(source, 'marker.txt'), 'utf8'), 'after selection')
  assert.equal(require('../electron/data-lock.cjs').readHolder()?.pid, process.pid)
  console.log('AUDIT_MIGRATION_OK', mode, tmp)
  app.exit(0)
} catch (error) { console.error(error.stack); app.exit(1) }

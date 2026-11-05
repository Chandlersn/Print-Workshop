/** Verify the PSD worker and its dependencies from a packaged app.asar. */
const { app } = require('electron')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
const fs = require('fs'), path = require('path'), assert = require('assert/strict')
const archive = path.resolve(process.argv[2] || '')
const fixture = path.resolve(process.argv[3] || '')
const root = fs.mkdtempSync(path.join(__dirname, '.tmp-psd-packed-'))
process.env.PRINTPRESS_DATA_DIR = path.join(root, 'data')
app.whenReady().then(async () => {
  const importer = require(path.join(archive, 'electron', 'psd-import.cjs'))
  const result = await importer.inspect(fixture)
  const saved = importer.commit(result.token)
  assert.ok(saved.layers.some(layer => layer.type === 'text'))
  const second = await importer.inspect(fixture)
  if (second.textPreview.available) {
    const imageCopy = importer.commit(second.token, { rasterizeText: true })
    assert.equal(imageCopy.layers.filter(layer => layer.type === 'text').length,
      saved.layers.filter(layer => layer.type === 'text').length - second.textPreview.available)
    assert.equal(imageCopy.layers.filter(layer => layer.type === 'image').length,
      saved.layers.filter(layer => layer.type === 'image').length + second.textPreview.available)
  } else importer.cancel(second.token)
  console.log('PACKAGED_PSD_IMPORT_OK', result.width, result.height, saved.layers.length)
  app.exit(0)
}).catch(err => { console.error('PACKAGED_PSD_IMPORT_FAIL', err.stack || err); app.exit(1) })

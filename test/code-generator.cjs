const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { rmDeep } = require('./helpers/rm.cjs')
const dir = path.join(__dirname, '.tmp-code-generator')
process.env.PRINTPRESS_DATA_DIR = dir
const dataset = require('../electron/dataset.cjs')

try {
  rmDeep(dir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'data.csv')
  fs.writeFileSync(file, '组别,编码\nA,C-A-0001\nA,\nB,\n')
  const { id } = dataset.importFromFile(file)
  const options = { datasetId: id, targetKey: '编码', format: 'C-{字段:组别}-{流水号}', start: 1, width: 4, step: 1 }
  const preview = dataset.previewCodes(options)
  assert.deepStrictEqual(preview.samples.map(x => x.value), ['C-A-0002', 'C-B-0003'])
  assert.strictEqual(preview.skipped, 1)
  dataset.applyCodes(preview.token)
  assert.deepStrictEqual(dataset.getDataset(id).rows.map(r => r['编码']), ['C-A-0001', 'C-A-0002', 'C-B-0003'])
  assert.throws(() => dataset.applyCodes(preview.token), /失效/)
  const next = dataset.previewCodes({ ...options, targetKey: '', newColumn: '新码', format: '{随机:8}-{流水号}' })
  dataset.updateCell(id, 0, '组别', 'Z')
  assert.throws(() => dataset.applyCodes(next.token), /发生变化/)
  const fresh = dataset.previewCodes({ ...options, targetKey: '', newColumn: '新码' })
  const result = dataset.applyCodes(fresh.token)
  const data = dataset.getDataset(id)
  assert.strictEqual(data.columns.find(c => c.key === result.key).filled, 3)
  assert.strictEqual(data.rows[0][result.key], fresh.samples[0].value)
  assert.throws(() => dataset.previewCodes({ ...options, targetKey: '', newColumn: '码', format: '{无效}' }), /占位符/)
  assert.throws(() => dataset.previewCodes({ ...options, targetKey: '', newColumn: '码', format: '重复' }), /不重复/)
  dataset.updateCell(id, 0, '组别', '')
  assert.throws(() => dataset.previewCodes({ ...options, targetKey: '', newColumn: '码' }), /字段为空/)

  fs.writeFileSync(file, '序号,编码\n' + Array.from({ length: 10000 }, (_, i) => `${i + 1},${i + 1}`).join('\n') + '\n末行,\n')
  const largeId = dataset.importFromFile(file).id
  const serial = dataset.previewCodes({ ...options, datasetId: largeId, format: '{流水号}', width: 1 })
  assert.strictEqual(serial.samples[0].value, '10001')
  dataset.applyCodes(serial.token)
  assert.strictEqual(dataset.getDataset(largeId).rows.at(-1)['编码'], '10001')

  function cli(operation, params) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/pp.cjs'), '--data-dir', dir,
      '--allow-write', 'call', operation, JSON.stringify(params)], { encoding: 'utf8' })
    if (result.error) throw result.error
    return JSON.parse((result.stdout || result.stderr).trim())
  }
  const cliOptions = { ...options, targetKey: '', newColumn: '随机码', format: '{随机:8}' }
  const first = cli('dataset:previewCodes', cliOptions).data
  const second = cli('dataset:previewCodes', cliOptions).data
  const applied = cli('dataset:applyCodes', { token: first.token })
  assert.strictEqual(applied.ok, true)
  assert.deepStrictEqual(dataset.getDataset(id).rows.map(row => row[applied.data.key]), first.samples.map(row => row.value))
  assert.match(cli('dataset:applyCodes', { token: first.token }).error.message, /失效/)
  assert.match(cli('dataset:applyCodes', { token: second.token }).error.message, /发生变化/)
  const now = Date.now
  const expiring = dataset.previewCodes(cliOptions)
  try {
    Date.now = () => now() + 15 * 60 * 1000
    assert.throws(() => dataset.applyCodes(expiring.token), /失效/)
    assert.throws(() => dataset.applyCodes(second.token), /失效/)
  } finally { Date.now = now }
  console.log('code generator tests passed')
} finally { rmDeep(dir) }

/** Exercise the public stdio entry with real Electron PDF and PNG renderers. */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const { once } = require('events')
const { rmDeepSafe } = require('./helpers/rm.cjs')
const { countPdfPagesFromFile } = require('../electron/pdf-merge.cjs')

const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-mcp-'))
const output = path.join(ROOT, '.workbuddy-ai', 'tmp', 'mcp-review', String(Date.now()))
fs.mkdirSync(output, { recursive: true })
const checks = []
const clients = []
function check(condition, message) {
  assert.ok(condition, message)
  checks.push(message)
  console.log('PASS', message)
}

function client(allowWrite, dataDir = path.join(temp, 'data')) {
  const env = { ...process.env, PRINTPRESS_DATA_DIR: dataDir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const args = [`--user-data-dir=${path.join(temp, 'profile')}`, ...(allowWrite ? ['--allow-write'] : [])]
  const launchArgs = process.argv.includes('--npm')
    ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', '--silent', 'mcp', '--', ...args]
    : [process.env.PRINTPRESS_MCP_TEST_LAUNCHER || path.join(ROOT, 'bin', 'pp-mcp.cjs'), ...args]
  env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || env.Path || '')
  const child = spawn(process.execPath, launchArgs, {
    cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let nextId = 1, stderr = '', exited = false
  const pending = new Map()
  const invalidStdout = []
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) } })
  const exit = once(child, 'exit').then(([code, signal]) => {
    exited = true
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`)) }
    pending.clear()
    return code
  })
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let response
    try { response = JSON.parse(line) } catch { invalidStdout.push(line); return }
    const p = pending.get(response.id)
    if (p) { pending.delete(response.id); clearTimeout(p.timer); p.resolve(response) }
  })
  function request(method, params = {}) {
    assert.ok(!exited, `MCP already exited: ${stderr}`)
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${stderr}`)) }, 60000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  const c = {
    child, request, invalidStdout,
    async abort() { if (!exited) child.kill(); await exit },
    async initialize() {
      const response = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'printpress-test', version: '1' } })
      check(response.result?.serverInfo?.name === 'printpress', 'MCP initializes through the public Electron entry')
      assert.equal(response.result.protocolVersion, '2025-06-18')
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    },
    async tool(name, args = {}, errorCode) {
      const response = await request('tools/call', { name, arguments: args })
      assert.ok(response.result?.content?.[0]?.text, JSON.stringify(response))
      const result = JSON.parse(response.result.content[0].text)
      if (errorCode) assert.equal(result.code, errorCode, JSON.stringify(result))
      else assert.ok(!response.result.isError, JSON.stringify(result))
      return result
    },
    async stop() {
      if (!exited) child.stdin.end()
      const timeout = setTimeout(() => child.kill(), 5000)
      const code = await exit
      clearTimeout(timeout)
      assert.equal(code, 0, stderr)
      check(invalidStdout.length === 0, 'stdout contains only JSON-RPC messages')
    },
  }
  clients.push(c)
  return c
}

async function main() {
  const csv = path.join(temp, '名单.csv')
  fs.writeFileSync(csv, '\ufeff编号,姓名\n001,张三\n002,李四\n', 'utf8')
  const readOnly = client(false)
  await readOnly.initialize()
  const tools = (await readOnly.request('tools/list')).result.tools
  check(new Set(tools.map(t => t.name)).size === tools.length, 'advertised tool names are unique')
  for (const name of ['pp_dataset_importFile', 'pp_template_save', 'pp_print_exportPdf', 'pp_print_exportImages', 'printpress_render_html']) {
    check(tools.some(t => t.name === name), `${name} is discoverable`)
  }
  await readOnly.tool('pp_dataset_importFile', { filePath: csv }, 'WRITE_FORBIDDEN')
  check((await readOnly.tool('pp_dataset_list')).length === 0, 'read-only import is rejected without creating a dataset')
  await readOnly.tool('pp_print_exportImages', { datasetId: 'ds_missing', templateId: 'tpl_missing', outputDir: path.join(output, 'denied-png'), field1: '编号', field2: '姓名' }, 'WRITE_FORBIDDEN')
  check(!fs.existsSync(path.join(output, 'denied-png')), 'read-only PNG export creates no directory')
  await readOnly.tool('printpress_render_html', { datasetId: 'ds_missing', templateId: 'tpl_missing', outputPath: path.join(output, 'denied.html') }, 'WRITE_FORBIDDEN')
  check(!fs.existsSync(path.join(output, 'denied.html')), 'read-only HTML export creates no file')
  await readOnly.stop()
  check(!fs.existsSync(path.join(temp, 'data', 'data-dir.lock.json')), 'MCP shutdown releases its data lock')

  const writer = client(true)
  await writer.initialize()
  await writer.tool('pp_template_save', {}, 'BAD_PARAMS')
  check((await writer.tool('pp_template_list')).length === 0, 'missing required parameters do not mutate templates')
  await writer.tool('pp_template_save', [], 'BAD_PARAMS')
  check(true, 'non-object tool arguments return BAD_PARAMS')
  await writer.tool('no_such_tool', {}, 'UNKNOWN_TOOL')
  check((await writer.request('ping')).result !== undefined, 'connection survives tool errors')
  const contender = client(true)
  await assert.rejects(() => contender.initialize(), /数据目录正在被批印坊使用/)
  check(true, 'a second MCP process cannot write to the same data directory')
  const ds = await writer.tool('pp_dataset_importFile', { filePath: csv, name: 'MCP 证书验收' })
  const data = await writer.tool('pp_dataset_get', { id: ds.id })
  check(data.rows.length === 2 && data.rows[1]['姓名'] === '李四', 'CSV import preserves Chinese text')
  for (const key of ['编号', '姓名']) await writer.tool('pp_dataset_setColumnPrint', { datasetId: ds.id, key, printOn: true })
  const bg = await writer.tool('pp_template_uploadBackground', { filePath: path.join(ROOT, 'test', 'fixtures', 'tiny.png') })
  const tpl = await writer.tool('pp_template_save', { template: {
    name: 'MCP 测试证书', datasetId: ds.id, pageSize: { id: 'a6-landscape', w: 148, h: 105 }, background: bg.background,
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 24, align: 'center', color: '#000000' }],
  } })
  const payload = { datasetId: ds.id, templateId: tpl.id }
  const validation = await writer.tool('pp_print_validate', payload)
  check(validation.recordCount === 2 && validation.issues.length === 0, 'imported data and saved template pass print validation')
  const htmlPath = path.join(output, '预览.html')
  await writer.tool('printpress_render_html', { ...payload, outputPath: htmlPath })
  const html = fs.readFileSync(htmlPath, 'utf8')
  check(html.includes('张三') && html.includes('李四'), 'HTML export contains both certificate names')
  const pdfPath = path.join(output, '证书.pdf')
  const pdf = await writer.tool('pp_print_exportPdf', { ...payload, savePath: pdfPath, batchRows: 1 })
  check(fs.readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-', 'real PDF bytes are written through MCP')
  check(countPdfPagesFromFile(pdfPath) === 2 && pdf.jobId, 'batched PDF export has two pages and a recorded job')
  const images = await writer.tool('pp_print_exportImages', { ...payload, outputDir: path.join(output, '图片'), field1: '编号', field2: '姓名', outputDpi: 150 })
  check(images.count === 2 && images.files.length === 2, 'PNG export creates one file per record without dialogs')
  check(images.files.map(f => path.basename(f)).join(',') === '001_张三.png,002_李四.png', 'PNG filenames combine the requested fields')
  const originals = images.files.map(f => fs.readFileSync(f))
  check(!originals[0].equals(originals[1]), 'different names produce different certificate images')
  for (const dpi of [150, 300, 600]) {
    const result = dpi === 150 ? images : await writer.tool('pp_print_exportImages', { ...payload, rows: [1], outputDir: path.join(output, `png-${dpi}`), field1: '编号', field2: '姓名', outputDpi: dpi })
    const bytes = fs.readFileSync(result.files[0])
    check(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `output at ${dpi} dpi is a PNG`)
    check(bytes.readUInt32BE(16) === Math.ceil(148 / 25.4 * dpi) && bytes.readUInt32BE(20) === Math.ceil(105 / 25.4 * dpi), `PNG dimensions match ${dpi} dpi`)
  }
  const repeated = await writer.tool('pp_print_exportImages', { ...payload, rows: [0], outputDir: images.directory, field1: '编号', field2: '姓名', outputDpi: 150 })
  check(path.basename(repeated.files[0]) === '001_张三 (2).png' && fs.readFileSync(images.files[0]).equals(originals[0]), 'repeated PNG export keeps the original and adds a suffix')
  const jobs = await writer.tool('pp_job_list')
  check(jobs.length === 5 && jobs.every(j => j.status === 'ok'), 'PDF and image exports are recorded in successful job history')
  check(jobs.filter(j => j.partial).length === 3, 'selected-row image exports keep their partial scope')
  const finalPing = writer.request('ping')
  const stopped = writer.stop()
  check((await finalPing).result !== undefined, 'queued requests finish before stdin EOF shuts the service down')
  await stopped
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, output }, null, 2))
  console.log(`MCP_E2E_OK: ${checks.length} checks; artifacts: ${output}`)
}

main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(async () => {
  await Promise.all(clients.map(c => c.abort()))
  if (path.resolve(temp).startsWith(path.join(ROOT, 'test') + path.sep)) rmDeepSafe(temp)
})

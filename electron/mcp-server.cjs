/** MCP stdio transport for the same operation registry used by the GUI and pp CLI. */
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const PROTOCOL_VERSION = '2024-11-05'
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2025-06-18'])

function jsonSchemaFor(params = {}) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(params)) {
    properties[key] = { description: String(spec.desc || key) }
    if (spec.required) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

function start({ api, printer, allowWrite, app = {}, input = process.stdin, output = process.stdout }) {
  const ctx = {
    allowWrite: Boolean(allowWrite),
    app: { version: require('../package.json').version, isPackaged: false, platform: process.platform, ...app },
    dialog: null,
    printer,
    emit: (channel, payload) => process.stderr.write(`[${channel}] ${JSON.stringify(payload)}\n`),
  }
  const operations = api.describe()
  const operationByTool = new Map()
  const operationTools = operations.map((op) => {
    const name = `pp_${op.name.replace(/[^A-Za-z0-9_-]/g, '_')}`
    operationByTool.set(name, op.name)
    return {
      name,
      description: `${op.write ? '[写操作] ' : ''}${op.name}${op.gui === 'printer' ? '（MCP 内置 Electron 隐藏渲染）' : op.gui && op.gui !== 'none' ? `（需要 GUI 能力：${op.gui}）` : ''}`,
      inputSchema: jsonSchemaFor(op.params),
    }
  })
  const tools = [
    {
      name: 'printpress_operations',
      description: '列出批印坊可用操作、参数和读写属性。证书制作通常使用 dataset、template、print 前缀的操作。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'printpress_render_html',
      description: '按数据集和模板生成证书 HTML。可选 outputPath 将 HTML 保存到本地；指定 outputPath 需要 MCP 服务以 --allow-write 启动。rows 使用 0 基行号，省略时生成全部记录。',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: { type: 'string' }, templateId: { type: 'string' },
          rows: { type: 'array', items: { type: 'integer', minimum: 0 } },
          outputPath: { type: 'string', description: '可选的 HTML 输出文件路径' },
        },
        required: ['datasetId', 'templateId'], additionalProperties: false,
      },
    },
    ...operationTools,
  ]

  function send(message) {
    output.write(`${JSON.stringify(message)}\n`)
  }

  async function invokeApi(name, params) {
    const result = await api.invoke(name, params, ctx)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.data
  }

  async function invoke(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw Object.assign(new Error('工具参数必须是对象'), { code: 'BAD_PARAMS' })
    }
    if (name === 'printpress_operations') return operations
    if (name === 'printpress_render_html') {
      const outputPath = args.outputPath ? path.resolve(String(args.outputPath)) : null
      if (outputPath && !ctx.allowWrite) throw Object.assign(new Error('保存 HTML 需要以 --allow-write 启动 MCP 服务'), { code: 'WRITE_FORBIDDEN' })
      const built = await invokeApi('print:generate', {
        datasetId: args.datasetId, templateId: args.templateId, rows: args.rows,
      })
      if (typeof built.html !== 'string') throw new Error('出片引擎未返回 HTML')
      if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.writeFileSync(outputPath, built.html, 'utf8')
      }
      const { html, ...summary } = built
      return { ...summary, ...(outputPath ? { path: outputPath } : { htmlBytes: Buffer.byteLength(html, 'utf8') }) }
    }
    const operation = operationByTool.get(name)
    if (!operation) throw Object.assign(new Error(`未知工具: ${name}`), { code: 'UNKNOWN_TOOL' })
    const params = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {}
    const result = await invokeApi(operation, params)
    if (operation === 'print:generate' && result && typeof result.html === 'string') {
      const { html, ...summary } = result
      return { ...summary, htmlBytes: Buffer.byteLength(html, 'utf8'), hint: '如需落盘，请使用 printpress_render_html 并指定 outputPath' }
    }
    return result
  }

  async function dispatch(message) {
    const { id, method, params = {} } = message
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
    if (id === undefined) return
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: SUPPORTED_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'printpress', version: require('../package.json').version },
      } })
      return
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } })
      return
    }
    if (method === 'tools/call') {
      try {
        const result = await invoke(String(params.name || ''), params.arguments || {})
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })
      } catch (error) {
        send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) }) }] } })
      }
      return
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }

  let queue = Promise.resolve()
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    queue = queue.then(() => dispatch(message)).catch((error) => {
      if (message && message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error.message || error) } })
    })
  })
  lines.on('close', () => queue.finally(() => {
    if (output === input) output.end(() => appQuit())
    else appQuit()
  }))
}

let appQuit = () => {}
function setQuit(fn) { appQuit = fn }

module.exports = { start, setQuit }

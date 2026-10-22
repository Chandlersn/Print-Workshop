/* host：托管批印坊宿主进程，并跟它讲 MCP。
 *
 * 以前每次跑批都要人肉开两条命令：一条后台起 electron --mcp-stdio，一条跑脚本，
 * 还得自己记着 unset ELECTRON_RUN_AS_NODE。现在 ppw 自己托管。
 *
 * 关键决定：**不自己建命名管道**，而是 spawn `bin/pp-mcp.cjs` 走标准 MCP stdio。
 * 那个脚本已经把跨平台管道（Windows 用 \\.\pipe\，其他用 unix socket）、
 * 开发态/安装态的 electron 路径判断、环境清理都做好了，重复实现只会多一处出错点。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const HANDSHAKE_TIMEOUT = 120000
const DEFAULT_TOOL_TIMEOUT = 30 * 60 * 1000

class Host {
  constructor(opts = {}) {
    this.repoRoot = opts.repoRoot || path.join(__dirname, '..', '..')
    this.dataDir = opts.dataDir
    this.allowWrite = opts.allowWrite !== false
    this.verbose = Boolean(opts.verbose)
    this.log = opts.log || (() => {})
    this.child = null
    this.nextId = 100
    this.pending = new Map()
    this.buffer = ''
    this.closed = false
  }

  /** 起宿主并完成 MCP 握手。失败时把子进程的 stderr 尾巴带进错误里，否则排查全靠猜。 */
  async open() {
    const launcher = path.join(this.repoRoot, 'bin', 'pp-mcp.cjs')
    if (!fs.existsSync(launcher)) throw new Error(`找不到 MCP 启动器: ${launcher}`)

    const args = [launcher]
    if (this.allowWrite) args.push('--allow-write')

    const env = { ...process.env }
    // 这两个会让 Electron 以 Node 模式启动，渲染进程起不来
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    if (this.dataDir) {
      env.PRINTPRESS_DATA_DIR = this.dataDir
      env.PRINTPRESS_DATA_DIR_CUSTOM = '1'
    }

    this.stderrTail = []
    this.child = spawn(process.execPath, args, {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.setEncoding('utf-8')
    this.child.stdout.on('data', chunk => this._onStdout(chunk))
    this.child.stderr.setEncoding('utf-8')
    this.child.stderr.on('data', chunk => {
      this.stderrTail.push(chunk)
      if (this.stderrTail.length > 200) this.stderrTail.shift()
      if (this.verbose) process.stderr.write(chunk)
    })
    this.child.on('error', err => this._failAll(new Error(`宿主启动失败: ${err.message}`)))
    this.child.on('exit', code => {
      this.closed = true
      const tail = this.stderrTail.join('').split('\n').filter(Boolean).slice(-6).join('\n  ')
      this._failAll(new Error(`宿主进程已退出（code=${code}）${tail ? `\n  ${tail}` : ''}`))
    })

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ppw', version: '1.0' },
    }, HANDSHAKE_TIMEOUT)
    this._write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return this
  }

  _write(msg) {
    if (!this.child || this.closed) throw new Error('宿主未连接')
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  _onStdout(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop()
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      let msg
      try { msg = JSON.parse(s) } catch { continue }
      if (msg.id === undefined || !this.pending.has(msg.id)) continue
      const p = this.pending.get(msg.id)
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`MCP 错误 ${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
  }

  _failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  request(method, params, timeoutMs = DEFAULT_TOOL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this._write({ jsonrpc: '2.0', id, method, params: params || {} })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  /**
   * 调一个 MCP 工具，返回解析后的 JSON。
   * 工具结果统一是 content[0].text 里的 JSON 串（见 electron/mcp-server.cjs）。
   */
  async callTool(name, args = {}, timeoutMs) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs)
    if (!r) throw new Error(`工具 ${name} 无返回`)
    if (r.isError) {
      const text = r.content && r.content[0] && r.content[0].text
      throw new Error(`工具 ${name} 执行失败: ${text || '(无详情)'}`)
    }
    const text = r.content && r.content[0] && r.content[0].text
    if (text === undefined) return null
    try { return JSON.parse(text) } catch { return text }
  }

  async close() {
    if (!this.child || this.closed) return
    this.closed = true
    try { this.child.stdin.end() } catch { /* 已断开 */ }
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { this.child.kill() } catch { /* 已退出 */ }
        resolve()
      }, 5000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/** 便捷用法：await withHost(opts, async host => {...})（无论成败都收尾） */
async function withHost(opts, fn) {
  const host = new Host(opts)
  await host.open()
  try {
    return await fn(host)
  } finally {
    await host.close()
  }
}

module.exports = { Host, withHost, DEFAULT_TOOL_TIMEOUT }

#!/usr/bin/env node
/** Node owns MCP stdio; Electron owns rendering. Windows Electron cannot read stdin. */
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const installedExecutable = path.resolve(ROOT, '..', '批印坊.exe')
const isInstalled = fs.existsSync(path.join(ROOT, 'app.asar')) && fs.existsSync(installedExecutable)
const token = `printpress-mcp-${process.pid}-${crypto.randomBytes(16).toString('hex')}`
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${token}` : path.join(os.tmpdir(), `${token}.sock`)
const env = { ...process.env, PRINTPRESS_MCP_PIPE: pipe }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

let worker, connection, startupTimer, shutdownTimer
let stopping = false
const server = net.createServer({ allowHalfOpen: true }, socket => {
  if (connection) { socket.destroy(); return }
  connection = socket
  clearTimeout(startupTimer)
  server.close()
  process.stdin.pipe(socket)
  socket.pipe(process.stdout, { end: false })
  socket.on('error', error => { console.error('[mcp] pipe:', error.message); stop(1) })
})

function stop(code = 0) {
  if (stopping) return
  stopping = true
  clearTimeout(startupTimer)
  process.exitCode = code
  process.stdin.unpipe()
  process.stdin.destroy()
  if (connection) connection.end()
  server.close()
  if (worker && worker.exitCode === null) {
    shutdownTimer = setTimeout(() => worker.kill(), 5000)
  }
}

server.on('error', error => { console.error('[mcp] startup:', error.message); stop(1) })
process.stdin.on('error', error => { console.error('[mcp] stdin:', error.message); stop(1) })
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
server.listen(pipe, () => {
  try {
    const executable = isInstalled ? installedExecutable : require('electron')
    const args = [...(isInstalled ? [] : [ROOT]), '--mcp-stdio', ...process.argv.slice(2)]
    worker = spawn(executable, args, {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    worker.stdout.pipe(process.stderr, { end: false })
    worker.stderr.pipe(process.stderr, { end: false })
    worker.on('error', error => { console.error('[mcp] Electron:', error.message); stop(1) })
    worker.on('exit', code => {
      clearTimeout(shutdownTimer)
      stop(code === null ? 1 : code)
    })
    startupTimer = setTimeout(() => { console.error('[mcp] Electron startup timed out'); stop(1) }, 20000)
  } catch (error) {
    console.error('[mcp] startup:', error.message)
    stop(1)
  }
})

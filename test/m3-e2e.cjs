/**
 * M3 端到端冒烟（需 Electron 运行时）：
 * 120 人批量 HTML → 隐藏窗口 → 真实 printToPDF 出文件，
 * 同时验证 pp:// 协议（底图加载）与 @page 纸张生效。
 * 运行：npx electron test/m3-e2e.cjs
 */
const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const { pathToFileURL } = require('url')

const DATA = path.join(__dirname, '.tmp-data-e2e')
process.env.PRINTPRESS_DATA_DIR = DATA

// 与 main.cjs 一致：数据目录 + 禁 GPU + pp:// 特权协议
rmDeep(DATA)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
// 本沙箱 crashpad 服务易损坏（not connected → 渲染进程随机启动失败），关闭无副作用
app.commandLine.appendSwitch('disable-breakpad')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

function registerMediaProtocol() {
  protocol.handle('pp', async (request) => {
    try {
      const u = new URL(request.url)
      const rel = decodeURIComponent(u.pathname).replace(/\\/g, '/').replace(/^\/+/, '')
      if (!rel || rel.split('/').includes('..')) return new Response('bad path', { status: 403 })
      const abs = path.join(DATA, rel)
      const resp = await net.fetch(pathToFileURL(abs).toString())
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

// 1x1 红色 PNG（有效底图字节）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function main() {
  await app.whenReady()
  registerMediaProtocol()

  // 种子：底图 + 数据集 + 模板（120 人）
  fs.mkdirSync(path.join(DATA, 'print-bg'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'print-bg/bg.png'), TINY_PNG)

  const { saveJson } = require('../electron/store.cjs')
  const rows = Array.from({ length: 120 }, (_, i) => ({
    姓名: `选手${String(i + 1).padStart(3, '0')}`,
    奖项: i % 10 === 0 ? '金奖' : '一等奖',
  }))
  saveJson('datasets', [{
    id: 'ds_e2e', name: '百人名单.xlsx',
    columns: [
      { key: '姓名', alias: '姓名', type: 'text' },
      { key: '奖项', alias: '奖项', type: 'text' },
    ],
    rows,
  }])
  saveJson('templates', [{
    id: 'tpl_e2e', name: '端到端奖状', pageSize: 'a4-landscape',
    background: 'print-bg/bg.png',
    fields: [
      { column: '姓名', x: 50, y: 45, fontSize: 28, align: 'center', bold: true },
      { column: '奖项', x: 50, y: 60, fontSize: 18, align: 'center', color: '#c0392b' },
    ],
  }])

  const printDomain = require('../electron/print.cjs')
  const printer = require('../electron/printer.cjs')
  const built = printDomain.buildBatchHtml('ds_e2e', 'tpl_e2e')
  if (built.recordCount !== 120) throw new Error(`recordCount=${built.recordCount}`)

  // 单窗口单次加载（M3 验证过的稳定模式；printer.loadHtml 自带窗口级重试），
  // 底图 pp:// 检查在同一页面内做——正文 .page 的背景正是 pp:// URL。
  const out = path.join(__dirname, '.tmp-out')
  fs.mkdirSync(out, { recursive: true })
  const pdfPath = path.join(out, 'batch-120.pdf')

  const win = await printer.loadHtml(built.html)
  try {
    const bgLoaded = await win.webContents.executeJavaScript(
      `new Promise((res) => {
        const i = new Image()
        i.onload = () => res('ok')
        i.onerror = () => res('fail')
        i.src = 'pp://media/print-bg/bg.png'
      })`,
    )
    if (bgLoaded !== 'ok') throw new Error('pp:// 底图加载失败')

    const buf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    })
    fs.writeFileSync(pdfPath, buf)

    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    console.log(`E2E_OK pdf=${pdfPath}`)
    console.log(`E2E_PAGES=${pages} bytes=${buf.length} bg=${bgLoaded}`)
    setTimeout(() => app.exit(pages === 120 ? 0 : 1), 300)
  } finally {
    win.destroy()
  }
}

main().catch((err) => {
  console.error('E2E_FAIL', err.message || err)
  setTimeout(() => app.exit(1), 300)
})

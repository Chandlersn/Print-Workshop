/**
 * 示例资产生成器（构建期运行）：
 * - 4 张示例模板底图：直接写 SVG 文件（Chromium background-image/img 原生支持
 *   SVG，无需光栅化；viewBox 即比例依据）
 * - 应用图标：SVG → 512px PNG（capturePage 在本环境多张连做会崩渲染进程，
 *   故每次进程只做一张，用 --only=<file> 逐张调用）
 * 运行：node 写 SVG 自动完成；图标：npx electron scripts/seed-assets.cjs --only=icon
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const OUT_BG = path.join(__dirname, '..', 'build', 'seed', 'print-bg')
const OUT_ICON = path.join(__dirname, '..', 'build', 'icon.png')

const DESIGNS = [
  {
    file: 'demo-award-landscape.svg',
    w: 1754, h: 1240,
    svg: `
      <rect width="1754" height="1240" fill="#fbf6e8"/>
      <rect x="28" y="28" width="1698" height="1184" fill="none" stroke="#b03a2e" stroke-width="7"/>
      <rect x="48" y="48" width="1658" height="1144" fill="none" stroke="#b03a2e" stroke-width="2"/>
      <rect x="16" y="16" width="24" height="24" fill="#b03a2e"/>
      <rect x="1714" y="16" width="24" height="24" fill="#b03a2e"/>
      <rect x="16" y="1200" width="24" height="24" fill="#b03a2e"/>
      <rect x="1714" y="1200" width="24" height="24" fill="#b03a2e"/>
      <text x="877" y="290" text-anchor="middle" font-family="KaiTi,SimSun,serif" font-size="150" font-weight="bold" fill="#b03a2e" letter-spacing="40">奖 状</text>
      <rect x="677" y="340" width="400" height="4" fill="#b08d3f"/>
      <text x="877" y="1140" text-anchor="middle" font-family="KaiTi,SimSun,serif" font-size="40" fill="#b08d3f" letter-spacing="10">荣誉见证 · 一路同行</text>
    `,
  },
  {
    file: 'demo-cert-landscape.svg',
    w: 1754, h: 1240,
    svg: `
      <rect width="1754" height="1240" fill="#faf7ef"/>
      <rect x="36" y="36" width="1682" height="1168" fill="none" stroke="#b08d3f" stroke-width="5"/>
      <rect x="56" y="56" width="1642" height="1128" fill="none" stroke="#b08d3f" stroke-width="1.5"/>
      <circle cx="36" cy="36" r="14" fill="#b08d3f"/>
      <circle cx="1718" cy="36" r="14" fill="#b08d3f"/>
      <circle cx="36" cy="1204" r="14" fill="#b08d3f"/>
      <circle cx="1718" cy="1204" r="14" fill="#b08d3f"/>
      <text x="877" y="300" text-anchor="middle" font-family="SimSun,KaiTi,serif" font-size="130" font-weight="bold" fill="#8a6a2f" letter-spacing="30">荣誉证书</text>
      <rect x="577" y="346" width="600" height="3" fill="#b08d3f"/>
      <text x="877" y="1130" text-anchor="middle" font-family="SimSun,serif" font-size="36" fill="#8c8577" letter-spacing="8">CERTIFICATE OF HONOR</text>
    `,
  },
  {
    file: 'demo-cert-portrait.svg',
    w: 1240, h: 1754,
    svg: `
      <rect width="1240" height="1754" fill="#fbf6e8"/>
      <rect x="30" y="30" width="1180" height="1694" fill="none" stroke="#b03a2e" stroke-width="6"/>
      <rect x="50" y="50" width="1140" height="1654" fill="none" stroke="#b03a2e" stroke-width="2"/>
      <path d="M 30 30 h 120 M 30 30 v 120" stroke="#b03a2e" stroke-width="10" fill="none"/>
      <path d="M 1210 30 h -120 M 1210 30 v 120" stroke="#b03a2e" stroke-width="10" fill="none"/>
      <path d="M 30 1724 h 120 M 30 1724 v -120" stroke="#b03a2e" stroke-width="10" fill="none"/>
      <path d="M 1210 1724 h -120 M 1210 1724 v -120" stroke="#b03a2e" stroke-width="10" fill="none"/>
      <text x="620" y="340" text-anchor="middle" font-family="KaiTi,SimSun,serif" font-size="130" font-weight="bold" fill="#b03a2e" letter-spacing="40">证 书</text>
      <rect x="470" y="388" width="300" height="4" fill="#b08d3f"/>
    `,
  },
  {
    file: 'demo-invite-landscape.svg',
    w: 1754, h: 1240,
    svg: `
      <rect width="1754" height="1240" fill="#f7f3ea"/>
      <circle cx="180" cy="1100" r="220" fill="#f3e0dd" opacity="0.55"/>
      <circle cx="1620" cy="160" r="180" fill="#f3e0dd" opacity="0.45"/>
      <rect x="70" y="70" width="1614" height="1100" fill="none" stroke="#6f675c" stroke-width="2"/>
      <rect x="82" y="82" width="1590" height="1076" fill="none" stroke="#c9bda6" stroke-width="1"/>
      <text x="877" y="310" text-anchor="middle" font-family="KaiTi,SimSun,serif" font-size="140" font-weight="bold" fill="#2b2622" letter-spacing="36">邀 请 函</text>
      <rect x="727" y="362" width="300" height="3" fill="#b03a2e"/>
      <text x="877" y="1120" text-anchor="middle" font-family="KaiTi,serif" font-size="38" fill="#6f675c" letter-spacing="12">敬请莅临</text>
    `,
  },
]

const ICON_SVG = `
  <rect width="512" height="512" rx="96" fill="#b03a2e"/>
  <rect x="52" y="52" width="408" height="408" rx="60" fill="none" stroke="#f6f2e9" stroke-width="10"/>
  <text x="256" y="352" text-anchor="middle" font-family="KaiTi,SimSun,serif" font-size="280" font-weight="bold" fill="#f6f2e9">印</text>
`

function writeSvg(name, w, h, svg) {
  const out = path.join(OUT_BG, name)
  const body = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`
  fs.writeFileSync(out, body.trim(), 'utf-8')
  console.log('生成', name)
}

// ---------- 主流程分支 1：写 SVG（纯 Node，默认） ----------
const onlyArg = process.argv.find((a) => a.startsWith('--only='))

if (!onlyArg) {
  fs.mkdirSync(OUT_BG, { recursive: true })
  for (const d of DESIGNS) writeSvg(d.file, d.w, d.h, d.svg)
  console.log('SEED_SVG_OK')
  process.exit(0)
}

// ---------- 分支 2：图标光栅化（Electron，单张） ----------
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')

app.whenReady().then(async () => {
  const tmp = path.join(OUT_BG, '.tmp-icon.html')
  fs.writeFileSync(tmp, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:512px;height:512px;overflow:hidden}</style></head><body><svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">${ICON_SVG}</svg></body></html>`, 'utf-8')
  const win = new BrowserWindow({ show: false, useContentSize: true, webPreferences: { sandbox: false } })
  win.setContentSize(512, 512)
  const { pathToFileURL } = require('url')
  await win.loadURL(pathToFileURL(tmp).toString())
  await new Promise((r) => setTimeout(r, 300))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  fs.writeFileSync(OUT_ICON, img.toPNG())
  fs.unlinkSync(tmp)
  console.log('ICON_OK', img.getSize().width + 'x' + img.getSize().height)
  // PNG 已落盘，进程随后可能因渲染层崩溃退出——直接硬退出不给它机会
  app.exit(0)
  process.exit(0)
}).catch((e) => { console.error('ICON_FAIL', e); process.exit(1) })

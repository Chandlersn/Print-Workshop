#!/usr/bin/env node
/**
 * 发版：把当前版本的安装包传到 GitHub Release。
 *
 * 为什么是脚本而不是网页拖拽：网页传 80MB 要等、还容易传错版本；
 * 这个脚本会逐项核对（版本号三处一致 → tag 在不在 → 包大小对不对），
 * 传完再回读一次资产大小复核。已存在的 Release 会复用，大小一致直接收工。
 *
 * 用法：
 *   npm run release:check                      # 只体检，不写任何东西
 *   GH_TOKEN=<PAT> npm run release:upload      # 建 Release + 传包
 *
 * token 只从环境变量读：不走命令行参数（会进进程列表）、不落盘、不打日志。
 * 需要 fine-grained PAT，仅授权本仓库，权限只勾 Contents: Read and write。
 * 注意 deploy key 没有 API 权限，传 Release 只能靠这个 token。
 *
 * 完整发版顺序（漏一步就会静默出问题，详见 docs/开发经验总结.md）：
 *   改 latest.json → 发版提交 → tag + push → npm run release:upload → 刷 jsDelivr 缓存
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const OWNER = 'Chandlersn'
const REPO = 'Print-Workshop'
const API = 'https://api.github.com'
const DRY = process.argv.includes('--dry-run')

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量。示例：')
  console.error('  GH_TOKEN=github_pat_xxx npm run release:check')
  process.exit(2)
}

let bad = 0
const ok = (c, m, extra) => {
  if (!c) { bad++; console.log(`::error::FAIL - ${m}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
  console.log(`  ${c ? 'ok  ' : 'FAIL'} - ${m}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`)
}
// 网络类探测改为“仅提示、不拦截”：CI 里 GITHUB_TOKEN 的 permissions.push 常报 false，
// 真没权限时后面建 Release 会明确报错，不必在这里挡。
const soft = (c, m, extra) => {
  console.log(`  ${c ? 'ok  ' : 'WARN'} - ${m}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`)
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'printpress-release-upload',
}

async function api(method, url, body, extraHeaders) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(extraHeaders || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  return { status: res.status, ok: res.ok, json, text }
}

/** 上传一个资产；同名已存在则先删后传（重跑脚本时常见），避免「资产已存在」报错 */
async function uploadAsset(releaseId, name, body) {
  const list = await api('GET', `${API}/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`)
  const exist = (list.json || []).find((a) => a.name === name)
  if (exist) {
    console.log(`     已存在 ${name}，先删后传`)
    await api('DELETE', `${API}/repos/${OWNER}/${REPO}/releases/assets/${exist.id}`)
  }
  const up = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
      body,
    },
  )
  const text = await up.text()
  ok(up.ok, `上传 ${name} 返回 ${up.status}`, up.ok ? '' : text.slice(0, 300))
  if (!up.ok) process.exit(1)
}

function readVersionHistoryEntry(version) {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
  const m = md.match(new RegExp(`^- \\*\\*v${version.replace(/\./g, '\\.')}（[^）]*）\\*\\*：(.+)$`, 'm'))
  return m ? m[1].trim() : ''
}

async function main() {
  // ── 1. 本地三处版本号必须一致（发版漏项第一号） ──
  console.log('== 1. 版本号一致性 ==')
  const pkgVer = require(path.join(ROOT, 'package.json')).version
  const latest = JSON.parse(fs.readFileSync(path.join(ROOT, 'latest.json'), 'utf-8'))
  const readmeVer = (() => {
    const m = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8').match(/\|\s*当前版本\s*\|\s*v?([\d.]+)\s*\|/)
    return m ? m[1] : ''
  })()
  ok(pkgVer === latest.version, `latest.json 与 package.json 一致（${pkgVer}）`, { pkg: pkgVer, latest: latest.version })
  ok(pkgVer === readmeVer, `README 头部与 package.json 一致（${pkgVer}）`, { pkg: pkgVer, readme: readmeVer })

  const tag = `v${pkgVer}`
  let exe = path.join(ROOT, 'release', `批印坊 Setup ${pkgVer}.exe`)
  if (!fs.existsSync(exe)) {
    const relDir = path.join(ROOT, 'release')
    const cands = fs.existsSync(relDir) ? fs.readdirSync(relDir).filter((f) => f.toLowerCase().endsWith('.exe')) : []
    console.log(`     release/ 下的 .exe: ${cands.join(', ') || '(无)'}`)
    if (cands.length) exe = path.join(relDir, cands[0])
  }
  ok(fs.existsSync(exe), `本地安装包存在`, path.basename(exe))
  const localSize = fs.existsSync(exe) ? fs.statSync(exe).size : 0
  if (localSize) console.log(`     包大小: ${localSize} 字节`)

  // ── 2. token 与仓库权限 ──
  console.log('\n== 2. token 与仓库权限 ==')
  const me = await api('GET', `${API}/user`)
  soft(me.ok, 'token 有效', me.ok ? me.json.login : `HTTP ${me.status}`)
  const repo = await api('GET', `${API}/repos/${OWNER}/${REPO}`)
  soft(repo.ok, '能读到目标仓库', repo.ok ? repo.json.full_name : `HTTP ${repo.status}`)
  const perms = (repo.json && repo.json.permissions) || {}
  soft(perms.push === true, '**有写权限**（Contents: Read and write）', perms)

  // ── 3. tag 状态 ──
  console.log('\n== 3. tag 状态 ==')
  const ref = await api('GET', `${API}/repos/${OWNER}/${REPO}/git/ref/tags/${tag}`)
  soft(ref.ok, `远端 tag ${tag} 存在`, ref.ok ? ref.json.object.sha.slice(0, 7) : `HTTP ${ref.status}（还没推？git push origin ${tag}）`)

  // ── 4. Release 状态 ──
  console.log('\n== 4. Release 状态 ==')
  const existing = await api('GET', `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
  let release = existing.ok ? existing.json : null
  const assetName = `PrintPress-${pkgVer}-Setup.exe`
  if (release) {
    console.log(`     已存在 Release: ${release.html_url}`)
    const hit = (release.assets || []).find((a) => a.name === assetName)
    if (hit && hit.size === localSize) {
      // 完全一致：同一次构建重跑，无需上传
      console.log(`     资产大小与本地一致（${hit.size}），无需上传`)
      console.log('\n无需上传，全部就绪。')
      process.exit(bad ? 1 : 0)
    }
    if (hit) {
      // 同版本重发（改了代码重新构建）→ 大小必然变，属正常，覆盖重传即可
      console.log(`     已存在旧资产但大小不同（远端 ${hit.size} / 本地 ${localSize}），将覆盖重传`)
    } else {
      console.log(`     缺资产 ${assetName}，将补传`)
    }
  } else {
    console.log(`     尚无 Release（HTTP ${existing.status}）`)
  }

  if (DRY) {
    console.log('\n--dry-run：体检结束，没有做任何写操作。')
    process.exit(bad ? 1 : 0)
  }
  if (bad) {
    console.log('\n体检有失败项，先修好再传。')
    process.exit(1)
  }

  // ── 5. 创建 Release（若不存在） ──
  console.log('\n== 5. 创建 Release ==')
  if (!release) {
    const notes = readVersionHistoryEntry(pkgVer)
    const created = await api('POST', `${API}/repos/${OWNER}/${REPO}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: `批印坊 ${tag}`,
      body: notes ? `## ${tag}\n\n${notes}` : tag,
      draft: false,
      prerelease: false,
    })
    ok(created.ok, 'Release 创建成功', created.ok ? created.json.html_url : `HTTP ${created.status} ${created.text.slice(0, 200)}`)
    if (!created.ok) process.exit(1)
    release = created.json
  } else {
    console.log('     复用已存在的 Release')
  }

  // ── 6. 上传资产 ──
  console.log('\n== 6. 上传安装包 ==')
  console.log(`     ${assetName}（${localSize} 字节）…`)
  const buf = fs.readFileSync(exe)
  await uploadAsset(release.id, assetName, buf)

  // ── 6b. 自动更新清单 latest.yml（electron-updater 靠它校验 sha512 + 定位安装包）──
  console.log('\n== 6b. 上传 latest.yml（自动更新清单）==')
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
  const latestYml = [
    `version: ${pkgVer}`,
    'files:',
    `  - url: ${assetName}`,
    `    sha512: ${sha512}`,
    `    size: ${localSize}`,
    `path: ${assetName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
  ].join('\n') + '\n'
  await uploadAsset(release.id, 'latest.yml', Buffer.from(latestYml, 'utf-8'))

  // 差异更新用的 blockmap（若存在则一并上传，全量下载不依赖它）
  const blockmapName = `PrintPress-${pkgVer}-Setup.exe.blockmap`
  const blockmapPath = path.join(ROOT, 'release', `批印坊 Setup ${pkgVer}.exe.blockmap`)
  if (fs.existsSync(blockmapPath)) {
    console.log(`     顺带上传 ${blockmapName}`)
    await uploadAsset(release.id, blockmapName, fs.readFileSync(blockmapPath))
  } else {
    console.log('     （无 blockmap，跳过；全量下载不受影响）')
  }

  // ── 7. 回读复核 ──
  console.log('\n== 7. 回读复核 ==')
  const after = await api('GET', `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
  const asset = after.ok ? (after.json.assets || []).find((a) => a.name === assetName) : null
  ok(Boolean(asset), '资产已挂到 Release 上')
  ok(Boolean(asset) && asset.size === localSize, '**远端大小 == 本地大小**（没传一半）',
    { 远端: asset && asset.size, 本地: localSize })
  if (asset) {
    console.log(`     下载地址: ${asset.browser_download_url}`)
    console.log(`     状态: ${asset.state}`)
  }
  console.log(`\nRelease 页面: ${release.html_url}`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error('出错:', e.message); process.exit(1) })

/**
 * 可编辑工程包（`.ppdesign`）：导出固定版本、导入副本（v0.5.0 M2）。
 *
 * ── 三条定调 ──────────────────────────────────────────────────
 * 1. **导出的是「已保存的那个版本」**，不是当前草稿。调用方必须给 `{ id, revision }`；
 *    开始导出后继续编辑不影响本次导出的内容（版本文件是不可变的）。
 * 2. **导入永远创建副本**：新工程 ID、版本 1，同名不覆盖，当前画板保持原状。
 *    原工程 ID 只作为来源记录写进清单。
 * 3. **提交是事务**：准备资源 → 落恢复记录 → 发布不可变文件 → **最后**发布工程索引。
 *    顺序反过来就会出现「索引里有工程、版本文件却不存在」的半工程。
 *
 * ── 分层 ──────────────────────────────────────────────────────
 * 本模块零 electron 依赖（字体/图片/工程读写全部走领域层），ZIP 读写在
 * package-codec.cjs。纯 Node 下可导出、可检查、可提交，CLI 与测试同一份实现。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { resolveInsideDataDir } = require('./store.cjs')
const { normalizeDesign } = require('./design-layout.cjs')
const designs = require('./designs.cjs')
const fonts = require('./fonts.cjs')
const codec = require('./package-codec.cjs')

/** 导出任务取消集合：导出是同步跑的，UI 靠 taskId 在下一条目开始前中止。 */
const cancelledTasks = new Set()

/** 包格式版本。与工程格式 `schemaVersion` 独立演进。 */
const PACKAGE_VERSION = 1
/** 只接受这一个包格式版本：将来改结构时抬它，旧包由旧应用继续读。 */
const STAGING_DIR = 'package-staging'
const TX_DIR = 'package-tx'
/** 检查令牌有效期：过期后暂存快照必须重新检查，不能拿两周前的结论去提交。 */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
/** 字体文件名基名：剔除 Windows/Linux 都不接受的路径字符，避免家族名变成路径。 */
function safeFontBase(family) {
  const base = String(family == null ? '' : family).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80)
  return base || 'font'
}
function stagingRoot() {
  return resolveInsideDataDir(STAGING_DIR)
}
function txRoot() {
  return resolveInsideDataDir(TX_DIR)
}
function txFile(txId) {
  return resolveInsideDataDir(`${TX_DIR}/${txId}.json`)
}
function nowIso() {
  return new Date().toISOString()
}

// ─────────────────────────── 导出 ───────────────────────────

/**
 * 收集工程依赖。**遍历全部图层，不按 visible 过滤**——隐藏图层重新显示时
 * 不能丢图、丢字体，这是「包拿去另一台电脑上打不开」最常见的原因。
 */
function collectReferences(doc) {
  const imageIds = new Set()
  const fontFamilies = new Set()
  for (const layer of doc.layers || []) {
    if (layer.type === 'image' && layer.assetId) imageIds.add(layer.assetId)
    if (layer.type === 'text' && layer.fontFamily) fontFamilies.add(layer.fontFamily)
  }
  return { imageIds: [...imageIds], fontFamilies: [...fontFamilies] }
}

/**
 * 导出工程包。
 *
 * @param {object} o
 * @param {string} o.id        工程 id
 * @param {number} o.revision  要导出的固定版本；省略取最新版本
 * @param {string} o.targetPath 输出文件绝对路径（.ppdesign）
 * @param {boolean} [o.includeFonts=true] 是否携带已上传字体原件
 * @returns {{path:string, bytes:number, entries:number, resources:Array, fonts:Array}}
 */
function exportPackage(o = {}) {
  const { id, revision, targetPath, includeFonts = true, taskId, onProgress, shouldCancel } = o
  if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('请先选择工程包的保存位置')
  // 固定版本：读的是**已提交**的那一份（designs.getDesign 会做哈希与字体核对），
  // 导出期间用户继续编辑当前草稿，不会改变这里读到的内容。
  const doc = designs.getDesign(id, revision)
  const refs = collectReferences(doc)

  const assets = {}
  const resources = []
  const imageEntries = []
  for (const assetId of refs.imageIds) {
    const asset = doc.assets[assetId]
    if (!asset) continue
    const info = designs.assetInfo(assetId) // 再核一次哈希：绝不导出已被外部改动的原件
    assets[assetId] = info
    const ext = asset.path.endsWith('.png') ? '.png' : '.jpg'
    const hash = assetId.slice('asset_'.length)
    resources.push({
      path: `images/${hash}${ext}`, role: 'image', sha256: hash,
      bytes: fs.statSync(resolveInsideDataDir(info.path)).size,
      mime: info.mime, width: info.width, height: info.height, name: info.name,
    })
    // 图片本身就是压缩格式，再 deflate 只是白烧 CPU ⇒ store
    imageEntries.push({ name: `images/${hash}${ext}`, filePath: resolveInsideDataDir(info.path), store: true })
  }

  // 字体：只携带**已上传**字体（doc.fontAssets 里有的）；系统字体不打包，
  // 只登记为「需本机提供」——打包系统字体既无分发权，也没必要。
  const fontRecords = []
  const entries = []
  const uploadDir = fonts.fontUploadDir()
  for (const family of refs.fontFamilies) {
    const file = doc.fontAssets[family]
    if (!file) {
      fontRecords.push({ family, status: 'required' })
      continue
    }
    const abs = path.join(uploadDir, file)
    if (!fs.existsSync(abs)) {
      fontRecords.push({ family, status: 'required' })
      continue
    }
    const bytes = fs.readFileSync(abs)
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const ext = path.extname(file).toLowerCase()
    if (includeFonts) {
      entries.push({ name: `fonts/${hash}${ext}`, filePath: abs })
      fontRecords.push({ family, status: 'embedded', path: `fonts/${hash}${ext}`, sha256: hash, bytes: bytes.length, ext })
    } else {
      fontRecords.push({ family, status: 'required', sha256: hash, bytes: bytes.length })
    }
  }

  const project = { ...doc, assets, fontAssets: { ...doc.fontAssets } }
  delete project.id // 导入端会分配新 ID；工程 JSON 里不留来源 ID，避免被当成同一份工程
  const projectBytes = Buffer.from(JSON.stringify(project, null, 2), 'utf8')
  const manifest = {
    packageVersion: PACKAGE_VERSION,
    schemaVersion: doc.schemaVersion,
    source: { id: doc.id, revision: doc.revision, name: doc.name, updatedAt: doc.updatedAt || null, exportedAt: nowIso() },
    artboard: { w: doc.artboard.w, h: doc.artboard.h },
    project: { file: 'project.json', bytes: projectBytes.length, sha256: crypto.createHash('sha256').update(projectBytes).digest('hex') },
    resources,
    fonts: fontRecords,
    stats: {
      layerCount: (doc.layers || []).length,
      groupCount: (doc.groups || []).length,
      guideCount: (doc.guides || []).length,
      imageCount: resources.length,
      fontCount: fontRecords.length,
    },
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  const all = [
    { name: 'manifest.json', buffer: manifestBytes },
    { name: 'project.json', buffer: projectBytes },
    ...entries,        // 字体
    ...imageEntries,   // 图片原件
  ]
  // 落盘前再过一遍白名单：写出去的包必须自己就能读回来
  for (const entry of all) codec.entryRole(entry.name)

  const written = codec.writeArchive(targetPath, all, {
    onProgress,
    shouldCancel: shouldCancel || (taskId ? () => cancelledTasks.has(taskId) : undefined),
  })
  return { path: written.path, bytes: written.bytes, entries: written.entries, resources, fonts: fontRecords, manifest }
}

// ─────────────────────────── 取消 ───────────────────────────

function cancelTask(taskId) {
  if (typeof taskId === 'string' && taskId) cancelledTasks.add(taskId)
  return { ok: true, taskId }
}

// ─────────────────────────── 导入检查 ───────────────────────────

function requireManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('工程包清单损坏')
  if (manifest.packageVersion !== PACKAGE_VERSION) {
    throw new Error(`不支持的工程包版本：${manifest.packageVersion}，请用同版本或更新版的批印坊打开`)
  }
  if (!Array.isArray(manifest.resources)) throw new Error('工程包清单缺少资源表')
  if (!Array.isArray(manifest.fonts)) throw new Error('工程包清单缺少字体表')
  if (!manifest.project || manifest.project.file !== 'project.json') throw new Error('工程包清单缺少工程文件声明')
}

function sniffImageOk(file, ext) {
  const head = Buffer.alloc(12)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, head, 0, 12, 0) } finally { fs.closeSync(fd) }
  if (ext === '.png') return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return head[0] === 0xff && head[1] === 0xd8
}

/**
 * 字体落地规划：**先把全部绑定算出来，再一次性重写工程**（计划 §4.3）。
 *
 * 判定顺序：内容一致 → 复用本地；同名不同内容 → 稳定别名 `PP_Font_<sha256>`；
 * 系统字体 / 本机已有 → 直接可用；都没有 → 记为缺失，必须由用户决定。
 */
function planFonts(manifestFonts, stagedByName) {
  const uploadDir = fonts.fontUploadDir()
  const uploaded = fonts.uploadedFonts()
  const byFamily = new Map(uploaded.map((f) => [f.family.toLowerCase(), f]))
  const byContent = new Map()
  for (const f of uploaded) {
    try { byContent.set(sha256File(path.join(uploadDir, f.file)), f) } catch { /* 读不到就当不存在 */ }
  }
  const systemFamilies = new Set(fonts.systemFonts().map((f) => f.family.toLowerCase()))
  const plans = []
  for (const record of manifestFonts || []) {
    const family = String(record.family || '')
    if (record.status === 'embedded') {
      const staged = stagedByName.get(record.path)
      if (!staged) {
        plans.push({ family, status: 'embedded', action: 'missing', reason: '包内缺少该字体原件' })
        continue
      }
      if (record.sha256 && staged.sha256 !== record.sha256) {
        plans.push({ family, status: 'embedded', action: 'missing', reason: '字体内容与清单记录不一致' })
        continue
      }
      const ext = (record.ext || path.extname(record.path)).toLowerCase()
      if (!fonts.FONT_EXTS.has(ext)) {
        plans.push({ family, status: 'embedded', action: 'missing', reason: `不支持的字体格式：${ext}` })
        continue
      }
      if (!sniffFontOk(staged.path, ext)) {
        plans.push({ family, status: 'embedded', action: 'missing', reason: '字体文件内容不是有效字体' })
        continue
      }
      // ① 本机已有一份**内容相同**的字体（可能叫别的名字）→ 复用它，不再复制一份
      const sameContent = byContent.get(staged.sha256)
      if (sameContent) {
        plans.push({ family, status: 'embedded', action: 'reuse', targetFamily: sameContent.family, file: sameContent.file, sha256: staged.sha256, staged: staged.path })
        continue
      }
      // ② 同名文件不存在 → 按原名发布（保持用户熟悉的字体名）
      const base = safeFontBase(family)
      const target = `${base}${ext}`
      const existsCaseInsensitive = uploaded.some((f) => f.file.toLowerCase() === target.toLowerCase())
      if (!existsCaseInsensitive) {
        plans.push({ family, status: 'embedded', action: 'publish', targetFamily: `${base}`, file: target, sha256: staged.sha256, ext, staged: staged.path })
        continue
      }
      // ③ 同名不同内容（Windows 大小写不敏感也算同名）→ 稳定别名，绝不覆盖旧文件
      const alias = `PP_Font_${staged.sha256}`
      plans.push({ family, status: 'embedded', action: 'alias', targetFamily: alias, file: `${alias}${ext}`, sha256: staged.sha256, ext, staged: staged.path, reason: '本机已有同名但内容不同的字体，导入副本将使用别名' })
      continue
    }
    // 需本机提供：系统字体或本机已上传
    if (byFamily.has(family.toLowerCase())) {
      plans.push({ family, status: 'required', action: 'reuse', targetFamily: byFamily.get(family.toLowerCase()).family })
    } else if (systemFamilies.has(family.toLowerCase())) {
      plans.push({ family, status: 'required', action: 'system', targetFamily: family })
    } else {
      plans.push({ family, status: 'required', action: 'missing', reason: '本机没有这个字体' })
    }
  }
  return plans
}

/** 字体文件签名探测：扩展名必须是受支持格式，且头部得像个字体。 */
function sniffFontOk(file, ext) {
  if (ext === '.ttf' || ext === '.ttc' || ext === '.otf') {
    const head = Buffer.alloc(4)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, head, 0, 4, 0) } finally { fs.closeSync(fd) }
    return head.readUInt32BE(0) === 0x00010000 || head.readUInt32BE(0) === 0x74746366 || head.toString('ascii', 0, 4) === 'true' || head.toString('ascii', 0, 4) === 'OTTO' || head.toString('ascii', 0, 4) === 'ttcf'
  }
  // woff / woff2 有明确的 magic
  const head = Buffer.alloc(4)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, head, 0, 4, 0) } finally { fs.closeSync(fd) }
  return head.toString('ascii', 0, 4) === 'wOFF' || head.toString('ascii', 0, 4) === 'wOF2'
}

/**
 * 检查阶段：把包读到**后端管理的暂存区**，返回检查令牌与摘要。
 *
 * 分两步的关键：提交阶段只认令牌对应的已验证内容——源文件在检查之后被人换掉，
 * 也不会改变最终导入的内容（我们读的是暂存副本）。
 */
async function inspectPackage(filePath, options = {}) {
  const source = String(filePath || '')
  if (!source || !path.isAbsolute(source)) throw new Error('工程包路径无效')
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('找不到该工程包文件')
  const token = crypto.randomBytes(12).toString('hex')
  const staging = resolveInsideDataDir(`${STAGING_DIR}/${token}`)
  const content = path.join(staging, 'content')
  fs.mkdirSync(content, { recursive: true })
  try {
    const { entries, totalBytes } = await codec.extractToDir(source, content, options)
    const byName = new Map(entries.map((e) => [e.name, e]))
    const manifestEntry = byName.get('manifest.json')
    const projectEntry = byName.get('project.json')
    if (!manifestEntry) throw new Error('工程包缺少 manifest.json')
    if (!projectEntry) throw new Error('工程包缺少 project.json')

    const manifest = readJson(manifestEntry.path)
    requireManifestShape(manifest)

    // 清单声明的资源必须逐条对上实际落盘的内容：哈希、字节数、文件签名
    // 声明集合 = 图片表 + 内嵌字体表（字体另有 status 字段，不进 resources）
    const declared = new Set([
      ...manifest.resources.map((r) => r.path),
      ...manifest.fonts.filter((f) => f.status === 'embedded' && f.path).map((f) => f.path),
    ])
    for (const record of manifest.resources) {
      const entry = byName.get(record.path)
      if (!entry) throw new Error(`工程包内缺少清单声明的文件：${record.path}`)
      if (record.sha256 && entry.sha256 !== record.sha256) throw new Error(`工程包内 ${record.path} 内容与清单记录不一致`)
      if (Number.isFinite(record.bytes) && record.bytes !== entry.bytes) throw new Error(`工程包内 ${record.path} 大小与清单记录不一致`)
      if (entry.role === 'image' && !sniffImageOk(entry.path, path.extname(entry.path).toLowerCase())) {
        throw new Error(`工程包内 ${record.path} 不是有效的图片文件`)
      }
    }
    // 反向核查：包里不能出现清单没列出的东西（多出来的条目一律视为不可信）
    for (const entry of entries) {
      if (entry.name === 'manifest.json' || entry.name === 'project.json') continue
      if (!declared.has(entry.name)) throw new Error(`工程包内含有清单未列出的文件：${entry.name}`)
    }

    const projectRaw = readJson(projectEntry.path)
    const doc = require('./design-layout.cjs').normalizeDesign(projectRaw)
    // 工程里引用的每张图，包里都必须有对应原件（不按 visible 过滤）
    for (const [assetId, asset] of Object.entries(doc.assets)) {
      const hash = assetId.slice('asset_'.length)
      const entry = byName.get(`images/${hash}${asset.path.endsWith('.png') ? '.png' : '.jpg'}`)
      if (!entry) throw new Error(`工程包内缺少底图原件：${asset.name || hash.slice(0, 8)}`)
      if (entry.sha256 !== hash) throw new Error(`工程包内底图原件与工程记录不一致：${asset.name || hash.slice(0, 8)}`)
    }

    const fontPlans = planFonts(manifest.fonts, byName)
    const record = {
      token,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      sourcePath: source,
      staging: content,
      manifest,
      projectPath: projectEntry.path,
      fontPlans,
      totalBytes,
    }
    fs.writeFileSync(path.join(staging, 'inspect.json'), JSON.stringify(record, null, 2), 'utf8')
    return summarize(record)
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* 清理失败不顶掉真错误 */ }
    throw err
  }
}

function summarize(record) {
  const manifest = record.manifest
  return {
    token: record.token,
    packageVersion: manifest.packageVersion,
    schemaVersion: manifest.schemaVersion,
    name: manifest.source && manifest.source.name ? manifest.source.name : '导入的底图',
    source: manifest.source || null,
    artboard: manifest.artboard,
    stats: manifest.stats,
    totalBytes: record.totalBytes,
    fonts: record.fontPlans.map((p) => ({
      family: p.family, status: p.status, action: p.action,
      targetFamily: p.targetFamily || null, reason: p.reason || null,
    })),
    // 需要用户在提交前做决定的字体（缺失 / 别名只是告知，不阻断）
    unresolved: record.fontPlans.filter((p) => p.action === 'missing').map((p) => p.family),
  }
}

// ─────────────────────────── 提交 ───────────────────────────

/** 已完成导入的令牌留档：暂存区在提交成功后就删了，重复提交要靠它认出来。 */
function doneFile(token) {
  return resolveInsideDataDir(`${STAGING_DIR}/done/${token}.json`)
}

function requireValidated(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{24}$/.test(token)) throw new Error('工程包检查令牌无效，请重新选择文件')
  const file = resolveInsideDataDir(`${STAGING_DIR}/${token}/inspect.json`)
  if (!fs.existsSync(file)) {
    // 暂存区已清 = 这次检查已经提交过。重复提交（用户连点两次）必须返回**同一个结果**，
    // 而不是再导入一份副本——「点两次出现两个工程」是这类流程最容易挨骂的地方。
    const done = doneFile(token)
    if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, 'utf8'))
    throw new Error('工程包检查已失效，请重新选择文件')
  }
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (Date.now() > Date.parse(record.expiresAt)) {
    cancelPackage(token)
    throw new Error('工程包检查已过期，请重新选择文件')
  }
  // 令牌绑定的是**暂存快照**：提交前复核文件还在且哈希没变
  if (!fs.existsSync(record.projectPath)) throw new Error('工程包暂存内容已丢失，请重新选择文件')
  return record
}

function cancelPackage(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{24}$/.test(token)) return { ok: false, reason: '令牌无效' }
  const staging = resolveInsideDataDir(`${STAGING_DIR}/${token}`)
  const recordFile = path.join(staging, 'inspect.json')
  let committed = null
  try {
    if (fs.existsSync(recordFile)) committed = JSON.parse(fs.readFileSync(recordFile, 'utf8')).committed || null
    else if (fs.existsSync(doneFile(token))) committed = JSON.parse(fs.readFileSync(doneFile(token), 'utf8')).committed || null
  } catch { /* 读不到就按未提交处理 */ }
  if (committed) return { ok: false, canceled: false, reason: '该工程包已导入，不能取消', committed }
  try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* 删不掉留给下次清扫 */ }
  return { ok: true, canceled: true, token }
}

/** 清扫过期暂存区与完成留档（应用启动时与每次导入前各跑一次） */
function purgeStaging() {
  const root = stagingRoot()
  if (!fs.existsSync(root)) return { removed: [] }
  const removed = []
  for (const name of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{24}$/.test(name)) continue
    const dir = path.join(root, name)
    const recordFile = path.join(dir, 'inspect.json')
    let expired = true
    try {
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
      expired = Date.now() > Date.parse(record.expiresAt)
    } catch { /* 没有记录 / 记录损坏 → 视为可清 */ }
    if (!expired) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch { /* 被占用就下次再清 */ }
  }
  // 完成留档：只用来认「这个令牌导入过了」，超过 TTL 就没有意义了
  const doneDir = path.join(root, 'done')
  if (fs.existsSync(doneDir)) {
    for (const name of fs.readdirSync(doneDir)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue
      const file = path.join(doneDir, name)
      let stale = true
      try { stale = Date.now() - fs.statSync(file).mtimeMs > TOKEN_TTL_MS } catch { /* 读不到就按过期处理 */ }
      if (!stale) continue
      try {
        fs.unlinkSync(file)
        removed.push(`done/${name}`)
      } catch { /* 删不掉下次再清 */ }
    }
  }
  return { removed }
}

/**
 * 提交导入：把已检查的暂存内容发布成**新工程**（新 ID、版本 1）。
 *
 * @param {string} token 检查令牌
 * @param {object} [o]
 * @param {object} [o.fontDecisions] { 原字体名: { action: 'substitute'|'default'|'file', family?, filePath? } }
 * @param {string} [o.name] 导入后的工程名（默认用包里的名字）
 */
function commitPackage(token, o = {}) {
  const record = requireValidated(token)
  if (record.committed) return { ...record.committed, reused: true }

  const decisions = o.fontDecisions || {}
  // 绑定映射：原字体名 → { family, file }。**先算完全部绑定再一次性重写工程**
  // —— 边遍历边改会出现「A 改成 B、B 又改成 C」的连锁替换。
  const bindings = new Map()
  const pendingFonts = [] // 需要真正写进 print-fonts 的
  for (const plan of record.fontPlans) {
    if (plan.action === 'missing') {
      const decision = decisions[plan.family]
      if (!decision) throw new Error(`请先处理缺失的字体：${plan.family}`)
      if (decision.action === 'substitute') {
        if (!decision.family) throw new Error(`替代字体名无效：${plan.family}`)
        const local = fonts.uploadedFonts().find((f) => f.family.toLowerCase() === String(decision.family).toLowerCase())
        bindings.set(plan.family, { family: String(decision.family), file: local ? local.file : null })
      } else if (decision.action === 'default') {
        bindings.set(plan.family, { family: '', file: null })
      } else if (decision.action === 'file') {
        const staged = stageProvidedFont(plan.family, decision.filePath)
        pendingFonts.push(staged)
        bindings.set(plan.family, { family: staged.targetFamily, file: staged.file })
      } else {
        throw new Error(`未知的字体处理方式：${decision.action}`)
      }
      continue
    }
    if (plan.action === 'publish' || plan.action === 'alias') {
      if (!fs.existsSync(plan.staged)) throw new Error(`工程包暂存内容已丢失：${plan.family}`)
      pendingFonts.push(plan)
      bindings.set(plan.family, { family: plan.targetFamily, file: plan.file })
    } else {
      // reuse：本机已有同内容字体；system：本机系统字体（不进 fontAssets）
      bindings.set(plan.family, { family: plan.targetFamily || plan.family, file: plan.file || null })
    }
  }

  const projectRaw = readJson(record.projectPath)
  const doc = normalizeDesign(projectRaw)
  if (o.name) doc.name = String(o.name).slice(0, 120)

  const newId = `design_${crypto.randomBytes(12).toString('hex')}`
  const txId = `tx_${crypto.randomBytes(12).toString('hex')}`
  fs.mkdirSync(txRoot(), { recursive: true })
  const tx = {
    txId, token, status: 'prepared', createdAt: nowIso(),
    newDesignId: newId,
    images: Object.keys(doc.assets),
    fonts: pendingFonts.map((f) => ({ file: f.file, staged: f.staged, sha256: f.sha256 })),
  }
  const writeTx = () => fs.writeFileSync(txFile(txId), JSON.stringify(tx, null, 2), 'utf8')
  writeTx()

  // 锁内只做同步文件操作：解包与校验都在锁外完成了
  return designs.withDesignLock(() => {
    const createdFonts = []
    try {
      // ① 发布图片原件（复用 designs 的导入路径：哈希校验 + 元数据一并写好）
      for (const assetId of tx.images) {
        const resource = record.manifest.resources.find((r) => `asset_${r.sha256}` === assetId)
        const staged = path.join(record.staging, resource.path)
        designs.importImageFile(staged, 'managed')
        // 包里带来的原件一律按「受管理」：换台机器导入后不该因为删一个图层就把原件删了
        designs.setAssetSource(assetId, 'managed')
      }
      tx.status = 'resources'
      writeTx()

      // ② 发布字体：**排他创建**，已存在必须内容一致
      for (const font of tx.fonts) {
        const target = path.join(fonts.fontUploadDir(), font.file)
        if (fs.existsSync(target)) {
          if (sha256File(target) !== font.sha256) throw new Error(`本机已存在同名但内容不同的字体：${font.file}`)
          continue
        }
        fs.writeFileSync(target, fs.readFileSync(font.staged), { flag: 'wx' })
        createdFonts.push(target)
      }

      // ③ 一次性重写字体绑定，再发布工程（索引最后写）
      const fontAssets = {}
      for (const [family, file] of Object.entries(doc.fontAssets || {})) {
        const bound = bindings.get(family)
        if (!bound) { fontAssets[family] = file; continue }  // 没被依赖收集到的条目：原样保留
        if (!bound.family) continue                          // 回默认字体栈：不再引用字体文件
        if (bound.file) fontAssets[bound.family] = bound.file
      }
      doc.fontAssets = fontAssets
      for (const layer of doc.layers) {
        if (layer.type !== 'text') continue
        const bound = bindings.get(layer.fontFamily)
        if (bound) layer.fontFamily = bound.family
      }
      const published = designs.publishRevisionLocked(doc, {
        id: newId, revision: 1, createdAt: nowIso(), recordUse: false,
      })
      tx.status = 'committed'
      tx.ref = { id: published.id, revision: published.revision, name: published.name }
      writeTx()
      record.committed = tx.ref
      // 留档必须在删暂存区**之前**：删完就认不出这个令牌提交过了
      fs.mkdirSync(path.dirname(doneFile(token)), { recursive: true })
      fs.writeFileSync(doneFile(token), JSON.stringify({ token, committed: tx.ref, at: nowIso() }, null, 2), 'utf8')
      try { fs.rmSync(resolveInsideDataDir(`${STAGING_DIR}/${token}`), { recursive: true, force: true }) } catch { /* 暂存清理失败不影响导入结果 */ }
      try { fs.unlinkSync(txFile(txId)) } catch { /* 已提交的事务记录可以删掉 */ }
      return { ...tx.ref, reused: false }
    } catch (err) {
      rollback(tx, createdFonts)
      throw err
    }
  })
}

/** 用户临时提供字体文件来补齐依赖（走同一套冲突规则，绝不覆盖本机已有字体） */
function stageProvidedFont(family, filePath) {
  if (typeof filePath !== 'string' || !filePath || !fs.existsSync(filePath)) throw new Error(`找不到字体文件：${family}`)
  const ext = path.extname(filePath).toLowerCase()
  if (!fonts.FONT_EXTS.has(ext)) throw new Error(`仅支持 ttf / otf / ttc / woff / woff2 字体文件：${family}`)
  const bytes = fs.readFileSync(filePath)
  if (!bytes.length || bytes.length > codec.LIMITS.maxFontBytes) throw new Error(`字体文件超过 32 MB：${family}`)
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  const base = safeFontBase(family)
  const file = `${base}${ext}`
  const target = path.join(fonts.fontUploadDir(), file)
  const exists = fs.existsSync(target) ||
    fonts.uploadedFonts().some((f) => f.file.toLowerCase() === file.toLowerCase())
  return {
    family, sha256: hash, staged: filePath, ext,
    file: exists ? `PP_Font_${hash}${ext}` : file,
    targetFamily: exists ? `PP_Font_${hash}` : base,
    action: 'publish',
  }
}

/**
 * 回滚：**只删本次事务自己写出来的东西**。
 * 图片原件一律保守保留（它们可能是别的工程 / 素材库也在用的同一份内容），
 * 只有字体是本次新建的才删。
 */
function rollback(tx, createdFonts) {
  for (const file of createdFonts) {
    try { fs.unlinkSync(file) } catch { /* 已被占用/已不存在 */ }
  }
  const dir = resolveInsideDataDir(`designs/${tx.newDesignId}`)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* 删不掉留给 purgeOrphanDirs */ }
  try { fs.unlinkSync(txFile(tx.txId)) } catch { /* 已不存在 */ }
}

/**
 * 恢复未完成的事务：崩溃 / 强杀 / 磁盘写满之后把状态收敛成确定结果。
 *
 * 判定口径（与计划一致）：
 *   - 索引里已经有这个工程 ⇒ 认定导入成功（提交标记没写完不算失败），补写记录后收尾；
 *   - 索引里没有 ⇒ 回滚本次事务写出的字体与版本目录；
 *   - 重复提交由 `record.committed` 挡住，返回同一个结果。
 */
function recoverPendingTransactions() {
  const root = txRoot()
  if (!fs.existsSync(root)) return { recovered: [], rolledBack: [] }
  const recovered = []
  const rolledBack = []
  for (const name of fs.readdirSync(root)) {
    if (!/^tx_[a-f0-9]{24}\.json$/.test(name)) continue
    const file = path.join(root, name)
    let tx
    try { tx = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    const indexed = designs.listDesigns().some((d) => d.id === tx.newDesignId)
    if (indexed) {
      recovered.push(tx.newDesignId)
      try { fs.unlinkSync(file) } catch { /* 留着也不影响 */ }
      continue
    }
    rollback(tx, (tx.fonts || []).map((f) => path.join(fonts.fontUploadDir(), f.file)).filter((p) => {
      // 只删内容确实与本次事务一致的（避免删掉用户后来自己放进去的同名文件）
      try { return fs.existsSync(p) && sha256File(p) === (tx.fonts.find((f) => path.join(fonts.fontUploadDir(), f.file) === p) || {}).sha256 } catch { return false }
    }))
    rolledBack.push(tx.newDesignId)
  }
  return { recovered, rolledBack }
}

module.exports = {
  PACKAGE_VERSION,
  LIMITS: codec.LIMITS,
  collectReferences,
  exportPackage,
  inspectPackage,
  commitPackage,
  cancelPackage,
  cancelTask,
  purgeStaging,
  recoverPendingTransactions,
  stagingRoot,
}

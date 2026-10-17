/** Versioned background artwork. Original image bytes are retained indefinitely. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const os = require('os')
const { loadJson, saveJson, resolveInsideDataDir } = require('./store.cjs')
const assetStorage = require('./asset-storage.cjs')
const { imageSizeFromBuffer, sniffImageExt } = require('./images.cjs')
const { normalizeDesign, collectFontFamilies, normalizeSource } = require('./design-layout.cjs')
const { toUserMessage } = require('./user-error.cjs')

const MAX_BYTES = 64 * 1024 * 1024
const MAX_PROJECT_BYTES = 512 * 1024 * 1024
const MAX_PIXELS = 80000000
const ASSET_ID = /^asset_([a-f0-9]{64})$/
const DESIGN_ID = /^design_[a-f0-9]{24}$/
/**
 * 原件池（内容寻址：同名同字节，`<sha256>.<ext>` + 同名 `.json` 边车）。
 *
 * **两个池子按 source 物理分开存放（I-51）**：
 * - `design-assets`：素材库受管理原件（managed）。素材库导入 / adopt「加入素材库」/
 *   工程包导入都落这里；侧栏「打开素材库文件夹」开的就是这个池。
 * - `ephemeral-assets`：临时底图原件（ephemeral）。模板页上传、底图制作页粘贴 / 拖入 /
 *   「＋ 图片」对话框、配图照片先落这里——受引用扫描保护（不误删），但不进素材库列表，
 *   被 adopt 时连字节一起迁进素材库池。
 *
 * 分池只决定「新导入落哪」与「升级时搬去哪」；读取按 hash 双池定位，
 * 所以旧工程文档里指向另一池的同 hash 路径照常能定位到真身。
 */
const POOL_MANAGED = 'design-assets'
const POOL_EPHEMERAL = 'ephemeral-assets'
const ASSET_POOLS = [POOL_MANAGED, POOL_EPHEMERAL]
function poolOfSource(source) {
  return normalizeSource(source) === 'ephemeral' ? POOL_EPHEMERAL : POOL_MANAGED
}
/**
 * 按 hash 在两个池子里定位原件的 `.json` 边车，返回池名；都不在返回 null。
 *
 * `design-assets` 优先：managed 是权威池——迁移 / 升级中途崩溃留下两份时，
 * 读到的必须是受管理那份（同 I-31 的 fail-safe 方向：漏判的后果只能是「多占一块盘」）。
 */
function locateAsset(hash) {
  for (const pool of ASSET_POOLS) {
    try { if (fs.existsSync(assetStorage.resolveAssetPath(`${pool}/${hash}.json`))) return pool } catch { /* 不可读：换下一个 */ }
  }
  return null
}
/** 原件图片（任一池）是否已在盘上——照片导入的 created 判定用，两池都算「已存在」。 */
function originalExists(hash) {
  for (const pool of ASSET_POOLS) {
    for (const ext of ['png', 'jpg', 'jpeg']) {
      try { if (fs.existsSync(assetStorage.resolveAssetPath(`${pool}/${hash}.${ext}`))) return true } catch { /* 不可读：当不存在 */ }
    }
  }
  return false
}
/**
 * 工程文档声明的原件路径是否可接受。
 *
 * 分池迁移后，旧文档里会残留「同 hash、另一池、同扩展名」的路径——那是合法历史值
 * （打开 / 保存时由 `canonicalAssets` 改写成真身）。指向别的 hash / 池外路径一律仍是损坏：
 * readAsset 靠 id 的哈希核对内容，路径声明只是提示，不是安全边界。
 */
function claimedPathOk(claim, hash, expected) {
  if (claim === expected) return true
  const ext = expected.slice(expected.lastIndexOf('.'))
  return ASSET_POOLS.some((pool) => claim === `${pool}/${hash}${ext}`)
}
const DATA_DIR = process.env.PRINTPRESS_DATA_DIR
/**
 * 保存锁的最终兜底超时（与 PID 无关）。
 *
 * `withLock` 的临界区只做「读索引 + 读单个版本 JSON + statSync 字体 + 两次原子写」，
 * 素材字节的哈希与校验都在锁外，正常远低于 1 分钟。活着的 PID 却持有超过 1 小时的锁，
 * 只可能是「旧进程崩溃后 PID 被复用」——此时 `process.kill(pid, 0)` 会误判为活锁，
 * 没有这条兜底就会永久锁死保存（且没有任何自助恢复入口）。
 */
const LOCK_TTL_MS = 60 * 60 * 1000
// Metadata only: source bytes are hashed on every read, but a known hash need not be inflated again.
const VERIFIED_IMAGES = new Map()

function projectId(id) {
  if (typeof id !== 'string' || !DESIGN_ID.test(id)) throw new Error('底图工程标识无效')
  return id
}
function index() { return loadJson('designs', { expect: 'array' }) || [] }
function withLock(run) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const lock = path.join(DATA_DIR, 'designs.write.lock')
  const ownerName = `${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`
  const pending = path.join(DATA_DIR, `.design-lock-${ownerName}`)
  fs.mkdirSync(pending)
  fs.writeFileSync(path.join(pending, ownerName), JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
  let acquired = false
  try {
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try { fs.renameSync(pending, lock); acquired = true } catch (err) {
        if (!fs.existsSync(lock)) throw err
        if (!recoverAbandonedLock(lock)) {
          // 把锁的绝对路径写进报错：重试解决不了残留锁，用户/agent 需要知道删什么。
          throw new Error(`底图工程正在由另一个进程保存，请稍后重试（若长期如此，可关闭所有批印坊窗口后删除：${lock}）`)
        }
      }
    }
    if (!acquired) throw new Error('底图工程正在保存，请稍后重试')
    return run()
  } finally {
    // 清理失败绝不能顶掉 run() 的真实结果：这里只尽力而为，剩下的由下一次
    // withLock 的 recoverAbandonedLock 回收（空目录会被直接 rmdir 掉）。
    const owned = acquired ? lock : pending
    try { fs.unlinkSync(path.join(owned, ownerName)) } catch { /* 已被清理或不可删 */ }
    try { fs.rmdirSync(owned) } catch { /* 非空/占用/已不存在都留给下一次回收 */ }
  }
}
function recoverAbandonedLock(lock) {
  let stat
  try { stat = fs.statSync(lock) } catch (err) { if (err.code === 'ENOENT') return true; throw err }
  // 本模块的锁一律是目录（由 rename 一个非空 pending 目录产生）。这个位置出现普通文件
  // 只可能是外部误建（杀软 / 同步盘 / 手工），它永远不会被我们释放——直接清掉，
  // 否则保存会永久报「另一个进程正在保存」且无路可走。
  if (!stat.isDirectory()) {
    try { fs.unlinkSync(lock); return true } catch (err) { return err.code === 'ENOENT' }
  }
  const owners = fs.readdirSync(lock)
  for (const name of owners) {
    if (!/^\d+-[a-f0-9]+\.json$/.test(name)) return false
    const file = path.join(lock, name)
    let owner
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
      if (err.code === 'ENOENT') continue
      return false
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.createdAt)) return false
    let alive = true
    try { process.kill(owner.pid, 0) } catch (err) { if (err.code === 'ESRCH') alive = false }
    // 早于本次开机 = 上一次开机留下的残留。
    if (owner.createdAt < Date.now() - os.uptime() * 1000 - 5000) alive = false
    // PID 复用兜底：临界区远短于 TTL，所以「PID 还活着但锁已超过 TTL」只可能是残留锁。
    if (owner.createdAt < Date.now() - LOCK_TTL_MS) alive = false
    if (alive) return false
    // Only remove the unique dead owner's file; another process's new lock is nonempty.
    try { fs.unlinkSync(file) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
  try { fs.rmdirSync(lock); return true } catch (err) {
    if (err.code === 'ENOENT') return true
    if (['ENOTEMPTY', 'EEXIST'].includes(err.code)) return false
    throw err
  }
}
function atomicFile(file, bytes, root = DATA_DIR) {
  // assertRealDataPath 会 realpathSync(DATA_DIR)，所以数据目录必须先存在。
  // 导入素材这条路径不持锁（importBuffer 不做 withLock），不能依赖 withLock 建目录：
  // 否则全新数据目录下第一次导入会抛原生 ENOENT。
  fs.mkdirSync(root, { recursive: true })
  if (path.resolve(root) === path.resolve(assetStorage.legacyManagedDir())) assertRealDataPath(root)
  let existing = path.dirname(file)
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  assertRealStoragePath(existing, root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  assertRealStoragePath(path.dirname(file), root)
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
function revisionPath(id, revision) {
  projectId(id)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('底图版本无效')
  return resolveInsideDataDir(`designs/${id}/${revision}.json`)
}
function readRevision(id, revision) {
  revisionPath(id, revision)
  const file = guardedFile(`designs/${id}/${revision}.json`, 'designs')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function guardedFile(relative, directory) {
  const absolute = resolveInsideDataDir(relative)
  const allowed = resolveInsideDataDir(directory)
  const real = fs.realpathSync(absolute)
  const root = fs.realpathSync(allowed)
  assertRealDataPath(root)
  const inside = path.relative(root, real)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw pathGuardError('素材路径越界')
  return real
}
/**
 * 原件（图片或 `.json` 边车）的路径守卫：第一段必须是两个已知池名之一，
 * 再按 `guardedFile` 的 realpath 口径复核文件真在池内（符号链接绕不过去）。
 */
function guardedAssetFile(relative) {
  const pool = String(relative).split('/')[0]
  if (!ASSET_POOLS.includes(pool)) throw pathGuardError('素材路径不在素材目录内')
  const absolute = assetStorage.resolveAssetPath(relative)
  const root = assetStorage.poolDir(pool)
  if (pool === POOL_EPHEMERAL || path.resolve(root) === path.resolve(assetStorage.legacyManagedDir())) assertRealDataPath(root)
  const real = fs.realpathSync(absolute)
  const realRoot = fs.realpathSync(root)
  const inside = path.relative(realRoot, real)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw pathGuardError('素材路径越界')
  return real
}
function assertRealDataPath(file) {
  assertRealStoragePath(file, DATA_DIR)
}
function assertRealStoragePath(file, storageRoot) {
  const root = fs.realpathSync(storageRoot)
  const real = fs.realpathSync(file)
  const relative = path.relative(root, real)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw pathGuardError('存储路径越界（符号链接）')
}
/**
 * 路径守卫错误的统一标记。
 *
 * 为什么要带 code：上层（如 `readAsset`）把「读不到」翻译成用户看得懂的「素材可能已被删除」，
 * 而**路径越界是安全问题，语义完全不同**——不能被那层翻译吞掉。
 * 守卫（test/designs.cjs 的 junction 出界用例）靠 code 后的错误文案证明
 * 「拒绝的原因是路径守卫，而不是碰巧失败」。
 */
function pathGuardError(message) {
  const err = new Error(message)
  err.code = 'PATH_ESCAPED'
  return err
}
function readAsset(id, claimedPath) {
  const match = typeof id === 'string' && ASSET_ID.exec(id)
  if (!match) throw new Error('素材标识无效')
  const pool = locateAsset(match[1])
  let asset
  try { asset = JSON.parse(fs.readFileSync(guardedAssetFile(`${pool || POOL_MANAGED}/${match[1]}.json`), 'utf8')) } catch (err) {
    // 这里**故意不拼 id、也不拼 err.message**：id 是内部标识（64 位十六进制），
    // err.message 里带绝对路径与 errno。两者都会原样出现在用户的报错横幅上，
    // 而用户既读不懂、也无法据此做任何事（2026-10-13 实际被投诉过，见 I-48）。
    // 例外：路径越界是安全问题，语义与「素材丢了」完全不同，照原样往外抛。
    // 详情不丢：原始 err 仍可在开发控制台看到（preload 的 invoke 包装会打）。
    if (err && err.code === 'PATH_ESCAPED') throw err
    throw new Error('找不到底图素材，可能已被删除或尚未同步。')
  }
  if (!asset || asset.id !== id || !['image/png', 'image/jpeg'].includes(asset.mime)) throw new Error('底图素材记录损坏')
  const expected = `${pool}/${match[1]}.${asset.mime === 'image/png' ? 'png' : 'jpg'}`
  if (asset.path !== expected) throw new Error('底图素材路径不一致')
  // claimedPath 是工程文档里的声明：只当提示。分池迁移后旧文档会残留指向另一池的
  // 同 hash 路径，那是合法历史值（I-51）；真身由上面的 expected 说话，内容由哈希核对。
  if (claimedPath !== undefined && !claimedPathOk(claimedPath, match[1], expected)) throw new Error('底图素材路径不一致')
  const abs = guardedAssetFile(expected)
  const size = fs.statSync(abs).size
  if (size <= 0 || size > MAX_BYTES) throw new Error('底图素材文件大小无效')
  const bytes = fs.readFileSync(abs)
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new Error('底图素材原件已改变，请重新导入')
  const measured = VERIFIED_IMAGES.get(match[1]) || validateImage(bytes)
  VERIFIED_IMAGES.set(match[1], measured)
  if (asset.width !== measured.width || asset.height !== measured.height || asset.mime !== measured.mime) throw new Error('底图素材尺寸记录不一致')
  return { asset: { id, path: expected, name: String(asset.name || '图片').slice(0, 200), width: measured.width, height: measured.height, mime: measured.mime, orientation: measured.orientation || 1, source: normalizeSource(asset.source) }, bytes: size }
}
/**
 * 对外只读出口：给素材库（asset-library.cjs）用，避免那边再造一份原件解析。
 *
 * 一律走 `readAsset`，也就是**照样做哈希核对**——素材库要缩略的必须是那个
 * 未被改动的原件，绝不能缩略一个已被外部替换的文件。
 */
function assetInfo(id) {
  return readAsset(assetIdOfExport(id)).asset
}
/** 仅供体积预估读取导入时记录的显示尺寸；出片仍须经 assetInfo 校验原件。 */
function assetGeometry(id) {
  const hash = ASSET_ID.exec(assetIdOfExport(id))[1]
  const pool = locateAsset(hash)
  const meta = JSON.parse(fs.readFileSync(guardedAssetFile(`${pool || POOL_MANAGED}/${hash}.json`), 'utf8'))
  if (meta.id !== id || !['image/png', 'image/jpeg'].includes(meta.mime)
      || !Number.isInteger(meta.width) || !Number.isInteger(meta.height)
      || meta.width < 1 || meta.height < 1 || meta.width > 24000 || meta.height > 24000) {
    throw new Error('素材尺寸记录无效，无法估算')
  }
  const expected = `${pool}/${hash}.${meta.mime === 'image/png' ? 'png' : 'jpg'}`
  if (meta.path !== expected) throw new Error('素材路径不一致，无法估算')
  guardedAssetFile(expected)
  // 估算只使用显示坐标的像素面积，不做编码，旧元数据无需补读整张 JPEG 的方向标记。
  return { width: meta.width, height: meta.height, orientation: 1, mime: meta.mime }
}
/**
 * Read only an asset's lifecycle marker without loading or hashing the image bytes.
 * `null` means the metadata is missing, malformed, or predates the source field;
 * callers must then use their own conservative fallback.
 */
function assetSource(id) {
  const assetId = assetIdOfExport(id)
  const hash = ASSET_ID.exec(assetId)[1]
  try {
    const pool = locateAsset(hash)
    if (!pool) return null
    const metadata = JSON.parse(fs.readFileSync(guardedAssetFile(`${pool}/${hash}.json`), 'utf8'))
    if (!metadata || metadata.id !== assetId || !Object.prototype.hasOwnProperty.call(metadata, 'source')) return null
    return normalizeSource(metadata.source)
  } catch (err) {
    if (err && err.code === 'PATH_ESCAPED') throw err
    return null
  }
}
function assetBytes(id) {
  const assetId = assetIdOfExport(id)
  const { asset } = readAsset(assetId)
  return { asset, buffer: fs.readFileSync(guardedAssetFile(asset.path)) }
}
function assetIdOfExport(id) {
  if (typeof id !== 'string' || !/^asset_[a-f0-9]{64}$/.test(id)) throw new Error('素材标识无效')
  return id
}

function canonicalAssets(doc) {
  let total = 0
  for (const [id, asset] of Object.entries(doc.assets)) {
    const trusted = readAsset(id, asset.path)
    doc.assets[id] = trusted.asset
    total += trusted.bytes
  }
  if (total > MAX_PROJECT_BYTES) throw new Error('底图素材总大小不能超过 512 MB')
  return doc
}
function canonicalFonts(doc, previous = {}) {
  const uploaded = require('./fonts.cjs').uploadedFonts()
  const references = {}
  for (const family of collectFontFamilies(doc)) {
    const file = (Object.hasOwn(doc.fontAssets, family) ? doc.fontAssets[family] : null) ||
      (Object.hasOwn(previous, family) ? previous[family] : null) || (uploaded.find(font => font.family === family) || {}).file
    if (!file) continue
    const expectedFamily = file.replace(/\.[^.]+$/, '')
    if (expectedFamily !== family) throw new Error(`底图字体素材与名称不一致：${family}`)
    try {
      const absolute = guardedFile(`print-fonts/${file}`, 'print-fonts')
      if (!fs.statSync(absolute).isFile() || fs.statSync(absolute).size === 0) throw new Error('文件为空')
    } catch (err) {
      // 保留「哪个字体」——用户据此能重装字体；丢掉 err.message（内含绝对路径与 errno，I-48）
      throw new Error(`底图所用上传字体缺失或不可读：${family}（${toUserMessage(err, '文件可能已被删除')}）`)
    }
    references[family] = file
  }
  doc.fontAssets = references
  return doc
}
function listDesigns() {
  return index().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}
/**
 * 记一次「使用」（打开工程、按预设新建后落库等），只更新摘要里的 `lastUsedAt`。
 *
 * ⚠️ **绝不能碰 `revision`，也不能重写工程内容**：使用记录是界面元数据，不是工程版本。
 * 一旦顺手 `revision + 1`（或把 doc 重存一遍），用户下一次保存就会撞 `DESIGN_CONFLICT`
 * （「底图已更新至版本 N，当前版本 M 不能覆盖」），而他根本没改过任何东西——
 * 属于最难排查的一类故障。契约登记为 **I-29**。
 *
 * 实现上只在 `designs.json` 的摘要里写一个时间戳，不碰 `designs/<id>/<rev>.json`，
 * 所以「记录使用」在物理上就不可能改变任何一份已提交版本的内容。
 */
function touchDesign(id) {
  projectId(id)
  return withLock(() => {
    const all = index()
    const found = all.find((d) => d.id === id)
    if (!found) throw new Error('底图工程不存在或已删除')
    /*
     * ⚠️ 只刷新**已经在「常用」里**的工程（有 `lastUsedAt` 才说明用户保存过）。
     *
     * 「常用」的门槛是**用户自己保存过**：系统按预设自动建出来的工程不算
     * （`saveDesign(..., { recordUse: false })`）。所以打开一份**从未保存过**的
     * 工程不会把它塞进常用——只是原地不动（返回 `touched: false`）。
     * 已经在常用里的，打开会把它顶到最前（这才是「常用」该有的行为）。
     *
     * 顺带：这里**绝不碰 `revision`**（I-29）——动了它用户下次保存就撞
     * `DESIGN_CONFLICT`，而报错完全指不到真凶。
     */
    if (!found.lastUsedAt) return { ok: true, id, lastUsedAt: found.lastUsedAt || null, touched: false }
    const now = new Date().toISOString()
    saveJson('designs', all.map((d) => (d.id === id ? { ...d, lastUsedAt: now } : d)))
    return { ok: true, id, lastUsedAt: now, touched: true }
  })
}
function getDesign(id, revision) {
  projectId(id)
  const head = index().find(d => d.id === id)
  if (!head) throw new Error('底图工程不存在或已删除')
  const rev = revision === undefined ? head.revision : revision
  if (!Number.isSafeInteger(rev) || rev < 1 || rev > head.revision) throw new Error('底图版本不存在或尚未提交')
  let doc
  try { doc = normalizeDesign(readRevision(id, rev)) } catch (err) {
    // 校验失败的原因（如「去色超出有效范围（0–1）」）是中文的、对报障有用，保留；
    // 但过一遍 toUserMessage：万一抛的是英文引擎错误，也不会漏到界面上（I-48）
    throw new Error(`读取底图工程失败：${toUserMessage(err, '文件可能已损坏')}`)
  }
  if (doc.id !== id || doc.revision !== rev) throw new Error('底图版本记录损坏')
  return canonicalFonts(canonicalAssets(doc))
}
function resolveDesign(ref) {
  if (!ref || typeof ref !== 'object') throw new Error('底图工程引用无效')
  // Templates must pin a committed revision, never silently follow the head.
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('底图模板必须指定已保存的版本')
  return getDesign(ref.id, ref.revision)
}

/** Validate a current editing snapshot for output without committing a revision. */
function resolveDraft(input) {
  const doc = normalizeDesign(input)
  let previousFonts = {}
  if (doc.id && doc.revision > 0) previousFonts = readRevision(doc.id, doc.revision).fontAssets || {}
  return canonicalFonts(canonicalAssets(doc), previousFonts)
}
function saveDesign(input, options) {
  const doc = canonicalAssets(normalizeDesign(input))
  /*
   * ⚠️ `recordUse: false` 只给「系统按预设自动建工程」用（`design:createFromPreset`）。
   *
   * 「常用」列表的门槛是**用户自己保存过**——预设刚生成出来的工程不该一出生就
   * 出现在常用里，否则每点一次「身份证（新建）」就往常用里塞一条，跟「工程库
   * 每点一次多一个」是同一类病（实测一次会话 18 个、装上 0.4.0 又点了 4 个）。
   * 用户真正保存（`design:save` / 另存副本 / 保存并应用）时才记这一次使用。
   */
  const recordUse = !options || options.recordUse !== false
  return withLock(() => {
    const all = index()
    const head = doc.id ? all.find(d => d.id === projectId(doc.id)) : null
    if (doc.id && !head) throw new Error('底图工程不存在，若要恢复副本请使用另存为')
    if (head && doc.revision !== head.revision) {
      const err = new Error(`底图已更新至版本 ${head.revision}，当前版本 ${doc.revision} 不能覆盖，请重新打开或另存副本`)
      err.code = 'DESIGN_CONFLICT'
      throw err
    }
    if (!head && doc.revision !== 0) throw new Error('新工程版本必须为 0')
    const previousFonts = head ? readRevision(head.id, head.revision).fontAssets || {} : {}
    canonicalFonts(doc, previousFonts)
    const now = new Date().toISOString()
    const id = head ? head.id : `design_${crypto.randomBytes(12).toString('hex')}`
    return publishRevisionLocked(doc, {
      id, revision: head ? head.revision + 1 : 1, createdAt: head ? head.createdAt : now, recordUse,
    })
  })
}

/**
 * 锁内发布一个**已校验**的版本：写版本 JSON → 更新索引。
 *
 * ⚠️ 调用方必须已持有 `withLock`，且 doc 必须已经过 `canonicalAssets` / `canonicalFonts`
 * （本函数不重复校验，也不再做版本冲突判断——那是 `saveDesign` 的事）。
 *
 * 为什么单独抽出来：工程包导入（design-package.cjs）要在**同一把锁里**完成
 * 「发布资源 → 发布工程」，如果它调公共 `saveDesign` 会二次获取同一把锁（死锁/重入）。
 *
 * 顺序是刻意的：**先写版本文件，最后写索引**。中途崩溃只会留下一个索引里看不见的
 * 孤儿目录（由恢复程序或 purgeOrphanDirs 回收），绝不会出现「索引里有、文件却不存在」。
 */
function publishRevisionLocked(doc, { id, revision, createdAt, recordUse }) {
  const now = new Date().toISOString()
  const saved = { ...doc, id, revision, createdAt, updatedAt: now }
  const target = revisionPath(saved.id, saved.revision)
  // An uncommitted orphan from a terminated write may be replaced; committed files never are.
  atomicFile(target, JSON.stringify(saved, null, 2))
  // lastUsedAt = 「用户最近一次用它的时间」，供界面上的「常用」列表排序。
  // 用户主动保存本身就是一次使用 ⇒ 刷成 now；系统按预设自动建的工程不记（见 saveDesign 头注）。
  const summary = { id, revision, name: saved.name, artboard: saved.artboard, layerCount: saved.layers.length, createdAt, updatedAt: now, lastUsedAt: recordUse ? now : null }
  const updated = index().filter(d => d.id !== id).concat(summary)
  try { saveJson('designs', updated) } catch (err) {
    try { fs.unlinkSync(target) } catch { /* Orphan is unreachable until a successful retry. */ }
    throw err
  }
  return saved
}
function deleteDesign(id) {
  projectId(id)
  return withLock(() => {
    const all = index()
    if (!all.some(d => d.id === id)) throw new Error('底图工程不存在或已删除')
    const used = (loadJson('templates', { expect: 'array' }) || []).filter(t => t.backgroundDesign && t.backgroundDesign.id === id)
    if (used.length) throw new Error(`底图正在被模板使用：${used.map(t => t.name).join('、')}，请先移除引用`)
    saveJson('designs', all.filter(d => d.id !== id))
    // Keep source bytes and revision documents for unsaved drafts and undo history.
    // 这些目录不会自己消失 —— 由 purgeOrphanDirs()（「关于 → 清理缓存与残留」）统一回收。
    return { ok: true }
  })
}

/** 递归求目录字节数；个别文件读不到就跳过，不因为一个文件放弃整个统计 */
function dirBytes(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      try { total += entry.isDirectory() ? dirBytes(p) : fs.statSync(p).size } catch { /* 读不到就跳过 */ }
    }
  } catch { /* 目录不存在 / 无权限，视为 0 */ }
  return total
}

/**
 * 回收「已删除工程的残留目录」。
 *
 * 为什么会有残留：`deleteDesign` 只从索引移除，`designs/<id>/` 与里面的版本 JSON 会留在磁盘上。
 * 当初的理由是「未保存草稿与撤销历史」，但 2026-10-11 核查过：草稿活在 localStorage、撤销栈活在内存，
 * 两者都不读这些文件；`referencedAssetIds` 也只遍历索引。所以它们是纯残留，且**没有任何界面入口**能清，
 * 长期使用后 `designs/` 会堆满没人管的目录。由「关于 → 清理缓存与残留」统一回收。
 *
 * 安全口径（同 I-32）：
 *   - 只扫 `designs/` 下的目录；路径由目录名经 `resolveInsideDataDir` 推导，**不接受任何外部路径**；
 *   - 目录名不匹配 `design_<24hex>` 的一律跳过（不认识的目录绝不碰）；
 *   - 只删**不在当前索引**里的；索引里有的一律不动（那是活工程）；
 *   - 删每个目录前**重新读一次索引**复核，防「读索引 → 删目录」之间有人刚保存了新工程；
 *   - 删不掉的（被占用 / 权限）如实报进 `skipped`，不静默吞。
 *
 * @returns {{removed: string[], freed: number, skipped: string[]}}
 */
function purgeOrphanDirs() {
  const root = resolveInsideDataDir('designs')
  if (!fs.existsSync(root)) return { removed: [], freed: 0, skipped: [] }
  const removed = []
  const skipped = []
  let freed = 0
  for (const name of fs.readdirSync(root)) {
    if (!DESIGN_ID.test(name)) continue
    const abs = resolveInsideDataDir(`designs/${name}`)
    let stat
    try { stat = fs.statSync(abs) } catch { continue }
    if (!stat.isDirectory()) continue
    // 逐个复核：只要索引里还有这个 id（哪怕刚保存进来的），就绝不删
    if (index().some((d) => d.id === name)) continue
    const size = dirBytes(abs)
    try {
      fs.rmSync(abs, { recursive: true, force: true })
      removed.push(name)
      freed += size
    } catch {
      skipped.push(name)
    }
  }
  return { removed, freed, skipped }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let n = i
  for (let b = 0; b < 8; b++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function validatePng(buf, size) {
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG 文件签名损坏')
  let offset = 8
  const compressed = []
  let header = null
  let ended = false
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    if (offset + length + 12 > buf.length) throw new Error('PNG 文件内容不完整')
    const type = buf.toString('ascii', offset + 4, offset + 8)
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== buf.readUInt32BE(offset + 8 + length)) throw new Error('PNG 文件校验失败')
    const chunk = buf.subarray(offset + 8, offset + 8 + length)
    if (offset === 8 && type !== 'IHDR') throw new Error('PNG 缺少图像头')
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('PNG 图像头无效')
      header = chunk
    }
    if (type === 'IDAT') compressed.push(chunk)
    offset += length + 12
    if (type === 'IEND') { ended = length === 0 && offset === buf.length; break }
  }
  if (!header || !ended || !compressed.length) throw new Error('PNG 文件内容不完整')
  const depth = header[8]
  const type = header[9]
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[type]
  if (!channels || !depths.includes(depth) || header[10] || header[11] || header[12] > 1) throw new Error('PNG 图像编码无效')
  const passes = header[12] === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
  const rows = []
  let expected = 0
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((size.width - x) / dx))
    const h = Math.max(0, Math.ceil((size.height - y) / dy))
    if (!w || !h) continue
    const row = Math.ceil(w * channels * depth / 8) + 1
    rows.push([row, h]); expected += row * h
  }
  if (expected > 256 * 1024 * 1024) throw new Error('PNG 解码内存超过 256 MB，请减少图片像素')
  let decoded
  try { decoded = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }) } catch { throw new Error('PNG 图片像素数据损坏') }
  if (decoded.length !== expected) throw new Error('PNG 图片像素数据长度不符')
  let pos = 0
  for (const [row, count] of rows) for (let i = 0; i < count; i++) {
    if (decoded[pos] > 4) throw new Error('PNG 像素过滤器无效')
    pos += row
  }
}
function validateImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_BYTES) throw new Error('图片内容为空或超过 64 MB')
  const ext = sniffImageExt(buf)
  let size
  try { size = imageSizeFromBuffer(buf) } catch { throw new Error('图片内容不完整') }
  if (!ext || !size || !size.width || !size.height || size.width > 24000 || size.height > 24000 || size.width * size.height > MAX_PIXELS) throw new Error('仅支持有效的 PNG/JPEG 图片，单边不超过 24000 像素且总像素不超过 8000 万')
  if (ext === '.png') validatePng(buf, size)
  else if (buf.lastIndexOf(Buffer.from([255, 217])) < 4 || buf.indexOf(Buffer.from([255, 218])) < 4) throw new Error('JPEG 图片内容不完整')
  const orientation = ext === '.jpg' ? jpegOrientation(buf) : 1
  // width/height 归正为**显示坐标**（EXIF O≥5 时换轴）；orientation 一并带出去，
  // 因为「出片按目标 DPI 降采样」需要在存储坐标里算尺寸（见 output-dpi.storageSize）。
  return { ...(orientation >= 5 ? { width: size.height, height: size.width } : size), ext, mime: ext === '.png' ? 'image/png' : 'image/jpeg', orientation }
}
function jpegOrientation(buf) {
  let offset = 2
  while (offset + 4 <= buf.length && buf[offset] === 255) {
    const marker = buf[offset + 1]
    if (marker === 218 || marker === 217) break
    const length = buf.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buf.length) break
    const start = offset + 4
    if (marker === 225 && length >= 16 && buf.toString('ascii', start, start + 6) === 'Exif\0\0') {
      const tiff = start + 6
      const end = offset + 2 + length
      const little = buf.toString('ascii', tiff, tiff + 2) === 'II'
      if (!little && buf.toString('ascii', tiff, tiff + 2) !== 'MM') return 1
      const u16 = pos => little ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos)
      const u32 = pos => little ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos)
      if (tiff + 8 > end || u16(tiff + 2) !== 42) return 1
      const directory = tiff + u32(tiff + 4)
      if (directory < tiff + 8 || directory + 2 > end) return 1
      const count = u16(directory)
      for (let i = 0; i < count; i++) {
        const entry = directory + 2 + i * 12
        if (entry + 12 > end) break
        if (u16(entry) === 274 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
          const value = u16(entry + 8)
          return value >= 1 && value <= 8 ? value : 1
        }
      }
    }
    offset += length + 2
  }
  return 1
}
function importBuffer(buf, name, source) {
  const size = validateImage(buf)
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  VERIFIED_IMAGES.set(hash, size)
  const id = `asset_${hash}`
  // 同内容已在任一池子 → 直接返回既有记录：内容寻址去重（I-31 原则①）。
  // 绝不因为这次传了别的 source 就再存一份字节——升级 / 降级只改边车标记（见 setAssetSource）。
  if (locateAsset(hash)) return readAsset(id).asset
  const pool = poolOfSource(source)
  const relative = `${pool}/${hash}${size.ext}`
  const asset = { id, path: relative, width: size.width, height: size.height, mime: size.mime, name: path.basename(String(name || '图片')).replace(/[\x00-\x1f]/g, '').slice(0, 200) || '图片', source: normalizeSource(source) }
  const target = assetStorage.resolveAssetPath(relative)
  const metadata = assetStorage.resolveAssetPath(`${pool}/${hash}.json`)
  const root = assetStorage.poolDir(pool)
  atomicFile(target, buf, root)
  atomicFile(metadata, JSON.stringify(asset, null, 2), root)
  return asset
}
function importImageBytes({ name, base64, source } = {}) {
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('图片 base64 内容无效或超过 64 MB')
  return importBuffer(Buffer.from(base64, 'base64'), name, source)
}
function importImageFile(filePath, source) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('图片文件无效或超过 64 MB')
  return importBuffer(fs.readFileSync(filePath), path.basename(filePath), source)
}
/**
 * 翻转原件元数据里的 `source`（供「加入素材库」时把临时件升为受管理）。
 * 单向升级：只允许 ephemeral → managed，绝不允许回退成 ephemeral。
 *
 * 升级**连字节一起搬**（I-51）：临时底图原件从 `ephemeral-assets/` 迁进素材库池
 * `design-assets/`（图片 + `.json` 边车，边车 `path` 同步改写）——两个池子物理分开，
 * 只改标记会让「打开素材库文件夹」看得见临时件、备份 / 清理也没法只针对素材库。
 *
 * 搬迁顺序：复制图片 → 写新边车 → 删旧边车 → 删旧图片。中途被杀最多留一份重复
 * （`locateAsset` 取 managed 那份，另一份沦为孤儿由清理入口收），绝不会把图搬丢；
 * 且任何中间态两个池子至少有一份完整可读。
 */
function setAssetSource(id, source) {
  const aid = assetIdOfExport(id)
  const match = ASSET_ID.exec(aid)
  const hash = match[1]
  const pool = locateAsset(hash)
  if (!pool) throw new Error('找不到底图素材，可能已被删除或尚未同步。')
  const metaPath = assetStorage.resolveAssetPath(`${pool}/${hash}.json`)
  const asset = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const next = normalizeSource(source)
  if (normalizeSource(asset.source) === 'managed' && next !== 'managed') throw new Error('受管理原件不能降级为临时件')
  const targetPool = poolOfSource(next)
  if (targetPool !== pool) {
    const ext = path.extname(String(asset.path || ''))
    const oldImage = guardedAssetFile(asset.path)
    const nextRelative = `${targetPool}/${hash}${ext}`
    const targetRoot = assetStorage.poolDir(targetPool)
    fs.mkdirSync(targetRoot, { recursive: true })
    if (targetPool === POOL_EPHEMERAL || path.resolve(targetRoot) === path.resolve(assetStorage.legacyManagedDir())) assertRealDataPath(targetRoot)
    fs.copyFileSync(oldImage, assetStorage.resolveAssetPath(nextRelative))
    asset.path = nextRelative
    asset.source = next
    atomicFile(assetStorage.resolveAssetPath(`${targetPool}/${hash}.json`), JSON.stringify(asset, null, 2), assetStorage.poolDir(targetPool))
    try { fs.unlinkSync(metaPath) } catch { /* 旧边车删不掉只是残留：locateAsset 仍读到新池那份 */ }
    try { fs.unlinkSync(oldImage) } catch { /* 旧图沦为孤儿，由 asset:listOrphans / purge 收 */ }
    return asset
  }
  asset.source = next
  atomicFile(metaPath, JSON.stringify(asset, null, 2), assetStorage.poolDir(pool))
  return asset
}

/**
 * 存量迁移：把 `design-assets/` 里 `source: 'ephemeral'` 的临时底图原件
 * （图片 + `.json` 边车）迁到 `ephemeral-assets/`，边车 `path` 同步改写。
 * 幂等（目标已存在即覆盖同内容）；单件失败跳过，不阻断其余与启动。
 *
 * 为什么必须做：分池只影响「新导入落哪」。不迁移的话旧临时件仍混在素材库池里，
 * 「打开素材库文件夹」依旧看得见临时底图——分池就白做了。
 *
 * 工程文档里的旧路径**不用动**：`readAsset` 的 claimedPath 容忍「同 hash、另一池」的
 * 历史声明，打开 / 保存时 `canonicalAssets` 会改写成真身（I-51）。
 *
 * @returns {{ migrated: number }}
 */
function migrateEphemeralOriginals() {
  const targetDir = assetStorage.poolDir(POOL_EPHEMERAL)
  let migrated = 0
  const roots = [...new Set([assetStorage.poolDir(POOL_MANAGED), assetStorage.legacyManagedDir()])]
  for (const legacy of roots) {
    let names
    try {
      if (path.resolve(legacy) === path.resolve(assetStorage.legacyManagedDir())) assertRealDataPath(legacy)
      names = fs.readdirSync(legacy)
    } catch { continue }
    for (const name of names) {
      const m = /^([a-f0-9]{64})\.json$/.exec(name)
      if (!m) continue
      const hash = m[1]
      let meta
      try { meta = JSON.parse(fs.readFileSync(path.join(legacy, name), 'utf8')) } catch { continue }
      if (!meta || normalizeSource(meta.source) !== 'ephemeral') continue
      // 扩展名只信边车自己的记录：内容寻址下 ext 由 mime 决定，跟文件名无关
      const ext = meta.mime === 'image/png' ? '.png' : (meta.mime === 'image/jpeg' ? '.jpg' : path.extname(String(meta.path || '')))
      if (!ext) continue
      try {
        fs.mkdirSync(targetDir, { recursive: true })
        assertRealDataPath(targetDir)
        const oldImage = path.join(legacy, `${hash}${ext}`)
        if (!fs.existsSync(oldImage)) continue
        fs.copyFileSync(oldImage, path.join(targetDir, `${hash}${ext}`))
        meta.path = `${POOL_EPHEMERAL}/${hash}${ext}`
        atomicFile(path.join(targetDir, `${hash}.json`), JSON.stringify(meta, null, 2))
        try { fs.unlinkSync(path.join(legacy, `${hash}.json`)) } catch { /* 同上：残留由清理入口收 */ }
        try { fs.unlinkSync(oldImage) } catch { /* 同上 */ }
        migrated++
      } catch { /* 单件搬不动就留在旧池：读得到、只是没分开，下次启动重试 */ }
    }
  }
  return { migrated }
}

/** Move older managed originals into a configured repository before any readers start. */
function migrateManagedOriginals() {
  const legacy = assetStorage.legacyManagedDir()
  const target = assetStorage.poolDir(POOL_MANAGED)
  if (path.resolve(legacy) === path.resolve(target)) return { migrated: 0 }
  let names
  try { assertRealDataPath(legacy); names = fs.readdirSync(legacy) } catch { return { migrated: 0 } }
  let migrated = 0
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.json$/.exec(name)
    if (!match) continue
    const hash = match[1]
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(legacy, name), 'utf8'))
      if (meta.id !== `asset_${hash}` || normalizeSource(meta.source) !== 'managed') continue
      const ext = meta.mime === 'image/png' ? 'png' : meta.mime === 'image/jpeg' ? 'jpg' : null
      if (!ext || meta.path !== `${POOL_MANAGED}/${hash}.${ext}`) continue
      const oldImage = path.join(legacy, `${hash}.${ext}`)
      const oldBytes = fs.readFileSync(oldImage)
      if (crypto.createHash('sha256').update(oldBytes).digest('hex') !== hash) continue
      const newMeta = assetStorage.resolveAssetPath(`${POOL_MANAGED}/${hash}.json`)
      const newImage = assetStorage.resolveAssetPath(`${POOL_MANAGED}/${hash}.${ext}`)
      atomicFile(newImage, oldBytes, target)
      atomicFile(newMeta, JSON.stringify(meta, null, 2), target)
      fs.unlinkSync(path.join(legacy, name))
      fs.unlinkSync(oldImage)
      migrated++
    } catch { /* Keep the old pair intact for a later retry. */ }
  }
  return { migrated }
}
function importLegacyBackground({ background, w, h, name } = {}) {
  if (typeof background !== 'string' || !/^print-bg\/[^/\\]+\.(png|jpe?g)$/i.test(background)) throw new Error('旧底图路径无效')
  const board = normalizeDesign({ name: name || '导入底图', artboard: { w, h }, layers: [], assets: {} })
  const asset = importImageFile(guardedFile(background, 'print-bg'), 'managed')
  return normalizeDesign({ ...board, assets: { [asset.id]: asset }, layers: [{ id: `layer_${crypto.randomBytes(6).toString('hex')}`, type: 'image', name: '原有底图', assetId: asset.id, x: 0, y: 0, w: board.artboard.w, h: board.artboard.h, locked: true }] })
}
function fontUsedBy(family) {
  const names = new Set()
  for (const head of index()) {
    for (let revision = 1; revision <= head.revision; revision++) {
      const doc = normalizeDesign(readRevision(head.id, revision))
      if (collectFontFamilies(doc).includes(family)) names.add(`${head.name}（底图版本 ${revision}）`)
    }
  }
  return [...names]
}

module.exports = { listDesigns, getDesign, resolveDesign, resolveDraft, saveDesign, deleteDesign, purgeOrphanDirs, touchDesign, importImageBytes, importImageFile, importImageBuffer: importBuffer, importLegacyBackground, fontUsedBy, assetInfo, assetGeometry, assetSource, assetBytes, setAssetSource, jpegOrientation, withDesignLock: withLock, publishRevisionLocked, migrateEphemeralOriginals, migrateManagedOriginals,
  POOL_MANAGED, POOL_EPHEMERAL, ASSET_POOLS, originalExists }

/**
 * agent 接口层（api.cjs + bin/pp.cjs）的验收测试。
 *
 * 这一批把守的是**架构不变量**，不是功能点——功能已经被前面 16 个套件覆盖了，
 * 本套件要防的是「重构时悄悄破坏分层」：
 *
 *   1. api.cjs 必须能在纯 Node 下加载（零 electron 依赖）——这是 agent 接口的地基，
 *      一旦有人在里面 require('./printer.cjs')，整个 CLI 立刻崩，而 GUI 毫无察觉。
 *   2. 39 个既有通道名一个不能少——ipc.cjs 从「手写 39 个 handler」变成
 *      「遍历注册表」，漏挂一个通道在 GUI 上就是「某个按钮点了没反应」，
 *      不会报错，只会静默失效。
 *   3. 写权限闸门必须在共享路径上——如果哪天有人把 allowWrite 检查写进
 *      CLI 而不是 api.call，GUI 通道就绕过了它。
 *   4. GUI 边界必须干净——需要弹窗/打印的操作在无 GUI 下要给出
 *      GUI_REQUIRED，而不是 TypeError。
 *
 * 运行：node test/api-cli.cjs
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { rmDeep } = require('./helpers/rm.cjs')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(__dirname, '.tmp-data-apicli')

// 必须在 require api.cjs 之前：store.cjs / print.cjs 在模块加载时读这个变量
rmDeep(TMP)
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/**
 * 去掉注释再断言。
 *
 * 必须这么做：api.cjs 的文档里明写了「本文件不得 require('electron')」，
 * 直接正则匹配源码会把这句注释本身判成违规——一个必然自相矛盾的测试。
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const api = require(path.join(ROOT, 'electron', 'api.cjs'))

/** 抽取前 ipc.cjs 里的全部通道名（39 个）。这份清单是契约，只能增不能减。 */
const LEGACY_CHANNELS = [
  'app:ping', 'app:env', 'app:cacheInfo', 'app:clearCache', 'app:changeDataDir',
  'app:resetDataDir', 'app:openDataDir', 'app:relaunch',
  'store:load', 'store:save',
  'dataset:importDialog', 'dataset:inspect', 'dataset:importSheets', 'dataset:list',
  'dataset:get', 'dataset:delete', 'dataset:renameColumn', 'dataset:updateCell',
  'dataset:addRow', 'dataset:deleteRow', 'dataset:setColumnPrint',
  'catalog:fields',
  'template:list', 'template:get', 'template:save', 'template:matchDataset',
  'template:rebindDataset', 'template:delete', 'template:uploadBackgroundDialog',
  'font:list', 'font:uploadDialog', 'font:delete',
  'print:validate', 'print:generate', 'print:exportPdf', 'print:send',
  'job:list', 'job:openSnapshot', 'job:delete',
]

/**
 * 抽取时新增的通道：
 * - 路径版（dataset:importFile / template:uploadBackground / font:upload）：
 *   替 agent 去掉「弹窗选文件」这一步
 * - dataset:deleteBatch：导入会话整批删除
 * - template:uploadBackgroundBytes：拖拽 / 剪贴板粘贴上传底图（图片只有字节、没有路径）
 * - template:discardBackground：换图 / 移除底图时当场删掉旧图文件
 */
const ADDED_CHANNELS = [
  'dataset:importFile',
  'dataset:deleteBatch',
  'template:uploadBackground',
  'template:uploadBackgroundBytes',
  'template:discardBackground',
  'font:upload',
  'design:list',
  'design:get',
  'design:save',
  'design:delete',
  'design:importDialog',
  'design:importBytes',
  'design:importBackground',
  'design:exportPng',
]

const CTX = { allowWrite: true, app: { version: 'test' }, dialog: null, printer: null }

async function run() {

  console.log('== 1. api.cjs 必须能在纯 Node 下加载（分层地基） ==')
  {
    ok(process.versions.electron === undefined, '测试进程确实是纯 Node（不是 Electron）')

    const s = stripComments(src('electron/api.cjs'))
    ok(!/require\(['"]electron['"]\)/.test(s), 'api.cjs 不 require electron')
    ok(!/require\(['"]\.\/printer\.cjs['"]\)/.test(s),
      'api.cjs 不 require printer.cjs（后者 require electron，会污染整条依赖链）')
    ok(!/BrowserWindow|ipcMain|dialog\.show/.test(s), 'api.cjs 里没有 Electron API 的直接调用')

    // 加载成功本身就是最强的证据：真依赖 electron 的话上面那句 require 已经抛了
    ok(api.describe().length > 0, `api.cjs 在纯 Node 下加载成功（${api.describe().length} 个操作）`)
    ok(typeof api.call === 'function' && typeof api.invoke === 'function', 'call / invoke 双入口齐备')
  }

  console.log('== 2. 通道契约：39 个既有通道一个不能少 ==')
  {
    const names = api.describe().map((o) => o.name)
    const missing = LEGACY_CHANNELS.filter((n) => !names.includes(n))
    ok(missing.length === 0, '既有通道全部保留', missing)

    // 文档里写死的「N 个操作」极易漂移（这次就发现 README 一直写着 42，实际 44），
    // 用断言钉住：以后加操作忘了改文档，这里会红。
    const readme = src('README.md')
    const counts = [...readme.matchAll(/(\d+)\s*个操作/g)].map((m) => Number(m[1]))
    ok(counts.length > 0 && counts.every((n) => n === names.length),
      `README 里的操作计数全部等于实际值 ${names.length}`, [...new Set(counts)])

    // 版本号同理：README 头部的「当前版本」老是忘了跟着 package.json 走
    // （v0.2.6、v0.2.7 两次发版都只补了版本史，头部一直停在 v0.2.5）。
    const pkgVersion = require(path.join(ROOT, 'package.json')).version
    const readmeVer = readme.match(/\|\s*当前版本\s*\|\s*v?([\d.]+)\s*\|/)
    ok(Boolean(readmeVer) && readmeVer[1] === pkgVersion,
      `README 头部「当前版本」与 package.json 一致（${pkgVersion}）`,
      readmeVer ? readmeVer[1] : '(没找到那一行)')
    ok(readme.includes(`v${pkgVersion}（`),
      `版本史里有 v${pkgVersion} 的条目（发版时别忘了写）`)

    // 同一类漂移：README 写的「N 套件」也老是忘了跟着 package.json 的 test 脚本走
    // （2026-10 查出它一直写着「19 套件」，实际已经 21）。
    // 断言条数没法在这里算（要跑完全部套件），所以只钉套件数——那个是能精确对上的。
    const testScript = require(path.join(ROOT, 'package.json')).scripts.test
    const suiteCount = testScript.split('&&').filter((s) => /node\s+test\//.test(s)).length
    const suiteCounts = [...readme.matchAll(/(\d+)\s*套件/g)].map((m) => Number(m[1]))
    ok(suiteCounts.length > 0 && suiteCounts.every((n) => n === suiteCount),
      `README 里的套件计数全部等于 npm test 实际挂载的 ${suiteCount} 个`, [...new Set(suiteCounts)])

    const added = names.filter((n) => !LEGACY_CHANNELS.includes(n))
    ok(added.length === ADDED_CHANNELS.length && ADDED_CHANNELS.every((n) => added.includes(n)),
      `新增通道恰好是预期的 ${ADDED_CHANNELS.length} 个（路径、批次、素材与图层工程）`, added)

    // ipc.cjs 必须从注册表派生，不能回退成手写
    const ipcSrc = stripComments(src('electron/ipc.cjs'))
    ok(/api\.ipcTable\(\)/.test(ipcSrc), 'ipc.cjs 从注册表派生通道（不是逐个手写）')
    ok(!/ipcMain\.handle\(['"]/.test(ipcSrc), 'ipc.cjs 里没有硬编码通道名')
    ok(!/require\(['"]\.\/(dataset|templates|print|fonts|store)\.cjs['"]\)/.test(ipcSrc),
      'ipc.cjs 不再直接依赖领域模块（业务逻辑已全部搬走）')
    ok(/allowWrite:\s*true/.test(ipcSrc), 'GUI 通道显式给足写权限（与抽取前行为一致）')
    ok(/dialog:\s*\{/.test(ipcSrc) && /printer,/.test(ipcSrc), 'GUI 能力经 ctx 注入')
  }

  console.log('== 3. 写权限闸门在共享路径上（不是 CLI 自己加的） ==')
  {
    const writeOps = api.describe().filter((o) => o.write)
    ok(writeOps.length > 0, `注册表标出了写操作（${writeOps.length} 个）`)

    // 遍历全部写操作：缺省上下文（allowWrite 缺省 false）必须一律被拦。
    // 用空参数调用即可——权限检查发生在参数解析之前，所以拦的是权限而不是参数。
    const leaked = []
    for (const op of writeOps) {
      try {
        api.call(op.name, {}, { app: {}, dialog: {}, printer: {} })
        leaked.push(`${op.name}:未抛错`)
      } catch (err) {
        if (err.code !== 'WRITE_FORBIDDEN') leaked.push(`${op.name}:${err.code}`)
      }
    }
    ok(leaked.length === 0, '全部写操作在无授权时被拦（且原因是 WRITE_FORBIDDEN）', leaked)

    // 只读操作不能被误拦：app:ping 是纯读，无授权也必须能跑
    ok(api.call('app:ping', {}, { app: { version: 'x' } }).pong === true,
      '只读操作不受写闸门影响')
  }

  console.log('== 4. GUI 边界：无 GUI 上下文要给 GUI_REQUIRED，不能是 TypeError ==')
  {
    const guiOps = api.describe().filter((o) => o.gui !== 'none')
    ok(guiOps.length > 0, `注册表标出了需 GUI 的操作（${guiOps.length} 个）`)

    const wrong = []
    for (const op of guiOps) {
      try {
        // allowWrite: true 是为了越过写闸门，真正测到能力检查
        api.call(op.name, {}, { allowWrite: true, app: {}, dialog: null, printer: null })
        wrong.push(`${op.name}:未抛错`)
      } catch (err) {
        if (err.code !== 'GUI_REQUIRED') wrong.push(`${op.name}:${err.code}`)
      }
    }
    ok(wrong.length === 0, '需 GUI 的操作在纯 Node 下统一给 GUI_REQUIRED', wrong)

    // 两个出口的文案要指向出路，而不是只说「不行」
    const r = await api.invoke('print:exportPdf', { datasetId: 'd', templateId: 't' },
      { allowWrite: true, app: {}, dialog: null, printer: null })
    ok(r.ok === false && r.error.code === 'GUI_REQUIRED', 'invoke 返回结构化错误（不抛）', r)
  }

  console.log('== 5. invoke 的必填参数体检（call 不做，避免改变 GUI 语义） ==')
  {
    const r = await api.invoke('dataset:get', {}, { allowWrite: true })
    ok(r.ok === false && r.error.code === 'BAD_PARAMS', '缺必填参数 → BAD_PARAMS', r)
    ok(/id/.test(r.error.message), '报错点名了缺哪个参数', r.error.message)

    const r2 = await api.invoke('no:such:op', {}, {})
    ok(r2.ok === false && r2.error.code === 'UNKNOWN_OP', '未知操作 → UNKNOWN_OP')

    const r3 = await api.invoke('app:ping', {}, { app: { version: '9.9.9' } })
    ok(r3.ok === true && r3.data.version === '9.9.9', 'invoke 成功时返回 {ok:true,data}')

    // call 保持原语义：缺参数是下游抛错，不是 BAD_PARAMS
    let code = ''
    try { api.call('dataset:get', {}, CTX) } catch (err) { code = err.code || 'NO_CODE' }
    ok(code === 'NO_CODE', 'call 不拦截参数（GUI 通道语义逐字保留）', code)
  }

  console.log('== 6. 纯 Node 闭环：导入 → 激活列 → 模板 → 校验 → 生成 ==')
  {
    const csv = path.join(TMP, '闭环名单.csv')
    fs.writeFileSync(csv, '\ufeff姓名,单位\n张三,甲校\n李四,乙校\n', 'utf-8')

    // 用 dataset:importFile 而不是 dataset:inspect——前者能指定名字，
    // 这正是新增它的原因（inspectFile 内部不给 nameOverride，名字被固定成文件名）
    const ds = api.call('dataset:importFile', { filePath: csv, name: '闭环名单' }, CTX)
    ok(ds.name === '闭环名单', 'importFile 尊重 name（这是 inspect 做不到的）', ds.name)
    ok(ds.rowCount === 2, '读到 2 行')

    const fields = api.call('catalog:fields', { id: ds.id }, CTX)
    ok(fields.every((f) => f.printOn === false), '新导入的列默认全部未激活打印')

    for (const f of fields) {
      api.call('dataset:setColumnPrint', { datasetId: ds.id, key: f.key, printOn: true }, CTX)
    }
    ok(api.call('catalog:fields', { id: ds.id }, CTX).every((f) => f.printOn),
      '激活后列全部可打印')

    const tpl = api.call('template:save', {
      template: {
        name: '闭环版式',
        datasetId: ds.id,
        pageSize: { w: 210, h: 297 },
        fields: [{ column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 12, align: 'center' }],
      },
    }, CTX)
    ok(Boolean(tpl.id), '模板已保存')

    const v = api.call('print:validate', { datasetId: ds.id, templateId: tpl.id }, CTX)
    ok(v.issues.length === 0, '全量校验无问题', v.issues)
    ok(v.scope.partial === false, '缺省范围是全量（partial=false）')

    const built = api.call('print:generate', { datasetId: ds.id, templateId: tpl.id }, CTX)
    ok(built.html.includes('张三'), '生成的 HTML 含数据')
    ok(built.scope.partial === false, '全量出片范围正确')

    // 留痕不变量：generate 是预览语义，不落盘不留痕
    ok(api.call('job:list', {}, CTX).length === 0,
      'print:generate 不产生留痕（预览不留痕，只有两个出口留痕）')

    // 部分出片：留痕必全，但状态只认全量
    const partial = api.call('print:validate', { datasetId: ds.id, templateId: tpl.id, rows: [0] }, CTX)
    ok(partial.scope.partial === true && partial.scope.selected === 1, '行级范围被正确识别为部分出片')
  }

  console.log('== 7. CLI 子进程端到端 ==')
  {
    const PP = path.join(ROOT, 'bin', 'pp.cjs')
    function pp(args) {
      const r = spawnSync(process.execPath, [PP, '--data-dir', TMP, ...args], { encoding: 'utf-8' })
      let json = null
      try { json = JSON.parse(r.stdout) } catch { /* 帮助文本不是 JSON */ }
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
    }

    const help = spawnSync(process.execPath, [PP, '--help'], { encoding: 'utf-8' })
    ok(help.status === 0, '--help 退出码 0')
    ok(/用法/.test(help.stdout) && /--allow-write/.test(help.stdout), '帮助文本含用法与写权限说明')

    // 回归：布尔开关后面跟位置参数，不能把位置参数吃掉
    const afterFlag = pp(['--allow-write', 'dataset', 'list'])
    ok(afterFlag.code === 0 && afterFlag.json && afterFlag.json.ok === true,
      '--allow-write 后跟位置参数能正确解析（布尔开关不吞值）', afterFlag.stdout)

    const afterCmd = pp(['dataset', 'list'])
    ok(afterCmd.code === 0 && Array.isArray(afterCmd.json.data), '选项放在命令之后也能解析')

    const denied = pp(['dataset', 'delete', 'ds_nonexistent'])
    ok(denied.code === 3, '写操作无授权 → 退出码 3', denied.code)
    ok(denied.json.error.code === 'WRITE_FORBIDDEN', '错误码是 WRITE_FORBIDDEN')

    const gui = pp(['--allow-write', 'export', '--dataset', 'd', '--template', 't',
      '--out', path.join(TMP, 'x.pdf')])
    ok(gui.code === 2, 'GUI 出口 → 退出码 2', gui.code)
    ok(gui.json.error.code === 'GUI_REQUIRED', '错误码是 GUI_REQUIRED')

    const unknown = pp(['nope'])
    ok(unknown.code === 1 && unknown.json.error.code === 'UNKNOWN_COMMAND', '未知命令 → 退出码 1')

    const badRows = pp(['validate', '--dataset', 'd', '--template', 't', '--rows', 'a,b'])
    ok(badRows.code === 1 && badRows.json.error.code === 'BAD_PARAMS', '--rows 非法值被拦')

    // 端到端：CLI 导一份新名单（走的是与应用完全相同的领域层）
    const csv2 = path.join(TMP, 'cli名单.csv')
    fs.writeFileSync(csv2, '\ufeff姓名,单位\n王五,丙校\n', 'utf-8')
    const imported = pp(['--allow-write', 'dataset', 'import', csv2, '--name', 'CLI 名单'])
    ok(imported.code === 0 && imported.json.data.name === 'CLI 名单',
      'CLI 导入成功且名字可控', imported.stdout)

    const listed = pp(['dataset', 'list'])
    ok(listed.json.data.some((d) => d.name === 'CLI 名单'), 'CLI 导入的数据集在列表里')

    const notFound = pp(['dataset', 'import', path.join(TMP, '不存在.csv')])
    ok(notFound.code === 1 && /文件不存在/.test(notFound.json.error.message), '导入不存在的文件给出明确报错')

    const fields = pp(['dataset', 'fields', imported.json.data.id])
    ok(fields.code === 0 && Array.isArray(fields.json.data), 'CLI 能查字段目录')

    const callEscape = pp(['call', 'app:ping'])
    ok(callEscape.code === 0 && callEscape.json.data.pong === true, 'call 兜底入口可用')

    // CLI 默认数据目录必须与已安装应用一致（agent 要操作的就是它那份）。
    // 必须清掉继承来的 PRINTPRESS_DATA_DIR，否则测的是环境变量优先级而不是默认解析。
    const cleanEnv = { ...process.env }
    delete cleanEnv.PRINTPRESS_DATA_DIR
    const envr = spawnSync(process.execPath, [PP, 'env'], { encoding: 'utf-8', env: cleanEnv })
    const envJson = JSON.parse(envr.stdout)
    ok(!envJson.data.dataDir.startsWith(ROOT),
      'CLI 默认数据目录不是仓库目录（对齐已安装应用，而非开发态）', envJson.data.dataDir)
    ok(/printpress|批印坊/.test(envJson.data.dataDir),
      '默认目录落在已安装应用的 userData 下', envJson.data.dataDir)
    ok(envJson.data.dataDir.replace(/\\/g, '/').endsWith('/data'),
      '默认目录是 userData/data', envJson.data.dataDir)
  }

  console.log('== 8. 零第三方依赖 ==')
  {
    const s = src('bin/pp.cjs')
    const reqs = [...s.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    const external = reqs.filter((r) =>
      !r.startsWith('.') && !r.startsWith('/') && !require('module').builtinModules.includes(r))
    ok(external.length === 0, 'CLI 入口自身只 require Node 内置模块（领域层的 xlsx 属既有依赖，不算新增）', external)
  }

  console.log('== 9. 数据目录口径必须一致（打包名 / CLI 默认 / 界面文案） ==')
  {
    // Electron 的 userData 目录名 = 打包后 package.json 的 name
    // （electron-builder 不会把 build.productName 写进 app 的 package.json，
    //   已核对 release/win-unpacked/resources/app.asar 内确无 productName 字段）
    const pkg = require(path.join(ROOT, 'package.json'))

    const cleanEnv = { ...process.env }
    delete cleanEnv.PRINTPRESS_DATA_DIR
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pp.cjs'), 'env'],
      { encoding: 'utf-8', env: cleanEnv })
    const dataDir = JSON.parse(r.stdout).data.dataDir
    ok(dataDir.includes(path.sep + pkg.name + path.sep),
      `CLI 默认目录用的是 package.json 的 name（${pkg.name}）`, dataDir)

    // 界面文案里写的路径必须与实际一致，否则用户照提示去找备份会找不到
    const guide = src('src/components/GuideDialog.vue')
    const expected = String.raw`%APPDATA%\\` + pkg.name + String.raw`\\data`
    ok(guide.includes(expected), '引导弹窗写的路径与打包名一致', expected)
    ok(!guide.includes(String.raw`批印坊\\data`), '引导弹窗不再写错目录名')

    // 文档同理（README 是用户最先看到的地方）
    const readme = src('README.md')
    ok(readme.includes(`%APPDATA%\\${pkg.name}\\data`) || readme.includes(`%APPDATA%/${pkg.name}/data`),
      'README 里的默认目录路径正确')
    ok(!readme.includes('批印坊\\data'), 'README 不再写错目录名')
  }
}

run().then(() => {
  rmDeep(TMP)
  console.log(`\nagent 接口层：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}).catch((err) => {
  console.error('测试本身崩溃:', err)
  rmDeep(TMP)
  process.exit(1)
})

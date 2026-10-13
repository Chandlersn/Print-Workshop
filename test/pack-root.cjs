/**
 * 打包前根目录自查（`npm run pack:check`）验收。
 *
 * 这套守的是「打包炸在一句看不懂的报错上」：
 *  - 根目录里有一个「列得出来、stat 解析不了」的条目 ⇒ electron-builder 在 computeFileSets
 *    里抛 `ENOENT: ... lstat '<乱码>'` 就断了（2026-10-13 实际卡过一次）；
 *  - 自查脚本自己写错判据 ⇒ 要么漏报（打包照样炸），要么误报（把正常目录报成垃圾）；
 *  - 清理脚本**默认就动手删** ⇒ 手一抖删掉真目录（安全边界必须是「只 rmdir 空树 + 默认只看」）；
 *  - 自查没真挂在 `dist` 上 ⇒ 等于没写，CI 的 release.yml 也走 dist，一起漏。
 *
 * 纯函数 + 真实临时目录，不需要 Electron、不需要数据目录。
 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const checkRoot = require('../scripts/check-pack-root.cjs')
const purge = require('../scripts/purge-broken-root-entries.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

// 临时目录：本套件所有真实 fs 用例都在这里跑，跑完删掉
const tmpRoots = []
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pack-root-'))
  tmpRoots.push(dir)
  return dir
}

console.log('== 1. 判据：只挑「列得出来、stat 解析不了」的条目 ==')

// 假 io：listRaw 给名字，statPath 按名字决定成不成功
const fakeIo = (names, statImpl) => ({
  listRaw: () => names.map((name) => Buffer.from(name)),
  statPath: (abs, buf) => statImpl(buf.toString('utf8')),
})

check('stat 解析不了的条目被挑出来，并带上原始字节 hex（好照着删）', () => {
  const broken = '\ufffd\ufffd\ufffd\ufffd\ufffd\u01a4' // 打包报错里显示成 `���ﯮƤ` 的那种
  const io = fakeIo(['dist', 'electron', broken], (name) => {
    if (name === broken) { const err = new Error('ENOENT: no such file or directory'); err.code = 'ENOENT'; throw err }
    return { isDirectory: () => true }
  })
  const { entries, readError } = checkRoot.findUnreadableEntries('X:/fake', io)
  assert.equal(readError, null, 'readdir 成功时不该报 readError')
  assert.equal(entries.length, 1, `只该挑出 1 个坏条目，实得 ${entries.length}`)
  assert.equal(entries[0].display, broken, '要把名字原样带出来')
  assert.equal(entries[0].hex, Buffer.from(broken).toString('hex'), 'hex 必须是原始字节')
  assert.equal(entries[0].code, 'ENOENT', '要带 errno，方便判断是不是「名字根本不存在」')
})

check('只要 stat 不了就算数——EACCES 之类同样会让 electron-builder 断在同一个地方', () => {
  const io = fakeIo(['locked'], () => { const err = new Error('EACCES'); err.code = 'EACCES'; throw err })
  assert.equal(checkRoot.findUnreadableEntries('X:/fake', io).entries.length, 1, 'stat 抛非 ENOENT 也必须算坏条目')
})

check('全部 stat 正常时一个都不报（不能把正常目录当垃圾）', () => {
  const io = fakeIo(['dist', 'electron', 'docs'], () => ({ isDirectory: () => true }))
  assert.deepEqual(checkRoot.findUnreadableEntries('X:/fake', io).entries, [], '不该有任何条目')
})

check('根目录本身读不了时报 readError，而不是抛异常崩掉自查', () => {
  const io = {
    listRaw: () => { const err = new Error('EPERM'); err.code = 'EPERM'; throw err },
    statPath: () => ({ isDirectory: () => true }),
  }
  let result
  assert.doesNotThrow(() => { result = checkRoot.findUnreadableEntries('X:/nope', io) }, '自查脚本自己不许抛')
  assert.equal(result.readError.code, 'EPERM', '要把 readdir 的失败原因带出来')
  assert.deepEqual(result.entries, [])
})

console.log('\n== 2. 提示项：只报「空的非 ASCII 目录」，不误伤有内容的 ==')
check('非 ASCII 且有内容的目录不报；非 ASCII 且空的目录才报；ASCII 空目录不报', () => {
  const dir = makeTmp()
  fs.mkdirSync(path.join(dir, 'empty-ascii'))
  fs.mkdirSync(path.join(dir, '空目录'))
  fs.mkdirSync(path.join(dir, '有内容'))
  fs.writeFileSync(path.join(dir, '有内容', 'keep.txt'), 'x')
  const found = checkRoot.findEmptyForeignDirs(dir).map((item) => item.display)
  assert.deepEqual(found, ['空目录'], `只该报空的非 ASCII 目录，实得 ${JSON.stringify(found)}`)
})

check('嵌套的空目录也算空（里面套几层空目录同样是垃圾）', () => {
  const dir = makeTmp()
  fs.mkdirSync(path.join(dir, '套娃', 'Microsoft', 'Spelling', 'neutral'), { recursive: true })
  assert.deepEqual(checkRoot.findEmptyForeignDirs(dir).map((i) => i.display), ['套娃'],
    '整棵树没有文件就该判为空')
})

check('嵌了一层有文件就不算空（宁可不报，也不能报成垃圾）', () => {
  const dir = makeTmp()
  fs.mkdirSync(path.join(dir, '套娃', 'Spelling'), { recursive: true })
  fs.writeFileSync(path.join(dir, '套娃', 'Spelling', 'dict.bin'), 'x')
  assert.deepEqual(checkRoot.findEmptyForeignDirs(dir), [], '有文件就不能进清单')
})

console.log('\n== 3. 集成：真实工程根目录必须是干净的 ==')
check('入口、图标与四张内置底图缺失时准确报出，恢复后自查通过', () => {
  const dir = makeTmp()
  const missing = checkRoot.findMissingRequiredFiles(dir)
  assert.equal(missing.length, 6)
  assert.ok(missing.includes('bin/pp.cjs') && missing.includes('build/icon.png'))
  for (const name of missing) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(ROOT, name), target)
  }
  assert.deepEqual(checkRoot.findMissingRequiredFiles(dir), [])
  fs.unlinkSync(path.join(dir, 'build/icon.png'))
  assert.deepEqual(checkRoot.findMissingRequiredFiles(dir), ['build/icon.png'])
  assert.deepEqual(checkRoot.findMissingRequiredFiles(ROOT), [], '实际工程恢复后六个文件都在')
})
check('工程根目录里没有任何「列得出来、stat 解析不了」的条目', () => {
  const { entries, readError } = checkRoot.findUnreadableEntries(ROOT)
  assert.equal(readError, null, `读不了工程根目录：${readError && readError.message}`)
  assert.deepEqual(entries.map((item) => item.hex), [],
    '这类条目会让 npm run dist 直接失败，先跑 npm run pack:purge 看看')
})

check('工程根目录没有空的非 ASCII 目录（曾经有 48 个）', () => {
  const found = checkRoot.findEmptyForeignDirs(ROOT)
  assert.deepEqual(found.map((item) => item.display), [],
    `根目录有空的非 ASCII 目录，跑 npm run pack:purge：${JSON.stringify(found.map((i) => i.display))}`)
})

console.log('\n== 4. 清理脚本的安全边界：只 rmdir 空树，默认只看不动 ==')
check('整棵树里有文件就整棵跳过（survey 数出文件数，交给调用方拒删）', () => {
  const dir = makeTmp()
  fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'deep.txt'), 'x')
  const { dirs, files, error } = purge.survey(dir)
  assert.equal(error, null, '能正常遍历时不该报 error')
  assert.equal(files, 1, `深层的文件也要数到，实得 ${files}`)
  assert.equal(dirs.length, 4, `自己 + 3 层，实得 ${dirs.length}`)
  assert.equal(dirs[dirs.length - 1].length, Buffer.from(dir).length, '最后一个必须是最浅的自己（深→浅，保证先删子目录）')
})

check('全空的树数出 0 个文件，才允许删', () => {
  const dir = makeTmp()
  fs.mkdirSync(path.join(dir, 'x', 'y'), { recursive: true })
  const { dirs, files } = purge.survey(dir)
  assert.equal(files, 0, '空树必须是 0 个文件')
  assert.equal(dirs.length, 3, '自己 + 2 层')
})

check('清理扫描拒绝根目录 junction，不进入目标目录', () => {
  const dir = makeTmp()
  const target = path.join(dir, 'target')
  fs.mkdirSync(path.join(target, 'keep-empty'), { recursive: true })
  const link = path.join(dir, '链接')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = purge.survey(link)
  assert.ok(result.error, '链接必须拒绝扫描')
  assert.deepEqual(result.dirs, [], '不能返回外部目录的待删除路径')
  assert.deepEqual(checkRoot.findEmptyForeignDirs(dir), [], '不能把链接当成空树建议删除')
})

check('清理扫描拒绝嵌套 junction，自查不递归链接环', () => {
  const dir = makeTmp()
  const tree = path.join(dir, '空树')
  fs.mkdirSync(tree)
  fs.symlinkSync(tree, path.join(tree, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(purge.survey(tree).error, '遇到链接环应立即停止')
  assert.deepEqual(checkRoot.findEmptyForeignDirs(dir), [], '有链接不能判为纯空目录树')
})

check('清理路径以工程根目录解析，不随终端 cwd 改变', () => {
  const dir = makeTmp()
  const project = path.join(dir, 'project')
  const elsewhere = path.join(dir, 'elsewhere')
  const target = path.join(project, '待清理')
  const unrelated = path.join(elsewhere, '待清理')
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(target, 'empty-child'), { recursive: true })
  fs.mkdirSync(path.join(unrelated, 'keep-child'), { recursive: true })
  const script = path.join(project, 'scripts', 'purge-broken-root-entries.cjs')
  fs.writeFileSync(script, read('scripts/purge-broken-root-entries.cjs'))
  require('child_process').execFileSync(process.execPath, [script, '--apply'], { cwd: elsewhere, windowsHide: true })
  assert.ok(!fs.existsSync(target), '应清理脚本所在工程的空目录')
  assert.ok(fs.existsSync(path.join(unrelated, 'keep-child')), '终端 cwd 下同名目录必须保留')
})

check('清理脚本默认不删：必须显式 --apply 才动手', () => {
  const src = read('scripts/purge-broken-root-entries.cjs')
  assert.ok(/const APPLY = process\.argv\.includes\('--apply'\)/.test(src), '开关必须是显式的 --apply')
  assert.ok(/if \(!APPLY\) \{/.test(src), '没给 --apply 时必须走「只列清单」分支')
  // 只 rmdir，从不 rm/rmSync —— 这条是安全边界里最要紧的一条
  assert.ok(!/rmSync|unlinkSync|fs\.rm\(/.test(src), '清理脚本只许 rmdir 空目录，不许出现任何删文件的调用')
})

console.log('\n== 5. I-46 静态守卫：自查必须排在 electron-builder 之前，清理只 rmdir 空树 ==')
check('npm run dist 里先跑自查、再 build、最后才 electron-builder', () => {
  const scripts = JSON.parse(read('package.json')).scripts
  const dist = scripts.dist || ''
  assert.ok(dist.includes('check-pack-root.cjs'), 'dist 必须挂上根目录自查，否则等于没写')
  assert.ok(dist.includes('electron-builder'), 'dist 当然还要打包')
  assert.ok(dist.indexOf('check-pack-root.cjs') < dist.indexOf('electron-builder'),
    '自查必须在 electron-builder 之前跑（事后跑没有任何意义）')
  assert.ok(dist.includes('--publish never'), 'dist 必须带 --publish never（I-26）')
  assert.ok(/^node scripts\/check-pack-root\.cjs &&/.test(dist), '自查要放在最前面，别等 vite build 白跑一遍才发现')
  assert.ok(scripts['pack:check'] && scripts['pack:purge'], '两个脚本都要能单独跑')
})

check('CI 的 release.yml 走 npm run dist ⇒ 自动被自查覆盖', () => {
  const yml = read('.github/workflows/release.yml')
  assert.ok(/run: npm run dist/.test(yml), 'release.yml 必须走 npm run dist（这样自查才在 CI 里生效）')
})

check('自查脚本以 Buffer 取名字：非法 UTF-8 的名字走字符串会对不上', () => {
  const src = read('scripts/check-pack-root.cjs')
  assert.ok(/encoding: 'buffer'/.test(src), 'readdir 必须以 buffer 取名字')
  assert.ok(/Buffer\.concat/.test(src), '拼路径必须走 Buffer')
})

// 收尾：清掉本套件建的临时目录
for (const dir of tmpRoots) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (err) { /* 临时目录清不掉不影响结论 */ }
}

console.log(`\n打包前根目录自查：${passed} 项通过`)

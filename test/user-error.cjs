/**
 * 「英文报错不许出现在界面上」（I-48）验收。
 *
 * 起因是用户直接贴来的一条报错：
 *   `Error invoking remote method 'design:save': Error: 找不到底图素材 asset_973b…：
 *    ENOENT: no such file or directory, lstat 'C:\Users\…\design-assets\….json'.`
 * ——一句用户读不懂、也无法据此做任何事的话。
 *
 * 这条链路有三个独立的失效点，本套件逐层钉住：
 *   1. **原文本身就不该长这样**：主进程拼消息时把内部 id / 绝对路径 / errno 拼了进去
 *      （`designs.cjs`、`store.cjs`），于是原文就是技术串；
 *   2. **整理逻辑被抄了多份、且大部分调用点没有**：`DatasetView` / `TemplateView` 各写了一份
 *      剥壳正则，其余十来处直接 `err.message`；
 *   3. **未来新增调用点会重新踩坑**：只要还有人写 `error.value = err.message`，坑就还在。
 *
 * 所以解法是「一份实现 + 一个收口」：实现收进 `electron/user-error.cjs`，
 * 收口放在 `preload.cjs` 的 `invoke` 包装——所有 IPC 失败都在那一处过一遍。
 *
 * 运行：node test/user-error.cjs
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')

const { toUserMessage, stripWrapper, DEFAULT_FALLBACK, MAX_LEN } = require('../electron/user-error.cjs')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

/** 递归收集某目录下的源码文件（跳过 node_modules / dist / fixtures） */
function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'fixtures') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, exts, out)
    else if (exts.includes(path.extname(entry.name))) out.push(abs)
  }
  return out
}

/** 把注释整段抠掉：注释里出现 `err.message` 是在解释历史，不算泄漏 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// 用户报障时的原文，逐字保留（换行是为了可读，实际是一条）
const REPORTED =
  "Error invoking remote method 'design:save': Error: 找不到底图素材 " +
  'asset_973b4d1c606b14798f883ebe198a7d3e9d904d651227d8ba2abdb1aa2c60c9aa：' +
  "ENOENT: no such file or directory, lstat 'C:\\Users\\lyq\\AppData\\Roaming\\printpress\\data\\design-assets\\973b4d1c606b14798f883ebe198a7d3e9d904d651227d8ba2abdb1aa2c60c9aa.json'."

console.log('== 1. 把 Electron 的壳剥掉，技术细节换成用户看得懂的话 ==')

check('用户报障原文 → 一句中文，不含 id / 路径 / errno', () => {
  const out = toUserMessage(REPORTED)
  assert.ok(out.includes('找不到底图素材'), `应当保留可读的中文主体，实得：${out}`)
  assert.ok(!/asset_/.test(out), `内部素材 id 必须消失，实得：${out}`)
  assert.ok(!/ENOENT|lstat|AppData|C:\\/.test(out), `errno 与绝对路径必须消失，实得：${out}`)
})

check('嵌套多层的壳要逐层剥干净（api 里再包一层也认）', () => {
  const out = toUserMessage(
    "Error invoking remote method 'a': Error: Error invoking remote method 'b': Error: 数据集为空，无法打印")
  assert.equal(out, '数据集为空，无法打印')
})

check('剥完什么都不剩（纯 errno / 纯英文 / 空）一律走兜底，绝不把原文透出去', () => {
  const raws = [
    "Error invoking remote method 'x': Error: ENOENT: no such file or directory, open 'C:\\a\\b.json'",
    'TypeError: Cannot read properties of undefined (reading x)',
    'EACCES: permission denied',
    null,
    undefined,
    '',
  ]
  for (const raw of raws) {
    assert.equal(toUserMessage(raw), DEFAULT_FALLBACK, `原文 ${JSON.stringify(raw)} 应落到兜底`)
  }
})

check('中文正文原样保留（不要为了「清洗」把有用的话也洗掉）', () => {
  assert.equal(toUserMessage(new Error('数据集为空，无法打印')), '数据集为空，无法打印')
  assert.equal(toUserMessage('去色超出有效范围（0–1）'), '去色超出有效范围（0–1）')
})

check('兜底可以按场景换（打印 / 读图各有各的说法）', () => {
  const out = toUserMessage('Print job canceled', '打印没有完成，可能被取消或打印机不可用。')
  assert.equal(out, '打印没有完成，可能被取消或打印机不可用。')
})

check('超长文案要截断——一句话超过 200 字就不是给人看的了', () => {
  const out = toUserMessage(`读取失败：${'很长的说明'.repeat(60)}`)
  assert.ok(out.length <= MAX_LEN + 1, `实得 ${out.length} 字`)
  assert.ok(out.endsWith('…'), '截断了就该有省略号')
})

check('剥壳函数自身幂等、可单独调用（守卫别只测外层）', () => {
  const once = stripWrapper("Error invoking remote method 'x': Error: 内容")
  assert.equal(once, '内容')
  assert.equal(stripWrapper(once), '内容')
})

console.log('\n== 2. 性质断言：结果里不许出现任何「技术串」 ==')

check('一批真实与构造的报错，输出一律不含壳 / 路径 / errno / 英文散文', () => {
  const raws = [
    REPORTED,
    "Error invoking remote method 'asset:list': Error: 读取失败 C:\\Users\\lyq\\AppData\\Roaming\\printpress\\data\\assets.json: EACCES: permission denied",
    "Error invoking remote method 'app:changeDataDir': Error: 写入失败 D:\\x\\y.json: EPERM: operation not permitted",
    "Error invoking remote method 'design:save': Error: 底图所用上传字体缺失或不可读：Alibaba-PuHuiTi-Regular（ENOENT: no such file or directory, stat 'C:\\fonts\\x.ttf'）",
    "Error invoking remote method 'design:save': Error: 读取底图工程失败：Unexpected token < in JSON at position 0",
    "Error invoking remote method 'updater': Error: Cannot find latest.yml in the latest release artifacts",
    'Error: Maximum call stack size exceeded',
  ]
  const forbidden = [
    ['IPC 壳', /Error invoking remote method/],
    ['errno', /\b(?:ENOENT|EACCES|EPERM|EBUSY|ENOTDIR|EISDIR|ENOSPC)\b/],
    ['绝对路径', /[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|var|tmp)\//],
    ['内部素材 id', /asset_[0-9a-f]{16,}/],
    ['英文引擎散文', /Unexpected token|Cannot read propert|Maximum call stack|Cannot find latest/],
  ]
  for (const raw of raws) {
    const out = toUserMessage(raw)
    for (const [what, re] of forbidden) {
      assert.ok(!re.test(out), `${what} 漏出去了：${JSON.stringify(raw)} → ${out}`)
    }
    // 输出要么是中文，要么是兜底；不允许出现「一个汉字都没有」的东西
    assert.ok(/[\u4e00-\u9fff]/.test(out), `输出必须含汉字：${JSON.stringify(raw)} → ${out}`)
  }
})

check('清洗后不留「断在标点上」的尾巴（：、（、，）', () => {
  const out = toUserMessage("Error invoking remote method 'x': Error: 底图所用上传字体缺失或不可读：SomeFont（ENOENT: x）")
  assert.ok(!/[:：,，、（(]$/.test(out), `不该以标点收尾，实得：${JSON.stringify(out)}`)
})

console.log('\n== 3. I-48 静态守卫：唯一实现 + 单一收口 ==')

check('实现只有一份，且是零依赖纯模块（preload 与渲染层都要能加载）', () => {
  const src = read('electron/user-error.cjs')
  assert.ok(/module\.exports\s*=\s*\{[^}]*toUserMessage/.test(src), '必须导出 toUserMessage')
  assert.ok(!/require\(['"]fs['"]\)|require\(['"]path['"]\)|require\(['"]electron['"]\)/.test(src),
    'user-error.cjs 必须是零依赖纯模块——它同时被 preload（Node）和界面（Vite）加载')
})

check('渲染层里不许再手写「剥 Electron 壳」的正则（曾经抄了两份）', () => {
  const files = walk(path.join(ROOT, 'src'), ['.vue', '.js', '.cjs'])
  const offenders = files
    .filter((abs) => /Error invoking remote method/.test(stripComments(fs.readFileSync(abs, 'utf-8'))))
    .map((abs) => path.relative(ROOT, abs))
  assert.deepEqual(offenders, [], `这些文件又自己写了一份剥壳正则：${JSON.stringify(offenders)}`)
})

check('所有 IPC 调用都走 preload 的统一包装（不再直接 ipcRenderer.invoke）', () => {
  const src = read('electron/preload.cjs')
  // 唯一允许出现 `ipcRenderer.invoke(` 的地方就是包装函数**自己**——剥掉它再看还剩几处
  const wrapper = src.match(/function invoke\(channel, \.\.\.args\) \{[\s\S]*?\n\}/)
  assert.ok(wrapper, '找不到 invoke 包装函数')
  const outside = src.replace(wrapper[0], '')
  const bare = outside.split('ipcRenderer.invoke(').length - 1
  assert.equal(bare, 0, `preload 里还有 ${bare} 处直接 ipcRenderer.invoke，绕过了清洗`)
  assert.ok(/toUserMessage\(err\)/.test(wrapper[0]), '包装里必须真的调用清洗函数')
  // 不许无条件 console.error：预期内的失败（删素材后的正常查询分支）也会走这里，
  // 全打成 error 会污染 e2e 的「界面无控制台错误」守卫。只许对「落到兜底文案」的失败打日志。
  assert.ok(!/console\.error/.test(wrapper[0].replace(/if \(message === DEFAULT_FALLBACK\) console\.error/, '')),
    '包装里除「未识别的失败」外不许再打 console.error')
  assert.ok(/DEFAULT_FALLBACK\) console\.error/.test(wrapper[0]), '「未识别的失败」仍要打日志（否则查无可查）')
  // 数量反证：包装确实覆盖了全部通道，不是只留一两个
  const wrapped = src.split('=> invoke(').length - 1
  assert.ok(wrapped > 50, `走包装的调用点太少（${wrapped}），像是只改了一部分`)
})

check('preload 能 require 到本地模块（sandbox 必须为 false）', () => {
  const main = read('electron/main.cjs')
  assert.ok(/sandbox:\s*false/.test(main),
    'preload 里 require 本地模块要求 sandbox:false；改成 true 会让所有 IPC 调用直接报错')
})

check('面向用户的文案里不再直接拼 err.message（本页/本组件是重点，主进程一起查）', () => {
  const patterns = [
    [/err\?\.message\s*\|\|\s*String\(err\)/, '`err?.message || String(err)`'],
    [/err\.message\s*\|\|\s*String\(err\)/, '`err.message || String(err)`'],
    [/err\s*&&\s*err\.message\s*\?\s*err\.message\s*:\s*err/, '`err && err.message ? err.message : err`'],
    [/\$\{err\.message\}/, '`${err.message}` 直接插进文案'],
  ]
  const files = [
    ...walk(path.join(ROOT, 'src'), ['.vue', '.js', '.cjs']),
    ...walk(path.join(ROOT, 'electron'), ['.cjs']),
  ].filter((abs) => path.basename(abs) !== 'user-error.cjs') // 它自己就是干这个的
  const offenders = []
  for (const abs of files) {
    const src = stripComments(fs.readFileSync(abs, 'utf-8'))
    for (const [re, what] of patterns) {
      // 逐行判：只关心「显示给用户」的那一行。`console.warn(…, err.message)` 是留给开发的，
      // 不在此列（原文本来就该能在开发时看到，见 preload 包装里的 console.error）。
      const hit = src.split('\n').find((line) => re.test(line) && !/console\./.test(line))
      if (hit) offenders.push(`${path.relative(ROOT, abs)} :: ${what}\n        ${hit.trim()}`)
    }
  }
  assert.deepEqual(offenders, [],
    `这些位置仍会把原文直接显示给用户，改成 toUserMessage(err)：\n      ${offenders.join('\n      ')}`)
})

check('主进程那几条「原文里就带路径 / id」的消息已改掉', () => {
  const designs = stripComments(read('electron/designs.cjs'))
  assert.ok(!/找不到底图素材 \$\{id\}/.test(designs), 'designs.cjs 不许再拼内部 id')
  const store = stripComments(read('electron/store.cjs'))
  assert.ok(!/读取失败 \$\{fp\}/.test(store), 'store.cjs 不许再拼绝对路径')
  assert.ok(!/写入失败 \$\{fp\}/.test(store), 'store.cjs 不许再拼绝对路径')
  // 反向对照：这些词有别的测试/文档钉着，清洗不能把它们一起洗掉
  assert.ok(/读取失败/.test(store) && /写入失败/.test(store), '`读取失败` / `写入失败` 必须保留')
})

check('界面侧真的接上了共享实现（不是只写了模块没人用）', () => {
  const must = [
    'src/App.vue',
    'src/views/DatasetView.vue',
    'src/views/TemplateView.vue',
    'src/views/BackgroundDesignerView.vue',
    'src/views/PrintCenterView.vue',
    'src/views/PhotoLibraryView.vue',
    'src/components/AssetLibrarySidebar.vue',
    'src/components/PhotoImportPanel.vue',
    'src/components/DesignSurface.vue',
  ]
  const missing = must.filter((p) => !/from '[^']*user-error\.cjs'/.test(read(p)))
  assert.deepEqual(missing, [], `这些界面还没接共享实现：${JSON.stringify(missing)}`)
})

console.log(`\n用户可见报错文案（I-48）：${passed} 项通过`)

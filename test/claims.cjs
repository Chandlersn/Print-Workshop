/**
 * 对外口径与实现一致性验收（I-52）。
 *
 * 为什么必须有：README 里的「96 个操作」「48 套件」既是卖点也是承诺，却没有任何守卫——
 *  - `docs/v0.7功能建议-参照Compositor.md` 里写着「api-cli 有 90 个操作」，实测 96，漂了三个版本；
 *  - 每加一个测试套件，README 的套件数就过期一次，而只有人恰好读到那一行才发现。
 *
 * 判据（三条，都可机械判定）：
 *  1. 实测值只来自三个权威源：`api.cjs` 的 OPS 注册表、`package.json` 的 test 链、`docs/不变量契约.md`；
 *  2. **当前口径文档**（README + 两份使用说明）里的数字型宣称必须等于实测值——写错就红；
 *  3. **历史快照文档**（阶段验收报告 / 开发计划 / 审计报告）写的是「当时是什么样」，按白名单豁免；
 *     白名单必须在仓库里真实存在、且确实含宣称——不许腐烂，也不许拿来悄无声息地吞掉新文件；
 *  4. 被 `.gitignore` 归为私人资产的本地笔记不参与对外口径核对（它们只在本地，读者看不到）。
 *
 * 反向也守一条：README 与不变量契约文档**必须不被忽略**——对外可信度的前提是它拿得到。
 *
 * 纯静态检查（读文件 + 正则），不 require Electron、不碰数据目录。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

let passed = 0
function check(label, run) {
  try { run(); passed++; console.log(`  ok - ${label}`) }
  catch (err) { console.error(`  FAIL - ${label}\n    ${err.message}`); process.exitCode = 1 }
}

// ---------------------------------------------------------------- 实测来源

/** 操作注册表：OPS 里形如 `  'ns:name': {` 的键即一个操作（命名空间前缀让这个模式在全文里足够特异） */
const KNOWN_NAMESPACES = [
  'app', 'asset', 'catalog', 'dataset', 'design', 'font', 'job', 'photo', 'print', 'store', 'template',
]
function measureOps() {
  const api = read('electron/api.cjs')
  assert.ok(api.includes('const OPS = {'), 'api.cjs 里必须存在 `const OPS = {`（唯一权威源）')
  const names = [...api.matchAll(/^\s{2}'([a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*)':\s*\{/gm)].map((m) => m[1])
  assert.ok(names.length > 0, '注册表里一个操作都没解析出来——正则失效了')
  return { names, byNamespace: names.reduce((acc, n) => { const ns = n.split(':')[0]; acc[ns] = (acc[ns] || 0) + 1; return acc }, {}) }
}

/**
 * 测试套件数：`npm test` 链里挂载的 `node test/*` 段数。
 * 口径与 `test/api-cli.cjs` 里那条动态守卫**必须一致**（它用 describe() 算操作数、用同一套
 * 正则算套件数），否则 README 会被两个口径夹在中间，怎么改都红。
 */
function measureSuites() {
  const pkg = JSON.parse(read('package.json'))
  const chain = String(pkg.scripts && pkg.scripts.test || '')
  assert.ok(chain, 'package.json 必须有 scripts.test')
  return chain.split('&&').filter((s) => /node\s+test\//.test(s)).length
}

/** 不变量条数：契约文档里的 `### I-NN` 标题数 */
function measureInvariants() {
  const doc = read('docs/不变量契约.md')
  return (doc.match(/^### I-\d+\b/gm) || []).length
}

// ---------------------------------------------------------------- 文档口径

/** `.gitignore` 里被忽略的 docs/ 条目 → 私人资产（本地笔记，不参与对外口径核对） */
function ignoredDocEntries() {
  return read('.gitignore')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.startsWith('docs/'))
}
function isPrivateDoc(rel) {
  const norm = rel.replace(/\\/g, '/')
  return ignoredDocEntries().some((entry) => {
    const e = entry.replace(/\\/g, '/')
    return e.endsWith('/') ? norm.startsWith(e) : norm === e
  })
}

/**
 * 历史快照文档白名单：写的是「当时是什么样」的数字，停留是合法的。
 * 每一条都必须在仓库里真实存在且确实含数字型宣称（见「白名单不许腐烂」那条）。
 */
const HISTORY_DOCS = [
  'docs/S1分批出片验收报告.md',
  'docs/S1压测基准报告.md',
  'docs/v0.6.0开发计划.md',
  'docs/v0.6后续优化开发计划.md',
  'docs/代码审计报告.md',
  'docs/底图图层编辑开发方案.md',
  'docs/文件恢复与代码审查报告-2026-10-13.md',
  'docs/名单筛选与历史删除核查报告.md',
]

/** 当前口径文档：读者拿它当「现在是什么样」，一个数字都不许错 */
const CURRENT_DOCS = ['README.md', 'docs/使用说明.md', 'docs/底图制作使用说明.md']

const CLAIM_PATTERNS = [
  { kind: '操作数', re: /(\d+)\s*个操作/g },
  // 口径与 api-cli.cjs 一致：`48 套件` 与 `48 个套件` 都算
  { kind: '套件数', re: /(\d+)\s*个?(?:测试)?套件/g },
  { kind: '不变量条数', re: /(\d+)\s*条不变量/g },
]

/**
 * 行内自带日期的宣称算「当时的记录」而不是「当前口径」：
 * 设计文档里常见「（2026-10-01；12 套件 339 项领域测试）」这种进度快照，
 * 数字本来就该停在当时——改数字反而是篡改记录。
 */
const DATED_LINE = /\b20\d\d-\d\d-\d\d\b|\b20\d\d\s*年\s*\d+\s*月/

/** 抓一份文档里所有数字型宣称（带行号与原文片段，失败信息要能直接定位） */
function claimsIn(rel) {
  const found = []
  read(rel).split(/\r?\n/).forEach((line, i) => {
    for (const p of CLAIM_PATTERNS) {
      const re = new RegExp(p.re.source, 'g')
      let m
      while ((m = re.exec(line))) {
        found.push({
          doc: rel,
          line: i + 1,
          kind: p.kind,
          value: Number(m[1]),
          dated: DATED_LINE.test(line),
          text: line.trim().slice(0, 90),
        })
      }
    }
  })
  return found
}

/** docs/ 下的 md 清单（不含子目录；docs/推文 是 gitignored 交付物区，不在配置文件里也要排除） */
function docsMd() {
  return fs.readdirSync(path.join(ROOT, 'docs'), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => `docs/${d.name}`)
    .filter((rel) => !rel.startsWith('docs/推文/'))
}

console.log('== 1. 唯一权威源：注册表 / test 链 / 契约文档都能实测 ==')

check('OPS 注册表解析出操作清单，命名空间都是已知的 11 个', () => {
  const { names, byNamespace } = measureOps()
  const unknown = Object.keys(byNamespace).filter((ns) => !KNOWN_NAMESPACES.includes(ns))
  assert.deepEqual(unknown, [], `出现未登记的命名空间: ${unknown.join(', ')}——新增命名空间要同步本文件与 README`)
  assert.equal(names.length, new Set(names).size, '操作名出现重复：注册表里一个名字只能有一个实现')
  assert.ok(names.every((n) => /^[a-z]+:[A-Za-z][A-Za-z0-9_]*$/.test(n)), '操作名必须形如 ns:name')
})

check('`test/ipc-wiring.cjs` 以 `api.describe()` 动态枚举注册表，不写死操作清单', () => {
  const src = read('test/ipc-wiring.cjs')
  assert.ok(/api\.describe\(\)/.test(src), 'IPC 装配必须从注册表读清单（写死清单就会漏挂新操作）')
})

check('契约文档里 I-NN 条数可实测', () => {
  assert.ok(measureInvariants() > 0, 'docs/不变量契约.md 里一个 `### I-NN` 都没有，正则或文档坏了')
})

console.log('\n== 2. 当前口径文档里的数字必须等于实测 ==')

check('README 声明了操作数，且等于注册表实测值', () => {
  const measured = measureOps().names.length
  const claims = claimsIn('README.md').filter((c) => c.kind === '操作数')
  assert.ok(claims.length > 0, 'README 必须声明操作数（这是它的核心卖点之一，不许悄悄删掉）')
  const bad = claims.filter((c) => c.value !== measured)
  assert.deepEqual(bad.map((c) => `README.md:${c.line} 写 ${c.value}，实测 ${measured}`), [], 'README 的操作数与注册表不一致')
})

check('README 声明了测试套件数，且等于 npm test 链段数', () => {
  const measured = measureSuites()
  const claims = claimsIn('README.md').filter((c) => c.kind === '套件数')
  assert.ok(claims.length > 0, 'README 必须声明套件数')
  const bad = claims.filter((c) => c.value !== measured)
  assert.deepEqual(bad.map((c) => `README.md:${c.line} 写 ${c.value}，实测 ${measured}`), [], 'README 的套件数与 npm test 实际链段数不一致')
})

check('两份使用说明里的数字型宣称同样必须等于实测', () => {
  const measured = { 操作数: measureOps().names.length, 套件数: measureSuites(), 不变量条数: measureInvariants() }
  const bad = CURRENT_DOCS.flatMap((doc) => claimsIn(doc).filter((c) => c.value !== measured[c.kind]))
  assert.deepEqual(bad.map((c) => `${c.doc}:${c.line} 写 ${c.value}，实测 ${measured[c.kind]}`), [], '使用说明与实现不一致')
})

console.log('\n== 3. 白名单之外一律不许出现陈旧数字（新文件也不能漏网） ==')

check('所有对外文档里的数字型宣称，要么等于实测，要么在历史快照白名单里', () => {
  const measured = { 操作数: measureOps().names.length, 套件数: measureSuites(), 不变量条数: measureInvariants() }
  const audited = [...new Set([...CURRENT_DOCS, ...docsMd()])].filter((doc) => !HISTORY_DOCS.includes(doc) && !isPrivateDoc(doc))
  const bad = []
  const dated = []
  for (const doc of audited) {
    for (const c of claimsIn(doc)) {
      if (c.dated) { dated.push(`${c.doc}:${c.line}`); continue }
      if (c.value !== measured[c.kind]) bad.push(`${c.doc}:${c.line} 写「${c.text}」（${c.kind} 实测 ${measured[c.kind]}）`)
    }
  }
  assert.deepEqual(bad, [], `这些文档的数字与实现不符——改数字，把它登记进 HISTORY_DOCS，或给该行标日期（\n    ${bad.join('\n    ')}`)
  if (dated.length) console.log(`    （行内自带日期、按当时的记录豁免：${dated.length} 处：${dated.join('、')}）`)
})

check('历史快照白名单：每条都真实存在，且确实含数字型宣称（不许腐烂）', () => {
  const missing = HISTORY_DOCS.filter((doc) => !exists(doc))
  assert.deepEqual(missing, [], `白名单里有仓库中不存在的文件: ${missing.join(', ')}`)
  const empty = HISTORY_DOCS.filter((doc) => claimsIn(doc).length === 0)
  assert.deepEqual(empty, [], `白名单里这些文件已不含任何数字型宣称，应从白名单移除（否则它会一直豁免未来的新宣称）: ${empty.join(', ')}`)
})

console.log('\n== 4. 公开性：契约与 README 必须在仓库里，私人笔记只留本地 ==')

check('.gitignore 覆盖的私人文档不参与对外口径核对（它们的数字只服务本地）', () => {
  const entries = ignoredDocEntries()
  assert.ok(entries.length > 0, '.gitignore 里必须仍能读出被忽略的 docs/ 条目——否则「私人资产」这个分类消失了，本文件的第 4 条判据就失去依据')
  const privateDocs = entries.filter((e) => e.endsWith('.md') && !e.endsWith('/'))
  assert.ok(privateDocs.length > 0, '至少应有一篇被明确归为私人资产的文档')
})

check('README 与不变量契约必须**不被**忽略（对外可信度的前提是文档拿得到）', () => {
  assert.ok(!isPrivateDoc('README.md'), 'README 不能被忽略')
  assert.ok(!isPrivateDoc('docs/不变量契约.md'), '不变量契约是对外承诺，不能被归为私人资产')
  assert.ok(!isPrivateDoc('docs/使用说明.md'), '使用说明不能被忽略')
})

console.log('\n== 5. 自证：本套件与 I-52 都已登记 ==')

check('本套件已挂进 npm test（不挂 = 等于没写）', () => {
  const chain = String(JSON.parse(read('package.json')).scripts.test || '')
  assert.ok(chain.includes('test/claims.cjs'), 'test/claims.cjs 必须出现在 npm test 链里')
})

check('I-52 已登记进契约文档，且守卫指向本文件', () => {
  const doc = read('docs/不变量契约.md')
  assert.ok(/^### I-52\b/m.test(doc), 'docs/不变量契约.md 必须有 I-52 条目')
  const section = doc.slice(doc.search(/^### I-52\b/m))
  assert.ok(section.includes('test/claims.cjs'), 'I-52 必须写清守卫在 test/claims.cjs')
})

check('README 的两个计数在 api-cli.cjs 里另有动态守卫（本套件与它同口径，不行就一起红）', () => {
  const src = read('test/api-cli.cjs')
  assert.ok(/describe\(\)/.test(src), 'api-cli.cjs 必须仍以 describe() 动态取操作数——它是操作数的第二道守卫')
  assert.ok(/个操作/.test(src) && /套件/.test(src), 'api-cli.cjs 必须仍然钉着 README 的操作数与套件数')
})

console.log(`\n对外口径与实现一致性：${passed} 项通过`)
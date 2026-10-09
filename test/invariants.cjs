/**
 * 不变量契约层：把散落的静态守卫收拢成一份「有名字的清单」，并机器校验它们还在。
 *
 * 动机：这个项目反复出现「常规路径正常、边缘静默坏掉」的 bug，而应对一直是
 * 「每出一次 bug 加一条静态守卫」——永远慢 bug 一步。这份契约换一种做法：
 * 每条不变量都登记在 docs/不变量契约.md 里（`### I-XX`），并指向一个测试文件里
 * 守它的**锚点**。本套件负责：
 *
 *   1. 文档里的 I-XX 与下面的 CONTRACT 必须一一对应（多一条少一条都红）；
 *   2. 每条不变量的锚点必须真实存在于它声明的文件里（守卫被删/被改写会红）；
 *   3. 守卫所在套件必须挂进 `npm test`（不在 CI 里跑的守卫等于没有）。
 *
 * 于是「加守卫」变成「先声明再守卫」，而不是「追着 bug 打补丁」。
 *
 * 运行：node test/invariants.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/**
 * 契约清单：编号 → { file: 守它的测试文件, anchor: 该文件里那段守卫的标题/注释锚点 }。
 * 加一条不变量时，先在 docs/不变量契约.md 写 `### I-XX ...`，再来这里登记。
 */
const CONTRACT = [
  { id: 'I-01', file: 'test/ipc-hardening.cjs', anchor: '== 1. store 通道必须只放行 UI 偏好类 ==' },
  { id: 'I-02', file: 'test/ipc-hardening.cjs', anchor: '== 2. 外部链接协议白名单 ==' },
  { id: 'I-03', file: 'test/ipc-hardening.cjs', anchor: '== 3. 新窗口默认必须 deny ==' },
  { id: 'I-04', file: 'test/ipc-hardening.cjs', anchor: '== 4. 文件名消毒（模板名直接拼 defaultPath） ==' },
  { id: 'I-05', file: 'test/ipc-hardening.cjs', anchor: '== 4b. 拖拽 / 粘贴上传底图' },
  { id: 'I-06', file: 'test/ipc-hardening.cjs', anchor: '== 4d. 底图文件与模板记录解耦' },
  { id: 'I-07', file: 'test/ipc-hardening.cjs', anchor: '== 5. 取消「印」必须使模板字段失效 ==' },
  { id: 'I-08', file: 'test/ipc-hardening.cjs', anchor: '== 6. 0 份出片不得计「已打」 ==' },
  { id: 'I-09', file: 'test/ipc-hardening.cjs', anchor: '== 8b. 清理缓存「点了没反应」不许再复发 ==' },
  { id: 'I-10', file: 'test/ipc-hardening.cjs', anchor: '== 9. 列显隐：不许变成「静默改打印」，也不许「藏了找不回」 ==' },
  { id: 'I-11', file: 'test/ipc-hardening.cjs', anchor: '9j. 跨 IPC 传参必须是纯对象' },
  { id: 'I-12', file: 'test/ipc-hardening.cjs', anchor: '9a. 先修隐患：display-settings 原本是 { tableSize: v } 单字段覆写' },
  { id: 'I-13', file: 'test/ipc-hardening.cjs', anchor: '9k. 读盘时机' },
  { id: 'I-14', file: 'test/ipc-hardening.cjs', anchor: '9l. 打印历史的「状态」徽标不许被拆行' },
  { id: 'I-15', file: 'test/print-failure.cjs', anchor: '== 3. 直打失败必须留痕 ==' },
  { id: 'I-16', file: 'test/robustness.cjs', anchor: '== 7. 多选对齐必须把「盒边缘」换算回「锚点」 ==' },
  { id: 'I-17', file: 'test/robustness.cjs', anchor: 'P1-10 清空尺寸不被静默锁死' },
  { id: 'I-18', file: 'test/api-cli.cjs', anchor: '== 1. api.cjs 必须能在纯 Node 下加载（分层地基） ==' },
  { id: 'I-19', file: 'test/canvas-align.cjs', anchor: '== 1. 画布字段框的盒宽必须恰好等于文字宽 ==' },
  { id: 'I-20', file: 'test/bg-fidelity.cjs', anchor: '== 7. 导出路径不许引入任何图片重编码（静态守卫）==' },
  { id: 'I-21', file: 'test/designs.cjs', anchor: '新版本不可改变模板固定的旧版本，旧编辑器保存产生冲突' },
  { id: 'I-22', file: 'test/design-render.cjs', anchor: '旧图转工程后删除旧文件或模板不影响工程原素材' },
  { id: 'I-23', file: 'test/design-render.cjs', anchor: '打印等待CSS背景实际解码完成，共用URL只解码一次' },
]

console.log('== 1. 文档与契约清单必须一一对应 ==')
{
  const doc = read('docs/不变量契约.md')
  const docIds = [...doc.matchAll(/^###\s+(I-\d{2})\b/gm)].map((m) => m[1])
  const contractIds = CONTRACT.map((c) => c.id)

  ok(docIds.length > 0, `文档里登记了 ${docIds.length} 条不变量`)
  ok(new Set(docIds).size === docIds.length, '文档里的编号无重复', docIds)
  ok(new Set(contractIds).size === contractIds.length, '契约清单里的编号无重复', contractIds)

  const missingInContract = docIds.filter((id) => !contractIds.includes(id))
  ok(missingInContract.length === 0, '文档里每条都在契约清单里登记了', missingInContract)
  const missingInDoc = contractIds.filter((id) => !docIds.includes(id))
  ok(missingInDoc.length === 0, '契约清单里每条都在文档里有条目', missingInDoc)

  // 编号要连号（I-01..I-NN），避免手写漏号
  const expected = contractIds.map((_, i) => `I-${String(i + 1).padStart(2, '0')}`)
  ok(JSON.stringify(contractIds) === JSON.stringify(expected),
    '编号连续且升序（I-01..I-NN）', { got: contractIds, want: expected })
}

console.log('== 2. 每条不变量的强制点必须真实存在 ==')
{
  const cache = {}
  const srcOf = (f) => (cache[f] || (cache[f] = read(f)))
  for (const inv of CONTRACT) {
    ok(srcOf(inv.file).includes(inv.anchor), `${inv.id} 的强制点仍在 ${inv.file}`, inv.anchor)
  }
}

console.log('== 3. 守卫所在套件必须挂进 npm test（不跑就等于没有） ==')
{
  const testScript = require(path.join(ROOT, 'package.json')).scripts.test
  const wired = new Set([...testScript.matchAll(/node\s+(test\/[\w.-]+\.cjs)/g)].map((m) => m[1]))
  for (const f of [...new Set(CONTRACT.map((c) => c.file))]) {
    ok(wired.has(f), `${f} 已挂进 npm test`)
  }
  // 本套件自己也要挂在里面，否则契约层形同虚设
  ok(wired.has('test/invariants.cjs'), '契约测试自身也挂进 npm test')
}

console.log(`\n不变量契约：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

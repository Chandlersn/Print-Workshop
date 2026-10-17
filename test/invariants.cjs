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
  { id: 'I-24', file: 'test/canvas-align.cjs', anchor: '== 6. 上传字体在画布与 PDF 使用同一字体名 ==' },
  { id: 'I-25', file: 'test/design-render.cjs', anchor: '== 仅编辑可见的图层绝不出片（静态守卫）==' },
  { id: 'I-26', file: 'test/e2e-harness.cjs', anchor: '== 6. 打包必须显式关闭 electron-builder 自身的发布（v0.2.13 空包真凶） ==' },
  { id: 'I-27', file: 'test/design-presets.cjs', anchor: '== 内置预设：参考框一律「仅编辑可见」，出片时一个图层都不印 ==' },
  { id: 'I-28', file: 'test/api-cli.cjs', anchor: '== 10. 打开类操作不接受路径参数（I-28） ==' },
  { id: 'I-29', file: 'test/designs.cjs', anchor: '使用记录（design:touch）绝不动版本号，否则下次保存会撞 DESIGN_CONFLICT' },
  { id: 'I-30', file: 'test/designs.cjs', anchor: '门槛是用户保存过' },
  { id: 'I-31', file: 'test/asset-library.cjs', anchor: '**同一字节内容只存一份原件**' },
  { id: 'I-32', file: 'test/asset-library.cjs', anchor: 'I-32 清理未引用原件：删除前必须复核仍孤儿，绝不静默删被引用的图' },
  { id: 'I-33', file: 'test/template-asset-library.cjs', anchor: '=== I-33 模板底图走素材库原件（assetId），discard 按 source 分流，受管理件不即时删 ===' },
  { id: 'I-34', file: 'test/ipc-hardening.cjs', anchor: '== 4f. 模板字段与属性面板必须贴右浮动并适应窗口（前端静态核查） ==' },
  { id: 'I-35', file: 'test/ipc-hardening.cjs', anchor: '== 10. 「检查更新」必须真能触发更新（前端静态核查） ==' },
  { id: 'I-36', file: 'test/ipc-hardening.cjs', anchor: '== 11. 应用内说明与 docs/使用说明.md 的章节骨架必须一致（I-36） ==' },
  { id: 'I-37', file: 'test/designs.cjs', anchor: '清理残留：只回收「不在索引」的工程目录，索引里的与形状不符的都不动（I-37）' },
  { id: 'I-38', file: 'test/design-package.cjs', anchor: '== ⑦ I-38 工程包：先校验后发布、路径只来自白名单、导入必是副本（静态守卫） ==' },
  { id: 'I-39', file: 'test/dataset-edit.cjs', anchor: '配图置顶排序（I-39，前端静态核查）' },
  { id: 'I-40', file: 'test/design-blend-adjust.cjs', anchor: 'I-40 静态守卫：一份实现、四处同源、界面不得绕过撤销语义' },
  { id: 'I-41', file: 'test/design-export.cjs', anchor: '== I-41 静态守卫：格式表单一权威源，透明能力与 DPI 元数据不得各写一份 ==' },
  { id: 'I-42', file: 'test/dataset-edit.cjs', anchor: '== 11. 详情头部必须容忍整块缺失的 source（I-42，旧记录真实存在） ==' },
  { id: 'I-43', file: 'test/design-crop-presets.cjs', anchor: '== 4. I-43 静态守卫：改尺寸必须连带改裁切，规格不许抄第二份 ==' },
  { id: 'I-44', file: 'test/design-image-effects.cjs', anchor: '== 4. I-44 静态守卫：界面只写一份，关掉要删字段而不是留 0 ==' },
  { id: 'I-45', file: 'test/designer-aids.cjs', anchor: '== 6. I-45 静态守卫：标尺与网格绝不能进工程文件，吸附阈值只有一份 ==' },
  { id: 'I-46', file: 'test/pack-root.cjs', anchor: '== 5. I-46 静态守卫：自查必须排在 electron-builder 之前，清理只 rmdir 空树 ==' },
  { id: 'I-47', file: 'test/design-blend-adjust.cjs', anchor: '== 7. I-47 静态守卫：滑杆的百分比换算必须与 schema 的取值口径成对 ==' },
  { id: 'I-48', file: 'test/user-error.cjs', anchor: '== 3. I-48 静态守卫：唯一实现 + 单一收口 ==' },
  { id: 'I-49', file: 'test/output-dpi.cjs', anchor: '== I-49 出片分辨率：照片按图框需要的像素预降采样，原件字节一律不动 ==' },
  { id: 'I-50', file: 'test/output-dpi.cjs', anchor: '== 10. I-50 固定图片：不带效果靠 Chromium 去重，带颜色调整/投影要烘成单份（静态核查）==' },
  { id: 'I-51', file: 'test/asset-library.cjs', anchor: '== I-51 素材保存仓库与临时底图分池存放 ==' },
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

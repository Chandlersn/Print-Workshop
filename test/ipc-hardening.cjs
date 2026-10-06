/**
 * 第四批：IPC 收口与结构清理的验收。
 *
 * 这一批修的多是「本不该存在的能力」——通用写入口、协议放行、绕开领域层的通道。
 * 它们不会让功能出错，只会让出错变得不可逆（清库、打开本地 exe、NTLM 协商），
 * 所以断言以「必须被拒绝」为主。
 *
 * 运行：node test/ipc-hardening.cjs
 */
const fs = require('fs')
const path = require('path')
const { rmDeep } = require('./helpers/rm.cjs')

const TMP = path.join(__dirname, '.tmp-data-ipc')
rmDeep(TMP)
fs.mkdirSync(TMP, { recursive: true })
process.env.PRINTPRESS_DATA_DIR = TMP

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok - ${label}`) }
  else { fail++; console.error(`  FAIL - ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

const printDomain = require('../electron/print.cjs')
const templates = require('../electron/templates.cjs')
const dataset = require('../electron/dataset.cjs')
const { safeExternalUrl, parseInfo } = require('../electron/version-check.cjs')

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8')

console.log('== 1. store 通道必须只放行 UI 偏好类 ==')
{
  // 业务实现已从 ipc.cjs 抽到 api.cjs（ipc.cjs 只剩 Electron 装配），
  // 所以结构断言的落点跟着走——断言的意图不变：白名单必须显式且唯一。
  const apiSrc = src('electron/api.cjs')
  ok(/STORE_ALLOWLIST = new Set\(\['settings', 'display-settings'\]\)/.test(apiSrc),
    '白名单显式列举（不是文件名形状校验）')
  ok(/assertStorableName/.test(apiSrc), '两个 handler 都走白名单校验')
  ok(!/assertSafeName/.test(apiSrc), '旧的文件名形状校验已移除（它挡不住 datasets/templates）')
  ok(!/STORE_ALLOWLIST/.test(src('electron/ipc.cjs')),
    'ipc.cjs 不再自持白名单副本（唯一权威源在 api.cjs）')

  // 领域库名必须被显式排除：形状合规但不在白名单
  const allowed = new Set(['settings', 'display-settings'])
  for (const name of ['datasets', 'templates', 'print-jobs', 'fonts', 'archive']) {
    ok(!allowed.has(name), `领域库 ${name} 不在白名单内（一行调用即可清空全部数据）`)
  }

  // 前端只用到这两个键，白名单不能更宽也不能更窄
  const callers = []
  for (const f of walk(path.join(__dirname, '..', 'src'))) {
    const s = fs.readFileSync(f, 'utf-8')
    for (const m of s.matchAll(/(?:loadData|saveData)\('([^']+)'/g)) callers.push(m[1])
  }
  ok(callers.length > 0, `扫到前端实际使用的键（${callers.length} 处）`)
  ok(callers.every((k) => allowed.has(k)), '前端用到的键全在白名单内', [...new Set(callers)])
  ok(new Set(callers).size === 2, '实际只用到 settings 与 display-settings 两个', [...new Set(callers)])
}

console.log('== 2. 外部链接协议白名单 ==')
{
  ok(safeExternalUrl('https://github.com/a/b/releases') !== null, 'https 放行')
  ok(safeExternalUrl('http://example.com') === null, 'http 拒绝（无正当理由）')
  ok(safeExternalUrl('file:///C:/Windows/System32/calc.exe') === null, 'file:// 拒绝（可拉起本地 exe）')
  ok(safeExternalUrl('smb://attacker.example/share') === null, 'smb:// 拒绝（Windows 上会触发 NTLM 协商）')
  ok(safeExternalUrl('javascript:alert(1)') === null, 'javascript: 拒绝')
  ok(safeExternalUrl('data:text/html,<script>alert(1)</script>') === null, 'data: 拒绝')
  ok(safeExternalUrl('vbscript:msgbox(1)') === null, 'vbscript: 拒绝')
  ok(safeExternalUrl('  https://ok.example  ') !== null, '首尾空白容忍')
  ok(safeExternalUrl('') === null, '空串拒绝')
  ok(safeExternalUrl(null) === null, 'null 拒绝')
  ok(safeExternalUrl(123) === null, '非字符串拒绝')
  ok(safeExternalUrl('ht!tps://x') === null, '畸形 URL 拒绝而非抛错')
  ok(safeExternalUrl('https://user:pass@evil.example') === null || safeExternalUrl('https://user:pass@evil.example').includes('evil.example'),
    '带凭据的 URL 行为明确（不抛错即可）')

  // parseInfo 必须把非法 url 抹掉，而不是原样透传
  const evil = parseInfo(JSON.stringify({ version: '9.9.9', url: 'file:///C:/Windows/System32/calc.exe' }))
  ok(evil && evil.url === '', 'parseInfo 抹掉 file:// 的 url（渲染层因此不给可点链接）', evil)
  const good = parseInfo(JSON.stringify({ version: '9.9.9', url: 'https://example.com/r' }))
  ok(good && good.url === 'https://example.com/r', 'parseInfo 保留 https 的 url', good && good.url)
  ok(parseInfo(JSON.stringify({ version: '9.9.9' })).url === '', '缺 url 时为空串（非 undefined）')
}

console.log('== 3. 新窗口默认必须 deny ==')
{
  const main = src('electron/main.cjs')
  const handler = main.slice(main.indexOf('setWindowOpenHandler'), main.indexOf('if (!app.isPackaged'))
  ok(/action: 'deny'/.test(handler), '存在 deny 分支')
  ok(!/action: 'allow'/.test(handler), '不再有 allow 分支（旧代码 default 就 allow）')
  const denyCount = (handler.match(/action: 'deny'/g) || []).length
  ok(denyCount >= 1, '所有路径最终都返回 deny', denyCount)
  // https 才交给系统浏览器
  ok(/\^https:\\\/\\\//.test(handler), '放行条件是 https 前缀')
}

console.log('== 4. 文件名消毒（模板名直接拼 defaultPath） ==')
{
  ok(printDomain.sanitizeFilename('2026年度表彰名单') === '2026年度表彰名单', '正常名原样保留')
  ok(!/[\\/:*?"<>|]/.test(printDomain.sanitizeFilename('a/b:c*d?e"f<g>h|i')), '路径非法字符全清')
  ok(!/\r|\n|\t/.test(printDomain.sanitizeFilename('a\r\nb\tc')), '控制字符全清')
  ok(printDomain.sanitizeFilename('') === '未命名', '空名兜底')
  ok(printDomain.sanitizeFilename(null) === '未命名', 'null 兜底')
  ok(!/^\s|\s$/.test(printDomain.sanitizeFilename('  名字  ')), '首尾空白清掉')
  ok(!/\.$/.test(printDomain.sanitizeFilename('名字.')), '结尾点被清（Windows 会截断）')
  ok(!/\s$/.test(printDomain.sanitizeFilename('名字 ')), '结尾空格被清')
  // Windows 保留设备名
  for (const r of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
    ok(printDomain.sanitizeFilename(r) !== r, `保留设备名 ${r} 被改写`, printDomain.sanitizeFilename(r))
  }
  ok(printDomain.sanitizeFilename('CON-cert') === 'CON-cert', '含保留字但非全等的正常名不误伤')
  ok(printDomain.sanitizeFilename('x'.repeat(200)).length <= 80, '限长 80')
  ok(printDomain.sanitizeFilename('x'.repeat(200)).endsWith('x'), '截断不产生尾点')

  // 接线：实现必须真的用上它（原来是死代码，0 处调用）
  const apiSrc2 = src('electron/api.cjs')
  ok(/printDomain\.sanitizeFilename\(built\.templateName\)/.test(apiSrc2), 'exportPdf 的 defaultPath 用了消毒后的名字')
  ok(!/defaultPath: `\$\{built\.templateName\}/.test(apiSrc2), '不再直接拼未消毒的模板名')
}

console.log('== 4b. 拖拽 / 粘贴上传底图：格式按内容判定，前端给的文件名不可信 ==')
{
  // 1x1 PNG 的有效字节（拖拽 / 粘贴的真实产物形态：只有内存字节，没有文件路径）
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64')

  const good = templates.uploadBackgroundBytes(PNG, '证书底图.png')
  ok(good.background.startsWith('print-bg/') && good.background.endsWith('.png'),
    'PNG 正常写入并归到 print-bg/', good.background)
  ok(good.width === 1 && good.height === 1, '尺寸按内容解析（1x1）', good)

  // 落盘位置必须真的在数据目录内
  const abs = path.join(TMP, 'print-bg', path.basename(good.background))
  ok(fs.existsSync(abs), '底图确实落在数据目录内', abs)

  // 路径穿越：只取文件名，不能按原路径拼
  const evil = templates.uploadBackgroundBytes(PNG, '../../../../Windows/System32/calc.png')
  ok(!evil.background.includes('..') && !evil.background.includes('System32'),
    '路径穿越被挡住（只取文件名）', evil.background)

  // Windows 非法字符
  const illegal = templates.uploadBackgroundBytes(PNG, 'a:b*c?d<e>f|g.png')
  ok(!/[:*?"<>|]/.test(illegal.background), 'Windows 非法字符被替换', illegal.background)

  // 后缀撒谎：内容是 PNG 却叫 .jpg —— 扩展名必须按内容判定
  const lying = templates.uploadBackgroundBytes(PNG, 'evil.jpg')
  ok(lying.background.endsWith('.png'), '扩展名按内容判定（叫 .jpg 的 PNG 仍存成 .png）', lying.background)

  // 内容不是图片：即使名字是 .png 也必须拒绝（这是这条通道最关键的一条）
  const notImage = Buffer.from('<?php system($_GET[0]); ?>')
  let rejected = ''
  try { templates.uploadBackgroundBytes(notImage, 'shell.png') } catch (e) { rejected = e.message }
  ok(rejected.length > 0, '非图片内容被拒绝（改名成 .png 也没用）', rejected)

  let emptyMsg = ''
  try { templates.uploadBackgroundBytes(Buffer.alloc(0), 'x.png') } catch (e) { emptyMsg = e.message }
  ok(emptyMsg.length > 0, '空内容被拒绝', emptyMsg)

  // 前端侧：必须读成 base64 且去掉 data: 前缀，否则主进程解出来是乱码
  const view = src('src/views/TemplateView.vue')
  ok(/uploadBackgroundBytes/.test(view), '前端调用了字节版上传通道')
  ok(/readAsDataURL/.test(view), '前端用 FileReader 把 File 读成 base64')
  ok(/slice\(comma \+ 1\)/.test(view), 'base64 去掉了 data: 前缀')
  ok(/onDrop|@drop/.test(view) && /onPaste|addEventListener\('paste'/.test(view),
    '拖拽与粘贴两条入口都接上了')
  ok(/preventDefault/.test(view), '拖拽时阻止默认行为（否则浏览器会直接打开这个文件）')
}

console.log('== 4c. 底图的上传入口与删除方式（前端静态核查） ==')
{
  const view = src('src/views/TemplateView.vue')

  // 上传入口从工具栏挪进了画布中央
  ok(/canvas-drop/.test(view) && /点击上传底图/.test(view), '画布中央有上传入口')
  ok(/canvas-drop-btn[\s\S]{0,200}uploadBackground/.test(view),
    '中央那块按钮触发上传')
  ok(!/>\s*上传底图\s*<\/button>/.test(view), '工具栏的独立「上传底图」按钮已移除')
  // 有字段时要收成底部小胶囊，否则会占住纸面中央、字段拖不动
  ok(/drop-compact/.test(view) && /pointer-events:\s*none/.test(view),
    '有字段时收成小胶囊，且容器不吃事件（不挡字段拖拽）')

  // 删除底图：点选中 + Delete，而不是点一下就删
  ok(/@click="selectBackground"/.test(view), '点底图进入选中态')
  ok(/bgSelected/.test(view), '有独立的底图选中标志')
  // 纸面上那句浮着的底图提示：选中字段时必须收起。
  // 用户在改字段，飘一句「点底图选中」既无关又挡视线。
  const tipTag = view.match(/<p v-if="([^"]+)" class="bg-tip"/)
  ok(Boolean(tipTag), '存在纸面上的底图提示（.bg-tip）')
  ok(Boolean(tipTag) && /!selectedField/.test(tipTag[1]),
    '选中字段时收起底图提示（改字段时不再弹「点底图」）')
  ok(/bgSelected\.value && \(e\.key === 'Delete'/.test(view), 'Delete 有删底图的分支')
  ok(/@click="removeBackground"|removeBackground\(\)/.test(view), '存在移除底图的实现')
  // 顺序很关键：选中底图时 selectedIdx 是 -1，targets 为空，
  // 若这一分支排在 targets 判空之后，就永远走不到
  const bgDelAt = view.indexOf("bgSelected.value && (e.key === 'Delete'")
  const targetsAt = view.indexOf('const targets = multiSel.value.size > 0')
  ok(bgDelAt > 0 && targetsAt > 0 && bgDelAt < targetsAt,
    '删底图的分支排在 targets 判空之前（否则按 Delete 永远没反应）')

  // 底图**不进**撤销栈：换图 / 删图会真删文件，撤销回来只会是张破图
  ok(!/background: t\.background/.test(view), '底图不进撤销快照（撤销回来只会是破图）')
  ok(/discardBackground/.test(view), '换图 / 删图都会丢弃旧图文件')
  ok(/@error="onBgError"/.test(view) && /function onBgError/.test(view),
    '底图加载失败时自动清引用（换了图没保存就走了的兜底）')
}

console.log('== 4d. 底图文件与模板记录解耦：换图 / 删图当场删文件 ==')
{
  const ICON = path.join(__dirname, '..', 'build', 'icon.png')
  const abs = (rel) => path.join(TMP, ...rel.split('/'))

  const fp = path.join(TMP, '底图名单.csv')
  fs.writeFileSync(fp, '姓名\n张三\n李四\n', 'utf-8')
  const ds = dataset.importFromFile(fp, '底图名单')
  dataset.setColumnPrint(ds.id, '姓名', true)

  const a = templates.uploadBackground(ICON)
  const b = templates.uploadBackground(ICON)
  ok(fs.existsSync(abs(a.background)), '上传后图片落盘')
  ok(a.background !== b.background, '两次上传文件名不同（时间戳前缀，不会互相覆盖）')

  templates.saveTemplate({
    name: '底图解耦测试', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    background: a.background, bgSize: { width: a.width, height: a.height },
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 12, align: 'center' }],
  })
  ok(fs.existsSync(abs(a.background)), '保存模板不碰底图文件（两件事）')

  // 换图：前端带着旧路径来丢弃，当场删
  templates.discardBackground(a.background)
  ok(!fs.existsSync(abs(a.background)), '换图后旧图文件当场被删')
  ok(fs.existsSync(abs(b.background)), '新图不受影响')

  // 移除底图走的是同一条：不等保存
  templates.discardBackground(b.background)
  ok(!fs.existsSync(abs(b.background)), '移除底图后文件当场被删（不等保存）')

  // 路径守卫：底图路径来自可手工编辑的 JSON，越界不能删到数据目录外
  const outside = path.join(TMP, '..', 'pp-victim.txt')
  fs.writeFileSync(outside, 'x')
  const guard = templates.discardBackground('../pp-victim.txt')
  ok(guard.removed === false, '越界路径被守卫挡下（removed:false）', guard)
  ok(fs.existsSync(outside), '数据目录外的文件没被删掉')
  fs.unlinkSync(outside)

  // 删模板仍连带清底图（唯一性由时间戳前缀保证）
  const c = templates.uploadBackground(ICON)
  const tpl = templates.saveTemplate({
    name: '待删模板', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    background: c.background, bgSize: { width: c.width, height: c.height },
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 12, align: 'center' }],
  })
  templates.deleteTemplate(tpl.id)
  ok(!fs.existsSync(abs(c.background)), '删模板连带清掉它的底图')
}

console.log('== 4e. 模板列表封顶 + 「列对齐」下线（前端静态核查） ==')
{
  const view = src('src/views/TemplateView.vue')

  // 「列对齐」按钮删了：它的纯函数也不该留成死代码
  ok(!/applyColumnSnap/.test(view), '工具栏不再有「列对齐」按钮（handler 也没了）')
  ok(!/>\s*列对齐\s*<\/button>/.test(view), '没有残留的「列对齐」按钮文案')
  ok(/均分横排/.test(view), '「均分横排」保留（删的是列对齐，不是整条工具栏）')
  const layout = src('src/lib/field-layout.cjs')
  ok(!/columnSnap/.test(layout), 'field-layout.cjs 里的 columnSnap 已删（零引用的死代码）')
  ok(/module\.exports\s*=\s*\{\s*evenRow,\s*anchorRatio\s*\}/.test(layout),
    '导出只剩 evenRow / anchorRatio')

  // 模板列表：8 条封顶 + 自动滚动条
  const listRule = view.match(/\.tpl-list\s*\{([\s\S]*?)\}/)
  ok(Boolean(listRule), '存在 .tpl-list 规则')
  const body = listRule ? listRule[1] : ''
  ok(/--tpl-visible:\s*8\s*;/.test(body), '可见条数上限是 8')
  ok(/max-height:\s*calc\(/.test(body) && /var\(--tpl-visible\)/.test(body),
    'max-height 由「可见条数」变量算出（不是拍脑袋的像素值）')
  ok(/overflow-y:\s*auto/.test(body), '用 overflow-y:auto —— 超过才出滚动条')

  // 关键：max-height 与条目高度必须共用同一个变量，否则两边各改各的就会错位
  const itemRule = view.match(/\.tpl-item\s*\{([\s\S]*?)\}/)
  const itemBody = itemRule ? itemRule[1] : ''
  ok(/height:\s*var\(--tpl-item-h\)/.test(itemBody),
    '.tpl-item 高度取自同一个变量（改一处两边同步）')
  // 溢出时 flex 默认会把条目压到 min-content 高（实测 56 → 53.6），封顶算式就废了
  ok(/flex-shrink:\s*0/.test(itemBody), '.tpl-item 不许被 flex 压缩（否则高度会缩水）')
  ok(/--tpl-item-h:\s*\d+px/.test(body), '.tpl-list 上定义了这个变量')
}

console.log('== 5. 取消「印」必须使模板字段失效 ==')
{
  const fp = path.join(TMP, '印列.csv')
  fs.writeFileSync(fp, '姓名,单位\n张三,A\n李四,B\n', 'utf-8')
  const ds = dataset.importFromFile(fp, '印列名单')
  // 先激活再建模板：saveTemplate 本身就要求字段已激活打印
  dataset.setColumnPrint(ds.id, '姓名', true)
  dataset.setColumnPrint(ds.id, '单位', true)
  const tpl = templates.saveTemplate({
    name: '双列', datasetId: ds.id, pageSize: { w: 210, h: 297 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 12, align: 'center' },
      { column: '单位', label: '单位', x: 50, y: 60, fontSize: 12, align: 'center' },
    ],
  })
  ok(printDomain.validateBatch(ds.id, tpl.id, null).issues.length === 0, '全部激活时无问题')

  // 事后取消「印」：旧口径只查列是否存在，会照常出片印出空白
  dataset.setColumnPrint(ds.id, '单位', false)
  const v = printDomain.validateBatch(ds.id, tpl.id, null)
  const miss = v.issues.find((i) => i.key === '单位')
  ok(Boolean(miss && miss.missing), '取消「印」后该字段判为缺失（阻断放行）')
  ok(miss && miss.reason === 'not-printable', '带 not-printable 原因（界面据此给「去数据页激活」的出路）', miss && miss.reason)
  ok(!v.issues.some((i) => i.key === '姓名'), '未取消的列不受牵连')

  // 界面对两种缺失给不同文案与出路
  const pv = src('src/views/PrintCenterView.vue')
  ok(/i\.reason === 'not-printable'/.test(pv), '界面区分两种缺失的文案')
  ok(/hasUnprintableIssue/.test(pv), '弹窗总提示也区分')
  ok(/未激活打印/.test(pv), 'flag 文案指向「未激活打印」')
}

console.log('== 6. 0 份出片不得计「已打」 ==')
{
  ok(printDomain.shouldMarkPrinted({ selected: 10, total: 10, partial: false }) === true, '全量出片回写')
  ok(printDomain.shouldMarkPrinted({ selected: 3, total: 10, partial: true }) === false, '部分出片不回写')
  ok(printDomain.shouldMarkPrinted({ selected: 0, total: 0, partial: false }) === false,
    '0 份不回写（空数据集不能凭空多一个成功信号）')
  ok(printDomain.shouldMarkPrinted({ selected: 0, total: 10, partial: true }) === false,
    '勾选 0 条（partial）不回写')
  ok(printDomain.shouldMarkPrinted(null) === true, '无 scope 时按全量（旧调用兼容）')

  // 端到端：空数据集出片
  const emptyFp = path.join(TMP, '空表.csv')
  fs.writeFileSync(emptyFp, '姓名\n', 'utf-8')
  const eds = dataset.importFromFile(emptyFp, '空名单')
  dataset.setColumnPrint(eds.id, '姓名', true)
  const etpl = templates.saveTemplate({
    name: '空表用', datasetId: eds.id, pageSize: { w: 210, h: 297 },
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 12, align: 'center' }],
  })
  const built = printDomain.buildBatchHtml(eds.id, etpl.id, null)
  ok(built.recordCount === 0, '空数据集 recordCount 为 0')
  ok(printDomain.shouldMarkPrinted(built.scope) === false, '0 份不回写「已打」', built.scope)
}

console.log('== 7. 种子幂等 + 文案口径 ==')
{
  const seed = src('electron/seed-demo.cjs')
  ok(/listDatasets\(\)\.find\(\(d\) => d\.name === dsName\)/.test(seed),
    '示例数据集按名字去重（迁移中途崩溃重启不留同名副本）')
  ok(/templateNames\(\)/.test(seed), '模板去重仍在')

  ok(/7 套示例模板/.test(src('src/App.vue')), '首启文案改为 7 套（实际种子是 7 套）')
  ok(/7 套示例模板/.test(src('src/components/GuideDialog.vue')), '引导弹窗同步')
  ok(!/4 套示例模板|4 套模板/.test(src('src/App.vue') + src('src/components/GuideDialog.vue')),
    '不再有「4 套」残留')

  const pv = src('src/views/PrintCenterView.vue')
  ok(!/需已上传底图/.test(pv), '空态文案不再强制要求底图（无底图版式是合法的）')
  ok(/底图可选/.test(pv), '明确说明底图可选')

  // 扩展名口径统一到一个常量
  const dv = src('src/views/DatasetView.vue')
  ok(/IMPORT_EXTS_TEXT = IMPORT_EXTS\.join/.test(dv), '扩展名文案由常量派生')
  ok((dv.match(/\{\{ IMPORT_EXTS_TEXT \}\}/g) || []).length === 2, '两处文案都引用该常量')
  ok(!/支持 \.xlsx \/ \.xls \/ \.csv ·/.test(dv), '旧的硬编码清单已替换')
  ok(!/支持 \.xlsx \/ \.xls \/ \.csv \/ \.txt<\/span>/.test(dv), '拖放区不再写死一份')

  // 死代码与死 token 已清
  ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'components', 'MultiSelect.vue')),
    '零引用的 MultiSelect.vue 已删')
  const theme = src('src/styles/theme.css')
  ok(!/--ok-line/.test(theme) && !/--cinnabar-line/.test(theme), '零引用的描线 token 已清')
  ok(!/background: #fbf4e4/.test(src('src/components/GuideDialog.vue')), '硬编码亮色已换成主题 token')
  ok(/var\(--warn-soft\)/.test(src('src/components/GuideDialog.vue')), '改用 --warn-soft（暗色下不再刺眼）')
}

console.log('== 7b. 种子迁移：临时文件删不掉也必须走完（可重试自愈） ==')
{
  // 回归：importDemoDataset 里「建数据集 → 删临时CSV → 激活列」的顺序，
  // 只要删CSV抛错，激活列就被跳过，数据集以「列全关」的半途状态落库；
  // 重试时按名字去重提前返回 → 建模板永远校验失败 → 迁移再也走不完。
  // 触发条件真实存在：杀软锁文件、只读盘、权限、宿主删除守卫。
  const seed = require('../electron/seed-demo.cjs')
  const seedDir = path.join(TMP, 'seed-src')
  fs.mkdirSync(seedDir, { recursive: true })
  // ver=1（旧版已种子）→ 走迁移分支，不依赖 print-bg 资源
  fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ theme: 'dark', demoSeeded: true, onboarded: true }))

  const tplBefore = templates.listTemplates().length

  const origUnlink = fs.unlinkSync
  fs.unlinkSync = () => { const e = new Error('EPERM: simulated unlink failure'); e.code = 'EPERM'; throw e }
  let r1
  try { r1 = seed.seedIfFirstRun(seedDir) } finally { fs.unlinkSync = origUnlink }

  ok(r1.seeded === true && r1.migrated === true, '删不掉临时文件时迁移仍走完', r1)
  const ext = dataset.listDatasets().find((d) => d.name === '示例名单·扩展')
  ok(!!ext, '扩展示例名单已导入')
  ok(ext && dataset.fieldCatalog(ext.id).filter((c) => c.printOn).length >= 6,
    '模板用到的列已激活（没有停在半途）')
  ok(templates.listTemplates().length > tplBefore, '会务证卡模板已补种')
  ok(JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf-8')).seedVersion === 2,
    'seedVersion 已写（不会每次启动重试）')
  ok(seed.seedIfFirstRun(seedDir).reason === 'already', '再次启动直接 already（幂等）')
  ok(fs.readdirSync(seedDir).filter((f) => f.endsWith('.csv')).length === 0,
    '临时 CSV 不落在 seed 资源目录（打包后是只读 resources/seed，开发态是被跟踪的 build/seed）')

  // 半途状态自愈：数据集在、列却全关时，去重命中也要补激活
  const list = JSON.parse(fs.readFileSync(path.join(TMP, 'datasets.json'), 'utf-8'))
  const target = list.find((d) => d.name === '示例名单·扩展')
  target.columns.forEach((c) => { delete c.printOn })
  fs.writeFileSync(path.join(TMP, 'datasets.json'), JSON.stringify(list), 'utf-8')
  fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ theme: 'dark', demoSeeded: true, onboarded: true }))
  seed.seedIfFirstRun(seedDir)
  const healed = dataset.listDatasets().find((d) => d.name === '示例名单·扩展')
  ok(dataset.fieldCatalog(healed.id).filter((c) => c.printOn).length >= 6,
    '列全关的半途状态能被重试自愈（去重命中时补激活）')
}

console.log('== 8. 缓存 0 值语义 ==')
{
  const app = src('src/App.vue')
  ok(/const cacheOk = ref\(true\)/.test(app), '有独立的成功标志（0 不再兼任「成功」与「失败」）')
  ok(/cacheOk\.value = false/.test(app), '查询失败时置false')
  ok(/读取失败/.test(app), '失败有独立文案（不把故障说成「已无缓存」）')
  ok(/:disabled="clearingCache \|\| \(cacheOk && cacheSize === 0\)"/.test(app),
    '确认 0 时禁用；查询失败时 cacheOk=false 故仍可点（保留重试路径）')
}

rmDeep(TMP)
console.log(`\nIPC 收口与结构：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

/** 递归列出目录下的文件 */
function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(vue|js|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

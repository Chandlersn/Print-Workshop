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
  ok(a.background !== b.background, '两次上传文件名不同（时间戳+随机前缀，不会互相覆盖）')
  // 只靠 Date.now() 命名会在**同一毫秒内**撞名（快机器 / CI 抓到过：本机慢，隔了 >1ms 才一直没暴露）
  const many = Array.from({ length: 8 }, () => templates.uploadBackground(ICON).background)
  ok(new Set(many).size === many.length, '8 次连续上传文件名两两不同（不靠毫秒精度保证唯一）')

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

console.log('== 8b. 清理缓存「点了没反应」不许再复发 ==')
{
  // 根因链：运行中的 GPUCache / DawnCache 被 Chromium 自己持有 → 删除必然 EPERM，
  // 而旧代码 `catch {}` 把它静默吞了、返回值里没有失败痕迹、界面也什么都不说。
  // 于是用户点了「清理缓存」看到的就是「没反应」。下面逐环钉住。
  const api = src('electron/api.cjs')
  ok(!/catch \{ \/\* 个别文件锁住/.test(api), '主进程不再静默吞掉删除失败')
  ok(/require\('\.\/cache\.cjs'\)/.test(api), '缓存实现抽到 cache.cjs（main.cjs 启动早期也要用）')
  ok(/cache\.cacheInfo\(ctx\.app\.userDataDir\)/.test(api), 'app:cacheInfo 委托 cache.cjs')
  ok(/cache\.clearCache\(ctx\.app\.userDataDir\)/.test(api), 'app:clearCache 委托 cache.cjs')

  const cacheSrc = src('electron/cache.cjs')
  ok(/failed\.push\(\{ name, size: s, error:/.test(cacheSrc), '删不掉的记进 failed，带原因和体积')
  ok(/writePending\(userDataDir, \[\.\.\.readPending\(userDataDir\), \.\.\.failed\.map/.test(cacheSrc),
    'failed 自动排队到下次启动')
  ok(!/require\('electron'\)/.test(cacheSrc), 'cache.cjs 是纯 Node 模块（不 require electron，main/api 都能用）')

  // 位置就是正确性本身：必须赶在 GPU 进程打开这两个目录之前，否则一样 EPERM
  const main = src('electron/main.cjs')
  const sweepAt = main.indexOf('runPendingCleanup')
  const readyAt = main.indexOf('app.whenReady()')
  ok(sweepAt > -1, 'main.cjs 启动时清理上次没清掉的缓存')
  ok(sweepAt > -1 && readyAt > -1 && sweepAt < readyAt,
    '**清理必须排在 app.whenReady() 之前**（晚于它 GPU 进程已持有 GPUCache，白清）', { sweepAt, readyAt })
  ok(/try \{[\s\S]{0,400}?runPendingCleanup[\s\S]{0,400}?\} catch/.test(main),
    '清理失败不能挡住启动（整段包在 try/catch 里）')

  // 界面：必须把结果说出来，且「排到下次启动」要和「已清掉」区分开
  const app = src('src/App.vue')
  ok(/const cacheMsg = ref\(''\)/.test(app), '界面有清理结果的状态位')
  ok(/已清理 \$\{fmtCacheSize\(r\.freed\)\}/.test(app), '清掉了多少，如实说')
  ok(/if \(r\.freed >= 1024\)/.test(app),
    '不足 1KB 不报「已清理 0 KB」（Chromium 的 Cache 目录常年只有几十字节索引，报了是噪音）')
  ok(/正被系统占用，将在下次启动时清理/.test(app), '**当场清不掉的要交代去向**（不许「没反应」）')
  ok(/已无可清理缓存/.test(app), '真的没缓存可清时也有话说')
  ok(/r\.queued/.test(app) && /r\.failed/.test(app), '界面读的是 failed / queued，不是自己猜')
  ok(/cacheMsgFail\.value = true/.test(app), '异常路径有独立标志（不是只说「已无缓存」）')
  ok(/'cr-warn'/.test(app), '「排到下次启动」用警示色（需要用户知情）')
  ok(/\.cr-warn \{/.test(app), 'cr-warn 有对应样式')
  ok(/openAbout[\s\S]{0,120}?cacheMsg\.value = ''/.test(app), '重开「关于」清掉上次的结果文案')
}

console.log('== 8c. 「关于」不再挂使用说明入口（顶栏「说明」是唯一入口） ==')
{
  const app = src('src/App.vue')
  ok(!/查看使用说明/.test(app), '「关于」里没有「查看使用说明」按钮了')
  ok(!/>\s*使用说明\s*<\/button>/.test(app), '没有残留的「使用说明」按钮文案')
  // 删干净 ≠ 把功能删了：顶栏入口与弹窗必须都还在，否则是误删
  ok(/showGuide = true/.test(app), '顶栏「说明」入口还在')
  ok(/<GuideDialog v-if="showGuide"/.test(app), '使用说明弹窗还在挂载')
  ok(/import GuideDialog from '\.\/components\/GuideDialog\.vue'/.test(app), 'GuideDialog 组件仍被引用')
  // 说明文档本身不许被顺手删掉
  ok(fs.existsSync(path.join(__dirname, '..', 'src', 'components', 'GuideDialog.vue')), 'GuideDialog.vue 还在')
  ok(fs.existsSync(path.join(__dirname, '..', 'docs', '使用说明.md')), 'docs/使用说明.md 还在')
}

console.log('== 9. 列显隐：不许变成「静默改打印」，也不许「藏了找不回」 ==')
{
  const dv = src('src/views/DatasetView.vue')

  // 9a. 先修隐患：display-settings 原本是 { tableSize: v } 单字段覆写。
  // 往里加 hiddenColumns 之后，用户点一次字号就会把隐藏状态整个清掉，而且不报错。
  ok(!/saveData\('display-settings', \{ tableSize: v \}\)/.test(dv),
    '不再用 { tableSize: v } 单字段覆写（那会顺手清掉 hiddenColumns）')
  ok(/hiddenColumns: hiddenColumns\.value/.test(dv), '写下去的是内存镜像整体（含 hiddenColumns）')
  const dsWrites = (dv.match(/saveData\('display-settings'/g) || []).length
  ok(dsWrites === 1, '只此一处写 display-settings（多个写点就是多个覆写风险）', dsWrites)
  ok(/let prefsLoaded = false/.test(dv) && /if \(!prefsLoaded\) return/.test(dv),
    '读到落盘值之前不许写（否则拿空镜像盖掉用户存着的隐藏状态）')
  ok(/prefsLoaded = true/.test(dv), '读成功才开闸')

  // 9b. 状态住在已有的 display-settings 里——store 是白名单制（第 1 节钉着「只能两个键」）
  ok(/sanitizeHidden\(saved && saved\.hiddenColumns\)/.test(dv),
    '读回时做形状校验（落盘 JSON 用户可手工编辑）')
  ok(/from '\.\.\/lib\/column-visibility\.cjs'/.test(dv),
    '纯逻辑抽到 column-visibility.cjs（可直接单测，见 test/column-visibility.cjs）')
  ok(fs.existsSync(path.join(__dirname, '..', 'test', 'column-visibility.cjs')),
    '那个套件确实存在')

  // 9c. 渲染必须走「可见列」，否则隐藏了还在画
  const visibleLoops = (dv.match(/v-for="col in visibleColumns"/g) || []).length
  ok(visibleLoops === 2, '表头与表体两处都按可见列渲染', visibleLoops)
  ok((dv.match(/v-for="col in columns"/g) || []).length === 1
    && /<label v-for="col in columns"/.test(dv),
    '还在直接迭代全量列的只剩显隐菜单里的复选框清单')
  ok(/hiddenKeysOf\(hiddenColumns\.value, activeId\.value, columns\.value\)/.test(dv),
    '隐藏集只收当前数据集真实存在的 key（换过文件的旧 key 不算数）')

  // 9d. 序号列与操作列天然不可隐藏：它们根本不在 v-for 里
  ok(/<th class="rownum-col">#<\/th>/.test(dv) && /<th class="op-col">操作<\/th>/.test(dv),
    '「#」与「操作」是固定表头，不在可隐藏的列集合里')

  // 9e. 至少留一列 + 必须有一条显眼的回头路
  ok(/canHideMore\(columns\.value, hiddenSet\.value\)/.test(dv), '有「至少留一列」的判定')
  ok(/function hideColumn[\s\S]{0,120}?!canHideMoreCols\.value\) return/.test(dv),
    'hideColumn 里挡了一次')
  ok(/function toggleColumnVisible[\s\S]{0,200}?!canHideMoreCols\.value\) return/.test(dv),
    '复选框路径也挡了一次（界面上禁用只是第一道）')
  ok(/已隐藏 \{\{ hiddenCount \}\} 列/.test(dv), '工具栏给出「已隐藏 N 列」的回头入口')
  ok(/v-if="hiddenCount"/.test(dv), '只在真有隐藏时出现（没藏东西就不占工具栏）')
  ok(/恢复全部隐藏的列（\{\{ hiddenCount \}\}）/.test(dv), '列头菜单里也有一条恢复')

  // 9f. 硬规则：隐藏 ≠ 取消「印」。隐藏只动显示，一次都不碰 printOn / 数据集
  const printCalls = (dv.match(/setColumnPrint/g) || []).length
  ok(printCalls === 1, '整个数据页只有「印」开关一处调 setColumnPrint —— 隐藏路径碰不到它', printCalls)
  ok(!/function applyHidden[\s\S]{0,300}?updateCell/.test(dv), '隐藏路径不写单元格')
  ok(!/function applyHidden[\s\S]{0,300}?renameColumn/.test(dv), '隐藏路径不改列名')
  ok(/仅隐藏显示，不影响「印」与打印/.test(dv), '菜单里把这条规则写给用户看')

  // 9g. 补录跳转撞上隐藏列：必须自动展开，否则从打印中心跳过来只看到一片空白
  const expandAt = dv.indexOf('if (hiddenSet.value.has(req.key))')
  const queryAt = dv.indexOf('[data-ri="${req.rowIndex}"][data-ck=')
  ok(expandAt > -1, '补录跳转有「目标列被隐藏」的分支')
  ok(expandAt > -1 && queryAt > -1 && expandAt < queryAt,
    '**先展开、再定位**（反过来滚动到的是一个还不存在的格子）', { expandAt, queryAt })

  // 9h. 浮层菜单：th 上有 overflow:hidden，留在表头里会被裁掉
  ok(/<Teleport to="body">/.test(dv), '菜单 Teleport 到 body（否则被 th 的 overflow 裁掉）')
  ok(/\.col-menu \{[\s\S]{0,120}?position: fixed/.test(dv), '菜单用 fixed 定位')
  const triggers = (dv.match(/^[ \t]*data-menu-trigger[ \t]*$/gm) || []).length
  ok(triggers === 2, '两个触发器（列头 ▾ 与胶囊）都打了标记', triggers)
  ok(/closest\('\[data-menu-trigger\]'\)/.test(dv),
    '点触发器不算「点外面」（否则 mousedown 先关、click 再开，看起来像点它关不掉）')
  ok(/e\.key === 'Escape'/.test(dv), 'Esc 能收起菜单')
  ok(/t instanceof Node/.test(dv),
    '滚动 / resize 收起菜单，但菜单内部滚动不算（resize 的 target 是 window 不是 Node，直接 contains 会抛错）')
  ok(/removeEventListener\('mousedown', onDocMouseDown, true\)/.test(dv),
    '卸载时摘掉监听（页面来回切不会越挂越多）')
  ok(/selectDataset[\s\S]{0,200}?closeMenus\(\)/.test(dv),
    '切换数据集时收起菜单（菜单里记的是上一个数据集的列）')
  ok(/pruneStaleHidden/.test(dv), '清掉已删数据集留下的隐藏记录（这个 map 只增不减）')

  // 9i. 列头「▾」默认隐身，但不能把已有的「印」挤出去
  ok(/\.col-menu-btn \{[\s\S]{0,400}?opacity: 0/.test(dv), '「▾」默认隐身（列头已有两个热区）')
  ok(/\.col-head:hover \.col-menu-btn/.test(dv), 'hover 才现')
  ok(/\.th-alias \{[\s\S]{0,200}?text-overflow: ellipsis/.test(dv),
    '列名出省略号（否则长列名会把「印」和「▾」一起挤出 th 可视区，两个开关都点不到）')

  // 9j. 跨 IPC 传参必须是纯对象。
  // ref 里装的是 Vue 响应式 Proxy，而 IPC 传参走结构化克隆，Proxy 克隆不了
  // （"An object could not be cloned."）。这个错是**同步**抛的，又会被 Vue 的事件处理
  // 吞掉 —— 表现成「状态改了、盘上没写」，从界面完全看不出来（隐藏列之后菜单关不上，
  // 就是同一次操作里后面的语句被这个异常截断了）。TemplateView 存模板也踩过同一个坑，
  // 所以这里扫全量前端代码钉住，不只盯本次改的这一处。
  const reactiveArg = /(?:saveData|saveTemplate|printValidate|printGenerate|printSend|printExportPdf)\(\s*[^,()]+,\s*[A-Za-z_$][\w$]*\.value\s*[,)]/
  const leaky = []
  for (const f of walk(path.join(__dirname, '..', 'src'))) {
    if (reactiveArg.test(fs.readFileSync(f, 'utf-8'))) {
      leaky.push(path.relative(path.join(__dirname, '..'), f))
    }
  }
  ok(leaky.length === 0, '没有把响应式容器整个丢给 IPC 的调用点（结构化克隆会抛）', leaky)
  ok(/JSON\.parse\(JSON\.stringify\(\{[\s\S]{0,200}?hiddenColumns: hiddenColumns\.value/.test(dv),
    '写盘前先转纯对象（和 TemplateView 存模板同一手法）')
  ok(/function persistDisplay\(\) \{[\s\S]{0,900}?\} catch \{/.test(dv),
    '写盘调用整体兜住（saveData 是同步抛的，Vue 会吞掉事件处理里的异常）')

  // 9k. 读盘时机：补录跳转的 immediate 回调在 **setup 阶段**就跑，要读隐藏状态判断
  // 「目标列是不是被藏了」。挂在 onMounted 里读就晚了——跳转回来时读到的还是空 map，
  // 自动展开失效（真机 e2e 抓到过这个竞态；顺带它还会把刚写下去的隐藏状态用旧值盖回来）。
  ok(/const prefsReady = loadDisplayPrefs\(\)/.test(dv),
    '落盘偏好在 setup 阶段就发起读取（不等 onMounted）')
  const awaitPrefsAt = dv.indexOf('await prefsReady')
  const hiddenCheckAt = dv.indexOf('if (hiddenSet.value.has(req.key))')
  ok(awaitPrefsAt > -1 && hiddenCheckAt > -1 && awaitPrefsAt < hiddenCheckAt,
    '补录跳转在判断「目标列被藏」之前先等读盘落地', { awaitPrefsAt, hiddenCheckAt })
  ok(!/onMounted\(\(\) => \{[\s\S]{0,200}?loadDisplayPrefs\(\)/.test(dv),
    'onMounted 不再重复读一次（晚读会把刚写下去的隐藏状态用旧值盖回来）')

  // 9l. 打印历史的「状态」徽标不许被拆行。
  // 用户截图：窗口非最大化时，状态列被压到一字宽，「完成」拆成「完」/「成」两行。
  // 根因：.det-flag 没用 white-space: nowrap，浏览器按 min-content（一字宽）给列宽。
  // 修法（与所有「st-ok/st-failed/st-canceled」徽标共用）：white-space: nowrap + inline-block。
  const pcSrc = src('src/views/PrintCenterView.vue')
  const detFlagBlock = /\.det-flag\s*\{[^}]*\}/.exec(pcSrc)
  ok(detFlagBlock, '.det-flag 规则存在', detFlagBlock && detFlagBlock[0])
  ok(detFlagBlock && /white-space\s*:\s*nowrap/.test(detFlagBlock[0]),
    '.det-flag 设了 white-space: nowrap（关键修复；表格列会按 unbreakable 宽度分配）')
  ok(detFlagBlock && /display\s*:\s*inline-block/.test(detFlagBlock[0]),
    '.det-flag 设了 display: inline-block（让 padding/border 可预测，不再被 inline 的基线对齐影响）')
  ok(!/^\s*\.det-flag\s*{[^}]*white-space\s*:\s*normal/.test('x' + (detFlagBlock && detFlagBlock[0])),
    '.det-flag 没有把 white-space 写回 normal')
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

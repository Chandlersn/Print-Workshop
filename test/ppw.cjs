/**
 * ppw（批处理工作台）纯函数验收。
 *
 * 这套工具的每一次出错都出在「口径」上，而不是「代码写错」：
 *   · 哪个索引算「这一行的行号」（数据集 0 基 vs Excel 1 基）
 *   · 编号为空的行算不算缺文件
 *   · 备份目录里的图算不算已出
 *   · Excel 和数据集不一致时，该改哪边
 * 所以测试重点全在这些判定上，不测命令行输出格式。
 *
 * 不连宿主、不读真实名册：所有输入都是合成数据 + 临时目录里的空 png。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const cli = require('../tools/ppw/cli.cjs')
const config = require('../tools/ppw/config.cjs')
const roster = require('../tools/ppw/roster.cjs')
const store = require('../tools/ppw/store.cjs')
const report = require('../tools/ppw/report.cjs')
const select = require('../tools/ppw/select.cjs')
const { planExport } = require('../tools/ppw/cmd/export.cjs')
const { auditUnits } = require('../tools/ppw/cmd/audit.cjs')

let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ppw-test-'))
const OUT = path.join(TMP, 'out')
const BAK = path.join(OUT, '_partial_backup')

function touch(sheet, fileName) {
  const dir = path.join(OUT, sheet)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), '')
}

function makeCfg() {
  return {
    ...config.DEFAULTS,
    outputDir: OUT,
    backupDir: BAK,
    reportDir: TMP,
    templateId: 'tpl_test',
    fileNameFields: ['1', '姓名'],
    skipCert: [{ sheet: 'U_SKIP', name: '不出的', reason: '测试' }],
    excelPending: [],
    excelSettled: [],
    knownDialects: [{ field: '奖项情况', datasetIs: '个人复赛{excel}' }],
  }
}

/** 合成一份 grid（等同 xlsx 的 sheet_to_json header:1 输出） */
function grid(rows) {
  return [['1', '姓名＊', '组别', '省/自治区/直辖市＊', '所在学校（必须写全名）＊', '指导老师', '证书编号', '奖项情况', '赛项'], ...rows]
}

function fullRow(code, name, over = {}) {
  return [
    code, name,
    over.组别 ?? '小学（1-2年级）',
    over.省 ?? '四川省',
    over.学校 ?? '成都市实验小学',
    over.指导 ?? '李老师',
    over.证书 ?? 'CS001',
    over.奖项 ?? '二等奖',
    over.赛项 ?? '经典诵读',
  ]
}

function main() {
  const cfg = makeCfg()

  console.log('== 1. argv 解析 ==')
  {
    const a = cli.parseArgs(['export', '--unit=61,62', '--dry', '--limit', '2'])
    ok(a.positional[0] === 'export', '第一个位置参数是命令名', a.positional)
    ok(a.flags.unit === '61,62', '--unit=61,62 取到原串', a.flags.unit)
    ok(a.flags.dry === true, '--dry 是布尔开关，不会把后面的 2 吞成自己的值', a.flags.dry)
    ok(a.flags.limit === '2', '--limit 2 空格形式也能取到值', a.flags.limit)

    const set = cli.parseUnitSet('61, 62 ,63')
    ok(set.size === 3 && set.has(62), '--unit 支持逗号与空格混排', [...set])

    let threw = false
    try { cli.parseUnitSet('a,b') } catch (e) { threw = e.code === 'USAGE' }
    ok(threw, '非数字序号 → 用法错误（不会静默忽略）')

    const b = cli.parseArgs(['fix', '--set', '指导老师=张老师', '--set', '组别=初中组'])
    ok(Array.isArray(b.flags.set) ? b.flags.set.length === 2 : b.flags.set === '初中组',
      '--set 重复出现时不丢值（后者覆盖或成数组，反正不能只剩第一个）', b.flags.set)
  }

  console.log('== 2. 表头匹配 ==')
  {
    const h = ['1', '姓名＊', '组别', '省/自治区/直辖市＊', '指导老师']
    ok(config.matchHeader(h, 'prefix:姓名') === 1, 'prefix:姓名 命中「姓名＊」')
    ok(config.matchHeader(h, 'eq:组别') === 2, 'eq:组别 精确命中')
    ok(config.matchHeader(h, 'contains:指导') === 4, 'contains:指导 命中「指导老师」')
    ok(config.matchHeader(h, 'eq:姓名') === -1, 'eq 不做前缀匹配（eq:姓名 认不出「姓名＊」）')
    let threw = false
    try { config.parseMatcher('regex:^x') } catch { threw = true }
    ok(threw, '未知匹配方式立刻报错，不留到跑批中途')

    // 真实表头形态：用配置里的默认规则必须能全部定位
    const real = ['1', '姓名＊', '身份证号＊', '年龄＊', '省/自治区/直辖市＊', '所在学校（必须写全名）＊',
      '年级＊', '联系方法＊', '监护人姓名＊', '实际奖项', '单位序号', '机构', '负责单位',
      '指导老师', '赛项', '负责', '证书编号', '奖项情况', '组别']
    const misses = config.DEFAULTS.requiredFields
      .filter(f => config.matchHeader(real, f.match) < 0)
      .map(f => f.key)
    ok(misses.length === 0, '默认 8 条规则能全部命中真实表头', misses)

    // 兄弟列不能互抢：真实表头里「实际奖项」(9) 和「奖项情况」(17) 都含「奖项」。
    // 曾经有张证书把一等奖印成二等奖，就是这里串了列——模板渲染的是奖项情况，读的却是实际奖项。
    ok(config.matchHeader(real, 'eq:奖项情况') === 17, 'eq:奖项情况 取到奖项情况列，不是「实际奖项」',
      config.matchHeader(real, 'eq:奖项情况'))
    ok(config.matchHeader(real, 'contains:奖项') === 9, 'contains:奖项 先撞上「实际奖项」——所以不能拿它认奖项情况')
    ok(config.matchHeader(['姓名＊', '姓名'], 'prefix:姓名') === 1, '有完全同名表头时精确命中优先，不被前缀规则抢走')

    // 端到端：拿到 8 个字段值后，奖项情况必须等于第 18 列，而不是第 10 列
    const row = ['1', '甲', '身份证', '10', '四川省', '某小学', '三年级', '138', '家长',
      '二等奖', '165', '某机构', '某机构', '张老师', '经典诵读', '李', 'CS001', '个人复赛一等奖', '小学']
    const u = roster.parseSheet([real, row], '165_某单位', config.DEFAULTS)
    ok(u.rows[0].values.奖项情况 === '个人复赛一等奖', '奖项情况取自奖项情况列（不是实际奖项）', u.rows[0].values.奖项情况)
    ok(u.rows[0].values.指导老师 === '张老师', '指导老师仍取「指导老师」列', u.rows[0].values.指导老师)
  }

  console.log('== 3. 名册解析口径 ==')
  {
    const g = grid([
      fullRow('100', '张三'),
      ['', '', '', '', '', '', '', '', ''],       // 全空行，必须被过滤
      fullRow('101', '李四', { 指导: '' }),        // 缺指导老师
      fullRow('', '王五'),                         // 编号空
    ])
    const unit = roster.parseSheet(g, '7_某单位', cfg)
    ok(unit.rows.length === 3, '全空行被过滤，3 条有效行', unit.rows.length)
    ok(unit.no === 7, '单位序号取工作表名前缀', unit.no)
    ok(unit.rows[0].dataRow === 0 && unit.rows[0].excelRow === 2, 'dataRow 0 基、excelRow 1 基（第 1 行是表头）',
      { d: unit.rows[0].dataRow, e: unit.rows[0].excelRow })
    ok(unit.rows[1].dataRow === 1 && unit.rows[1].excelRow === 4, '跳过空行后 excelRow 仍对准 Excel 实际行号',
      { d: unit.rows[1].dataRow, e: unit.rows[1].excelRow })
    ok(unit.rows[1].blanks.join() === '指导老师', '缺字段精确到字段名', unit.rows[1].blanks)
    ok(unit.rows[2].code === '', '编号为空的行照常保留（由出片环节跳过，而不是在解析时丢）')
    ok(unit.missingColumns.length === 0, '必填列都能定位')

    ok(roster.fileStem(unit.rows[0]) === '100_张三', '文件名主体 = 编号_姓名')
    ok(roster.fileStem(unit.rows[2]) === '', '编号空 → 文件名主体为空串（调用方据此跳过）')

    // 整表缺列：不能因为定位不到列就当成「字段都齐」
    const g2 = [['1', '姓名＊'], ['1', '甲']]
    const u2 = roster.parseSheet(g2, '8_缺列单位', cfg)
    ok(u2.missingColumns.length === config.DEFAULTS.requiredFields.length - 1,
      '缺的列全部报出来（只缺姓名时不报，因为姓名缺失会直接抛）', u2.missingColumns)

    let threw = false
    try { roster.parseSheet([['1', '随便']], '9_没姓名列', cfg) } catch { threw = true }
    ok(threw, '连姓名列都没有 → 直接抛，不产出半成品计划')
  }

  console.log('== 4. Excel × 数据集差异方向 ==')
  {
    const row = { code: '1', name: '甲', values: { 指导老师: '张老师', 奖项情况: '二等奖', 组别: '小学' }, blanks: [] }
    const keys = ['指导老师', '奖项情况', '组别']

    const none = roster.diffRow(cfg, row, { 指导老师: '张老师', 奖项情况: '个人复赛二等奖', 组别: '小学' }, keys)
    ok(none.length === 0, '奖项简写属已知口径 → 不算差异', none)

    const filled = roster.diffRow(cfg, row, { 指导老师: '张老师', 奖项情况: '个人复赛二等奖', 组别: '' }, keys)
    ok(filled.length === 1 && filled[0].verdict === 'dataset-empty', 'Excel 有值数据集空 → dataset-empty', filled)
    ok(/同步进数据集后重出/.test(filled[0].action), '该方向的动作是「同步后重出」', filled[0].action)

    const cleared = roster.diffRow(cfg, { ...row, values: { ...row.values, 组别: '' } },
      { 指导老师: '张老师', 奖项情况: '个人复赛二等奖', 组别: '小学' }, keys)
    ok(cleared.length === 1 && cleared[0].verdict === 'dataset-filled', 'Excel 空数据集有值 → dataset-filled', cleared)
    ok(/只回填 Excel/.test(cleared[0].action), '该方向的动作是「只回填，不重出」——避免白跑一遍出片', cleared[0].action)

    const differ = roster.diffRow(cfg, row, { 指导老师: '李老师', 奖项情况: '个人复赛二等奖', 组别: '小学' }, keys)
    ok(differ.length === 1 && differ[0].verdict === 'value-differs', '两边都有值但不同 → value-differs', differ)

    const missing = roster.diffRow(cfg, row, undefined, keys)
    ok(missing[0].verdict === 'row-missing', '数据集缺整行 → row-missing（要重导，不是改单元格）', missing)
  }

  console.log('== 5. 磁盘文件分类 ==')
  {
    ok(store.stemOf('100_张三.png') === '100_张三', '普通文件名原样')
    ok(store.stemOf('100_张三 (2).png') === '100_张三', '「 (2)」副本后缀被去掉（否则会被当成另一张）')
    ok(store.stemOf('100_张三_改前.png') === '100_张三', '备份后缀「_改前」被去掉')

    const cls = store.classifyStems([
      '空值_甲.png',            // 历史残留
      '100_甲.png',             // 正常
      '200_乙.png', '201_乙.png', // 同人两场
      '300_丙.png', '300_丙 (2).png', // 重复副本
    ])
    ok(cls.junk.length === 1, '空编号残留识别出 1 个', cls.junk.map(j => j.file))
    ok(cls.multi.length === 1 && cls.multi[0].name === '乙', '同人两场按「编号不同、姓名相同」识别', cls.multi)
    ok(cls.dup.length === 1 && cls.dup[0].files.length === 2, '重复副本识别出 2 个文件（要人挑一个删）', cls.dup)
  }

  console.log('== 6. 出片计划（planExport）==')
  {
    touch('7_某单位', '100_张三.png')      // 已出
    touch('7_某单位', '104_已出但字段空.png')
    fs.mkdirSync(path.join(BAK, '7_某单位'), { recursive: true })
    fs.writeFileSync(path.join(BAK, '7_某单位', '105_在备份里.png'), '')   // 成品躺在备份目录

    const g = grid([
      fullRow('100', '张三'),                     // 已出
      fullRow('101', '李四', { 指导: '' }),        // 字段不全 → 拦截
      fullRow('102', '王五'),                     // 待出
      fullRow('', '编号空的'),                     // 编号空 → 跳过
      fullRow('104', '已出但字段空', { 指导: '' }),  // 已出 + 字段空 → 不重复出，但也不该算待出
      fullRow('105', '在备份里'),                  // 备份里有 → 算已出
    ])
    const unit = roster.parseSheet(g, '7_某单位', cfg)
    const rosterObj = { file: 'x.xlsx', batch: 'test', units: [unit] }
    const datasets = [{ id: 'ds1', name: 'test·7_某单位', rows: unit.rows.map(r => ({ '1': r.code, 姓名: r.name })) }]

    const plan = planExport(cfg, rosterObj, { datasets, backupStems: store.scanBackup(BAK) })
    ok(plan.stats.totalRows === 6, '总行数含编号空的行', plan.stats.totalRows)
    ok(plan.stats.skippedNoCode === 1, '编号空的行被跳过且单独计数', plan.stats.skippedNoCode)
    ok(plan.stats.blocked === 1 && plan.blocked[0].row.name === '李四', '字段不全的行被拦截', plan.blocked.map(b => b.row.name))
    ok(plan.stats.already === 2, '正式目录里已有的算已出', plan.stats.already)
    ok(plan.stats.backupOnly === 1 && plan.backupOnly[0].row.name === '在备份里',
      '备份目录里的成品单独计数（默认不采信：那是上次出片的旧版，可能已过时）', plan.backupOnly.map(b => b.row.name))
    ok(plan.stats.todoRows === 2, '待出 2 张：王五 + 备份里那张', plan.tasks.map(t => t.rows.map(r => r.name)))

    const withBak = planExport(cfg, rosterObj, { datasets, backupStems: store.scanBackup(BAK), includeBackup: true })
    ok(withBak.stats.already === 3 && withBak.stats.todoRows === 1,
      '--include-backup 时才认备份里的图（省掉重出，但由人负责确认它没过时）', withBak.stats)

    const noBak = planExport(cfg, rosterObj, { datasets })
    ok(noBak.stats.todoRows === 2 && noBak.stats.backupOnly === 0, '不传 backupStems 时完全不看备份目录', noBak.stats)

    const allow = planExport(cfg, rosterObj, { datasets, allowIncomplete: true, backupStems: store.scanBackup(BAK) })
    ok(allow.stats.blocked === 0 && allow.stats.todoRows === 3, '--allow-incomplete 时字段不全也放行', allow.stats)

    const limited = planExport(cfg, rosterObj, { datasets, limit: 1, backupStems: store.scanBackup(BAK) })
    ok(limited.tasks[0].rows.length === 1, '--limit 只截断待出行数', limited.tasks[0].rows.length)

    // 行序核对：数据集被重新导入导致行序变化时，必须拒绝而不是发错证
    const { assertAligned } = require('../tools/ppw/cmd/export.cjs')
    let threw = false
    try {
      assertAligned({ unit, dataset: { rows: [{ '1': '999', 姓名: '错的人' }] }, rows: [unit.rows[0]] }, ['1', '姓名'])
    } catch (e) { threw = /行序不一致/.test(e.message) }
    ok(threw, '数据集行序错位 → 拒绝出片（唯一能挡住「把 A 的证书发给 B」的闸门）')
  }

  console.log('== 7. 对账（auditUnits）==')
  {
    touch('10_正常单位', '200_甲.png')
    touch('11_全空单位', '不存在.png') // 建目录但无对应文件
    const g1 = grid([fullRow('200', '甲')])
    const g2 = grid([fullRow('201', '乙', { 组别: '' })])
    const units = [
      roster.parseSheet(g1, '10_正常单位', cfg),
      roster.parseSheet(g2, '11_缺组别单位', cfg),
      roster.parseSheet([], '12_空表单位', cfg),
    ]
    // 让 11 的图存在，确保「缺文件」不干扰「校验不通过」的判定
    touch('11_缺组别单位', '201_乙.png')

    const ds10 = { id: 'a', name: 't·10_正常单位', rows: [{ '1': '200', 姓名: '甲', 组别: '小学（1-2年级）', 指导老师: '李老师', 省自治区直辖市: '四川省', 所在学校必须写全名: '成都市实验小学', 证书编号: 'CS001', 奖项情况: '个人复赛二等奖', 赛项: '经典诵读' }] }
    const ds11 = { id: 'b', name: 't·11_缺组别单位', rows: [{ '1': '201', 姓名: '乙', 组别: '', 指导老师: '李老师', 省自治区直辖市: '四川省', 所在学校必须写全名: '成都市实验小学', 证书编号: 'CS001', 奖项情况: '个人复赛二等奖', 赛项: '经典诵读' }] }

    const r = auditUnits(cfg, [{ batch: 'test', units }], { datasets: [ds10, ds11], backupStems: new Set() })
    ok(r.stats.units === 3, '空表单位也保留在汇总里（否则单位数比名册少，看着像漏读）', r.stats.units)
    ok(r.stats.blankUnits === 1, '空表单独计数', r.stats.blankUnits)
    ok(r.stats.done === 2, '两张图都算已出', r.stats.done)
    ok(r.stats.missingFile === 0, '没有缺文件', r.stats.missingFile)
    ok(r.stats.blankRows === 1, '只把真缺字段的那行算作校验不通过', r.stats.blankRows)
    ok(r.stats.knownDialect === 2, '奖项简写两处都归入已知口径（不产生噪音行）', r.stats.knownDialect)
    ok(r.drift.length === 0, '口径差异不进「数据漂移」页', r.drift)
    ok(r.need.length === 1 && r.need[0].单位 === '11_缺组别单位', '只有缺字段那家需处理', r.need.map(u => u.单位))
    ok(r.actionable.length === 1 && r.actionable[0].优先级 === 'A·补数据重做',
      '已出图但字段空 → 判定为「补数据重做」而不是「新出」', r.actionable.map(a => a.优先级))

    // 不出证书名单：不算缺文件、不算校验不通过、不进待处理
    const g3 = grid([fullRow('300', '不出的', { 指导: '' })])
    const u3 = roster.parseSheet(g3, 'U_SKIP', cfg)
    const r2 = auditUnits(cfg, [{ batch: 'test', units: [u3] }], { datasets: [], backupStems: new Set() })
    ok(r2.skipList.length === 1, '进了「不出证书」页', r2.skipList)
    ok(r2.stats.missingFile === 0, '不出证书的人不算缺文件', r2.stats.missingFile)
    ok(r2.stats.blankRows === 0, '不出证书的人不算校验不通过', r2.stats.blankRows)
    ok(r2.actionable.length === 0, '不出证书的人不进待处理', r2.actionable)

    // 备份目录里躺着成品 → 计已出，同时提示归位
    const g4 = grid([fullRow('400', '丙')])
    const u4 = roster.parseSheet(g4, '13_备份单位', cfg)
    fs.mkdirSync(path.join(BAK, '13_备份单位'), { recursive: true })
    fs.writeFileSync(path.join(BAK, '13_备份单位', '400_丙.png'), '')
    const r3 = auditUnits(cfg, [{ batch: 'test', units: [u4] }], { datasets: [], backupStems: store.scanBackup(BAK) })
    ok(r3.stats.done === 1, '备份目录里的成品算已出（6_啊呜 11 张就是这么被误报成缺文件的）', r3.stats.done)
    ok(r3.stats.backupHits === 1, '单独统计「成品在备份目录」', r3.stats.backupHits)
    ok(r3.clean.some(c => c.类型 === '成品在备份目录'), '文件清理页提示归位', r3.clean)
  }

  console.log('== 8. CSV 输出 ==')
  {
    ok(report.csvCell('a,b') === '"a,b"', '含逗号加引号')
    ok(report.csvCell('他说"好"') === '"他说""好"""', '引号双写转义')
    ok(report.csvCell('换\n行') === '"换\n行"', '换行也要包起来，否则整行错位')
    ok(report.csvCell(0) === '0', '数字 0 保留（不能被 falsy 吞成空）')

    const f = path.join(TMP, 't.csv')
    report.writeCsv(f, ['列一', '列二'], [{ 列一: '甲', 列二: '乙' }])
    const text = fs.readFileSync(f, 'utf-8')
    ok(text.charCodeAt(0) === 0xfeff, 'CSV 带 BOM（否则中文在部分预览器里乱码）')
    ok(text.includes('"列一","列二"'), '表头显式带引号，不会看起来像没有表头', text.slice(0, 20))
  }

  console.log('== 9. 名册正被 Excel 打开时要提示 ==')
  {
    // Windows 上「用户改了但没保存」是唯一无解的沟通死结：磁盘 mtime 停在最后一次保存，
    // 读到的永远是旧值。锁文件是唯一线索，必须提示出来。
    const dir = path.join(TMP, 'lockprobe')
    fs.mkdirSync(dir, { recursive: true })
    const book = path.join(dir, '合并_9-9号.xlsx')
    fs.writeFileSync(book, 'x')

    const warns = []
    const ctx = { cfg, flags: {}, log: { warn: m => warns.push(m), info: () => {}, ok: () => {} } }

    select.warnIfOpenInEditor(ctx, [book])
    ok(warns.length === 0, '没有锁文件 → 不提示（别没事找事）', warns)

    fs.writeFileSync(path.join(dir, '~$合并_9-9号.xlsx'), 'lock')
    select.warnIfOpenInEditor(ctx, [book])
    ok(warns.length === 1, '有 ~$ 锁文件 → 提示一次', warns.length)
    ok(/Ctrl\+S/.test(warns[0] || ''), '提示里必须给出可执行动作（Ctrl+S 保存）', warns[0])
    ok(/合并_9-9号\.xlsx/.test(warns[0] || ''), '提示要点名是哪份文件', warns[0])
  }

  console.log('== 10. 局部裁剪（核对形近字用） ==')
  {
    // 「钥/玥」「街/节」这类只差偏旁的字，在成品图缩略图下看不出来，
    // 而这恰好是这批数据最高频的错误。裁剪工具必须保证：像素原样、不插值、不越界。
    const pngcrop = require('../tools/png-crop.cjs')

    // 4×2 的 RGB 图，每个像素三个通道都填成同一个可辨识的值
    const vals = [10, 20, 30, 40, 50, 60, 70, 80]
    const src = {
      width: 4, height: 2, channels: 3,
      data: Buffer.from(vals.flatMap(v => [v, v, v]))
    }
    const px = (x, y) => src.data[(y * 4 + x) * 3]

    // encode → decode 往返：像素与尺寸都不能变
    const f1 = path.join(TMP, 'crop-roundtrip.png')
    pngcrop.encode(src, f1, 1)
    const back = pngcrop.decode(f1)
    ok(back.width === 4 && back.height === 2, '往返后尺寸不变', back.width + 'x' + back.height)
    ok(px(0, 0) === back.data[0] && px(3, 1) === back.data[(1 * 4 + 3) * 3], '往返后像素不变（无损）')

    // crop 取的是指定矩形，左上角对应 (x,y)
    const sub = pngcrop.crop(src, 1, 1, 2, 1)
    ok(sub.width === 2 && sub.height === 1, '裁剪尺寸正确', sub.width + 'x' + sub.height)
    ok(sub.data[0] === px(1, 1) && sub.data[3] === px(2, 1), '裁的是 (1,1) 起的两个像素', [...sub.data])

    // 放大必须是最近邻：2 倍后每个源像素铺成 2×2，数值不能出现插值出来的中间色
    const f2 = path.join(TMP, 'crop-scale2.png')
    pngcrop.encode(sub, f2, 2)
    const big = pngcrop.decode(f2)
    ok(big.width === 4 && big.height === 2, '放大 2 倍尺寸正确', big.width + 'x' + big.height)
    const row = [0, 1, 2, 3].map(x => big.data[(0 * 4 + x) * 3])
    ok(row[0] === row[1] && row[2] === row[3], '放大后同一源像素的两列数值相同（最近邻，无插值）', row)
    ok(new Set(row).size === 2, '放大后只出现原有的两种灰阶，不引入中间色', row)

    // 越界必须报错，不能悄悄裁出黑边
    let threw = false
    try { pngcrop.crop(src, 3, 1, 2, 1) } catch { threw = true }
    ok(threw, '裁剪区越界要抛错，不能返回残缺图')
  }

  console.log('== 11. 点亮字段校验（模板字段提取） ==')
  {
    // verify 的全部结论都建立在一个事实上：「模板要渲染哪些字段」是从模板导出的，
    // 不是从配置猜的。提取错了，后面的比对就全错。
    const verify = require('../tools/ppw/cmd/verify.cjs')

    const tpl = {
      fields: [
        { column: '姓名' },
        { column: '奖项情况' },
        { column: '姓名' },          // 同列放两次（同一字段多个位置）不算两个字段
        { column: '' },              // 空列名要忽略
        { label: '只有 label 没有 column' },
      ],
    }
    const cols = verify.templateColumns(tpl)
    ok(cols.length === 2, '同一列重复放置算一个字段，空 column 忽略', cols)
    ok(cols[0] === '姓名' && cols[1] === '奖项情况', '保持模板里的出现顺序', cols)

    // readTemplates 两种存储结构都要认
    const dirA = path.join(TMP, 'tplA')
    fs.mkdirSync(dirA, { recursive: true })
    fs.writeFileSync(path.join(dirA, 'templates.json'), JSON.stringify([{ id: 'a', fields: [] }]))
    ok(verify.readTemplates(dirA).length === 1, '模板文件是数组时能读', verify.readTemplates(dirA))

    const dirB = path.join(TMP, 'tplB')
    fs.mkdirSync(dirB, { recursive: true })
    fs.writeFileSync(path.join(dirB, 'templates.json'), JSON.stringify({ templates: [{ id: 'b' }] }))
    ok(verify.readTemplates(dirB)[0].id === 'b', '模板文件是 {templates:[]} 时也能读')

    let threw = false
    try { verify.readTemplates(path.join(TMP, 'nope')) } catch { threw = true }
    ok(threw, '模板文件缺失要抛错，不能静默返回空让校验假通过')
  }

  console.log('== 11. 必填清单随模板推导（字段数量不是写死的） ==')
  {
    // 用户的原话：「万一下一次是 9 个字段、5 个字段呢？难道就不起作用」
    // 所以这里钉的是「数量随模板走」，不是「这批必须是 8 个」。
    const config = require('../tools/ppw/config.cjs')

    const tpl5 = ['姓名', '组别', '奖项情况', '证书编号', '赛项']
    const merged = config.mergeRequiredFields(
      [{ key: '姓名', match: 'prefix:姓名' }, { key: '证书编号', match: 'eq:证书编号' }],
      tpl5)
    ok(merged.length === 5, '模板 5 个字段就校验 5 个（配置只给 2 个也补齐）', merged.map(f => f.key))
    ok(merged.map(f => f.key).join() === tpl5.join(), '顺序跟着模板走')
    ok(merged.find(f => f.key === '姓名').match === 'prefix:姓名', '配置给了 matcher 就沿用，不被覆盖')
    ok(merged.find(f => f.key === '组别').match === 'eq:组别', '没配的列退化为精确同名匹配')

    const tpl9 = [...tpl5, '省自治区直辖市', '所在学校必须写全名', '指导老师', '备注']
    ok(config.mergeRequiredFields([], tpl9).length === 9, '模板 9 个字段就是 9 个')
    ok(config.mergeRequiredFields([], tpl9).find(f => f.key === '备注').match === 'eq:备注',
      '完全没配置时也能靠精确同名兜底')

    const extra = config.mergeRequiredFields([{ key: '身份证号', match: 'eq:身份证号' }], tpl5)
    ok(extra.length === 6 && extra[5].key === '身份证号',
      '模板不渲染但配置要求非空的列照样校验（多校验一次无害）', extra.map(f => f.key))

    ok(config.mergeRequiredFields([{ key: '姓名', match: 'prefix:姓名' }], null).length === 1,
      '模板读不到时退回配置，不会把清单清空')

    // 编号列：换一批叫「学号」也认得出，不是只有「证书编号」
    ok(config.pickIdField([{ key: '姓名' }, { key: '学号' }]) === '学号', '认得出「学号」当编号列')
    ok(config.pickIdField([{ key: '姓名' }, { key: '参赛号' }]) === '参赛号', '认得出「参赛号」')
    ok(config.pickIdField([{ key: '姓名' }, { key: '组别' }]) === '姓名', '一个都认不出时退回第一列')
    ok(config.pickIdField([]) === '', '空清单返回空串，不炸')
  }

  // 收尾清理走项目统一的 rmDeepSafe：宿主注入的 safe-delete 会拦「一次删太多」，
  // 直接 rmSync 递归会整条测试链崩在这里（清理不是被测行为，不该让测试变红）
  require('./helpers/rm.cjs').rmDeepSafe(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

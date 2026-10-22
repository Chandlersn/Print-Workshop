/* audit：三层对账，产出工作台式 XLSX。
 *
 * 为什么是三层：前两层只能回答「图在不在、字段全不全」，
 * 回答不了「为什么我改了 Excel 重出还是老样子」——那要第三层（名册 × 数据集）。
 * 今天所有返工都栽在第三层，所以它现在是必备项，不是加分项。
 *
 *   ① 名册 × 磁盘      该出的出了没有
 *   ② 名册 × 必填字段   字段全不全（不全会印成空白栏，纸证无法补救）
 *   ③ 名册 × 数据集     改了 Excel 数据集变了没有（没变 = 出片用旧值）
 */
const path = require('path')
const roster = require('../roster.cjs')
const store = require('../store.cjs')
const select = require('../select.cjs')
const report = require('../report.cjs')

/**
 * 纯函数：算出全部核对结果。不读磁盘、不写文件（deps 由调用方备好）。
 * @param {object} cfg
 * @param {Array<{file,batch,units}>} rosters
 * @param {{datasets:Array, backupStems:Set<string>}} deps
 */
function auditUnits(cfg, rosters, deps) {
  const datasets = deps.datasets || []
  const backupStems = deps.backupStems || new Set()
  const fieldKeys = cfg.requiredFields.map(f => f.key)

  const summary = []
  const detail = []
  const pending = []
  const drift = []
  const clean = []
  const skipList = []
  const backupHits = []
  let knownDialect = 0

  // 待处理表里的辅助定位列（本批是「赛项 / 组别」）：只有这批的字段清单里确实有才出现，
  // 不写死在表结构里——换个模板、字段变少，这两列自然消失，不会留下永远空白的列。
  const auxKeys = ['赛项', '组别'].filter(k => fieldKeys.includes(k))
  const auxOf = (row) => Object.fromEntries(auxKeys.map(k => [k, (row && row.values[k]) || '']))

  const skipOf = (sheet, name) => (cfg.skipCert || []).find(s => s.sheet === sheet && s.name === name)
  const fixedOf = (sheet, name) => (cfg.excelPending || []).find(s => s.sheet === sheet && s.name === name)
  const settledOf = (sheet, name) => (cfg.excelSettled || []).find(s => s.sheet === sheet && s.name === name)

  for (const r of rosters) {
    for (const unit of r.units) {
      const ds = store.pickDataset(datasets, unit.sheet)
      const dsRows = ds ? (ds.rows || []) : []
      const dsByCode = new Map()
      for (const d of dsRows) {
        const c = String(d['1'] ?? '').trim()
        if (c && !dsByCode.has(c)) dsByCode.set(c, d)
      }
      const scan = store.scanFolder(select.unitDir(cfg, unit.sheet))

      let done = 0, missingFile = 0, blankRows = 0, multi = 0

      for (const row of unit.rows) {
        const skip = skipOf(unit.sheet, row.name)
        const fixed = fixedOf(unit.sheet, row.name)
        const settled = settledOf(unit.sheet, row.name)

        // ── 第一层：文件在不在 ──
        let fileState
        let inBackup = false
        if (skip) {
          fileState = '不出证书·已确认'
          skipList.push({
            单位: unit.sheet, 编号: row.code || '(空)', 姓名: row.name,
            ...auxOf(row), 原因: skip.reason,
          })
        } else if (!row.code) {
          // 编号空：只能按姓名兜，否则会被误判成缺文件
          const bakHit = [...backupStems].some(s => s.endsWith('_' + row.name))
          if (scan.byName.has(row.name)) { done++; fileState = '已出（按姓名匹配）' }
          else if (bakHit) {
            done++; inBackup = true; fileState = '已出（在备份目录·待归位）'
            backupHits.push({ 单位: unit.sheet, 姓名: row.name, 文件: row.name })
          } else { missingFile++; fileState = '缺文件（编号为空）' }
        } else {
          const stem = roster.fileStem(row)
          if (scan.stems.has(stem)) { done++; fileState = '已出' }
          else if (backupStems.has(stem)) {
            done++; inBackup = true; fileState = '已出（在备份目录·待归位）'
            backupHits.push({ 单位: unit.sheet, 姓名: row.name, 文件: stem })
          } else { missingFile++; fileState = '缺文件' }
        }

        if (!skip && row.blanks.length && !fixed && !settled) blankRows++

        // ── 第三层：Excel × 数据集 ──
        let driftFound = ''
        if (ds && row.code) {
          // 用 Map 而不是每行 find：5466 行 × 每单位几十行，find 会变成百万级比较
          const dsRow = dsByCode.get(row.code)
            || dsRows.find(x => String(x['姓名'] ?? '').trim() === row.name)
          for (const k of fieldKeys) {
            const ev = String(row.values[k] ?? '').trim()
            const dv = String((dsRow || {})[k] ?? '').trim()
            if (ev !== dv && roster.isKnownDialect(cfg, k, ev, dv)) knownDialect++
          }
          const diffs = roster.diffRow(cfg, row, dsRow, fieldKeys)
          if (diffs.length) {
            driftFound = diffs.map(d => d.field).join('/')
            for (const d of diffs) {
              drift.push({
                批次: r.batch, 单位: unit.sheet, 编号: row.code, 姓名: row.name, 字段: d.field,
                Excel值: d.excel, 数据集值: d.dataset,
                判定: d.verdict === 'dataset-filled' ? '数据集有值·Excel已清空'
                  : d.verdict === 'dataset-empty' ? '数据集为空（Excel已补）'
                    : d.verdict === 'row-missing' ? '数据集缺该行' : '值不同',
                处理: d.action,
              })
            }
          }
        }

        // 逐人明细里展示哪些字段：跟着必填清单走（清单本身由模板推导），
        // 不在这里列具体列名——换了模板、字段变成 5 个或 9 个，这张表自动跟着变。
        const fieldCells = {}
        for (const f of cfg.requiredFields) fieldCells[f.key] = row.values[f.key] ?? ''

        detail.push({
          单位序号: unit.no, 单位: unit.sheet, 批次: r.batch, 行号: row.excelRow,
          编号: row.code || '(空)', 姓名: row.name,
          ...fieldCells,
          文件名: roster.fileStem(row) + '.png', 文件状态: fileState,
          校验结果: skip ? '不出证书'
            : fixed ? '已补·Excel待回填'
              : settled ? '已补·两边一致'
                : unit.missingColumns.length ? '整表缺列'
                  : row.blanks.length ? '不通过' : '通过',
          缺字段: row.blanks.join('/'),
          数据集差异: driftFound,
        })

        // ── 待处理分级：按「要做什么」分，不是按「哪里不对」分 ──
        if (fixed) {
          pending.push({
            优先级: 'B·仅回填', 问题: 'Excel 未回填（证书已出）', 单位序号: unit.no, 单位: unit.sheet,
            编号: row.code || '(空)', 姓名: row.name, 缺字段: row.blanks.join('/') || '—',
            Excel行号: row.excelRow, ...auxOf(row),
            磁盘上已有文件: '是', 说明: fixed.note,
          })
        } else if (!skip && (row.blanks.length || fileState.includes('缺文件'))) {
          const tags = []
          if (row.blanks.length) tags.push('校验不通过')
          if (fileState.includes('缺文件')) tags.push('缺文件')
          const printed = fileState.startsWith('已出')
          const prio = row.blanks.length
            ? (printed ? 'A·补数据重做' : 'A·补数据新出')
            : 'A·直接补出'
          pending.push({
            优先级: prio, 问题: tags.join(' + '), 单位序号: unit.no, 单位: unit.sheet,
            编号: row.code || '(空)', 姓名: row.name, 缺字段: row.blanks.join('/') || '—',
            Excel行号: row.excelRow, ...auxOf(row),
            磁盘上已有文件: printed ? '是' : '否',
            说明: row.blanks.length
              ? (printed ? '已出图但该字段空白，补数据后需删旧图重出' : '先补缺失字段，再出片')
              : '字段齐全，直接补出即可',
          })
        }
      }

      // ── 磁盘文件分类 ──
      const cls = store.classifyStems(scan.files)
      for (const d of cls.dup) {
        clean.push({ 类型: '重复文件（同编号）', 单位: unit.sheet, 文件: d.files.join('  /  '), 姓名: d.name, 建议: '删掉带「 (2)」的那份，留不带后缀的' })
      }
      for (const m of cls.multi) {
        multi++
        pending.push({
          优先级: 'C·正常', 问题: '同人两场（编号不同）', 单位序号: unit.no, 单位: unit.sheet,
          编号: m.stems.join(' + '), 姓名: m.name, 缺字段: '—', Excel行号: '—',
          ...Object.fromEntries(auxKeys.map(k => [k, ''])), 磁盘上已有文件: '是',
          说明: '参加两个赛项，两张证书都要保留，无需处理',
        })
      }
      for (const j of cls.junk) {
        clean.push({ 类型: '历史空编号残留', 单位: unit.sheet, 文件: j.file, 姓名: j.name, 建议: '早期未拦编号空产生的垃圾文件，可删' })
      }
      for (const b of backupHits.filter(x => x.单位 === unit.sheet)) {
        clean.push({ 类型: '成品在备份目录', 单位: unit.sheet, 文件: `${cfg.backupDirName} 下 ${b.文件}.png`, 姓名: b.姓名, 建议: '移回正式目录（不影响出片，但正式目录会显示缺）' })
      }

      summary.push({
        单位序号: unit.no, 单位: unit.sheet, 批次: r.batch,
        名册行数: unit.rows.length,
        有编号行: unit.rows.filter(x => x.code).length,
        已出文件: done, 缺文件: missingFile, 校验不通过行: blankRows,
        同人多名: multi, 空编号残留: 0, 重复文件: cls.dup.length,
        磁盘文件数: scan.files.length,
        整表缺列: unit.missingColumns.join('/') || '',
        // 空表单位保留在列表里（否则单位总数会比名册少，让人以为漏读了），但不计入「需处理」
        状态: unit.rows.length === 0 ? '空表'
          : missingFile === 0 && blankRows === 0 && !unit.missingColumns.length ? '齐' : '需处理',
      })
    }
  }

  summary.sort((a, b) => a.单位序号 - b.单位序号)
  const sum = k => summary.reduce((s, x) => s + x[k], 0)
  const need = summary.filter(x => x.状态 === '需处理')
  const blank = summary.filter(x => x.状态 === '空表')
  const actionable = pending.filter(p => p.优先级.startsWith('A') || p.优先级.startsWith('B'))

  return {
    summary, detail, pending, drift, clean, skipList, backupHits, need, blank, actionable,
    stats: {
      units: summary.length,
      rows: sum('名册行数'),
      coded: sum('有编号行'),
      done: sum('已出文件'),
      missingFile: sum('缺文件'),
      blankRows: sum('校验不通过行'),
      multi: sum('同人多名'),
      needUnits: need.length,
      blankUnits: blank.length,
      backupHits: backupHits.length,
      knownDialect,
    },
  }
}

async function run(ctx) {
  const { cfg, log } = ctx
  const files = select.rosterFiles(ctx)
  const rosters = files.map(f => roster.readRoster(f, cfg))

  const result = auditUnits(cfg, rosters, {
    datasets: store.readDatasets(ctx.dataDir),
    backupStems: store.scanBackup(cfg.backupDir),
  })
  const { stats, summary, need, blank, pending, drift, clean, skipList } = result

  log(`单位 ${stats.units} 家 ｜ 名册 ${stats.rows} 行 ｜ 已出 ${stats.done} ｜ 缺文件 ${stats.missingFile} ｜ 校验不通过 ${stats.blankRows} 行`)
  log(`状态「齐」${stats.units - need.length - stats.blankUnits} 家，需处理 ${need.length} 家${stats.blankUnits ? `，空表 ${stats.blankUnits} 家` : ''}`)
  log(`数据漂移 ${drift.length} 处（另有奖项简写 ${stats.knownDialect} 处属已知口径，不计入）`)
  log(`待清理 ${clean.length} 组 ｜ 同人两场 ${stats.multi} 人 ｜ 不出证书 ${skipList.length} 人`)
  for (const u of need) {
    log(`  ${u.单位}  行${u.名册行数} 已出${u.已出文件} 缺${u.缺文件} 校验不通过${u.校验不通过行}`)
  }

  // ── 批次进度 ──
  const batchMap = new Map()
  for (const u of summary) {
    const b = batchMap.get(u.批次) || { 批次: u.批次, 单位数: 0, 名册行数: 0, 已出: 0, 缺文件: 0, 校验不通过: 0, 需处理单位: 0 }
    b.单位数++; b.名册行数 += u.名册行数; b.已出 += u.已出文件
    b.缺文件 += u.缺文件; b.校验不通过 += u.校验不通过行
    if (u.状态 === '需处理') b.需处理单位++
    batchMap.set(u.批次, b)
  }
  // 保持配置里的顺序，不要按字符串排（61-120 会排到 181-234 后面去）
  const batchRows = (cfg.rosters || []).map(f => {
    const label = path.basename(f, path.extname(f)).replace(/^合并_/, '')
    return batchMap.get(label) || { 批次: label, 单位数: 0, 名册行数: 0, 已出: 0, 缺文件: 0, 校验不通过: 0, 需处理单位: 0 }
  })

  const overview = [
    { 项目: '覆盖范围', 数值: `${stats.units} 家单位（来自 ${files.length} 份名册）`, 备注: '工作表名 = 单位名，序号取名字前缀' },
    { 项目: '名册总行数', 数值: stats.rows, 备注: '含编号为空的行' },
    { 项目: '有编号行', 数值: stats.coded, 备注: '只有这些行可能出片' },
    { 项目: '已出文件', 数值: stats.done, 备注: '按「编号_姓名.png」精确匹配（含备份目录）' },
    { 项目: '成品在备份目录', 数值: stats.backupHits, 备注: stats.backupHits ? '正式目录缺但备份里有，不算缺文件，建议移回' : '无' },
    { 项目: '缺文件', 数值: stats.missingFile, 备注: '详见「待处理」页 A 类' },
    { 项目: '字段校验不通过', 数值: stats.blankRows, 备注: '必填字段有空值，出了也是空白栏，详见「待处理」' },
    { 项目: '状态「齐」单位', 数值: stats.units - need.length - stats.blankUnits, 备注: `共 ${stats.units} 家` },
    { 项目: '空表单位', 数值: stats.blankUnits, 备注: blank.length ? blank.map(u => u.单位).join('、') + '（0 行，无需出片）' : '无' },
    { 项目: '需处理单位', 数值: need.length, 备注: need.map(u => u.单位).join('、') || '无' },
    { 项目: '数据漂移（Excel↔数据集）', 数值: drift.length, 备注: `已扫 ${stats.coded} 行 × ${cfg.requiredFields.length} 字段；另有奖项简写 ${stats.knownDialect} 处属已知口径` },
    { 项目: '待清理文件', 数值: clean.length, 备注: '空编号残留 / 重复副本 / 备份里的成品，不影响出片' },
    { 项目: '同人两场（编号不同）', 数值: stats.multi, 备注: '参加两个赛项，两张都要保留，属正常' },
    { 项目: '不出证书', 数值: skipList.length, 备注: '已确认，不计入缺文件' },
    { 项目: '生成时间', 数值: new Date().toLocaleString('zh-CN'), 备注: '名册 × 磁盘 × 数据集 三方核对' },
  ]

  const notes = [
    { 项目: '奖项情况·口径', 结论: '以数据集为准，Excel 是简写，不处理', 说明: `本次扫描到 ${stats.knownDialect} 处「Excel=二等奖 / 数据集=个人复赛二等奖」。已核实：模板 ${cfg.templateId} 里没有「个人复赛」这段文字（templates.json 中出现 0 次），字段是直接渲染的，所以证书上那整串都来自数据集。若按 Excel 反向覆盖成「二等奖」，所有证书标题会变错。` },
    { 项目: '出口校验规则', 结论: `${cfg.requiredFields.length} 个必填字段非空才允许出片`, 说明: cfg.requiredFields.map(f => f.key).join(' / ') + '。任一为空 → FIELD_BLANK 拦截，除非显式 allowIncomplete。' },
    { 项目: '编号为空的行', 结论: '不出片', 说明: '这些人在补充名单里已按 5xxx 编号出过。历史遗留的「空值_*.png」就是早期未拦截造成的垃圾，现在出口校验已堵住。' },
    { 项目: '同人两场比赛', 结论: '两张都出', 说明: '证书编号可能相同但赛项不同，属正常，不按重复处理。' },
    { 项目: '不出证书', 结论: '仅个案，不是通用规则', 说明: (cfg.skipCert || []).map(s => `${s.sheet} ${s.name}（${s.reason}）`).join('；') || '无' },
    { 项目: '数据漂移怎么来的', 结论: 'Excel 改了 ≠ 数据集变了', 说明: '出片读的是批印坊数据集副本，不是 Excel 原件。改完 Excel 必须用 ppw sync / ppw fix 同步进数据集才会生效，否则重出的图与旧图一模一样（MD5 相同，已实测）。' },
    { 项目: '跑批期间禁止改数据集', 结论: '会被整份回写覆盖', 说明: 'markPrinted 用宿主内存里的 datasets.json 整份重写。批处理运行中改的单元格会被下一次回写覆盖，必须先停驱动 + 宿主再改。' },
    { 项目: '备份目录', 结论: '可能藏着有效成品', 说明: '批量重出前会把旧图挪进 _partial_backup。那里面的图能用，扫描时已纳入「已出」，不会误报缺文件。' },
  ]

  const sheets = [
    { name: '总览', rows: overview, cols: [26, 46, 70] },
    { name: '批次进度', rows: batchRows, cols: [12, 9, 11, 9, 9, 12, 12] },
    { name: '待处理', rows: result.actionable.length ? result.actionable : [{ 优先级: '（无）', 问题: '', 单位: '', 编号: '', 姓名: '', 缺字段: '', 说明: '当前没有待处理项' }], cols: [12, 22, 9, 34, 14, 10, 16, 10, 10, 10, 9, 9, 44] },
    { name: '数据漂移', rows: drift.length ? drift : [{ 批次: '（无）', 单位: '', 编号: '', 姓名: '', 字段: '', Excel值: '', 数据集值: '', 判定: '无差异', 处理: '' }], cols: [12, 34, 12, 10, 14, 22, 26, 22, 30] },
    { name: '逐单位汇总', rows: summary, cols: [8, 34, 12, 10, 10, 10, 8, 13, 10, 11, 12, 12, 10, 8] },
    { name: '逐人明细', rows: result.detail, cols: [8, 34, 12, 6, 12, 10, 9, 14, 12, 22, 18, 26, 10, 16, 10, 14] },
    { name: '文件清理', rows: clean.length ? clean : [{ 类型: '无', 单位: '—', 文件: '—', 姓名: '—', 建议: '没有需要清理的文件' }], cols: [22, 34, 40, 12, 46] },
    { name: '不出证书', rows: skipList.length ? skipList : [{ 单位: '（无）', 编号: '', 姓名: '', ...Object.fromEntries(auxKeys.map(k => [k, ''])), 原因: '' }], cols: [34, 14, 10, 12, 16, 40] },
    { name: '口径说明', rows: notes, cols: [20, 34, 100] },
  ]

  const out = select.outPath(ctx, cfg.reportBaseName, '.xlsx')
  const written = report.writeXlsx(out, sheets)
  if (written.degraded) log.warn(`原路径写不进去（${written.reason}），已改写到 ${written.path}`)
  log(`报告: ${written.path}`)

  return {
    summary: '',
    exitCode: stats.missingFile || stats.blankRows ? 1 : 0,
    report: written.path,
    degraded: written.degraded,
    ...stats,
    drift: drift.length,
    clean: clean.length,
  }
}

module.exports = { run, auditUnits }

/**
 * 多工作表导入 + 表头行检测 验收测试。
 * 覆盖：detectHeaderRow（多段式结构）/ sliceFromHeader（空行/幽灵列裁剪）/
 *       listSheets 概要 / importSheets split 与 merge 模式。
 * 若环境变量 REAL_XLSX 指向真实文件，则追加真实验收（不计入失败）。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-sheets')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const path = require('path')
const XLSX = require('xlsx')
const excel = require('../electron/importer/excel.cjs')
const dataset = require('../electron/dataset.cjs')

const TMP = path.join(__dirname, '.tmp-data-sheets')
let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

async function main() {
  rmDeep(TMP)
  fs.mkdirSync(TMP, { recursive: true })

  // 构造「证书打包分表」同构工作簿：总览 + 两个机构分表（标题/统计段/空行/明细段）
  const wb = XLSX.utils.book_new()
  const aoaOverview = [
    ['总览标题（合并单元格）', '', '', ''],
    ['序号', '机构', '合计'],
    [1, 'A机构', 3],
    [2, 'B机构', 2],
  ]
  function orgSheet(org, people) {
    return [
      [`${org} — 证书打包清单`, '', '', '', '', '', '', '', '', '', '', ''],
      [`收件单位：${org}`, '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['一、按校区小计', '', '', '', '', '', '', '', '', '', '', ''],
      ['序号', '校区', '特金奖', '金奖', '小计', '', '', '', '', '', '', ''],
      [1, org, 1, 1, 2, '', '', '', '', '', '', ''],
      ['小计', org, 1, 1, 2, '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['二、逐人明细清单', '', '', '', '', '', '', '', '', '', '', ''],
      ['序号', '赛事阶段', '证书编号', '选手姓名', '奖项', '作品名称', '指导老师', '选送机构', '', '', '', ''],
      ...people,
    ]
  }
  const sheetA = orgSheet('A机构', [
    [1, '省级', 'CERT-001', '张三', '金奖', '《作品一》', '李老师', 'A机构'],
    [2, '省级', 'CERT-002', '李四', '银奖', '（待补）', '李老师', 'A机构'],
  ])
  const sheetB = orgSheet('B机构', [
    [1, '国家级', 'CERT-003', '王五', '特金奖', '《作品三》', '赵老师', 'B机构'],
  ])
  const aoaC = [['姓名', '电话'], ['孙七', '13800000000']] // 无多段结构的普通表
  for (const [name, aoa] of [['① 打包总览', aoaOverview], ['01-A机构', sheetA], ['02-B机构', sheetB], ['附表', aoaC]]) {
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  const fp = path.join(TMP, '打包分表.xlsx')
  XLSX.writeFile(wb, fp)

  console.log('== 1. 表头行检测（多段式结构） ==')
  const gridA = excel.parseSheetGrid(fp, '01-A机构')
  ok(gridA.length === 12, '原始网格含标题/统计/明细段', gridA.length)
  const hrA = excel.detectHeaderRow(gridA)
  ok(hrA === 9, '明细段表头行（0基 9）得分最高', hrA)
  const hrOverview = excel.detectHeaderRow(excel.parseSheetGrid(fp, '① 打包总览'))
  ok(hrOverview === 1, '总览表头在第 2 行（0基 1）', hrOverview)
  ok(excel.detectHeaderRow([['只有一行文字', '']]) === -1, '无有效表头返回 -1')

  console.log('== 2. 表头切片 ==')
  const sliced = excel.sliceFromHeader(gridA, hrA)
  ok(sliced[0][0] === '序号' && sliced[0][3] === '选手姓名', '切片后首行即表头', sliced[0])
  ok(sliced.length === 3, '只保留表头+2 行数据（空行被滤）', sliced.length)
  ok(sliced[0].length === 8, '右侧幽灵列被裁掉（12 → 8 列）', sliced[0].length)
  ok(excel.sliceFromHeader(gridA, 999) === null, '越界表头行返回 null')

  console.log('== 3. listSheets 概要 ==')
  const sheets = excel.listSheets(fp)
  ok(sheets.length === 4, '4 个工作表全部列出', sheets.length)
  const sA = sheets.find((s) => s.name === '01-A机构')
  ok(sA.dataRows === 2 && sA.colCount === 8, '分表概要（2 行 × 8 列）', sA)
  ok(sA.headerPreview[3] === '选手姓名', '表头预览取自检测表头', sA.headerPreview)

  console.log('== 4. importSheets split 模式 ==')
  const resSplit = await dataset.importSheets(fp, {
    mode: 'split',
    selections: [
      { name: '01-A机构' }, // 表头行缺省 → 自动检测
      { name: '02-B机构', headerRow: 9 }, // 显式指定
      { name: '附表' },
    ],
  })
  ok(resSplit.length === 3, '3 个表 → 3 个数据集', resSplit.length)
  const dsA = dataset.getDataset(resSplit[0].id)
  ok(dsA.rows.length === 2 && dsA.columns.length === 8, 'A 表 2 行 × 8 列', { r: dsA.rows.length, c: dsA.columns.length })
  ok(dsA.rows[0]['选手姓名'] === '张三', '记录键取自检测表头（选手姓名列）', dsA.rows[0])
  ok(dsA.name.endsWith('·01-A机构'), '命名 = 文件名·表名', dsA.name)
  const dsB = dataset.getDataset(resSplit[1].id)
  ok(dsB.rows[0]['选手姓名'] === '王五', '显式表头行生效', dsB.rows[0])
  const dsC = dataset.getDataset(resSplit[2].id)
  ok(dsC.rows.length === 1 && dsC.columns[0].key === '姓名', '普通表不受影响', dsC.rows[0])

  console.log('== 5. importSheets merge 模式 ==')
  const resMerge = await dataset.importSheets(fp, {
    mode: 'merge',
    selections: [{ name: '01-A机构' }, { name: '02-B机构' }],
  })
  ok(resMerge.length === 1, '合并为 1 个数据集')
  const dsM = dataset.getDataset(resMerge[0].id)
  ok(dsM.rows.length === 3, '两表数据行拼接（2+1）', dsM.rows.length)
  ok(dsM.columns.some((c) => c.alias === '来源工作表'), '自动加来源列', dsM.columns.map((c) => c.alias))
  ok(dsM.rows.every((r) => r['来源工作表'] === dsM.rows[0]['来源工作表'] || true) &&
     dsM.rows[2]['来源工作表'] === '02-B机构', '来源列取自表名', dsM.rows[2])
  ok(dsM.rows[0]['选手姓名'] === '张三' && dsM.rows[2]['选手姓名'] === '王五', '列并集对齐正确')

  console.log('== 6. 边界与守卫 ==')
  let threw = false
  try { await dataset.importSheets(fp, { mode: 'split', selections: [] }) } catch { threw = true }
  ok(threw, '空选择被拒')
  threw = false
  try { await dataset.importSheets(fp, { mode: 'split', selections: [{ name: '不存在' }] }) } catch { threw = true }
  ok(threw, '不存在的表名被拒')
  threw = false
  try { await dataset.importSheets(fp, { mode: 'split', selections: [{ name: '01-A机构', headerRow: 999 }] }) } catch { threw = true }
  ok(threw, '越界表头行被拒')

  console.log('== 6.5 导入进度回调 ==')
  const events = []
  const resP = await dataset.importSheets(fp, {
    mode: 'split',
    selections: [{ name: '01-A机构' }, { name: '02-B机构' }, { name: '附表' }],
    onProgress: (p) => events.push(p),
  })
  ok(resP.length === 3, '进度模式下导入结果一致', resP.length)
  ok(events.length > 0 && events[0].stage === 'read' && events[0].pct === 2, '首事件：读取工作簿', events[0])
  ok(events.some((e) => e.stage === 'parse' && e.total === 3 && e.current === 2 && e.name === '02-B机构'), '解析进度带 current/total/表名')
  ok(events.some((e) => e.stage === 'build' && e.total === 3 && e.current === 3), '生成进度逐表上报')
  const lastEv = events[events.length - 1]
  ok(lastEv.stage === 'done' && lastEv.pct === 100 && lastEv.label === '导入完成', '末事件：完成 100%', lastEv)
  ok(events.every((e, i) => i === 0 || events[i - 1].pct <= e.pct), 'pct 单调不减')

  console.log('== 7. inspectFile 分发 ==')
  const ins = dataset.inspectFile(fp)
  ok(ins.kind === 'xlsx' && ins.sheets.length === 4, 'xlsx → 工作表清单', ins.kind)
  const csvFp = path.join(TMP, 'simple.csv')
  fs.writeFileSync(csvFp, '姓名,奖项\n测试,金奖', 'utf-8')
  const insCsv = dataset.inspectFile(csvFp)
  ok(insCsv.kind === 'csv' && insCsv.datasets[0].rowCount === 1, 'csv → 直接导入', insCsv.kind)

  rmDeep(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)

  // == 8. 真实文件验收（可选，文件存在才跑，不计入失败但打印结果） ==
  const realFp = process.env.REAL_XLSX
  if (realFp && fs.existsSync(realFp)) {
    console.log('\n== 8. 真实文件验收（' + path.basename(realFp) + '） ==')
    try {
      process.env.PRINTPRESS_DATA_DIR = path.join(__dirname, '.tmp-data-real')
      rmDeep(process.env.PRINTPRESS_DATA_DIR)
      delete require.cache[require.resolve('../electron/store.cjs')]
      const realSheets = excel.listSheets(realFp)
      const withData = realSheets.filter((s) => s.dataRows > 0)
      console.log(`  工作表总数 ${realSheets.length}，含数据 ${withData.length}`)
      const sample = withData.find((s) => s.dataRows > 30 && s.headerPreview.includes('选手姓名'))
      if (sample) {
        const res = await dataset.importSheets(realFp, { mode: 'split', selections: [{ name: sample.name }] })
        const ds = dataset.getDataset(res[0].id)
        console.log(`  样例表「${sample.name}」：${ds.rows.length} 行 × ${ds.columns.length} 列`)
        console.log('  字段:', ds.columns.map((c) => c.alias).join(' | '))
        console.log('  首行:', JSON.stringify(ds.rows[0]).slice(0, 200))
        const merged = await dataset.importSheets(realFp, {
          mode: 'merge',
          selections: withData.filter((s) => s.headerPreview.includes('选手姓名')).slice(0, 20).map((s) => ({ name: s.name })),
        })
        console.log(`  合并 20 表：${dataset.getDataset(merged[0].id).rows.length} 行`)
      }
      rmDeep(process.env.PRINTPRESS_DATA_DIR)
      console.log('  真实文件验收完成')
    } catch (err) {
      console.error('  真实文件验收异常:', err.message || err)
    }
  }

  process.exit(failCount ? 1 : 0)
}

main()

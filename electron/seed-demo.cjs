/**
 * 首启种子：示例名单 + 4 套示例模板（含底图）。
 * 仅在 settings.demoSeeded 未置位时执行一次；底图从资源目录复制。
 * 资源目录：开发态 build/seed，打包后 resources/seed（extraResources）。
 */
const path = require('path')
const fs = require('fs')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')

// 示例名单（与底图标题配套的字段）
const DEMO_ROWS = [
  ['姓名', '奖项', '单位', '日期'],
  ['张明远', '金奖', '市第一实验小学', '2026-06-01'],
  ['李思涵', '一等奖', '市第一实验小学', '2026-06-01'],
  ['王雨桐', '一等奖', '少年宫美术班', '2026-06-01'],
  ['陈嘉树', '二等奖', '少年宫美术班', '2026-06-01'],
  ['刘一诺', '二等奖', '阳光培训机构', '2026-06-01'],
  ['赵清越', '金奖', '阳光培训机构', '2026-06-01'],
  ['孙梓萱', '一等奖', '春蕾艺术学校', '2026-06-01'],
  ['周子墨', '三等奖', '春蕾艺术学校', '2026-06-01'],
  ['吴若曦', '二等奖', '启航教育', '2026-06-01'],
  ['郑昊然', '一等奖', '启航教育', '2026-06-01'],
  ['冯雅琪', '金奖', '星辉书画社', '2026-06-01'],
  ['蒋承志', '二等奖', '星辉书画社', '2026-06-01'],
]

// 示例模板：字段坐标为页面百分比（一横奖状 / 一横证书 / 一竖证书 / 一邀请函）
const TPL_DEFS = [
  {
    name: '示例·奖状（横版 A4）',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    bg: 'print-bg/demo-award-landscape.svg',
    bgSize: { width: 1754, height: 1240 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 34, bold: true, color: '#2b2622', align: 'center', fontFamily: '楷体' },
      { column: '奖项', label: '奖项', x: 50, y: 63, fontSize: 22, color: '#b03a2e', align: 'center', fontFamily: '楷体' },
      { column: '单位', label: '单位', x: 50, y: 77, fontSize: 15, color: '#6f675c', align: 'center' },
      { column: '日期', label: '日期', x: 50, y: 86, fontSize: 13, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '示例·荣誉证书（横版 A4）',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    bg: 'print-bg/demo-cert-landscape.svg',
    bgSize: { width: 1754, height: 1240 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 52, fontSize: 32, bold: true, color: '#2b2622', align: 'center', fontFamily: '宋体' },
      { column: '奖项', label: '奖项', x: 50, y: 65, fontSize: 20, color: '#8a6a2f', align: 'center', fontFamily: '宋体' },
      { column: '单位', label: '单位', x: 50, y: 79, fontSize: 14, color: '#6f675c', align: 'center' },
      { column: '日期', label: '日期', x: 50, y: 88, fontSize: 12, color: '#8c8577', align: 'center' },
    ],
  },
  {
    name: '示例·证书（竖版 A4）',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    bg: 'print-bg/demo-cert-portrait.svg',
    bgSize: { width: 1240, height: 1754 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 42, fontSize: 30, bold: true, color: '#2b2622', align: 'center', fontFamily: '楷体' },
      { column: '奖项', label: '奖项', x: 50, y: 55, fontSize: 19, color: '#b03a2e', align: 'center', fontFamily: '楷体' },
      { column: '单位', label: '单位', x: 50, y: 70, fontSize: 14, color: '#6f675c', align: 'center' },
      { column: '日期', label: '日期', x: 50, y: 82, fontSize: 12, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '示例·邀请函（横版 A4）',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    bg: 'print-bg/demo-invite-landscape.svg',
    bgSize: { width: 1754, height: 1240 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 52, fontSize: 30, bold: true, color: '#2b2622', align: 'center', fontFamily: '楷体' },
      { column: '单位', label: '单位', x: 50, y: 68, fontSize: 15, color: '#6f675c', align: 'center' },
    ],
  },
]

/**
 * 首启种子入口。seedDir = 示例资产目录（含 print-bg/、demo.csv）。
 * 任一步失败都不阻塞启动（示例内容非关键路径），返回执行摘要。
 */
function seedIfFirstRun(seedDir) {
  const settings = loadJson('settings') || {}
  if (settings.demoSeeded) return { seeded: false, reason: 'already' }

  try {
    // 1. 复制示例底图
    const srcBg = path.join(seedDir, 'print-bg')
    const destBg = path.join(process.env.PRINTPRESS_DATA_DIR, 'print-bg')
    fs.mkdirSync(destBg, { recursive: true })
    for (const f of fs.readdirSync(srcBg)) {
      if (f.startsWith('.')) continue
      const dest = path.join(destBg, f)
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(srcBg, f), dest)
    }

    // 2. 示例名单走真实导入链路（列名规范化/类型推断全部生效）
    const csvPath = path.join(seedDir, 'demo.csv')
    fs.writeFileSync(csvPath, '\ufeff' + DEMO_ROWS.map((r) => r.join(',')).join('\r\n'), 'utf-8')
    const ds = dataset.importFromFile(csvPath)
    fs.unlinkSync(csvPath) // 导入完成即删，不留临时文件

    // 2.5 示例列头激活「印」：示例数据本就为打印准备，模板字段须全部激活才允许保存
    const usedKeys = new Set(TPL_DEFS.flatMap((d) => d.fields.map((f) => f.column)))
    for (const c of dataset.fieldCatalog(ds.id)) {
      if (usedKeys.has(c.key)) dataset.setColumnPrint(ds.id, c.key, true)
    }

    // 3. 示例模板（绑定示例数据集，预览即有真实数据）
    for (const def of TPL_DEFS) {
      templates.saveTemplate({
        name: def.name,
        pageSize: def.pageSize,
        background: def.bg,
        bgSize: def.bgSize,
        datasetId: ds.id,
        fields: def.fields.map((f) => ({ ...f })),
      })
    }

    saveJson('settings', { ...settings, demoSeeded: true })
    return { seeded: true, datasetId: ds.id, templates: TPL_DEFS.length }
  } catch (err) {
    // 失败不写 demoSeeded，下次启动重试；但也不阻塞应用启动
    return { seeded: false, reason: String(err.message || err) }
  }
}

module.exports = { seedIfFirstRun }

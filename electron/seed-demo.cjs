/**
 * 首启种子：示例名单 + 10 套内置模板（seedVersion 2）。
 * 10 套 = 证书文书类 5（奖状/证书横/证书竖/聘书/邀请函）+ 会务证卡类 5（会议桌牌/考场座位贴/胸卡/工作证/姓名贴纸）。
 * 选型依据 2026-10 需求调查：SeatMark 226 套分类清单（座位贴/桌牌/胸卡/证卡居前）
 * + 邮件合并教程热度（奖状/证书为教师学期末刚需）+ 国际侧 badge 工具品类（90×55 胸牌为事实标准）。
 *
 * 版本化：seedVersion 0 = 未种子（全新安装，全量种子）；1 = 旧版已种子（迁移：补 6 套新模板，
 *   绑定导入的扩展示例名单，不动老数据）；>=2 = 已就绪。
 * 资源目录：开发态 build/seed，打包后 resources/seed（extraResources）。
 */
const path = require('path')
const fs = require('fs')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')

const SEED_VERSION = 2

// 示例名单：9 列覆盖全部 10 套模板的字段（证书文书 + 会务考务）
const DEMO_ROWS = [
  ['姓名', '单位', '部门', '职务', '班级', '考场', '座位号', '奖项', '日期'],
  ['张明远', '市第一实验小学', '美术组', '参赛选手', '六年级一班', '第1考场', '05', '金奖', '2026-06-01'],
  ['李思涵', '市第一实验小学', '美术组', '参赛选手', '六年级一班', '第1考场', '12', '一等奖', '2026-06-01'],
  ['王雨桐', '少年宫美术班', '教务处', '参赛选手', '素描班', '第2考场', '03', '一等奖', '2026-06-01'],
  ['陈嘉树', '少年宫美术班', '美术组', '参赛选手', '水彩班', '第2考场', '08', '二等奖', '2026-06-01'],
  ['刘一诺', '阳光培训机构', '教学部', '参赛选手', '创意班', '第3考场', '01', '二等奖', '2026-06-01'],
  ['赵清越', '阳光培训机构', '教学部', '参赛选手', '国画班', '第3考场', '07', '金奖', '2026-06-01'],
  ['孙梓萱', '春蕾艺术学校', '美术部', '参赛选手', '漫画班', '第1考场', '21', '一等奖', '2026-06-01'],
  ['周子墨', '春蕾艺术学校', '美术部', '参赛选手', '素描班', '第2考场', '15', '三等奖', '2026-06-01'],
  ['吴若曦', '启航教育', '教学部', '参赛选手', '水彩班', '第3考场', '19', '二等奖', '2026-06-01'],
  ['郑昊然', '启航教育', '教学部', '参赛选手', '创意班', '第1考场', '30', '一等奖', '2026-06-01'],
  ['冯雅琪', '星辉书画社', '创作部', '参赛选手', '国画班', '第2考场', '26', '金奖', '2026-06-01'],
  ['蒋承志', '星辉书画社', '创作部', '参赛选手', '书法班', '第3考场', '11', '二等奖', '2026-06-01'],
]

// 证书文书类：带示例底图，字段坐标为页面百分比（单张版式）
const TPL_DOC_DEFS = [
  {
    name: '常用·奖状（横版 A4）',
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
    name: '常用·荣誉证书（横版 A4）',
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
    name: '常用·证书（竖版 A4）',
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
    name: '常用·聘书（竖版 A4）',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    bg: 'print-bg/demo-cert-portrait.svg',
    bgSize: { width: 1240, height: 1754 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 30, bold: true, color: '#2b2622', align: 'center', fontFamily: '楷体' },
      { column: '职务', label: '职务', x: 50, y: 60, fontSize: 17, color: '#8a6a2f', align: 'center', fontFamily: '楷体' },
      { column: '单位', label: '单位', x: 50, y: 78, fontSize: 13, color: '#6f675c', align: 'center' },
      { column: '日期', label: '日期', x: 50, y: 88, fontSize: 11, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '常用·邀请函（横版 A4）',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    bg: 'print-bg/demo-invite-landscape.svg',
    bgSize: { width: 1754, height: 1240 },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 52, fontSize: 30, bold: true, color: '#2b2622', align: 'center', fontFamily: '楷体' },
      { column: '单位', label: '单位', x: 50, y: 68, fontSize: 15, color: '#6f675c', align: 'center' },
    ],
  },
]

// 会务证卡类：多联拼版（无底图，白纸黑字 + 裁切线），字段坐标为单格百分比
const TPL_GRID_DEFS = [
  {
    name: '常用·会议桌牌（台签 200×100，A4 两联）',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    layout: { mode: 'grid', itemW: 200, itemH: 100, showCutMarks: true },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 38, fontSize: 34, bold: true, color: '#2b2622', align: 'center', fontFamily: '楷体' },
      { column: '职务', label: '职务', x: 50, y: 64, fontSize: 15, color: '#6f675c', align: 'center' },
      { column: '单位', label: '单位', x: 50, y: 82, fontSize: 13, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '常用·考场座位贴（90×60，A4 八联）',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 90, itemH: 60, showCutMarks: true },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 32, fontSize: 16, bold: true, color: '#2b2622', align: 'center' },
      { column: '座位号', label: '座位号', x: 50, y: 62, fontSize: 24, bold: true, color: '#b03a2e', align: 'center' },
      { column: '考场', label: '考场', x: 50, y: 85, fontSize: 11, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '常用·胸卡参会证（85×54，A4 十联）',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 85, itemH: 54, showCutMarks: true },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 38, fontSize: 16, bold: true, color: '#2b2622', align: 'center' },
      { column: '单位', label: '单位', x: 50, y: 64, fontSize: 10, color: '#6f675c', align: 'center' },
      { column: '职务', label: '职务', x: 50, y: 82, fontSize: 10, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '常用·工作证卡贴（85×54，A4 十联）',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 85, itemH: 54, showCutMarks: true },
    fields: [
      { column: '单位', label: '单位', x: 50, y: 20, fontSize: 9, color: '#6f675c', align: 'center' },
      { column: '姓名', label: '姓名', x: 50, y: 46, fontSize: 15, bold: true, color: '#2b2622', align: 'center' },
      { column: '部门', label: '部门', x: 50, y: 70, fontSize: 10, color: '#6f675c', align: 'center' },
      { column: '职务', label: '职务', x: 50, y: 88, fontSize: 10, color: '#6f675c', align: 'center' },
    ],
  },
  {
    name: '常用·姓名贴纸（50×30，A4 三十六联）',
    pageSize: { id: 'a4-portrait', w: 210, h: 297 },
    layout: { mode: 'grid', itemW: 50, itemH: 30, showCutMarks: true },
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 42, fontSize: 13, bold: true, color: '#2b2622', align: 'center' },
      { column: '班级', label: '班级', x: 50, y: 75, fontSize: 9, color: '#6f675c', align: 'center' },
    ],
  },
]

function templateNames() {
  return new Set(templates.listTemplates().map((t) => t.name))
}

/** 导入示例名单（显式命名，不带扩展名），激活模板用到的列，返回数据集 */
function importDemoDataset(seedDir, csvName, dsName) {
  const csvPath = path.join(seedDir, csvName)
  fs.writeFileSync(csvPath, '\ufeff' + DEMO_ROWS.map((r) => r.join(',')).join('\r\n'), 'utf-8')
  const ds = dataset.importFromFile(csvPath, dsName)
  fs.unlinkSync(csvPath) // 导入完成即删，不留临时文件
  const allDefs = [...TPL_DOC_DEFS, ...TPL_GRID_DEFS]
  const usedKeys = new Set(allDefs.flatMap((d) => d.fields.map((f) => f.column)))
  for (const c of dataset.fieldCatalog(ds.id)) {
    if (usedKeys.has(c.key)) dataset.setColumnPrint(ds.id, c.key, true)
  }
  return ds
}

/** 落模板（按名字去重，重试/迁移不重复建），返回新建数量 */
function saveTemplates(defs, dsId) {
  const existing = templateNames()
  let created = 0
  for (const def of defs) {
    if (existing.has(def.name)) continue
    templates.saveTemplate({
      name: def.name,
      pageSize: def.pageSize,
      background: def.bg,
      bgSize: def.bgSize,
      layout: def.layout,
      datasetId: dsId,
      fields: def.fields.map((f) => ({ ...f })),
    })
    created += 1
  }
  return created
}

/**
 * 种子入口（版本化）。
 * - ver 0（全新安装）：复制底图 + 导入示例名单 + 全部 10 套模板
 * - ver 1（旧版已种子）：不动老数据，导入扩展示例名单 + 补 6 套会务证卡模板
 * - ver >=2：无事可做
 * 任一步失败都不阻塞启动（示例内容非关键路径），返回执行摘要。
 */
function seedIfFirstRun(seedDir) {
  const settings = loadJson('settings') || {}
  const ver = Number(settings.seedVersion) || (settings.demoSeeded ? 1 : 0)
  if (ver >= SEED_VERSION) return { seeded: false, reason: 'already' }

  try {
    if (ver === 0) {
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
      const ds = importDemoDataset(seedDir, '示例名单.csv', '示例名单')
      // 3. 全部 10 套模板绑定该数据集（预览即有真实数据）
      const created = saveTemplates([...TPL_DOC_DEFS, ...TPL_GRID_DEFS], ds.id)
      saveJson('settings', { ...settings, demoSeeded: true, seedVersion: SEED_VERSION })
      return { seeded: true, migrated: false, datasetId: ds.id, templates: created }
    }

    // ver 1 → 2 迁移：老 4 套与老数据原样保留；扩展名单 + 6 套会务证卡模板
    const ds = importDemoDataset(seedDir, '示例名单-扩展.csv', '示例名单·扩展')
    const created = saveTemplates(TPL_GRID_DEFS, ds.id)
    saveJson('settings', { ...settings, seedVersion: SEED_VERSION })
    return { seeded: true, migrated: true, datasetId: ds.id, templates: created }
  } catch (err) {
    // 失败不写 seedVersion，下次启动重试；但也不阻塞应用启动
    return { seeded: false, reason: String(err.message || err) }
  }
}

module.exports = { seedIfFirstRun }

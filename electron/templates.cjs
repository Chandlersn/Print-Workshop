/**
 * 模板领域层：模板 CRUD（全量快照写）、底图上传（真实尺寸 + 纸张建议）、
 * 变形预警计算、字体引用校验。
 *
 * 位置坐标系：字段 x/y 存页面百分比，纸张变化时排版自适应；
 * 字号存 pt（用户习惯单位），渲染时换算物理尺寸。
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { loadJson, saveJson, resolveInsideDataDir } = require('./store.cjs')
const { imageSize } = require('./images.cjs')
const dataset = require('./dataset.cjs')

const STORE_NAME = 'templates'
const BG_DIR = path.join(process.env.PRINTPRESS_DATA_DIR, 'print-bg')
const BG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const PAGE_SIZES = [
  { id: 'a3-landscape', name: 'A3 横版', w: 420, h: 297 },
  { id: 'a3-portrait', name: 'A3 竖版', w: 297, h: 420 },
  { id: 'a4-landscape', name: 'A4 横版', w: 297, h: 210 },
  { id: 'a4-portrait', name: 'A4 竖版', w: 210, h: 297 },
  // B5 用国内市售复印纸规格（JIS 182×257），面积介于 A4 与 A5 之间
  { id: 'b5-landscape', name: 'B5 横版', w: 257, h: 182 },
  { id: 'b5-portrait', name: 'B5 竖版', w: 182, h: 257 },
  { id: 'a5-landscape', name: 'A5 横版', w: 210, h: 148 },
  { id: 'a5-portrait', name: 'A5 竖版', w: 148, h: 210 },
  { id: 'a6-landscape', name: 'A6 横版', w: 148, h: 105 },
  { id: 'a6-portrait', name: 'A6 竖版', w: 105, h: 148 },
]

/**
 * 常见小尺寸成品预设（mm）——多联拼版的「成品尺寸」选项。
 * 覆盖证件照 / 相纸 / 常用卡片；用户也可填自定义尺寸（预设只是省事，不是限制）。
 * 尺寸为国内通行规格：1 寸 25×35、2 寸 35×49、5 寸（5R）89×127 等。
 */
const ITEM_SIZES = [
  { id: 'photo-1s', name: '小 1 寸 22×32', w: 22, h: 32 },
  { id: 'photo-1', name: '1 寸 25×35', w: 25, h: 35 },
  { id: 'photo-2s', name: '小 2 寸 35×45', w: 35, h: 45 },
  { id: 'photo-2', name: '2 寸 35×49', w: 35, h: 49 },
  { id: 'photo-3', name: '3 寸 54×89', w: 54, h: 89 },
  { id: 'photo-5', name: '5 寸 89×127', w: 89, h: 127 },
  { id: 'photo-6', name: '6 寸 102×152', w: 102, h: 152 },
  { id: 'card-badge', name: '胸卡 85×54', w: 85, h: 54 },
  { id: 'card-tent', name: '桌牌 200×100', w: 200, h: 100 },
]

function loadAll() {
  return loadJson(STORE_NAME, { expect: 'array' }) || []
}

function persistAll(list) {
  saveJson(STORE_NAME, list)
}

function listTemplates() {
  const dsList = dataset.listDatasets()
  return loadAll().map((t) => {
    const ds = dsList.find((d) => d.id === t.datasetId)
    return {
      id: t.id,
      name: t.name,
      pageSize: t.pageSize,
      fieldCount: (t.fields || []).length,
      hasBackground: Boolean(t.background),
      datasetId: t.datasetId || '',
      datasetName: ds ? ds.name : '',
      updatedAt: t.updatedAt,
    }
  })
  // 最近编辑的置顶：刚保存的模板在下拉/列表里第一眼就能看到
  .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

function getTemplate(id) {
  const t = loadAll().find((x) => x.id === id)
  if (!t) throw new Error(`所选模板已不存在（可能已被删除），请刷新后重试`)
  return t
}

/** 全量快照保存：有 id 更新，无 id 新建。模板必须绑定数据集（打印中心按模板直接带出） */
function saveTemplate(template) {
  if (!template || typeof template !== 'object') throw new Error('模板数据为空')
  if (!template.name || !String(template.name).trim()) throw new Error('模板名称不能为空')
  if (!template.datasetId) throw new Error('模板必须关联数据集（先在工具栏选择数据集）')
  const ds = dataset.getDataset(String(template.datasetId)) // 不存在则抛错
  // 出口把关：画布上每个字段都必须对上数据集已激活打印的列——
  // 总数对不上（换数据集残留的失效字段 / 数据页事后取消「印」）不允许保存通过
  const m = matchFields(template, ds)
  if (!m.ok) {
    throw new Error(
      `模板 ${m.fieldCount} 个字段中有 ${m.missing.length} 个校验未通过：` +
      `${m.missing.map((x) => `「${x.label}」`).join('')}在数据集「${ds.name}」中不存在或未激活打印。` +
      '请删除画布上的失效字段，或去数据页表格列头点「印」激活后重试')
  }
  const list = loadAll()
  const now = new Date().toISOString()
  if (template.id) {
    const idx = list.findIndex((x) => x.id === template.id)
    if (idx === -1) throw new Error(`所选模板已不存在（可能已被删除），请刷新后重试`)
    template.updatedAt = now
    list[idx] = template
  } else {
    template.id = `tpl_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
    template.createdAt = now
    template.updatedAt = now
    list.push(template)
  }
  persistAll(list)
  return template
}

function deleteTemplate(id) {
  const t = getTemplate(id)
  const rest = loadAll().filter((x) => x.id !== id)
  persistAll(rest)
  // 连带清理底图文件：上传时文件名唯一（时间戳前缀），一个底图只被一条模板记录引用；
  // 不清理会让 print-bg 目录随删模板持续膨胀（孤儿文件无任何应用内释放入口）
  // 路径必须过守卫：background 来自可被手工编辑的 JSON，`../` 会删到数据目录外
  if (t.background) {
    const stillUsed = rest.some((x) => x.background === t.background)
    if (!stillUsed) {
      try {
        fs.unlinkSync(resolveInsideDataDir(t.background))
      } catch (err) {
        // 路径越界说明存储被改过：留痕但不让删除模板整体失败（模板记录已删干净）
        console.warn(`[templates] 底图清理跳过（${err.message}）`)
      }
    }
  }
  return { ok: true }
}

/**
 * 底图比例与纸张比例差（相对纸张比例）。
 * >0.02 即预警（源项目同阈值）。
 */
function ratioDiff(pageW, pageH, imgW, imgH) {
  if (!imgW || !imgH || !pageW || !pageH) return 0
  return Math.abs(imgW / imgH - pageW / pageH) / (pageW / pageH)
}

/** 真实像素 → 毫米（按 96dpi） */
function pxToMm(px) {
  return Math.round((px / 96) * 25.4)
}

/** 纸张建议：比例最接近的标准纸张（差 ≤2% 命中），否则按像素换算自定义 */
function suggestPageSize(imgW, imgH) {
  const imgRatio = imgW / imgH
  let best = null
  let bestDiff = Infinity
  for (const p of PAGE_SIZES) {
    const diff = Math.abs(p.w / p.h - imgRatio) / (p.w / p.h)
    // A3 与 A4 等比（√2），平局时偏好更小的纸——A4 底图不应被建议成 A3
    const smaller = best && p.w * p.h < best.w * best.h
    if (diff < bestDiff || (diff === bestDiff && smaller)) { bestDiff = diff; best = p }
  }
  if (bestDiff <= 0.02) {
    return { matched: true, page: best, diff: bestDiff }
  }
  return {
    matched: false,
    page: { id: 'custom', name: '自定义', w: pxToMm(imgW), h: pxToMm(imgH) },
    diff: bestDiff,
  }
}

/** 底图上传：复制进数据目录 + 读真实尺寸 + 纸张建议 */
function uploadBackground(srcPath) {
  const base = path.basename(srcPath)
  if (!BG_EXTS.has(path.extname(base).toLowerCase())) {
    throw new Error('仅支持 png / jpg / webp 图片')
  }
  const size = imageSize(srcPath, fs)
  if (!size) throw new Error('无法识别图片尺寸（支持 PNG / JPEG）')

  fs.mkdirSync(BG_DIR, { recursive: true })
  const fileName = `${Date.now().toString(36)}-${base}`
  const dest = path.join(BG_DIR, fileName)
  fs.copyFileSync(srcPath, dest)

  const suggest = suggestPageSize(size.width, size.height)
  return {
    background: `print-bg/${fileName}`,
    width: size.width,
    height: size.height,
    suggest,
  }
}

/** 字体引用校验：返回引用该 family 的模板名清单 */
function fontUsedBy(family) {
  return loadAll()
    .filter((t) => (t.fields || []).some((f) => f.fontFamily === family))
    .map((t) => t.name)
}

/**
 * 字段匹配核心（不依赖已存模板 id，新建/保存/换绑共用同一份判定）：
 * 模板上已放置的每个字段，都必须在目标数据集「已激活打印」（列头「印」）
 * 的列中存在。缺失即视为结构错配，杜绝渲染白版。
 */
function matchFields(tpl, ds) {
  const activated = new Set(
    (ds.columns || []).filter((c) => c.printOn === true).map((c) => c.key))
  const fields = (tpl.fields || [])
    .filter((f) => f.column || f.key)
    .map((f) => ({ key: f.column || f.key, label: f.label || f.column || f.key }))
  const missing = fields.filter((f) => !activated.has(f.key))
  return {
    ok: missing.length === 0,
    templateId: tpl.id || '',
    templateName: tpl.name || '',
    datasetId: ds.id,
    datasetName: ds.name,
    fieldCount: fields.length,
    activatedCount: activated.size,
    missing,
  }
}

/** 已存模板 × 数据集匹配校验（换绑预检、打印中心前置警告共用） */
function matchDataset(templateId, datasetId) {
  const tpl = getTemplate(String(templateId))
  const ds = dataset.getDataset(String(datasetId))
  return matchFields(tpl, ds)
}

/** 换绑数据集：必须先通过字段匹配校验，通过后更新绑定并持久化 */
function rebindDataset(templateId, datasetId) {
  const m = matchDataset(templateId, datasetId)
  if (!m.ok) {
    const err = new Error(
      `字段不匹配：${m.missing.map((x) => x.label).join('、')} 未在新数据集激活打印（列头点「印」后再换绑）`)
    err.missing = m.missing
    throw err
  }
  const list = loadAll()
  const t = list.find((x) => x.id === String(templateId))
  t.datasetId = String(datasetId)
  persistAll(list)
  return { ok: true, datasetId: t.datasetId, datasetName: m.datasetName }
}

module.exports = {
  PAGE_SIZES,
  ITEM_SIZES,
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  uploadBackground,
  suggestPageSize,
  ratioDiff,
  fontUsedBy,
  matchFields,
  matchDataset,
  rebindDataset,
}

/* verify：校验模板要渲染的字段在数据集里是否「存在且已激活」。
 *
 * 背景（这段边界靠实测校准，别按直觉改）：
 * 数据集的每一列有一个「印」开关（printOn）。它控制三件事：
 *   ① 模板编辑页的字段选择器只列出已激活的列（src/views/TemplateView.vue）
 *   ② 换绑数据集时的 matchFields 校验，未激活即判结构错配（electron/templates.cjs）
 *   ③ 打印预检会把未激活列报成 missing，提示用户去数据页点「印」
 * 它不控制第四件事：已配置好的模板直接出片。渲染读的是行里的值，不看开关。
 * 实测依据：某单位数据集 8 个字段全未点亮，当天照样重出 4 张且内容正确。
 *
 * 所以判定要精确区分：
 *   列根本不存在        → 出片该位置必然空白，error
 *   列在但没点亮        → 不影响已配好的模板出片；会让模板页选不到、换绑失败、预检报警，warn
 *   模板要的列不在必填清单 → import 不会点亮它，新导入的单位将来会踩上一条，warn
 */
const fs = require('fs')
const path = require('path')
const store = require('../store.cjs')

function readTemplates(dataDir) {
  const file = path.join(dataDir, 'templates.json')
  if (!fs.existsSync(file)) throw new Error(`找不到模板文件：${file}`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return Array.isArray(raw) ? raw : raw.templates || []
}

/** 模板真正要渲染的字段（fields[].column 去重，忽略空值） */
function templateColumns(tpl) {
  const cols = []
  for (const f of tpl.fields || []) {
    const c = String(f.column || '').trim()
    if (c && !cols.includes(c)) cols.push(c)
  }
  return cols
}

/** 单位筛选：--unit 61,62 */
function unitFilter(flags) {
  const raw = flags.unit ?? flags.units
  if (!raw) return null
  const set = new Set(
    String(raw).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      .map(Number).filter(n => Number.isFinite(n))
  )
  return set.size ? set : null
}

function unitNoOf(name) {
  const m = /·\s*(\d+)[_．.]/.exec(String(name || ''))
  return m ? Number(m[1]) : null
}

/** 同一个单位可能有多份数据集；出片按 pickDataset 取，这里必须用同一口径 */
function groupsOf(datasets) {
  const groups = new Map()
  for (const d of datasets) {
    const sheet = String(d.name || '').split('·').pop()
    if (!groups.has(sheet)) groups.set(sheet, [])
    groups.get(sheet).push(d)
  }
  return groups
}

async function run(ctx) {
  const { cfg, log, dataDir, flags } = ctx
  const out = {
    templateId: cfg.templateId, templateColumns: [], requiredFields: [],
    checked: 0, blank: [], unlit: [], dupGroups: 0, problems: [],
  }

  const tpl = readTemplates(dataDir).find(t => t.id === cfg.templateId)
  if (!tpl) throw new Error(`模板 ${cfg.templateId} 不在 ${dataDir}/templates.json 里`)

  const tplCols = templateColumns(tpl)
  const reqCols = (cfg.requiredFields || []).map(f => f.key)
  out.templateColumns = tplCols
  out.requiredFields = reqCols

  log(`模板 ${tpl.name || tpl.id}：渲染 ${tplCols.length} 个字段`)
  log(`  ${tplCols.join(' / ')}`)
  const src = cfg.__requiredSource || {}
  log(`必填清单 ${reqCols.length} 个字段${src.template
    ? `（模板声明 ${src.template} 个 + 配置 ${src.configured} 个，合并去重后 ${reqCols.length} 个）`
    : '（模板没读到，按配置走）'}`)
  log(`  ${reqCols.join(' / ')}`)
  if (src.template && src.template !== reqCols.length) {
    log(`  注意：清单由模板推导，模板改几个字段这里就跟着变——不是写死的数量`)
  }

  // ① 模板要渲染、但不在必填清单 → import 不会点亮它
  const notRequired = tplCols.filter(c => !reqCols.includes(c))
  if (notRequired.length) {
    out.problems.push({ level: 'warn', kind: 'template-not-required', columns: notRequired })
    log.warn(`模板要渲染但这些列不在必填清单里，import 不会点亮：${notRequired.join(' / ')}`)
    log.warn('  影响：模板页选不到它们、换绑数据集判结构错配；已配好的模板出片不受影响')
  } else {
    log('模板字段全部在必填清单内')
  }

  // ② 必填但模板不渲染 → 只是多校验一次
  const extra = reqCols.filter(c => !tplCols.includes(c))
  if (extra.length) {
    out.problems.push({ level: 'info', kind: 'required-not-in-template', columns: extra })
    log(`必填但模板不渲染（多校验，无影响）：${extra.join(' / ')}`)
  }

  // ③ 逐单位检查「出片时实际会取到的那份数据集」
  let datasets = []
  try { datasets = store.readDatasets(dataDir) } catch (err) { log.warn(err.message) }

  const only = unitFilter(flags)
  const groups = groupsOf(datasets)
  let checked = 0
  for (const sheet of groups.keys()) {
    if (only && !only.has(unitNoOf(groups.get(sheet)[0].name))) continue
    const pick = store.pickDataset(datasets, sheet)
    if (!pick || !(pick.columns || []).length) continue
    checked++
    if (groups.get(sheet).length > 1) out.dupGroups++

    const byKey = new Map((pick.columns || []).map(c => [c.key, c]))
    const lack = tplCols.filter(k => !byKey.has(k))
    const off = tplCols.filter(k => byKey.has(k) && byKey.get(k).printOn !== true)
    if (lack.length) out.blank.push({ sheet, dataset: pick.name, columns: lack })
    if (off.length) out.unlit.push({ sheet, dataset: pick.name, columns: off })
  }
  out.checked = checked

  log(`检查 ${checked} 个单位（按 pickDataset 口径取数据集；其中有重份的 ${out.dupGroups} 组）`)
  if (!checked) log.warn('没有匹配到任何数据集（--unit 是否写错？或还没 import）')

  if (out.blank.length) {
    out.problems.push({ level: 'error', kind: 'dataset-missing-column', count: out.blank.length })
    log.err(`${out.blank.length} 个单位的数据集里没有模板要的列 —— 出片该位置会是空白`)
    out.blank.slice(0, 10).forEach(b => log.err(`  ${b.sheet} 缺: ${b.columns.join(' / ')}`))
    if (out.blank.length > 10) log.err(`  …另有 ${out.blank.length - 10} 个`)
  }

  if (out.unlit.length) {
    out.problems.push({ level: 'warn', kind: 'column-print-off', count: out.unlit.length })
    log.warn(`${out.unlit.length} 个单位有列未点亮「印」开关（不影响已配好的模板出片）`)
    out.unlit.slice(0, 8).forEach(u => log.warn(`  ${u.sheet} 未点亮: ${u.columns.join(' / ')}`))
    if (out.unlit.length > 8) log.warn(`  …另有 ${out.unlit.length - 8} 个`)
    log.warn('  会影响：模板页选不到这些字段、换绑数据集判结构错配、预检提示未激活')
    log.warn('  要补：pp_dataset_setColumnPrint 打开，或重新 import（按必填清单点亮）')
  }

  if (!out.blank.length && !out.unlit.length && checked) log('模板字段全部存在且已点亮')

  const errors = out.problems.filter(p => p.level === 'error')
  const warns = out.problems.filter(p => p.level === 'warn')
  const summary = errors.length
    ? `结论：${errors.length} 类会导致空白的结构问题，出片前必须修`
    : warns.length
      ? `结论：结构完整；${warns.length} 类提示项不影响出片，但会影响改模板 / 换绑数据集`
      : checked ? `结论：${tplCols.length} 个字段全部就绪（${checked} 个单位）` : '结论：没有可检查的数据集'
  return { ...out, summary, exitCode: errors.length ? 1 : 0 }
}

module.exports = { run, templateColumns, readTemplates }

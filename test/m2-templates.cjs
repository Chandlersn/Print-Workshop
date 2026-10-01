/**
 * M2 模板工坊领域层验收测试。
 * 运行：node test/m2-templates.cjs
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-m2')
const fs = require('fs')
const path = require('path')

const { pngSize, jpegSize, imageSize } = require('../electron/images.cjs')
const templates = require('../electron/templates.cjs')
const fonts = require('../electron/fonts.cjs')

const FIXTURES = path.join(__dirname, 'fixtures')
let pass = 0
let fail = 0

function assert(cond, label, extra) {
  if (cond) { pass += 1; console.log(`  PASS ${label}`) }
  else { fail += 1; console.error(`  FAIL ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`) }
}

function throws(fn, label) {
  try { fn(); fail += 1; console.error(`  FAIL ${label}（未抛错）`) }
  catch { pass += 1; console.log(`  PASS ${label}`) }
}

async function main() {
  console.log('== 1. 图片尺寸解析 ==')
  // 1x1 PNG（base64 内嵌，避免依赖外部生成）
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64')
  const size = pngSize(png1x1)
  assert(size && size.width === 1 && size.height === 1, 'PNG 1x1 解析', size)
  assert(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])) === null, '非法 JPEG 返回 null')
  const pngPath = path.join(FIXTURES, 'tiny.png')
  fs.writeFileSync(pngPath, png1x1)
  assert(imageSize(pngPath, fs).width === 1, 'imageSize 经文件读取')

  console.log('== 2. 纸张建议 ==')
  const hit = templates.suggestPageSize(2970, 2100)
  assert(hit.matched && hit.page.id === 'a4-landscape', 'A4 横版比例命中', hit)
  const miss = templates.suggestPageSize(1000, 3000)
  assert(!miss.matched && miss.page.id === 'custom' && miss.page.w === 265, '非标准比例换算自定义（mm/96dpi 四舍五入）', miss)
  const diff = templates.ratioDiff(297, 210, 1000, 1000)
  assert(diff > 0.02, '正方形底图配 A4 横版差超阈值', diff)

  console.log('== 3. 底图上传 ==')
  const bg = templates.uploadBackground(pngPath)
  assert(bg.background.startsWith('print-bg/'), '底图入 print-bg 目录', bg.background)
  assert(bg.width === 1 && bg.height === 1, '尺寸读取正确', bg)
  assert(fs.existsSync(path.join(process.env.PRINTPRESS_DATA_DIR, bg.background)), '文件真实落盘')

  console.log('== 4. 模板 CRUD（须绑定数据集） ==')
  const dataset = require('../electron/dataset.cjs')
  const csvPath = path.join(FIXTURES, 'bind-ds.csv')
  fs.writeFileSync(csvPath, '姓名,奖级\n甲,金奖\n乙,银奖\n', 'utf8')
  const ds = dataset.importFromFile(csvPath)
  dataset.setColumnPrint(ds.id, '姓名', true)

  throws(() => templates.saveTemplate({ name: '无绑定', fields: [] }), '未绑定数据集保存被拒')
  throws(() => templates.saveTemplate({ name: '绑定不存在', datasetId: 'ds_none', fields: [] }), '绑定不存在的数据集被拒')

  console.log('== 4.5 保存强校验：字段总数须与数据集激活列一一对应 ==')
  // ds 此刻只激活「姓名」：带一个未激活字段「奖级」保存必须被拒（用户实测的漏网场景）
  let savedErr = ''
  try {
    templates.saveTemplate({
      name: '含失效字段',
      datasetId: ds.id,
      fields: [
        { column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
        { column: '奖级', label: '奖级', x: 50, y: 70, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
      ],
    })
  } catch (err) { savedErr = String(err.message || err) }
  assert(savedErr.includes('2 个字段中有 1 个'), '未激活字段保存被拒且报数准确', savedErr)
  assert(savedErr.includes('奖级') && savedErr.includes('印'), '报错点名缺失字段并给激活指引', savedErr)
  assert(!/ds_|tpl_/.test(savedErr), '报错不暴露内部 id', savedErr)
  dataset.setColumnPrint(ds.id, '奖级', true)
  const tplOk = templates.saveTemplate({
    name: '字段全匹配',
    datasetId: ds.id,
    fields: [
      { column: '姓名', label: '姓名', x: 50, y: 50, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
      { column: '奖级', label: '奖级', x: 50, y: 70, fontSize: 24, color: '#000', align: 'center', bold: false, fontFamily: '' },
    ],
  })
  assert(tplOk.id, '字段全部激活后保存通过')
  templates.deleteTemplate(tplOk.id)
  dataset.setColumnPrint(ds.id, '奖级', false) // 还原：后续用例依赖仅姓名激活

  const tpl = templates.saveTemplate({
    name: '测试证书',
    pageSize: { id: 'a4-landscape', w: 297, h: 210 },
    background: bg.background,
    bgSize: { width: 1, height: 1 },
    datasetId: ds.id,
    fields: [{ key: '姓名', label: '姓名', x: 50, y: 60, fontSize: 28, color: '#2b2622', align: 'center', bold: true, fontFamily: '楷体' }],
  })
  assert(tpl.id && tpl.id.startsWith('tpl_'), '新建生成 id', tpl.id)
  assert(tpl.datasetId === ds.id, '模板绑定数据集持久化')
  const got = templates.getTemplate(tpl.id)
  assert(got.fields.length === 1 && got.fields[0].key === '姓名', '字段快照完整')
  const before = got.updatedAt
  templates.saveTemplate({ ...JSON.parse(JSON.stringify(got)), name: '测试证书改' })
  const got2 = templates.getTemplate(tpl.id)
  assert(got2.name === '测试证书改', '全量快照更新')
  assert(got2.updatedAt >= before, 'updatedAt 刷新')
  assert(templates.listTemplates().length === 1, '清单 1 条')

  console.log('== 5. 字体管理与引用校验 ==')
  const fakeFont = path.join(FIXTURES, '测试楷体.ttf')
  fs.writeFileSync(fakeFont, 'not-a-real-font')
  const up = fonts.uploadFont(fakeFont)
  assert(up.family === '测试楷体', '上传字体 family=去扩展名', up)
  assert(fonts.uploadedFonts().some((f) => f.family === '测试楷体'), '上传清单包含')

  const sys = fonts.systemFonts()
  const sysNames = sys.map((f) => f.family)
  assert(Array.isArray(sysNames), '系统字体清单返回', sysNames.length)
  assert(!sysNames.includes('不存在的字体'), '不写死暴露不存在的字体')

  assert(templates.fontUsedBy('测试楷体').length === 0, '未被引用时为空')
  templates.saveTemplate({ ...JSON.parse(JSON.stringify(got2)), fields: [{ key: '姓名', label: '姓名', x: 1, y: 1, fontSize: 1, color: '#000', align: 'left', bold: false, fontFamily: '测试楷体' }] })
  assert(templates.fontUsedBy('测试楷体').includes('测试证书改'), '引用检测命中模板名')

  let threw = false
  try { fonts.deleteFont('测试楷体.ttf') } catch { threw = true }
  assert(threw, '被引用字体删除被拒')

  console.log('== 6. 模板 × 数据集匹配与换绑 ==')
  // 造第二个数据集：只激活「奖级」，模板字段「姓名」未激活 → 匹配失败
  const csv2Path = path.join(FIXTURES, 'bind-ds2.csv')
  fs.writeFileSync(csv2Path, '姓名,奖级\n甲,金奖\n', 'utf8')
  const ds2 = dataset.importFromFile(csv2Path)
  dataset.setColumnPrint(ds2.id, '奖级', true)
  const m0 = templates.matchDataset(tpl.id, ds.id)
  assert(m0.ok && m0.fieldCount === 1, '绑定数据集自检通过（姓名已激活）', m0)
  const m1 = templates.matchDataset(tpl.id, ds2.id)
  assert(!m1.ok && m1.missing.length === 1 && m1.missing[0].key === '姓名', '缺失字段被识别', m1.missing)
  throws(() => templates.rebindDataset(tpl.id, ds2.id), '匹配失败时换绑被拒')

  // 激活后重新匹配 → 通过 → 换绑持久化
  dataset.setColumnPrint(ds2.id, '姓名', true)
  const m2 = templates.matchDataset(tpl.id, ds2.id)
  assert(m2.ok, '激活缺失字段后匹配通过')
  const rb = templates.rebindDataset(tpl.id, ds2.id)
  assert(rb.ok && rb.datasetId === ds2.id, '换绑成功并持久化')
  assert(templates.listTemplates().find((t) => t.id === tpl.id).datasetId === ds2.id, '清单反映新绑定')
  throws(() => templates.matchDataset(tpl.id, 'ds_none'), '对不存在数据集匹配抛错')

  console.log('== 6.5 模板删除连带清理底图文件 ==')
  const bgAbs = path.join(process.env.PRINTPRESS_DATA_DIR, tpl.background || bg.background)
  assert(fs.existsSync(bgAbs), '删除前底图文件真实在盘')
  templates.deleteTemplate(tpl.id)
  assert(templates.fontUsedBy('测试楷体').length === 0, '模板删除后引用解除')
  assert(!fs.existsSync(bgAbs), '删除模板连带清理底图文件（不留孤儿）')
  assert(templates.listTemplates().length === 0, '模板清单清空')
  fonts.deleteFont('测试楷体.ttf')
  assert(!fonts.uploadedFonts().some((f) => f.family === '测试楷体'), '解除引用后删除成功')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('测试执行异常:', err)
  process.exit(1)
})

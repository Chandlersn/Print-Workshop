/**
 * 出口校验（field-check.cjs）验收测试。
 *
 * 把守的核心不变量：**模板上的关键字段全有值，才能出证书**。
 * 空白字段不会报错，只会让成品上留一条「指导教师：」的空行 ——
 * 纸证书发出去改不了，所以这条必须在写盘前拦住。
 *
 * 另守住三个易漏点：
 * - 全空白字符串（'   '）等同于空，不能靠 trim 漏过去；
 * - 空值与 undefined/null 同样算空（数据集缺列时就是这个形态）；
 * - 报错要指名到「谁缺哪个字段」，否则几百行里无从下手。
 */
const fieldCheck = require('../electron/field-check.cjs')

let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

const KEYS = ['姓名', '组别', '指导老师', '证书编号', '赛项', '奖项情况', '省自治区直辖市', '所在学校必须写全名']
const allFilled = (o = {}) => ({
  姓名: '张三', 组别: '小学（1-2年级）', 指导老师: '李老师', 证书编号: 'CS001',
  赛项: '经典诵读', 奖项情况: '个人复赛一等奖', 省自治区直辖市: '四川省',
  所在学校必须写全名: '成都市实验小学', ...o,
})

function main() {
  console.log('== 1. 关键字段齐备 → 放行 ==')
  {
    const rows = [allFilled(), allFilled({ 姓名: '李四', 证书编号: 'CS002' })]
    let threw = false
    try { fieldCheck.assertFieldsFilled(rows, KEYS) } catch { threw = true }
    ok(!threw, '8 个字段全有值 → 不抛异常')
    ok(fieldCheck.findBlankRows(rows, KEYS).length === 0, 'findBlankRows 返回空数组')
  }

  console.log('== 2. 任一字段为空 → 拒绝出证书 ==')
  {
    const rows = [allFilled(), allFilled({ 姓名: '李四', 证书编号: 'CS002', 指导老师: '' })]
    let err = null
    try { fieldCheck.assertFieldsFilled(rows, KEYS, row => row['证书编号']) } catch (e) { err = e }
    ok(!!err, '缺指导老师 → 抛异常')
    ok(err && err.code === fieldCheck.FIELD_BLANK, '错误码是 FIELD_BLANK（可与打印机故障区分）', err && err.code)
    ok(err && /指导老师/.test(err.message), '错误信息点名缺哪个字段', err && err.message)
    ok(err && err.blankRows.length === 1 && err.blankRows[0].fields.join() === '指导老师', '错误体带行级明细', err && err.blankRows)
    ok(err && err.blankRows[0].name === 'CS002', '错误体用 nameOf 指向具体是哪个证书', err && err.blankRows[0])
  }

  console.log('== 3. 判空口径 ==')
  {
    const blank = row => fieldCheck.blankFieldsOf(row, KEYS)
    ok(blank(allFilled({ 组别: '   ' })).join() === '组别', "全空白字符串 '   ' 等同为空")
    ok(blank(allFilled({ 组别: undefined })).join() === '组别', 'undefined 算空（数据集缺列的形态）')
    ok(blank(allFilled({ 组别: null })).join() === '组别', 'null 算空')
    ok(blank(allFilled({ 组别: 0 })).length === 0, '数字 0 不算空（不能被 falsy 误判）')
    ok(blank(allFilled({ 组别: '  小学  '})).length === 0, '有值但带空格 → 不算空')
  }

  console.log('== 4. 入参健壮性 ==')
  {
    let threw = false
    try { fieldCheck.assertFieldsFilled([], KEYS) } catch { threw = true }
    ok(!threw, '空行集 → 直接放行（没有行就没有可校验的对象）')
    let threw2 = false
    try { fieldCheck.assertFieldsFilled([allFilled()], []) } catch { threw2 = true }
    ok(!threw2, '无要求字段 → 放行')
    const dup = fieldCheck.findBlankRows([allFilled({ 组别: '' })], ['组别', '组别'])
    ok(dup[0].fields.length === 1, '重复字段名去重，不会报两遍同一个字段')
    const noName = fieldCheck.findBlankRows([allFilled({ 姓名: '' })], KEYS)
    ok(noName[0].name === '(未命名)', '没有可用命名时回落到 (未命名)，而不是空串', noName[0])
  }

  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

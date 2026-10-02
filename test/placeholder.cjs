/**
 * 占位值检测验收：只走**值形态规则**（括号包裹 / 纯标点），不写死业务字面量。
 * 命中只作「疑似占位」提示，绝不拦截、不等于空值——出口校验的语义底线。
 *
 * （原 scope-filters 套件随「行筛选 / 分组导出」下线一并收缩：行筛选由行级勾选取代，
 *   打印范围相关断言见 print-scope.cjs。）
 */
const { isPlaceholder, PLACEHOLDER_SHAPES } = require('../electron/placeholder.cjs')

let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

console.log('== 占位值检测（值形态规则，非业务字面量） ==')
ok(isPlaceholder('（待补）') === true, '全角括号包裹')
ok(isPlaceholder('(TBD)') === true, '半角括号包裹')
ok(isPlaceholder('【占位】') === true, '方头括号包裹')
ok(isPlaceholder('——') === true, '纯破折号')
ok(isPlaceholder('/') === true, '纯斜杠')
ok(isPlaceholder('???') === true, '纯问号')
ok(isPlaceholder('（良好的作品）') === true, '形态规则对一切整值括号包裹生效（只提示不拦截，不猜内容好坏）')
ok(isPlaceholder('张三') === false, '正常文本')
ok(isPlaceholder('张三（金奖）') === false, '句中括号不算整值包裹')
ok(isPlaceholder('') === false && isPlaceholder('  ') === false, '空串不是占位（是空值，另行统计）')
ok(isPlaceholder(null) === false && isPlaceholder(undefined) === false, 'null/undefined 安全')
ok(isPlaceholder(0) === false, '数字 0 安全')
ok(PLACEHOLDER_SHAPES.length === 2, '形态规则只有两条（可读、可审）')

console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
process.exit(failCount ? 1 : 0)

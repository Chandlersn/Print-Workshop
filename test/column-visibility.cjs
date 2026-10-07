/**
 * 数据页列显隐纯函数验收。
 *
 * 这些函数守的是三件容易出错的事：
 *   1. 落盘 JSON 用户可手工编辑，坏形状不能带进渲染；
 *   2. 隐藏状态按列 key 记，换过文件后的旧 key 不能算数（否则「已隐藏 1 列」却看不见藏了谁）；
 *   3. 至少留一列——藏到 0 列，用户连找回的入口都没有（胶囊只在有隐藏时才出现）。
 *
 * 运行：node test/column-visibility.cjs
 */
const assert = require('assert')
const {
  sanitizeHidden, hiddenKeysOf, withHidden, visibleColumnsOf, canHideMore, pruneHidden,
} = require('../src/lib/column-visibility.cjs')

let pass = 0
function ok(cond, label, extra) {
  assert.ok(cond, label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  pass += 1
  console.log('  ok -', label)
}

const COLS = [{ key: '姓名' }, { key: '单位' }, { key: '奖项' }]

console.log('== 1. 落盘形状校验：坏形状当没存过，绝不带进渲染 ==')
{
  for (const bad of [null, undefined, 'x', 123, true, ['a'], []]) {
    ok(JSON.stringify(sanitizeHidden(bad)) === '{}', `非对象入参 ${JSON.stringify(bad)} → 空 map`)
  }
  ok(JSON.stringify(sanitizeHidden({ ds1: 'not-array' })) === '{}', '值不是数组的数据集被丢掉')
  ok(JSON.stringify(sanitizeHidden({ ds1: ['a', 1, null, '', 'b'] })) === '{"ds1":["a","b"]}',
    '数组里的非字符串与空串被剔掉', sanitizeHidden({ ds1: ['a', 1, null, '', 'b'] }))
  ok(JSON.stringify(sanitizeHidden({ ds1: ['a', 'a', 'b'] })) === '{"ds1":["a","b"]}', '同一列记两次会去重')
  ok(JSON.stringify(sanitizeHidden({ ds1: [] })) === '{}', '空数组的数据集不留键（盘上不攒空数组）')
  ok(JSON.stringify(sanitizeHidden({ '': ['a'] })) === '{}', '空 id 被丢掉')
  ok(JSON.stringify(sanitizeHidden({ ds1: ['a'], ds2: ['b'] })) === '{"ds1":["a"],"ds2":["b"]}',
    '多个数据集原样保留')
}

console.log('== 2. 隐藏集只认「当前数据集真实存在的列」 ==')
{
  ok(hiddenKeysOf({ ds1: ['姓名', '单位'] }, 'ds1', COLS).size === 2, '正常的两个隐藏列')
  // 关键：重新导入同一个文件会换 key，旧 key 留在盘上但不该算数
  ok(hiddenKeysOf({ ds1: ['姓名', '已删除的列'] }, 'ds1', COLS).size === 1,
    '盘上的旧 key（列已不存在）不算数', [...hiddenKeysOf({ ds1: ['姓名', '已删除的列'] }, 'ds1', COLS)])
  ok(hiddenKeysOf({ ds1: ['姓名'] }, 'ds-other', COLS).size === 0, '别的数据集的记录不串台')
  ok(hiddenKeysOf(null, 'ds1', COLS).size === 0, 'map 为 null → 空集')
  ok(hiddenKeysOf({ ds1: ['姓名'] }, 'ds1', null).size === 0, '没有列时 → 空集（列都还没加载）')
  ok(hiddenKeysOf({ ds1: ['姓名'] }, '', COLS).size === 0, '数据集 id 为空 → 空集')
}

console.log('== 3. 写回：不改入参、去重、空集删键 ==')
{
  const before = { ds1: ['姓名'], ds2: ['单位'] }
  const next = withHidden(before, 'ds1', ['单位', '奖项'])
  ok(JSON.stringify(before) === '{"ds1":["姓名"],"ds2":["单位"]}', '原 map 未被改动', before)
  ok(JSON.stringify(next.ds1) === '["单位","奖项"]', '目标数据集被整体替换')
  ok(JSON.stringify(next.ds2) === '["单位"]', '别的数据集不受影响')

  const cleared = withHidden(before, 'ds1', [])
  ok(!('ds1' in cleared), '空集删键而不是留个空数组')
  ok('ds2' in cleared, '删键不牵连别的数据集')

  ok(JSON.stringify(withHidden(before, 'ds1', ['a', 'a'])) === '{"ds1":["a"],"ds2":["单位"]}',
    '重复的 key 去重')
  ok(JSON.stringify(withHidden(before, 'ds1', ['a', null, 3, ''])) === '{"ds1":["a"],"ds2":["单位"]}',
    '非字符串 key 被剔掉（不让坏值进盘）')
  ok(JSON.stringify(withHidden(before, '', ['a'])) === JSON.stringify(before),
    'datasetId 为空时原样返回（不往 map 里塞空键）')
  ok(JSON.stringify(withHidden(null, 'ds1', ['a'])) === '{"ds1":["a"]}', 'null map 也能起步')
}

console.log('== 4. 可见列过滤 ==')
{
  const vis = visibleColumnsOf(COLS, new Set(['单位']))
  ok(vis.length === 2 && vis[0].key === '姓名' && vis[1].key === '奖项',
    '按隐藏集过滤且保持原顺序', vis.map((c) => c.key))
  ok(visibleColumnsOf(COLS, ['单位']).length === 2, '隐藏集给数组也认')
  ok(visibleColumnsOf(COLS, []).length === 3, '空隐藏集 → 全量')
  ok(visibleColumnsOf(COLS, new Set()).length === 3, '空 Set → 全量')
  ok(visibleColumnsOf(null, ['姓名']).length === 0, 'columns 为 null → 空数组')
  ok(visibleColumnsOf(COLS, new Set(['姓名', '单位', '奖项'])).length === 0,
    '理论上不会发生，但函数本身不抛错')
}

console.log('== 5. 至少留一列 ==')
{
  ok(canHideMore(COLS, new Set()) === true, '3 列一列没藏 → 还能藏')
  ok(canHideMore(COLS, new Set(['姓名'])) === true, '3 列藏 1 → 还能藏')
  ok(canHideMore(COLS, new Set(['姓名', '单位'])) === false, '3 列藏 2（只剩 1 列）→ 拦住')
  ok(canHideMore(COLS, new Set(['姓名', '单位', '奖项'])) === false, '全藏 → 拦住')
  ok(canHideMore([{ key: '姓名' }], new Set()) === false, '单列数据集根本没有可藏的余地')
  ok(canHideMore([], new Set()) === false, '没有列 → 拦住')
  ok(canHideMore(COLS, ['姓名', '单位']) === false, '隐藏集给数组也认')
}

console.log('== 6. 清理已删数据集留下的记录 ==')
{
  const map = { alive: ['a'], dead: ['b'], alsoDead: ['c'] }
  const pruned = pruneHidden(map, ['alive', 'other'])
  ok(JSON.stringify(pruned) === '{"alive":["a"]}', '只留仍在的数据集', pruned)
  ok(JSON.stringify(map) === '{"alive":["a"],"dead":["b"],"alsoDead":["c"]}', '原 map 未被改动')
  ok(JSON.stringify(pruneHidden(map, new Set(['alive']))) === '{"alive":["a"]}', 'Set 也认')
  // 这条是安全底线：列表读失败 / 全删光时都可能是空，宁可留垃圾也不抹偏好
  ok(JSON.stringify(pruneHidden(map, [])) === JSON.stringify(map),
    '数据集列表为空时原样返回（不把用户偏好一次抹掉）', pruneHidden(map, []))
  ok(JSON.stringify(pruneHidden(null, ['a'])) === '{}', 'null map → 空 map')
}

console.log('== 7. 存盘 → 读回 往返稳定（改字号不许冲掉隐藏状态） ==')
{
  // 模拟 DatasetView 的整写镜像：点一次字号，写下去的是 { tableSize, hiddenColumns }
  const mirror = withHidden({}, 'ds1', ['姓名', '单位'])
  const written = { tableSize: 'l', hiddenColumns: mirror }
  const readBack = sanitizeHidden(written.hiddenColumns)
  ok(hiddenKeysOf(readBack, 'ds1', COLS).size === 2, '改字号后隐藏状态原样读回')
  ok(written.tableSize === 'l', '字号也一起写下去了（两个字段同住一个键）')

  // 往返幂等：写两次与写一次等价
  const twice = sanitizeHidden(withHidden(readBack, 'ds1', [...hiddenKeysOf(readBack, 'ds1', COLS)]))
  ok(JSON.stringify(twice) === JSON.stringify(readBack), '同状态反复存读不漂移', twice)

  const emptied = sanitizeHidden(withHidden(readBack, 'ds1', []))
  ok(JSON.stringify(emptied) === '{}', '全部恢复后盘上是干净的（无空数组残留）')
  ok(visibleColumnsOf(COLS, hiddenKeysOf(emptied, 'ds1', COLS)).length === 3, '恢复后三列全可见')
}

console.log(`\n列显隐纯逻辑：${pass} 项断言通过`)

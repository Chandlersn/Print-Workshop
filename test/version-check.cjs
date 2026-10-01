#!/usr/bin/env node
/**
 * 更新检测单元测试：版本比较 / 载荷解析 / checkForUpdate 决策矩阵。
 * 全部用注入的 fake fetch，不发起真实网络请求，也不依赖数据目录。
 */
const assert = (cond, name, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
  if (!cond) process.exitCode = 1
}

const vc = require('../electron/version-check.cjs')

console.log('== 1. compareVersions 版本比较 ==')
assert(vc.compareVersions('0.1.0', '0.1.0') === 0, '相同版本 = 0')
assert(vc.compareVersions('0.1.1', '0.1.0') === 1, '补丁位更大')
assert(vc.compareVersions('0.2.0', '0.1.9') === 1, '次版本位更大（跨进位）')
assert(vc.compareVersions('1.0.0', '0.9.9') === -1 ? false : true, '主版本位更大')
assert(vc.compareVersions('0.1.0', '1.0.0') === -1, '本地更小 → -1')
assert(vc.compareVersions('v0.2.0', '0.2.0') === 0, '忽略 v 前缀')
assert(vc.compareVersions('0.1', '0.1.0') === 0, '缺段补 0 等价')
assert(vc.compareVersions('0.10.0', '0.9.0') === 1, '数值比较而非字符串比较（10 > 9）')

console.log('== 2. parseInfo 载荷解析 ==')
const good = vc.parseInfo('{"version":"0.2.0","notes":"修复若干","url":"https://x/releases"}')
assert(good && good.version === '0.2.0' && good.notes === '修复若干' && good.url === 'https://x/releases', '合法载荷完整解析', good)
assert(vc.parseInfo('{"notes":"缺版本号"}') === null, '缺 version → null（不猜测）')
assert(vc.parseInfo('{"version":"   "}') === null, '纯空白 version → null（不猜测）')
assert(vc.parseInfo('{"version":"  0.3.0  "}').version === '0.3.0', 'version 首尾空白被裁剪')
assert(vc.parseInfo('not json at all') === null, '非 JSON → null')
assert(vc.parseInfo('') === null, '空串 → null')

console.log('== 3. checkForUpdate 决策矩阵（fake fetch，无真实网络） ==')
const okFetch = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => body })
const LATEST = JSON.stringify({ version: '0.2.0', notes: '新版', url: 'https://x' })

async function main() {
  {
    const r = await vc.checkForUpdate({ fetchImpl: okFetch(LATEST), currentVersion: '0.1.0', infoUrl: 'fake://x' })
    assert(r.status === 'newer' && r.info.version === '0.2.0', '远程更大 → newer + info', r)
  }
  {
    const r = await vc.checkForUpdate({ fetchImpl: okFetch(LATEST), currentVersion: '0.2.0', infoUrl: 'fake://x' })
    assert(r.status === 'current', '版本相同 → current（不打扰）', r)
  }
  {
    const r = await vc.checkForUpdate({ fetchImpl: okFetch(LATEST), currentVersion: '0.3.0', infoUrl: 'fake://x' })
    assert(r.status === 'current', '本地更新 → current（不做降级提示）', r)
  }
  {
    const r = await vc.checkForUpdate({ fetchImpl: okFetch('gone', 404), currentVersion: '0.1.0', infoUrl: 'fake://x' })
    assert(r.status === 'unavailable' && /HTTP 404/.test(r.reason), 'HTTP 错误 → unavailable', r)
  }
  {
    const r = await vc.checkForUpdate({ fetchImpl: okFetch('{"broken"'), currentVersion: '0.1.0', infoUrl: 'fake://x' })
    assert(r.status === 'unavailable' && r.reason === 'bad payload', '坏载荷 → unavailable', r)
  }
  {
    const r = await vc.checkForUpdate({
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
      currentVersion: '0.1.0', infoUrl: 'fake://x',
    })
    assert(r.status === 'unavailable' && r.reason === 'network', '网络异常 → unavailable（离线静默）', r)
  }
  {
    const r = await vc.checkForUpdate({
      fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e },
      currentVersion: '0.1.0', infoUrl: 'fake://x',
    })
    assert(r.status === 'unavailable' && r.reason === 'timeout', '超时 → unavailable', r)
  }
  {
    const r = await vc.checkForUpdate({ fetchImpl: okFetch(LATEST), currentVersion: '', infoUrl: 'fake://x' })
    assert(r.status === 'unavailable', '缺 currentVersion → unavailable', r)
  }

  console.log('== 4. 配置常量形态 ==')
  assert(/^https:\/\//.test(vc.UPDATE_INFO_URL), 'UPDATE_INFO_URL 是 https 地址')
  assert(/^https:\/\//.test(vc.RELEASES_URL) && /releases$/.test(vc.RELEASES_URL), 'RELEASES_URL 指向 releases 页')
  assert(/^https:\/\//.test(vc.FEEDBACK_URL), 'FEEDBACK_URL 是 https 地址')

  console.log(`\n结果: ${process.exitCode ? '存在失败' : '全部通过'}`)
}

main()

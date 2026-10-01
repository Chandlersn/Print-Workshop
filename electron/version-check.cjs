/**
 * 更新检测：远程 latest.json 与本地版本号比对（纯函数 + 主进程接线共用）。
 *
 * 设计原则（对应「自动化边界三问」）：
 * - 检测这步系统能确定性完成 → 启动后自动做一次，无需人触发；
 * - 结果必须卡点可见 → 只有「远程版本更大」才弹横幅（现象 + 出口链接），
 *   网络失败 / 超时 / 数据异常一律静默（status:'unavailable'），绝不打扰离线用户；
 * - 手动「检查更新」入口给用户明确反馈（最新 / 新版本 / 检测失败），不留死胡同。
 *
 * 所有对外 URL 收敛在本文件（单一权威定义源）：建仓 / 换仓库只改这三个常量。
 * PRINTPRESS_UPDATE_URL 环境变量可覆盖检测地址（测试与私有部署用）。
 */

const UPDATE_INFO_URL = 'https://cdn.jsdelivr.net/gh/PLACEHOLDER/REPO@main/latest.json'
const RELEASES_URL = 'https://github.com/PLACEHOLDER/REPO/releases'
const FEEDBACK_URL = 'https://github.com/PLACEHOLDER/REPO/issues'

const CHECK_TIMEOUT_MS = 3000

/** 语义化版本比较（忽略 v 前缀，逐段数值比较，缺段补 0）。返回 -1/0/1。 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** 宽容解析远程 latest.json：version 缺失/非法 → null（视为检测失败，不猜测） */
function parseInfo(text) {
  try {
    const o = JSON.parse(text)
    if (!o || typeof o.version !== 'string' || !o.version.trim()) return null
    return {
      version: o.version.trim(),
      notes: typeof o.notes === 'string' ? o.notes : '',
      url: typeof o.url === 'string' ? o.url : '',
    }
  } catch {
    return null
  }
}

/**
 * 一次检测。返回三种状态之一：
 * - { status:'newer', info }    远程版本更大 → 渲染层弹横幅
 * - { status:'current' }        本地已是最新（含远程更旧，不做降级提示）
 * - { status:'unavailable', reason } 检测失败（离线/超时/坏数据），静默处理
 */
async function checkForUpdate({
  fetchImpl = fetch,
  currentVersion,
  infoUrl = process.env.PRINTPRESS_UPDATE_URL || UPDATE_INFO_URL,
  timeoutMs = CHECK_TIMEOUT_MS,
} = {}) {
  if (!currentVersion) return { status: 'unavailable', reason: 'missing currentVersion' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(infoUrl, { signal: ctrl.signal })
    if (!res.ok) return { status: 'unavailable', reason: `HTTP ${res.status}` }
    const info = parseInfo(await res.text())
    if (!info) return { status: 'unavailable', reason: 'bad payload' }
    if (compareVersions(info.version, currentVersion) > 0) return { status: 'newer', info }
    return { status: 'current' }
  } catch (err) {
    return { status: 'unavailable', reason: err && err.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  UPDATE_INFO_URL, RELEASES_URL, FEEDBACK_URL, CHECK_TIMEOUT_MS,
  compareVersions, parseInfo, checkForUpdate,
}

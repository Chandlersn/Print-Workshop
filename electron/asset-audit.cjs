const path = require('path')
const { Worker } = require('worker_threads')
let worker = null, state = { phase: 'idle', report: null }
function status(options = {}) {
  const maintenance = require('./asset-thumbnail-cleanup.cjs').status()
  if (!state.report) return { ...state, maintenance }
  const { groups, issues, assets, ...summary } = state.report
  const pageFor = (items, input) => {
    const pages = Math.max(1, Math.ceil(items.length / 30))
    const page = Math.min(pages, Number.isSafeInteger(input) && input > 0 ? input : 1)
    return { page, pages, total: items.length, items: items.slice((page - 1) * 30, page * 30) }
  }
  return { phase: state.phase, maintenance, report: { ...summary, groupCount: groups.length, groups: pageFor(groups, options.groupsPage), issueCount: issues.length, issues: pageFor(issues, options.issuesPage), assets: pageFor(assets, options.assetsPage) } }
}
function start() {
  if (worker) return status()
  state = { phase: 'starting', report: null }
  const current = new Worker(path.join(__dirname, 'asset-audit-worker.cjs'), { workerData: { audit: true } })
  worker = current
  current.on('message', message => {
    if (worker !== current) return
    if (message.phase === 'completed') { state = { phase: 'completed', report: message.report }; worker = null }
    else if (message.phase === 'failed') { state = { phase: 'failed', reason: message.reason, report: null }; worker = null }
    else state = { ...message, report: null }
  })
  current.on('error', () => { if (worker === current) { worker = null; state = { phase: 'failed', reason: '扫描进程异常，请重新尝试', report: null } } })
  current.on('exit', code => { if (worker === current) { worker = null; state = { phase: 'failed', reason: code ? '扫描进程异常退出' : '扫描未完成', report: null } } })
  return status()
}
async function cancel() {
  if (worker) { const current = worker; worker = null; state = { phase: 'canceled', report: null }; await current.terminate() }
  return status()
}
module.exports = { status, start, cancel }

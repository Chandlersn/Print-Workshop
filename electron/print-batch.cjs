/**
 * 分批出片编排（S1.3-b）：按整纸切批后的「逐批输出 → 校验 → 发布」。
 *
 * 纯 Node 模块（不 require electron）——Electron 打印通道经参数注入，
 * 这样整个编排（含取消、临时件清理、合并发布）能在 npm test 里用假
 * printer 驱动真 pdf-merge 全链路验证。
 *
 * 分层的理由（不变式「中途失败不能把半成品标记为成功」）：
 * - 每批 printToPDF 先写**批临时文件**（最终文件同目录，保证 rename 原子）
 * - 批内校验：页数必须等于计划页数（Chromium 多排一页/漏页当场炸）
 * - 全部批次成功后合并到**合并临时件**，再校验总页数
 * - 最后一步才 rename 发布最终文件；此前任何失败/取消都不碰最终文件，
 *   finally 里清掉所有临时件
 *
 * 取消语义（docs/v0.6后续优化开发计划.md §3）：
 * - PDF：停止后续批次、销毁窗口、清理临时输出，状态记为取消
 * - 直打：只停止尚未提交的部分；已交给系统队列的内容不承诺撤回，
 *   错误信息里带「已提交 N 批」
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { mergePdfs, countPdfPagesFromFile } = require('./pdf-merge.cjs')

function tempStamp() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

function tryUnlink(p) {
  try { if (p) fs.unlinkSync(p) } catch { /* 临时件清理失败不影响主流程 */ }
}

/** 取消错误：api.cjs 据 err.canceled 决定留痕状态是 canceled 还是 failed */
function canceledError(kind, extra = {}) {
  const err = new Error(kind === 'print'
    ? `已取消打印：已提交 ${extra.submitted || 0} 批（系统队列内的内容无法撤回），未提交批次不再送出`
    : '已取消导出，临时输出已清理')
  err.canceled = true
  err.submitted = extra.submitted || 0
  return err
}

function totalPagesOf(batches) {
  return batches.reduce((s, b) => s + b.pages, 0)
}

/**
 * 分批导出 PDF。
 * @param o.batches   planBatches 的结果（行区间 + 每批计划页数）
 * @param o.printer   { printToPdfBuffer(html, {partition}) }——Electron 通道
 * @param o.onProgress (p) => void  阶段事件，供上层转成 IPC 进度
 * @param o.shouldCancel () => boolean
 */
async function exportPdfBatched(o) {
  const {
    domain, printer, datasetId, templateId, rows, savePath,
    batches, onProgress = () => {}, shouldCancel = () => false,
  } = o
  const dir = path.dirname(savePath)
  const stamp = tempStamp()
  const partPaths = []
  let mergedTmp = ''
  try {
    if (shouldCancel()) throw canceledError('pdf')
    const totalRows = batches.reduce((s, b) => s + b.rows, 0)
    for (let i = 0; i < batches.length; i++) {
      if (shouldCancel()) throw canceledError('pdf')
      const b = batches[i]
      onProgress({ phase: 'batch-start', index: i + 1, batches: batches.length, start: b.start, end: b.end, rows: b.rows, pages: b.pages })
      const built = domain.buildBatchHtml(datasetId, templateId, rows, { range: { from: b.start, to: b.end } })
      // 每批一个内存 session：Chromium 复用同源渲染进程会让批间内存只累不释
      const buf = await printer.printToPdfBuffer(built.html, { partition: `temp:print-batch-${i + 1}-${stamp}` })
      const partPath = path.join(dir, `.printpress-tmp-${stamp}-part${i + 1}of${batches.length}.pdf`)
      fs.writeFileSync(partPath, buf)
      partPaths.push(partPath)
      // 批内校验：计划页数与实际不符 = Chromium 排出了意外分页，必须炸在发布前
      const actual = countPdfPagesFromFile(partPath)
      if (actual !== b.pages) {
        throw new Error(`第 ${i + 1}/${batches.length} 批页数不符：计划 ${b.pages} 页，实际 ${actual} 页（未产出最终文件）`)
      }
      onProgress({ phase: 'batch-done', index: i + 1, batches: batches.length, bytes: buf.length, pages: actual, rows: b.rows })
      if (shouldCancel()) throw canceledError('pdf')
    }
    const expectPages = totalPagesOf(batches)
    onProgress({ phase: 'merge', pages: expectPages, files: partPaths.length })
    if (shouldCancel()) throw canceledError('pdf')
    mergedTmp = path.join(dir, `.printpress-tmp-${stamp}-merged.pdf`)
    const merged = await mergePdfs(partPaths, mergedTmp)
    if (merged.pages !== expectPages) {
      throw new Error(`合并页数不符：计划 ${expectPages} 页，实际 ${merged.pages} 页（未产出最终文件）`)
    }
    if (shouldCancel()) throw canceledError('pdf')
    // 发布：同目录 rename（原子覆盖）；此前任何一步失败都没碰过最终文件
    fs.renameSync(mergedTmp, savePath)
    mergedTmp = ''
    onProgress({ phase: 'publish', path: savePath, bytes: merged.bytes, pages: merged.pages, rows: totalRows })
    return { ok: true, path: savePath, bytes: merged.bytes, pages: merged.pages, batches: batches.length }
  } finally {
    // 成功发布后批临时件也没用了（合并件已改名走人）——一并清
    for (const p of partPaths) tryUnlink(p)
    tryUnlink(mergedTmp)
  }
}

/**
 * 分批直接送打印。没有临时文件（纸不经过磁盘），失败/取消只涉及未提交的批。
 * 非静默时每批由系统对话框确认设备和设置；Electron 不返回对话框选中的设备，
 * 不能把后续批次改为静默默认设备。silent=true 时各批沿用调用者指定的静默行为。
 */
async function sendToPrinterBatched(o) {
  const {
    domain, printer, datasetId, templateId, rows, silent,
    batches, onProgress = () => {}, shouldCancel = () => false,
  } = o
  let submitted = 0
  let submittedRows = 0
  for (let i = 0; i < batches.length; i++) {
    if (shouldCancel()) throw canceledError('print', { submitted })
    const b = batches[i]
    onProgress({ phase: 'submit-start', index: i + 1, batches: batches.length, start: b.start, end: b.end, rows: b.rows, pages: b.pages })
    const built = domain.buildBatchHtml(datasetId, templateId, rows, { range: { from: b.start, to: b.end } })
    const r = await printer.sendToPrinter(built.html, {
      silent: Boolean(silent),
      partition: `temp:print-batch-${i + 1}-${tempStamp()}`,
    })
    if (!r || !r.ok) {
      throw new Error(`第 ${i + 1}/${batches.length} 批送打印失败：${(r && r.error) || '未知原因'}`
        + `${submitted ? `（前 ${submitted} 批已提交系统队列，无法撤回）` : ''}`)
    }
    submitted++
    submittedRows += b.rows
    onProgress({ phase: 'submit-done', index: i + 1, batches: batches.length, submitted, rows: submittedRows })
    if (shouldCancel()) throw canceledError('print', { submitted })
  }
  return { ok: true, submitted, rows: submittedRows, batches: batches.length }
}

module.exports = { exportPdfBatched, sendToPrinterBatched, canceledError }

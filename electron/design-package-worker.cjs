/** `.ppdesign` 导出 worker：ZIP 写入与图片读取不能阻塞 Electron 主线程。 */
const { parentPort, workerData } = require('worker_threads')
const designPackage = require('./design-package.cjs')

const canceled = new Int32Array(workerData.cancelBuffer)
try {
  const result = designPackage.exportPackage({
    ...workerData.options,
    shouldCancel: () => Atomics.load(canceled, 0) !== 0,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }),
  })
  parentPort.postMessage({ type: 'done', result })
} catch (error) {
  if (error && (error.code === 'CANCELLED' || error.name === 'CancelledError')) {
    parentPort.postMessage({ type: 'canceled' })
  } else {
    parentPort.postMessage({ type: 'error', message: error?.message || String(error) })
  }
}

/** Electron decoding adapter. Processing and model inference run off the UI thread. */
const { nativeImage, app } = require('electron')
const { Worker } = require('worker_threads')
const path = require('path'), fs = require('fs')
let worker = null, sequence = 0
const pending = new Map()
function modelPath(name = 'modnet.onnx') {
  const bundled = path.join(process.resourcesPath || '', 'models', name)
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', 'build', 'models', name)
}
function status() { return { ready: fs.existsSync(modelPath()), qualityReady: fs.existsSync(modelPath('birefnet-lite.onnx')), faceReady: fs.existsSync(modelPath('yunet.onnx')), name: 'MODNet', local: true } }
function ensureWorker() {
  if (worker) return worker
  const instance = worker = new Worker(path.join(__dirname, 'photo-processing-worker.cjs'))
  instance.on('message', message => {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.reference ? message.reference : { png: Buffer.from(message.png), restorePng: Buffer.from(message.restorePng), analysis: message.analysis })
  })
  const fail = error => {
    if (worker === instance) worker = null
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
  }
  instance.on('error', () => fail(new Error('照片处理进程启动失败，请重新安装或重启应用')))
  instance.on('exit', () => { if (worker === instance) fail(new Error('照片处理已中断，请重试')) })
  instance.unref()
  return instance
}
async function processPhoto({ asset, buffer, recipe, protectPolygon, subjectPolygon, model = 'fast', analyzeReference = false }) {
  if (quitting) throw new Error('应用正在关闭，照片处理已停止')
  if (!['fast', 'quality'].includes(model)) throw new Error('抠图模式无效')
  if (recipe?.cutout && !(model === 'quality' ? status().qualityReady : status().ready)) throw new Error('所选本地抠图模型缺失，请重新安装完整安装包或选择其他模式')
  if ((analyzeReference || recipe?.faceAlign) && !status().faceReady) throw new Error('本地人物对齐模型缺失，请重新安装完整安装包')
  let image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('照片无法解码')
  let size = image.getSize()
  if (Math.max(size.width, size.height) > 3200) {
    const scale = 3200 / Math.max(size.width, size.height)
    image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'best' }); size = image.getSize()
  }
  const bitmap = image.toBitmap(), id = ++sequence
  const instance = ensureWorker()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { instance.terminate(); reject(new Error('单张照片处理超时，请缩小照片或选择快速模式后重试')) }, model === 'quality' ? 300000 : 120000)
    pending.set(id, { resolve, reject, timer })
    instance.postMessage({ id, assetId: asset.id, bitmap, width: size.width, height: size.height, orientation: asset.orientation || 1, recipe, protectPolygon, subjectPolygon, analyzeReference, model, modelPath: modelPath(model === 'quality' ? 'birefnet-lite.onnx' : 'modnet.onnx'), faceModelPath: modelPath('yunet.onnx') })
  })
}
function analyzePhoto({ asset, buffer }) { return processPhoto({ asset, buffer, analyzeReference: true }) }
async function shutdown() {
  const instance = worker
  if (!instance) return
  worker = null
  await new Promise(resolve => {
    const timer = setTimeout(() => { instance.terminate().finally(resolve) }, 4000)
    instance.once('exit', () => { clearTimeout(timer); resolve() })
    instance.postMessage({ shutdown: true })
  })
}
let quitting = false
app?.on?.('before-quit', event => {
  if (!worker || quitting) return
  event.preventDefault(); quitting = true
  shutdown().finally(() => app.quit())
})
function cropPhoto({ buffer, crop }) {
  const image = nativeImage.createFromBuffer(buffer), size = image.getSize()
  if (image.isEmpty() || !crop || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(crop[key])) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1.000001 || crop.y + crop.h > 1.000001) throw new Error('照片裁剪区域无效')
  const x = Math.floor(crop.x * size.width), y = Math.floor(crop.y * size.height)
  return image.crop({ x, y, width: Math.min(size.width - x, Math.max(1, Math.round(crop.w * size.width))), height: Math.min(size.height - y, Math.max(1, Math.round(crop.h * size.height))) }).toPNG()
}
module.exports = { status, processPhoto, analyzePhoto, cropPhoto, shutdown }

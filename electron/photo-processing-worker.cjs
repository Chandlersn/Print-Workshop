const { parentPort } = require('worker_threads')
const fs = require('fs'), crypto = require('crypto')
const { orientedRgba, applyMatte, processPixels, photoTransform } = require('./photo-processing-pixels.cjs')
const { pngFromPixels } = require('./psd-import.cjs')
const MODEL_HASH = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9'
let sessionPromise = null, chain = Promise.resolve()
const mattes = new Map()
async function segment(image, modelPath, assetId) {
  if (mattes.has(assetId)) return mattes.get(assetId)
  const ort = require('onnxruntime-node')
  if (!sessionPromise) sessionPromise = (async () => {
    if (crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex') !== MODEL_HASH) throw new Error('抠图模型校验失败，请重新安装应用')
    return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' })
  })().catch(error => { sessionPromise = null; throw error })
  const session = await sessionPromise
  const scale = Math.min(512 / Math.min(image.width, image.height), 1024 / Math.max(image.width, image.height))
  const w = Math.max(32, Math.round(image.width * scale / 32) * 32), h = Math.max(32, Math.round(image.height * scale / 32) * 32)
  const input = new Float32Array(3 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.max(0, Math.min(image.width - 1, (x + .5) * image.width / w - .5)), sy = Math.max(0, Math.min(image.height - 1, (y + .5) * image.height / h - .5))
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1), tx = sx - x0, ty = sy - y0
    for (let c = 0; c < 3; c++) {
      const upper = image.data[(y0 * image.width + x0) * 4 + c] * (1 - tx) + image.data[(y0 * image.width + x1) * 4 + c] * tx
      const lower = image.data[(y1 * image.width + x0) * 4 + c] * (1 - tx) + image.data[(y1 * image.width + x1) * 4 + c] * tx
      input[c * w * h + y * w + x] = (upper * (1 - ty) + lower * ty) / 127.5 - 1
    }
  }
  const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) })
  const tensor = output[session.outputNames[0]]
  const mask = { data: new Float32Array(tensor.data), width: tensor.dims.at(-1), height: tensor.dims.at(-2) }
  if (mask.data.length !== mask.width * mask.height || mask.data.some(value => !Number.isFinite(value))) throw new Error('抠图结果无效，请重试')
  mattes.set(assetId, mask)
  while (mattes.size > 12) mattes.delete(mattes.keys().next().value)
  return mask
}
async function run(message) {
  const image = orientedRgba(message.bitmap, message.width, message.height, message.orientation)
  const original = { ...image, data: new Uint8ClampedArray(image.data) }
  const faces = message.recipe.faceAlign ? await require('./photo-face-align.cjs').detect(image, message.faceModelPath, message.assetId) : []
  if (message.recipe.cutout) {
    const mask = await segment(image, message.modelPath, message.assetId)
    applyMatte(image, mask.data, mask.width, mask.height)
  }
  const transform = photoTransform(image, message.recipe, faces)
  const output = processPixels(image, message.recipe, transform)
  const masked = message.recipe.cutout || message.recipe.edge || message.recipe.bottom
  const png = pngFromPixels(output)
  const restorePng = masked ? pngFromPixels(processPixels(original, { ...message.recipe, cutout: false, edge: false, bottom: false }, transform)) : png
  return { png, restorePng, analysis: { issues: transform.issues, faceCount: faces.length, factor: transform.factor } }
}
parentPort.on('message', message => {
  chain = chain.then(async () => {
    if (message.shutdown) {
      try { const session = await sessionPromise; if (session) await session.release() } catch { /* allow shutdown after a failed model load */ }
      await require('./photo-face-align.cjs').shutdown()
      sessionPromise = null; mattes.clear(); parentPort.close(); return
    }
    try { const result = await run(message); parentPort.postMessage({ id: message.id, ...result }) }
    catch (error) { parentPort.postMessage({ id: message.id, error: error.message }) }
  })
})

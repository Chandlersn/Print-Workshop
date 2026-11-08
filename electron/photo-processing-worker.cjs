const { parentPort } = require('worker_threads')
const fs = require('fs'), crypto = require('crypto')
const { orientedRgba, applyMatte, subjectRegion, applySubjectMatte, processPixels, photoTransform } = require('./photo-processing-pixels.cjs')
const { pngFromPixels } = require('./psd-import.cjs')
const MODEL_HASH = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9'
const QUALITY_HASH = '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333'
let sessionPromise = null, loadedModel = null, chain = Promise.resolve(), idleTimer = null
const mattes = new Map()
async function releaseSession() {
  try { const session = await sessionPromise; if (session) await session.release() }
  finally { sessionPromise = null; loadedModel = null }
}
async function fileHash(file) {
  const digest = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
async function segment(image, modelPath, assetId, model, region = { x: 0, y: 0, width: image.width, height: image.height }) {
  const cacheKey = `${model}:${assetId}:${region.x},${region.y},${region.width},${region.height}`
  if (mattes.has(cacheKey)) return mattes.get(cacheKey)
  const ort = require('onnxruntime-node')
  if (loadedModel && loadedModel !== model) await releaseSession()
  if (!sessionPromise) sessionPromise = (async () => {
    if (await fileHash(modelPath) !== (model === 'quality' ? QUALITY_HASH : MODEL_HASH)) throw new Error('抠图模型校验失败，请重新安装应用')
    return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' })
  })().catch(error => { sessionPromise = null; throw error })
  const session = await sessionPromise
  loadedModel = model
  const scale = Math.min(512 / Math.min(region.width, region.height), 1024 / Math.max(region.width, region.height))
  const w = model === 'quality' ? 1024 : Math.max(32, Math.round(region.width * scale / 32) * 32), h = model === 'quality' ? 1024 : Math.max(32, Math.round(region.height * scale / 32) * 32)
  const input = new Float32Array(3 * w * h)
  const mean = [.485, .456, .406], std = [.229, .224, .225]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.max(region.x, Math.min(region.x + region.width - 1, region.x + (x + .5) * region.width / w - .5)), sy = Math.max(region.y, Math.min(region.y + region.height - 1, region.y + (y + .5) * region.height / h - .5))
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1), tx = sx - x0, ty = sy - y0
    for (let c = 0; c < 3; c++) {
      const upper = image.data[(y0 * image.width + x0) * 4 + c] * (1 - tx) + image.data[(y0 * image.width + x1) * 4 + c] * tx
      const lower = image.data[(y1 * image.width + x0) * 4 + c] * (1 - tx) + image.data[(y1 * image.width + x1) * 4 + c] * tx
      const value = upper * (1 - ty) + lower * ty
      input[c * w * h + y * w + x] = model === 'quality' ? (value / 255 - mean[c]) / std[c] : value / 127.5 - 1
    }
  }
  const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) })
  const tensor = output[session.outputNames[0]]
  const mask = { data: new Float32Array(tensor.data), width: tensor.dims.at(-1), height: tensor.dims.at(-2) }
  if (mask.data.length !== mask.width * mask.height || mask.data.some(value => !Number.isFinite(value))) throw new Error('抠图结果无效，请重试')
  if (model === 'quality') for (let i = 0; i < mask.data.length; i++) mask.data[i] = 1 / (1 + Math.exp(-mask.data[i]))
  mattes.set(cacheKey, mask)
  while (mattes.size > 12) mattes.delete(mattes.keys().next().value)
  return mask
}
async function run(message) {
  const image = orientedRgba(message.bitmap, message.width, message.height, message.orientation)
  if (message.analyzeReference) {
    const faces = await require('./photo-face-align.cjs').detect(image, message.faceModelPath, message.assetId)
    if (faces.length !== 1) return { reference: { faceCount: faces.length } }
    const face = faces[0]
    return { reference: { faceCount: 1, faceHeight: face.h / image.height, eyeX: (face.eyes[0].x + face.eyes[1].x) / (2 * image.width), eyeY: (face.eyes[0].y + face.eyes[1].y) / (2 * image.height) } }
  }
  const original = { ...image, data: new Uint8ClampedArray(image.data) }
  const faces = message.recipe.faceAlign ? await require('./photo-face-align.cjs').detect(image, message.faceModelPath, message.assetId) : []
  if (message.recipe.cutout) {
    const region = message.subjectPolygon ? subjectRegion(image, message.subjectPolygon) : null
    const mask = await segment(image, message.modelPath, message.assetId, message.model || 'fast', region || undefined)
    if (region) applySubjectMatte(image, mask.data, mask.width, mask.height, message.subjectPolygon, region)
    else applyMatte(image, mask.data, mask.width, mask.height, message.protectPolygon)
  }
  const transform = photoTransform(image, message.recipe, faces)
  const output = processPixels(image, message.recipe, transform)
  const masked = message.recipe.cutout || message.recipe.edge || message.recipe.bottom
  const png = pngFromPixels(output)
  const restorePng = masked ? pngFromPixels(processPixels(original, { ...message.recipe, cutout: false, edge: false, bottom: false }, transform)) : png
  return { png, restorePng, analysis: { issues: transform.issues, faceCount: faces.length, factor: transform.factor } }
}
parentPort.on('message', message => {
  clearTimeout(idleTimer)
  chain = chain.then(async () => {
    if (message.shutdown) {
      try { await releaseSession() } catch { /* allow shutdown after a failed model load */ }
      await require('./photo-face-align.cjs').shutdown()
      mattes.clear(); parentPort.close(); return
    }
    try { const result = await run(message); parentPort.postMessage({ id: message.id, ...result }) }
    catch (error) { parentPort.postMessage({ id: message.id, error: error.message }) }
    if (loadedModel === 'quality') idleTimer = setTimeout(() => {
      chain = chain.then(() => releaseSession()).catch(() => {})
    }, 30000)
  })
})

/** Local YuNet inference. Decoder follows OpenCV's FaceDetectorYN stride outputs. */
const fs = require('fs'), crypto = require('crypto')
const HASH = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
let promise
const cache = new Map()
function overlap(a, b) {
  const area = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return area / Math.max(1, a.w * a.h + b.w * b.h - area)
}
async function detect(image, modelPath, key) {
  if (cache.has(key)) return cache.get(key)
  const ort = require('onnxruntime-node')
  if (!promise) promise = (async () => {
    if (crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex') !== HASH) throw new Error('人物对齐模型校验失败，请重新安装应用')
    return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 })
  })().catch(error => { promise = null; throw error })
  const session = await promise, size = 640, scale = Math.min(size / image.width, size / image.height)
  const input = new Float32Array(3 * size * size)
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(image.width - 1, Math.floor((x + .5) / scale)), sy = Math.min(image.height - 1, Math.floor((y + .5) / scale))
    for (let c = 0; c < 3; c++) input[c * size * size + y * size + x] = image.data[(sy * image.width + sx) * 4 + 2 - c]
  }
  const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) })
  const candidates = []
  for (const stride of [8, 16, 32]) {
    const cls = output[`cls_${stride}`].data, obj = output[`obj_${stride}`].data, box = output[`bbox_${stride}`].data, kps = output[`kps_${stride}`].data
    const cols = size / stride
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
      if (score < .75) continue
      const row = Math.floor(i / cols), col = i % cols
      const width = Math.exp(box[i * 4 + 2]) * stride / scale, height = Math.exp(box[i * 4 + 3]) * stride / scale
      const face = { x: (col + box[i * 4]) * stride / scale - width / 2, y: (row + box[i * 4 + 1]) * stride / scale - height / 2, w: width, h: height, score,
        eyes: [0, 1].map(n => ({ x: (kps[i * 10 + n * 2] + col) * stride / scale, y: (kps[i * 10 + n * 2 + 1] + row) * stride / scale })) }
      if (face.w > 0 && face.h > 0 && [face.x, face.y, face.w, face.h, ...face.eyes.flatMap(p => [p.x, p.y])].every(Number.isFinite)) candidates.push(face)
    }
  }
  const faces = []
  for (const candidate of candidates.sort((a,b) => b.score - a.score).slice(0, 5000)) {
    if (!faces.some(face => overlap(face, candidate) > .3)) faces.push(candidate)
    if (faces.length >= 20) break
  }
  cache.set(key, faces)
  while (cache.size > 64) cache.delete(cache.keys().next().value)
  return faces
}
async function shutdown() { try { const session = await promise; if (session) await session.release() } finally { promise = null; cache.clear() } }
module.exports = { detect, shutdown, overlap }

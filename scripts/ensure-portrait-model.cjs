/** Obtain and verify the release model without placing its 224 MB in Git. */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), https = require('https')
const { pipeline } = require('stream/promises')
const file = path.join(__dirname, '..', 'build', 'models', 'birefnet-lite.onnx')
const partial = `${file}.download`
const expected = '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333'
const url = 'https://www.modelscope.cn/models/onnx-community/BiRefNet_lite-ONNX/resolve/master/onnx/model.onnx'
async function digest(fileName) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(fileName)) hash.update(chunk)
  return hash.digest('hex')
}
function get(address, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('模型下载重定向次数过多'))
  return new Promise((resolve, reject) => {
    const request = https.get(address, { headers: { 'User-Agent': 'PrintPress-Model-Download/1.0' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); resolve(get(new URL(response.headers.location, address), redirects + 1)); return
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`模型下载失败（HTTP ${response.statusCode}）`)); return }
      resolve(response)
    })
    request.setTimeout(60000, () => request.destroy(new Error('模型下载连接超时')))
    request.on('error', reject)
  })
}
async function main() {
  if (fs.existsSync(file) && await digest(file) === expected) { console.log('精细人像模型已就绪。'); return }
  console.log('正在下载精细抠图模型（约 224 MB），完成后会校验文件。')
  try {
    // Avoid stale cached redirects containing expired signed download URLs.
    await pipeline(await get(`${url}?fresh=${Date.now()}`), fs.createWriteStream(partial))
    if (await digest(partial) !== expected) throw new Error('模型校验失败，请重新下载')
    fs.renameSync(partial, file)
    console.log('精细人像模型已下载并校验。')
  } catch (error) {
    try { fs.unlinkSync(partial) } catch {}
    throw error
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })

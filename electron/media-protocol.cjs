// Register the same controlled media handler in each actual printing session.
const path = require('path')
const { pathToFileURL } = require('url')
const { net } = require('electron')
const registered = new WeakSet()
function registerMediaProtocol(targetSession) {
  if (registered.has(targetSession)) return
  const dataDir = process.env.PRINTPRESS_DATA_DIR
  if (!dataDir) throw new Error("未初始化媒体数据目录")
  targetSession.protocol.handle('pp', async (request) => {
    try {
      const u = new URL(request.url)
      // hostname 只是命名空间标签（media），真实相对路径在 pathname；
      // 若把 hostname 拼进路径会多出一层不存在的目录（M2 遗留 bug，M3 修复）
      const rel = decodeURIComponent(u.pathname).replace(/\\/g, '/').replace(/^\/+/, '')
      if (!rel || rel.split('/').includes('..')) {
        return new Response('bad path', { status: 403 })
      }
      // 素材库原件标识 asset_<sha256>：解析成 design-assets 内真实文件后再服务，
      // 这样模板页底图（存 assetId）与旧 print-bg 路径都能用同一协议访问。
      const assetMatch = /^asset_([a-f0-9]{64})$/.exec(rel)
      if (assetMatch) {
        const asset = require('./designs.cjs').assetInfo(`asset_${assetMatch[1]}`)
        const abs = path.join(dataDir, asset.path)
        const resp = await net.fetch(pathToFileURL(abs).toString())
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      const abs = require('./store.cjs').resolveInsideDataDir(rel)
      const resp = await net.fetch(pathToFileURL(abs).toString())
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  registered.add(targetSession)
}

module.exports = { registerMediaProtocol }

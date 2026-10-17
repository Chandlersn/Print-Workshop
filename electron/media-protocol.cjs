// Register the same controlled media handler in each actual printing session.
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
      // 素材库原件标识 asset_<sha256>：解析成两个原件池（design-assets / ephemeral-assets，
      // I-51）之一的真实文件后再服务，这样模板页底图（存 assetId）与旧 print-bg 路径
      // 都能用同一协议访问。
      const assetMatch = /^asset_([a-f0-9]{64})$/.exec(rel)
      if (assetMatch) {
        const asset = require('./designs.cjs').assetInfo(`asset_${assetMatch[1]}`)
        const abs = require('./asset-storage.cjs').resolveAssetPath(asset.path)
        const resp = await net.fetch(pathToFileURL(abs).toString())
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      /*
       * 素材路径（<pool>/<sha256>.<ext>）同样按 hash 解析真身（I-51）。
       *
       * 为什么需要：分池迁移与「加入素材库」（adopt 把临时件原件搬进素材库池）都会
       * 搬动原件，而界面手里的工程文档 / 未保存草稿可能还指着搬走前的池路径
       * （编辑器的画布按 doc.assets[].path 拼 URL，且前端不参与搬迁后的同步）。
       * 同一 hash 就是同一份字节，按 asset_<hash> 取回真身即可，渲染层无感。
       *
       * 边车缺失 / 损坏时退回「按给定路径直读」——与加这条之前的行为完全一致。
       */
      const poolMatch = /^(design-assets|ephemeral-assets)\/([a-f0-9]{64})\.(png|jpe?g)$/i.exec(rel)
      if (poolMatch) {
        try {
          const asset = require('./designs.cjs').assetInfo(`asset_${poolMatch[2]}`)
          const abs = require('./asset-storage.cjs').resolveAssetPath(asset.path)
          const resp = await net.fetch(pathToFileURL(abs).toString())
          return new Response(resp.body, {
            status: resp.status,
            headers: {
              'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
            },
          })
        } catch { /* 退到下面的直读分支 */ }
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

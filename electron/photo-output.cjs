/** Original-photo URLs and relocatable archives. No Electron dependency or image recompression. */
const fs = require('fs')
const path = require('path')
const designs = require('./designs.cjs')

function photoUrl(assetId) {
  if (typeof assetId !== 'string' || !/^asset_[a-f0-9]{64}$/.test(assetId)) throw new Error('照片素材标识无效')
  return `pp://media/${assetId}`
}

/** jobDir is a newly created archive directory owned by print.cjs, never a user supplied path. */
function archivePhotos(jobDir, html, assetIds = []) {
  if (typeof html !== 'string' || !Array.isArray(assetIds) || assetIds.length > 5000) throw new Error('照片归档参数无效')
  const urls = new Map([...new Set(assetIds)].map(id => [photoUrl(id), id]))
  for (const hit of html.matchAll(/pp:\/\/media\/asset_[a-f0-9]{64}/g)) {
    if (!urls.has(hit[0])) throw new Error('照片快照的资源清单不完整')
  }
  if (!urls.size) return html
  const dir = path.join(jobDir, 'photos')
  fs.mkdirSync(dir) // A new directory only: never overwrite existing archive photos.
  const written = []
  try {
    for (const [url, id] of urls) {
      const { asset, buffer } = designs.assetBytes(id)
      const name = path.basename(asset.path)
      const target = path.join(dir, name)
      fs.writeFileSync(target, buffer, { flag: 'wx' })
      written.push(target)
      html = html.split(url).join(`photos/${name}`)
    }
    return html
  } catch (err) {
    for (const file of written) { try { fs.unlinkSync(file) } catch { /* preserve failed cleanup for inspection */ } }
    try { fs.rmdirSync(dir) } catch { /* only an empty directory may be removed */ }
    throw err
  }
}

module.exports = { photoUrl, archivePhotos }

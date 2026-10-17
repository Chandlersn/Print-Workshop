/** Backend-only storage location for managed image originals. */
const path = require('path')
const { resolveInsideDataDir } = require('./store.cjs')

const DATA_DIR = process.env.PRINTPRESS_DATA_DIR
const MANAGED_POOL = 'design-assets'
const EPHEMERAL_POOL = 'ephemeral-assets'
// The default keeps existing installations readable. Set this before Electron starts
// to put the managed repository on another disk; temporary backgrounds stay in dataDir.
const configured = process.env.PRINTPRESS_ASSET_DIR
if (configured && !path.isAbsolute(configured)) throw new Error('PRINTPRESS_ASSET_DIR 必须是绝对路径')
const managedDir = path.resolve(configured || path.join(DATA_DIR, MANAGED_POOL))
if (configured) {
  const dataRoot = path.resolve(DATA_DIR)
  const inside = path.relative(dataRoot, managedDir)
  const containsData = path.relative(managedDir, dataRoot)
  if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside)) ||
      (!containsData.startsWith('..') && !path.isAbsolute(containsData))) {
    throw new Error('PRINTPRESS_ASSET_DIR 不能与数据目录相同或互相嵌套')
  }
}

function poolDir(pool) {
  if (pool === MANAGED_POOL) return managedDir
  if (pool === EPHEMERAL_POOL) return resolveInsideDataDir(EPHEMERAL_POOL)
  throw new Error('未知素材存储池')
}

function resolveAssetPath(relative) {
  const match = /^(design-assets|ephemeral-assets)\/([a-f0-9]{64})\.(png|jpe?g|json)$/.exec(relative)
  if (!match) throw new Error('素材存储路径无效')
  return path.join(poolDir(match[1]), `${match[2]}.${match[3]}`)
}

function legacyManagedDir() { return resolveInsideDataDir(MANAGED_POOL) }

module.exports = { MANAGED_POOL, EPHEMERAL_POOL, poolDir, resolveAssetPath, legacyManagedDir, managedDir }

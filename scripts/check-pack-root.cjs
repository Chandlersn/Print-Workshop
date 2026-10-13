#!/usr/bin/env node
/**
 * 打包前的工程根目录自查。
 *
 * 为什么需要：electron-builder 会先遍历**工程根目录**再按 `files` 过滤。根目录里只要有一个
 * 「readdir 读得到、stat 却解析不了」的条目，它就会在 computeFileSets 里抛
 *   ⨯ ENOENT: no such file or directory, lstat 'D:\个人开发\new-tools\���ﯮƤ'
 * 然后中断打包。那句报错既不说清是哪个环节，也不说该删什么——2026-10-13 实际卡过一次，
 * 排查成本全花在「这串乱码是什么」上。
 *
 * 这类条目**没法靠修业务代码避免**：在 Windows 上 Node 根本建不出来（`mkdir` 会把带非法
 * 字节的路径直接拒掉，实测 ENOENT），只可能由非 Node 的工具按原始字节建目录留下。
 * 所以只能在打包前拦住，并把「怎么办」说清楚。
 *
 * 判据刻意收得很窄——**只有 stat 解析不了的条目才硬失败**，因为那种条目 electron-builder
 * 一定会炸；名字奇怪但能正常读写的目录只给提示，不阻断打包。
 *
 * 用法：
 *   npm run pack:check     # 只体检，不写任何东西
 *   npm run dist           # 打包前自动跑（已挂在 dist 里；CI 的 release.yml 也走 dist）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MAX_LIST = 20
// 本次实际误删的入口与发布资源；自查不能只检查存在的条目，还须检查必需文件是否缺失。
const REQUIRED_FILES = [
  'bin/pp.cjs', 'build/icon.png',
  'build/seed/print-bg/demo-award-landscape.svg',
  'build/seed/print-bg/demo-cert-landscape.svg',
  'build/seed/print-bg/demo-cert-portrait.svg',
  'build/seed/print-bg/demo-invite-landscape.svg',
]

const SEP = Buffer.from([path.sep.charCodeAt(0)])
const isAscii = (text) => /^[\x20-\x7e]+$/.test(text)

const defaultIo = {
  // 以 Buffer 取名字：非法 UTF-8 的目录名只有原始字节还认得出来，
  // 走 utf8 会被替换成 U+FFFD，连 stat 都对不上（这正是打包报错里那串 `���`）。
  listRaw: (dir) => fs.readdirSync(dir, { encoding: 'buffer' }),
  statPath: (abs) => fs.lstatSync(abs),
}

function join(rootDir, name) {
  return Buffer.concat([Buffer.from(rootDir), SEP, Buffer.isBuffer(name) ? name : Buffer.from(String(name))])
}

function findMissingRequiredFiles(rootDir) {
  const missing = []
  for (const name of REQUIRED_FILES) {
    try {
      if (!fs.statSync(path.join(rootDir, name)).isFile()) missing.push(name)
    } catch { missing.push(name) }
  }
  return missing
}

/**
 * 找出「列得出来、却 stat 不了」的条目——就是会把 electron-builder 打挂的那一类。
 * 返回 { entries, readError }；entries 里每项带原始字节 hex，方便照着删。
 */
function findUnreadableEntries(rootDir, io = defaultIo) {
  const { listRaw, statPath } = { ...defaultIo, ...io }
  let names
  try {
    names = listRaw(rootDir)
  } catch (err) {
    return { entries: [], readError: err }
  }
  const entries = []
  for (const name of names) {
    const buf = Buffer.isBuffer(name) ? name : Buffer.from(String(name))
    try {
      statPath(join(rootDir, name), buf)
    } catch (err) {
      entries.push({ hex: buf.toString('hex'), display: buf.toString('utf8'), code: err.code })
    }
  }
  return { entries, readError: null }
}

/**
 * 递归数一棵子树里的文件数。有文件 ⇒ 不是垃圾；遍历失败 ⇒ 交给调用方跳过。
 * 必须递归：2026-10-13 那 48 个垃圾目录**每个里面都套着一个空的 `Microsoft`**，
 * 只看直接子项数量会全部漏报。
 */
function countFilesUnder(rootBuf, io = defaultIo) {
  const { listRaw, statPath } = { ...defaultIo, ...io }
  let files = 0
  const stack = [rootBuf]
  while (stack.length) {
    const cur = stack.pop()
    let kids
    try {
      kids = listRaw(cur)
    } catch (err) {
      return { files: 0, error: err }
    }
    for (const kid of kids) {
      const abs = join(cur, kid)
      let st
      try {
        st = statPath(abs, kid)
      } catch (err) {
        return { files: 0, error: err }
      }
      if (st.isSymbolicLink?.()) files += 1 // 链接不视为可清理的空目录，也不跟随。
      else if (st.isDirectory()) stack.push(abs)
      else files += 1
    }
  }
  return { files, error: null }
}

/**
 * 名字不是纯 ASCII、且**整棵子树里一个文件都没有**的目录——不阻断打包，但基本可以确定是垃圾：
 * 2026-10-13 那次根目录里躺着 48 个这种空目录（里面各套一个空的 `Microsoft`）。
 * 判据是「整棵树无文件」，所以有内容的非 ASCII 目录不会被误伤。
 */
function findEmptyForeignDirs(rootDir, io = defaultIo) {
  const { listRaw, statPath } = { ...defaultIo, ...io }
  let names
  try {
    names = listRaw(rootDir)
  } catch (err) {
    return []
  }
  const out = []
  for (const name of names) {
    const buf = Buffer.isBuffer(name) ? name : Buffer.from(String(name))
    const text = buf.toString('utf8')
    if (isAscii(text)) continue
    const abs = join(rootDir, name)
    try {
      const stat = statPath(abs, buf)
      if (stat.isSymbolicLink?.() || !stat.isDirectory()) continue
    } catch (err) {
      // stat 不了的已经在 findUnreadableEntries 里报过，这里不重复
      continue
    }
    const { files, error } = countFilesUnder(abs, io)
    if (!error && files === 0) out.push({ hex: buf.toString('hex'), display: text })
  }
  return out
}

function main() {
  const { entries, readError } = findUnreadableEntries(ROOT)
  if (readError) {
    console.error(`[pack:check] 读不了工程根目录 ${ROOT}：${readError.message}`)
    process.exitCode = 1
    return
  }

  const junk = findEmptyForeignDirs(ROOT)
  const missing = findMissingRequiredFiles(ROOT)
  if (missing.length) {
    console.error(`[pack:check] 缺少 ${missing.length} 个必需文件，请恢复后再打包：`)
    for (const name of missing) console.error(`             ${name}`)
    process.exitCode = 1
  }

  if (entries.length) {
    console.error(`[pack:check] 工程根目录有 ${entries.length} 个「列得出来、stat 解析不了」的条目，`)
    console.error('             electron-builder 一定会在这里中断，先把它们删掉：')
    for (const item of entries.slice(0, MAX_LIST)) {
      console.error(`              hex=${item.hex}  utf8=${JSON.stringify(item.display)}  (${item.code})`)
    }
    if (entries.length > MAX_LIST) console.error(`              …… 还有 ${entries.length - MAX_LIST} 个`)
    console.error('')
    console.error('            这类名字在 Windows 上用 Node 建不出来，只能按原始字节删。')
    console.error('            先看清单（不删任何东西）：  npm run pack:purge')
    console.error('            确认后执行（只删「整棵树为空」的目录）：  npm run pack:purge -- --apply')
    process.exitCode = 1
  }

  if (junk.length) {
    console.warn(`[pack:check] 提示：根目录有 ${junk.length} 个空的非 ASCII 目录（不影响打包，但基本是垃圾）：`)
    for (const item of junk.slice(0, MAX_LIST)) console.warn(`             ${JSON.stringify(item.display)}  hex=${item.hex}`)
    if (junk.length > MAX_LIST) console.warn(`             …… 还有 ${junk.length - MAX_LIST} 个`)
    console.warn('             清理：npm run pack:purge（只看）→ npm run pack:purge -- --apply')
  }

  if (!entries.length && !missing.length) {
    console.log(junk.length
      ? `[pack:check] 没有会阻断打包的条目，但有 ${junk.length} 个空的非 ASCII 目录（见上）。`
      : `[pack:check] 工程根目录可读，条目名全部能解析（${ROOT}）`)
  }
}

if (require.main === module) main()

module.exports = { ROOT, findUnreadableEntries, findEmptyForeignDirs, findMissingRequiredFiles }

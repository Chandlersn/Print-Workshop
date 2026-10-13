#!/usr/bin/env node
/**
 * 清理工程根目录里「名字不是纯 ASCII」的目录——也就是把 `npm run dist` 打挂的那类垃圾。
 *
 * 为什么单独一个脚本、还要按原始字节操作：这类目录名不是合法 UTF-8（打包报错里显示成
 * `���ﯮƤ`），走字符串路径连 `stat` 都对不上。只有以 Buffer 取名字、以 Buffer 拼路径，
 * 才认得出它们。见 scripts/check-pack-root.cjs 的说明。
 *
 * 安全边界（刻意收得极窄）：
 *   - **只 rmdir，从不删文件**：先递归数一遍，整棵树里只要有一个文件就整棵跳过；
 *   - 默认**只看不动**，必须显式 `--apply` 才执行；
 *   - 只处理工程根目录的**直接子目录**，不递归扫别处。
 * 所以最坏情况也只是删掉几个空目录。
 *
 * 用法：
 *   npm run pack:purge              # 只列清单
 *   npm run pack:purge -- --apply   # 执行
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const SEP = Buffer.from([path.sep.charCodeAt(0)])
const isAscii = (text) => /^[\x20-\x7e]+$/.test(text)

function join(dir, name) {
  const head = Buffer.isBuffer(dir) ? dir : Buffer.from(String(dir))
  return Buffer.concat([head, SEP, Buffer.isBuffer(name) ? name : Buffer.from(String(name))])
}

/** 递归收集一棵子树里的所有目录（深→浅），并数出文件数。文件数 > 0 就不许动。 */
function survey(root) {
  const rootBuf = Buffer.isBuffer(root) ? root : Buffer.from(String(root))
  const dirs = []
  let files = 0
  const stack = [rootBuf]
  while (stack.length) {
    const cur = stack.pop()
    // lstat 不跟随链接，禁止空目录扫描越过 junction 或进入链接环。
    try {
      const stat = fs.lstatSync(cur)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return { dirs: [], files: 0, error: Object.assign(new Error('拒绝链接或非目录'), { code: 'UNSAFE_DIR' }) }
      }
    } catch (err) { return { dirs: [], files: 0, error: err } }
    dirs.push(cur)
    let kids
    try {
      kids = fs.readdirSync(cur, { encoding: 'buffer' })
    } catch (err) {
      return { dirs: [], files: 0, error: err }
    }
    for (const kid of kids) {
      const abs = join(cur, kid)
      let st
      try {
        st = fs.lstatSync(abs)
      } catch (err) {
        return { dirs: [], files: 0, error: err }
      }
      if (st.isSymbolicLink()) {
        return { dirs: [], files: 0, error: Object.assign(new Error('拒绝包含链接的目录树'), { code: 'UNSAFE_DIR' }) }
      }
      if (st.isDirectory()) stack.push(abs)
      else files += 1
    }
  }
  dirs.sort((a, b) => b.length - a.length) // 深→浅，保证先删子目录
  return { dirs, files, error: null }
}

function main() {
  let names
  try {
    names = fs.readdirSync(ROOT, { encoding: 'buffer' })
  } catch (err) {
    console.error(`[pack:purge] 读不了工程根目录：${err.message}`)
    process.exitCode = 1
    return
  }

  const targets = []
  for (const name of names) {
    const buf = Buffer.isBuffer(name) ? name : Buffer.from(String(name))
    const text = buf.toString('utf8')
    if (isAscii(text)) continue
    let st
    try {
      st = fs.lstatSync(join(ROOT, buf))
    } catch (err) {
      targets.push({ buf, text, hex: buf.toString('hex'), error: err.code })
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      targets.push({ buf, text, hex: buf.toString('hex'), error: 'NOT_A_DIR' })
      continue
    }
    targets.push({ buf, text, hex: buf.toString('hex'), error: null })
  }

  if (!targets.length) {
    console.log(`[pack:purge] 工程根目录没有非 ASCII 目录，无需清理（${ROOT}）`)
    return
  }

  console.log(`[pack:purge] 根目录有 ${targets.length} 个非 ASCII 目录：${APPLY ? '执行删除' : '仅列出（加 --apply 才执行）'}`)
  let removed = 0
  let skipped = 0
  for (const item of targets) {
    if (item.error) {
      console.log(`  跳过 ${item.hex}  读不了（${item.error}）—— 需要手工处理`)
      skipped += 1
      continue
    }
    const { dirs, files, error } = survey(join(ROOT, item.buf))
    if (error) {
      console.log(`  跳过 ${item.hex}  遍历失败（${error.code}）—— 需要手工处理`)
      skipped += 1
      continue
    }
    if (files > 0) {
      console.log(`  跳过 ${item.hex}  树内有 ${files} 个文件，绝不删`)
      skipped += 1
      continue
    }
    if (!APPLY) {
      console.log(`  待删 ${item.hex}  空目录树（${dirs.length} 个目录 / 0 个文件）`)
      continue
    }
    let ok = 0
    for (const dir of dirs) {
      try {
        const stat = fs.lstatSync(dir)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('目录已变化'), { code: 'UNSAFE_DIR' })
        fs.rmdirSync(dir)
        ok += 1
      } catch (err) {
        console.log(`  删除中断 ${item.hex}  ${err.code}`)
        break
      }
    }
    console.log(`  已删 ${item.hex}  ${ok}/${dirs.length} 个空目录`)
    removed += ok
  }

  if (APPLY) {
    console.log(`[pack:purge] 共删除 ${removed} 个空目录，跳过 ${skipped} 个。现在可以重新 npm run dist。`)
  } else {
    console.log('[pack:purge] 确认上面都是空目录后，用 npm run pack:purge -- --apply 执行。')
  }
  if (skipped) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { ROOT, survey }

/**
 * M5.1 数据目录自定义 - 领域层验收测试。
 * 覆盖：bootstrap 配置读写、优先级决策、可写探测、嵌套守卫、整目录迁移。
 */
process.env.PRINTPRESS_DATA_DIR = require('path').join(__dirname, '.tmp-data-dd')
const fs = require('fs')
const { rmDeep } = require('./helpers/rm.cjs')
const path = require('path')
const dd = require('../electron/data-dir.cjs')

const TMP = path.join(__dirname, '.tmp-data-dd')

let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else { failCount++; console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`) }
}

function fresh(p) { rmDeep(p); fs.mkdirSync(p, { recursive: true }) }

function main() {
  rmDeep(TMP)
  const userData = path.join(TMP, 'userdata')
  fs.mkdirSync(userData, { recursive: true })

  console.log('== 1. 无配置时的默认决策 ==')
  const defPackaged = path.join(userData, 'data') // 打包态默认目录派生自 userDataDir
  const appRoot = path.join(TMP, 'app')
  const defDev = path.join(appRoot, 'data') // 开发态默认目录派生自 appPath
  let r = dd.resolveDataDir({ isPackaged: true, userDataDir: userData, appPath: appRoot })
  ok(r.dataDir === defPackaged && !r.custom, '打包态默认 userData/data', r.dataDir)
  r = dd.resolveDataDir({ isPackaged: false, userDataDir: userData, appPath: appRoot })
  ok(r.dataDir === defDev && !r.custom, '开发态默认 appPath/data', r.dataDir)

  console.log('== 2. bootstrap 配置读写 ==')
  ok(dd.readCustomDataDir(userData) === null, '无配置读取返回 null')
  ok(dd.readCustomDataDir(path.join(TMP, 'no-such-dir')) === null, '目录不存在也不崩')
  dd.writeCustomDataDir(userData, 'D:\\printpress-data')
  ok(dd.readCustomDataDir(userData) === 'D:\\printpress-data', '写入后读回一致')
  dd.writeCustomDataDir(userData, null)
  ok(dd.readCustomDataDir(userData) === null, 'null 清除配置')
  fs.writeFileSync(path.join(userData, dd.BOOTSTRAP_FILE), '{broken', 'utf-8')
  ok(dd.readCustomDataDir(userData) === null, '损坏的 JSON 不崩、返回 null')

  console.log('== 3. 优先级决策 ==')
  const customDir = path.join(TMP, 'my-data')
  fs.mkdirSync(customDir, { recursive: true })
  dd.writeCustomDataDir(userData, customDir)
  r = dd.resolveDataDir({ isPackaged: true, userDataDir: userData, appPath: appRoot })
  ok(r.dataDir === customDir && r.custom, '有效自定义配置优先', r.dataDir)
  // 真正的"不可写"：路径被文件占用（mkdirSync 必失败）。不存在的目录会被探测函数建出来，
  // 属于预期行为（等价于启动时 ensureDataDir）
  const blocked = path.join(TMP, 'occupied-path')
  fs.writeFileSync(blocked, 'x', 'utf-8')
  dd.writeCustomDataDir(userData, blocked)
  r = dd.resolveDataDir({ isPackaged: true, userDataDir: userData, appPath: appRoot })
  ok(r.dataDir === defPackaged && !r.custom, '自定义路径不可用时回退默认', r.dataDir)
  dd.writeCustomDataDir(userData, customDir) // 恢复，供后面用

  console.log('== 4. 可写探测 ==')
  ok(dd.isWritableDir(customDir) === true, '普通目录可写')
  const deepDir = path.join(TMP, 'a', 'b', 'c')
  ok(dd.isWritableDir(deepDir) === true && fs.existsSync(deepDir), '可写探测会递归建目录')
  const asFile = path.join(customDir, 'somefile.txt')
  fs.writeFileSync(asFile, 'x', 'utf-8')
  ok(dd.isWritableDir(asFile) === false, '路径被文件占用 → 不可写')

  console.log('== 5. 嵌套守卫 ==')
  ok(dd.nestingIssue(customDir, customDir) !== null, '同目录被拒')
  ok(dd.nestingIssue(path.join(customDir, 'sub'), customDir) !== null, '当前数据目录内部的子目录被拒')
  ok(dd.nestingIssue(TMP, customDir) !== null, '当前数据目录的祖先目录被拒')
  ok(dd.nestingIssue(path.join(TMP, 'elsewhere'), customDir) === null, '无嵌套关系 → 放行')

  console.log('== 6. 整目录迁移 ==')
  const src = path.join(TMP, 'migrate-src')
  const dest = path.join(TMP, 'migrate-dest')
  fresh(src); fresh(dest)
  fs.mkdirSync(path.join(src, 'print-bg'), { recursive: true })
  fs.writeFileSync(path.join(src, 'settings.json'), '{"theme":"dark"}', 'utf-8')
  fs.writeFileSync(path.join(src, 'print-bg', 'bg.svg'), '<svg/>', 'utf-8')
  dd.copyDirSync(src, dest)
  ok(fs.readFileSync(path.join(dest, 'settings.json'), 'utf-8') === '{"theme":"dark"}', '根文件复制')
  ok(fs.readFileSync(path.join(dest, 'print-bg', 'bg.svg'), 'utf-8') === '<svg/>', '子目录递归复制')
  fs.writeFileSync(path.join(src, 'settings.json'), '{"theme":"light"}', 'utf-8')
  dd.copyDirSync(src, dest)
  ok(JSON.parse(fs.readFileSync(path.join(dest, 'settings.json'), 'utf-8')).theme === 'light', '同名文件覆盖（合并语义）')

  console.log('== 7. 恢复默认 ==')
  dd.writeCustomDataDir(userData, null)
  r = dd.resolveDataDir({ isPackaged: true, userDataDir: userData, appPath: defDev })
  ok(r.dataDir === defPackaged && !r.custom, '清除配置后回到默认')
  ok(fs.existsSync(customDir), '恢复默认不删自定义目录里的旧数据')

  rmDeep(TMP)
  console.log(`\n共 ${passCount + failCount} 项断言：${passCount} 通过，${failCount} 失败`)
  process.exit(failCount ? 1 : 0)
}

main()

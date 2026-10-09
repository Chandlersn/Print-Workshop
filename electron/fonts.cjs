/**
 * 字体管理：系统字体检测（Windows 注册表优先 + 目录存在性兜底）+ 上传字体。
 * 检测原则：候选清单 + 实际存在性检测，不写死暴露结果——
 * 装在任意目录/用户级的字体只有注册表能兜住（源项目踩坑教训）。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2'])
const FONT_DIR_SYS = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
const FONT_DIR_USER = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts')
const UPLOAD_DIR = path.join(process.env.PRINTPRESS_DATA_DIR, 'print-fonts')

/** 与 PDF 中 @font-face 使用同一个 family 名，避免文件名中的 CSS 语法字符造成画布回退字体。 */
function normalizeFamily(name) {
  return String(name == null ? '' : name).replace(/['"\\;{}()]/g, '').trim()
}

// 常用中文字体候选：文件名 → 期望 family 名
const CANDIDATES = [
  { file: 'simsun.ttc', family: '宋体' },
  { file: 'simhei.ttf', family: '黑体' },
  { file: 'msyh.ttc', family: '微软雅黑' },
  { file: 'msyhbd.ttc', family: '微软雅黑' },
  { file: 'simkai.ttf', family: '楷体' },
  { file: 'simfang.ttf', family: '仿宋' },
  { file: 'Deng.ttf', family: '等线' },
  { file: 'SIMLI.TTF', family: '隶书' },
  { file: 'SIMYOU.TTF', family: '幼圆' },
  { file: 'STXINGKA.TTF', family: '华文行楷' },
  { file: 'STKAITI.TTF', family: '华文楷体' },
  { file: 'STFANGSO.TTF', family: '华文仿宋' },
  { file: 'STZHONGS.TTF', family: '华文中宋' },
  { file: 'STHUPO.TTF', family: '华文琥珀' },
  { file: 'FZSTK.TTF', family: '方正舒体' },
  { file: 'FZYTK.TTF', family: '方正姚体' },
]

/** 注册表 Fonts 键 → { 文件名(小写): 显示标题 } */
function queryRegistryFontMap() {
  const map = new Map()
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ]
  for (const key of keys) {
    try {
      const out = execSync(`reg query "${key}"`, { encoding: 'utf-8', timeout: 5000 })
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^(.+?)\s{2,}REG_SZ\s+(.+)$/)
        if (!m) continue
        const title = m[1].replace(/\s*\((TrueType|TrueTypeFont|OpenType|字体)\)\s*$/i, '').trim()
        const data = m[2].trim()
        // 数据可能是纯文件名，也可能是绝对路径
        const base = path.basename(data).toLowerCase()
        map.set(base, { title, data })
      }
    } catch {
      // 查询失败不阻断（沙箱/精简系统），目录扫描兜底
    }
  }
  return map
}

function fileExistsInFontDirs(fileName) {
  for (const dir of [FONT_DIR_SYS, FONT_DIR_USER]) {
    const p = path.join(dir, fileName)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** 系统字体清单：候选 × 注册表 × 存在性，三重校验后暴露 */
function systemFonts() {
  const regMap = queryRegistryFontMap()
  const found = new Map()
  for (const cand of CANDIDATES) {
    if (found.has(cand.family)) continue
    let abs = fileExistsInFontDirs(cand.file)
    if (!abs) {
      const reg = regMap.get(cand.file.toLowerCase())
      if (reg && path.isAbsolute(reg.data) && fs.existsSync(reg.data)) {
        abs = reg.data
      }
    }
    if (abs) found.set(cand.family, { family: cand.family, file: cand.file })
  }
  return Array.from(found.values())
}

/** 上传字体清单：family 名 = 去扩展名文件名 */
function uploadedFonts() {
  if (!fs.existsSync(UPLOAD_DIR)) return []
  return fs.readdirSync(UPLOAD_DIR)
    .filter((f) => FONT_EXTS.has(path.extname(f).toLowerCase()))
    .map((f) => {
      const family = f.replace(/\.[^.]+$/, '')
      return { family, cssFamily: normalizeFamily(family), file: f }
    })
}

function fontUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  return UPLOAD_DIR
}

/** 上传：复制进数据目录，返回 { family, file } */
function uploadFont(srcPath) {
  const base = path.basename(srcPath)
  if (!FONT_EXTS.has(path.extname(base).toLowerCase())) {
    throw new Error('仅支持 ttf / otf / ttc / woff / woff2 字体文件')
  }
  fontUploadDir()
  const dest = path.join(UPLOAD_DIR, base)
  fs.copyFileSync(srcPath, dest)
  const family = base.replace(/\.[^.]+$/, '')
  return { family, cssFamily: normalizeFamily(family), file: base }
}

function deleteFont(fileName) {
  const base = path.basename(fileName)
  // 引用校验在领域层做（而非 IPC 层），任何调用路径都被保护
  // 惰性 require 规避模块初始化顺序问题
  const templates = require('./templates.cjs')
  const family = base.replace(/\.[^.]+$/, '')
  const usedBy = templates.fontUsedBy(family)
  if (usedBy.length) {
    throw new Error(`字体正在被模板使用：${usedBy.join('、')}，请先移除模板中的引用`)
  }
  const dest = path.join(UPLOAD_DIR, base)
  if (!fs.existsSync(dest)) throw new Error(`字体文件不存在: ${base}`)
  fs.unlinkSync(dest)
  return { ok: true }
}

module.exports = { systemFonts, uploadedFonts, uploadFont, deleteFont, fontUploadDir, FONT_EXTS, normalizeFamily }

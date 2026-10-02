/**
 * CSV 导入：多编码检测 + RFC 4180 引号规则。
 * 编码策略：BOM 判定 → UTF-8 严格模式探测 → GBK 回退 → latin1 兜底。
 * （Node 内置全量 ICU，TextDecoder('gbk') 可用，零额外依赖）
 */

function decodeBuffer(buf) {
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  // UTF-16 LE BOM（Excel 导出的 Unicode CSV 常见）
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2))
  }
  // 严格 UTF-8：非法字节序列即判非 UTF-8
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    // fallthrough
  }
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}

/**
 * RFC 4180 状态机解析：支持引号字段、内嵌逗号/换行、双引号转义。
 * 返回二维字符串数组（网格），不做表头假设。
 */
function parseCsvGrid(text) {
  const grid = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); grid.push(row); row = [] }

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i += 1; continue
      }
      // 引号内换行规范化 CRLF/CR → LF：Windows 导出的 CSV 全文 CRLF，
      // 若原样保留会把 \r 混进单元格数据（打印渲染/比对都会带隐性回车）
      if (ch === '\r') {
        field += '\n'
        i += (text[i + 1] === '\n') ? 2 : 1
        continue
      }
      field += ch; i += 1
      continue
    }

    if (ch === '"') { inQuotes = true; i += 1; continue }
    if (ch === ',') { pushField(); i += 1; continue }
    if (ch === '\r') {
      if (text[i + 1] === '\n') { pushRow(); i += 2 } else { pushRow(); i += 1 }
      continue
    }
    if (ch === '\n') { pushRow(); i += 1; continue }
    field += ch; i += 1
  }

  // 末尾无换行的最后一段
  if (field !== '' || row.length > 0) pushRow()

  // 剔除完全为空的行（尾部空行常见）
  return grid.filter((r) => r.some((c) => String(c).trim() !== ''))
}

function importCsv(filePath, fs) {
  const buf = fs.readFileSync(filePath)
  const text = decodeBuffer(buf)
  const grid = parseCsvGrid(text)
  if (grid.length === 0) {
    throw new Error('CSV 文件为空或无法解析出有效行')
  }
  return grid
}

module.exports = { decodeBuffer, parseCsvGrid, importCsv }

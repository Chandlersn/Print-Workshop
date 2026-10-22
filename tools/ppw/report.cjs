/* report：落 CSV / XLSX。
 *
 * 两条硬约束（都是踩过的）：
 *  1. CSV 必须带 BOM 且每格加引号 —— 否则部分预览器会把 BOM 当第一列隐形前缀，
 *     表头看起来像没有。
 *  2. 写用户可能正打开的文件必须能降级 —— WPS/Excel 持有句柄时 writeFile 抛 EBUSY，
 *     不能让整份报告打挂。降级成「文件名（时间戳）」并如实返回路径。
 */
const fs = require('fs')
const path = require('path')
const XLSX = require('xlsx')

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 写 CSV。headers 必填，且**表头每格强制加引号**：
 *  BOM 会紧贴第一格，若那格不加引号，部分预览器会把 BOM 当成第一列的隐形前缀，
 *  整行看起来像没有列名 —— 用户就是这么反馈过「表头加上啊」。 */
function writeCsv(file, headers, rows) {
  if (!headers || !headers.length) throw new Error('writeCsv 需要显式表头')
  const forceQuote = v => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`
  const lines = [headers.map(forceQuote).join(',')]
  for (const r of rows) {
    lines.push((Array.isArray(r) ? r : headers.map(h => r[h])).map(csvCell).join(','))
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf-8')
  return file
}

/**
 * 尝试写 XLSX；被占用时改用带时间戳的兄弟文件名。
 * @returns {{path:string, degraded:boolean, reason?:string}}
 */
function writeXlsx(file, sheets) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const rows = (s.rows && s.rows.length) ? s.rows : [{ 说明: '（空）' }]
    const ws = XLSX.utils.json_to_sheet(rows)
    const width = Object.keys(rows[0] || {}).length || 1
    if (s.cols) {
      // 列宽数组允许与列数不等：这张表的列是按字段清单动态生成的，字段多一个少一个
      // 都不该让后几列没有宽度（看起来像表格断了）。短了按末列宽度补齐，长了截断。
      const last = s.cols[s.cols.length - 1] || 14
      const arr = s.cols.length >= width
        ? s.cols.slice(0, width)
        : [...s.cols, ...Array(width - s.cols.length).fill(last)]
      ws['!cols'] = arr.map(w => ({ wch: w }))
    }
    ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(width - 1)}${rows.length + 1}` }
    // 中文 sheet 名上限 31 字符，超了 Excel 会拒绝打开
    XLSX.utils.book_append_sheet(wb, ws, String(s.name).slice(0, 31))
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    XLSX.writeFile(wb, file)
    return { path: file, degraded: false }
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
    const ext = path.extname(file)
    const alt = path.join(path.dirname(file), `${path.basename(file, ext)}_${stamp}${ext}`)
    XLSX.writeFile(wb, alt)
    return { path: alt, degraded: true, reason: err.code === 'EBUSY' ? '目标文件被占用（Excel/WPS 打开着）' : err.message }
  }
}

module.exports = { writeCsv, writeXlsx, csvCell }

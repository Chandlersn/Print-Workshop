/**
 * 导入器分发：按扩展名路由到 CSV / Excel 解析，产出统一网格。
 * 上层（dataset.cjs）负责把网格转成数据集结构。
 */
const fs = require('fs')
const path = require('path')
const { importCsv } = require('./csv.cjs')
const { importExcel } = require('./excel.cjs')

function importGrid(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.csv' || ext === '.txt') {
    return importCsv(filePath, fs)
  }
  if (ext === '.xlsx' || ext === '.xls') {
    return importExcel(filePath)
  }
  throw new Error(`不支持的文件类型: ${ext}（支持 .xlsx / .xls / .csv）`)
}

module.exports = { importGrid }

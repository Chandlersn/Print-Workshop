/**
 * 人类可读的体积。**只用于显示**——任何判断逻辑一律用原始字节数，不要拿字符串比大小。
 *
 * 必须有 GB 档：S1 压测里 500 张照片按原图出片是 7.90 GB，只到 MB 会显示成
 * 「8089.6 MB」，用户看不出「省了一个量级」——而出片分辨率这个功能要卖的就是这个量级差。
 *
 * 放在 src/lib 是因为界面（出片体积提示、画布导出结果）与测试要共用同一份实现。
 */
function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

module.exports = { formatBytes }

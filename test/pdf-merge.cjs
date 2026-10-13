/**
 * PDF 合并验收（S1.3-b）：对象级流式拼接的正确性与安全边界。
 *
 * 守的不变量：
 * - **不重栅格化**：合并产物每页 content stream 与源逐字节一致（顺序也对）
 * - **页序 = 输入顺序**：a+b+a → 6 页，第 3 页起是 b 的内容
 * - **页树完整**：合并后每个页对象的 /Parent 都改指新页树节点，且该节点的
 *   /Kids 真的包含这一页（读者靠 Parent/Kids 成树，漏一个都白版）
 * - **xref 可信**：startxref 的偏移处真是 xref；每个在用条目都能解析出
 *   N G obj；trailer /Size 与对象数一致；%%EOF 收尾
 * - **规模与边界**：300 页 × 3 份不崩；不支持的结构（截断 / /Prev / /Encrypt /
 *   xref 流）明确抛 UnsupportedPdfError，失败即删输出，不留半成品
 *
 * 本文件的校验器 readPdfLike 是**独立实现**（正则 + 位置读取），刻意不复用
 * electron/pdf-merge.cjs 的解析器——用被测代码校验自己会漏掉共谋错误。
 */
const fs = require('fs')
const path = require('path')
const { buildPdf, readPdfLike, checkMergedStructure, payloadsOf, bufEq } = require('./helpers/pdf-fixture.cjs')
const { mergePdfs, countPdfPagesFromFile, UnsupportedPdfError } = require('../electron/pdf-merge.cjs')
// 收尾清理走 rmDeepSafe：CI（windows-latest）上杀软/索引器会短暂持有刚写完的文件句柄，
// 裸 fs.rmSync 递归删除会以 ENOTEMPTY 崩掉整个套件（2026-10-13 真实发生过，60 项全绿仍红）。
const { rmDeepSafe } = require('./helpers/rm.cjs')

const FIXTURES = path.join(__dirname, 'fixtures')
const TMP = path.join(__dirname, '.tmp-merge')

let passCount = 0
let failCount = 0
function ok(cond, label, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`) }
  else {
    failCount++
    console.error(`  FAIL - ${label}${extra !== undefined ? ` | ${JSON.stringify(extra)}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  rmDeepSafe(TMP)
  fs.mkdirSync(TMP, { recursive: true })
  const out = (name) => path.join(TMP, name)
  const writeFix = (name, buf) => {
    const p = out(name)
    fs.writeFileSync(p, buf)
    return p
  }

  const flatA = writeFix('flat-a.pdf', buildPdf({ tag: 'A', pages: 2 }))
  const flatB = writeFix('flat-b.pdf', buildPdf({ tag: 'B', pages: 2 }))
  const nested = writeFix('nested.pdf', buildPdf({ tag: 'N', pages: 3, nestedTree: true }))
  const binary1 = writeFix('bin-1.pdf', buildPdf({ tag: 'B1', pages: 2, binary: true, indirectLength: true }))
  const binary2 = writeFix('bin-2.pdf', buildPdf({ tag: 'B2', pages: 3, binary: true }))
  const chromeA = path.join(FIXTURES, 'chromium-3page-a.pdf')
  const chromeB = path.join(FIXTURES, 'chromium-3page-b.pdf')

  console.log('== 1. countPdfPagesFromFile（页数入口先立住） ==')
  ok(countPdfPagesFromFile(flatA) === 2, '手写扁平页树 2 页')
  ok(countPdfPagesFromFile(nested) === 3, '手写嵌套页树 3 页')
  ok(countPdfPagesFromFile(chromeA) === 3, '真实 Chromium 夹具 3 页')
  ok(countPdfPagesFromFile(chromeB) === 3, '真实 Chromium 夹具 b 3 页')
  let threw = false
  try { countPdfPagesFromFile(out('nope.pdf')) } catch { threw = true }
  ok(threw, '不存在的文件抛错（不返回 0 冒充空文档）')

  console.log('== 2. 基本合并：扁平 × 扁平（内容逐字节、页序、页树、xref） ==')
  const m1 = out('m1.pdf')
  const r1 = await mergePdfs([flatA, flatB], m1)
  ok(r1.pages === 4, '合并页数 2+2=4', r1.pages)
  const srcA = readPdfLike(fs.readFileSync(flatA))
  const srcB = readPdfLike(fs.readFileSync(flatB))
  const merged1 = checkMergedStructure('m1', fs.readFileSync(m1), 4, ok)
  const expect1 = [...payloadsOf(srcA), ...payloadsOf(srcB)]
  ok(expect1.every((p, i) => bufEq(p, merged1.detail[i].payload)), '逐页 content stream 与源逐字节一致（顺序 a→b）')
  let xrefOk = true
  for (const [num, e] of merged1.entries) if (!e.free && !/^\d+ 0 obj/.test('' + num + ' 0 obj')) xrefOk = false
  for (const [num, e] of merged1.entries) {
    if (e.free) continue
    const t = merged1.objAt(num).text
    if (!new RegExp(`^${num}\\s+0\\s+obj`).test(t)) xrefOk = false
  }
  ok(xrefOk, 'xref 每个在用条目偏移都能解析出对应对象头')
  const infoText = merged1.infoRef ? merged1.objAt(Number(merged1.infoRef[1])).text : ''
  ok(/fixture-A/.test(infoText), 'trailer /Info 取自第一份输入（A）')

  console.log('== 3. 顺序语义：a+b+a 六页，第 3 页起是 b ==')
  const m2 = out('m2.pdf')
  const r2 = await mergePdfs([flatA, flatB, flatA], m2)
  ok(r2.pages === 6, '合并页数 2+2+2=6', r2.pages)
  const merged2 = checkMergedStructure('m2', fs.readFileSync(m2), 6, ok)
  const expect2 = [...payloadsOf(srcA), ...payloadsOf(srcB), ...payloadsOf(srcA)]
  ok(expect2.every((p, i) => bufEq(p, merged2.detail[i].payload)), 'a+b+a 的逐页载荷序列（重复输入也保序）')

  console.log('== 4. 嵌套页树 × 扁平 ==')
  const m3 = out('m3.pdf')
  const r3 = await mergePdfs([nested, flatB], m3)
  ok(r3.pages === 5, '合并页数 3+2=5', r3.pages)
  const srcN = readPdfLike(fs.readFileSync(nested))
  const merged3 = checkMergedStructure('m3', fs.readFileSync(m3), 5, ok)
  ok([...payloadsOf(srcN), ...payloadsOf(srcB)].every((p, i) => bufEq(p, merged3.detail[i].payload)),
    '嵌套页树合并后逐字节保真')

  console.log('== 5. 间接 /Length + 二进制载荷（含 endstream 陷阱字节） ==')
  const m4 = out('m4.pdf')
  const r4 = await mergePdfs([binary1, binary2], m4)
  ok(r4.pages === 5, '合并页数 2+3=5', r4.pages)
  const srcB1 = readPdfLike(fs.readFileSync(binary1))
  const srcB2 = readPdfLike(fs.readFileSync(binary2))
  const merged4 = checkMergedStructure('m4', fs.readFileSync(m4), 5, ok)
  ok([...payloadsOf(srcB1), ...payloadsOf(srcB2)].every((p, i) => bufEq(p, merged4.detail[i].payload)),
    '二进制载荷逐字节保真（含 \\r\\nendstream\\r\\n 陷阱串）')
  const indirectLeft = merged4.detail.some((d) => /\/Length\s+\d+\s+\d+\s+R/.test(d.objectText))
  ok(!indirectLeft, '合并产物中 /Length 全是直接整数（间接已解值直排）')

  console.log('== 6. 规模：300 页 × 3 份 ==')
  const big1 = writeFix('big-1.pdf', buildPdf({ tag: 'G1', pages: 300, binary: true }))
  const big2 = writeFix('big-2.pdf', buildPdf({ tag: 'G2', pages: 300, binary: true }))
  const big3 = writeFix('big-3.pdf', buildPdf({ tag: 'G3', pages: 300, binary: true }))
  const m5 = out('m5.pdf')
  const t0 = Date.now()
  const r5 = await mergePdfs([big1, big2, big3], m5)
  const cost = Date.now() - t0
  ok(r5.pages === 900, '900 页合并成功', r5.pages)
  const srcG1 = readPdfLike(fs.readFileSync(big1))
  const srcG2 = readPdfLike(fs.readFileSync(big2))
  const merged5 = checkMergedStructure('m5', fs.readFileSync(m5), 900, ok)
  const p299 = srcG1.detail[299].payload
  const p300 = srcG1.detail[300] ? null : srcG2.detail[0].payload
  ok(bufEq(p299, merged5.detail[299].payload), '边界抽检：第 300 页 = 第一份的第 300 页')
  ok(bufEq(p300, merged5.detail[300].payload), '边界抽检：第 301 页 = 第二份的第 1 页')
  ok(bufEq(srcG2.detail[299].payload, merged5.detail[599].payload), '边界抽检：第 600 页 = 第二份的第 300 页')
  console.log(`  .. 900 页合并耗时 ${cost}ms，输出 ${(r5.bytes / 1024 / 1024).toFixed(1)}MB`)

  console.log('== 7. 不支持结构：明确拒绝 + 不留半成品 ==')
  const cases = [
    ['截断文件（无 %%EOF）', () => fs.readFileSync(flatA).slice(0, 120)],
    ['trailer 带 /Prev', () => buildPdf({ tag: 'P', pages: 1, extraTrailer: ' /Prev 3' })],
    ['trailer 带 /Encrypt', () => buildPdf({ tag: 'E', pages: 1, extraTrailer: ' /Encrypt 3 0 R' })],
  ]
  for (const [label, make] of cases) {
    const bad = writeFix(`bad-${label.length}.pdf`, make())
    const target = out(`bad-out-${label.length}.pdf`)
    let msg = ''
    try { await mergePdfs([bad], target) } catch (err) { msg = `${err.name}` }
    ok(msg === 'UnsupportedPdfError', `${label} → UnsupportedPdfError`, msg)
    ok(!fs.existsSync(target), `${label} → 半成品输出已删除`)
  }
  // xref 流形态（/Type /XRef）
  const xrefStream = Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /XRef /Size 2 /W [1 1 1] >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n', 'latin1')
  const xsPath = writeFix('xref-stream.pdf', xrefStream)
  const xsTarget = out('xs-out.pdf')
  let xsErr = ''
  try { await mergePdfs([xsPath], xsTarget) } catch (err) { xsErr = err.name }
  ok(xsErr === 'UnsupportedPdfError', 'xref 流 → UnsupportedPdfError', xsErr)
  // 第二个输入坏 → 整体失败且输出删除（第一批已写也一起清）
  const partialTarget = out('partial.pdf')
  let pErr = ''
  try { await mergePdfs([flatA, xsPath], partialTarget) } catch (err) { pErr = err.name }
  ok(pErr === 'UnsupportedPdfError', '第二个输入损坏 → 整体抛出', pErr)
  ok(!fs.existsSync(partialTarget), '第二个输入损坏 → 已写出的部分也删除（无半成品）')

  console.log('== 8. 真实 Chromium 产物 ==')
  const m6 = out('m6.pdf')
  const r6 = await mergePdfs([chromeA, chromeB], m6)
  ok(r6.pages === 6, 'Chromium 3+3=6 页', r6.pages)
  const srcCA = readPdfLike(fs.readFileSync(chromeA))
  const srcCB = readPdfLike(fs.readFileSync(chromeB))
  const merged6 = checkMergedStructure('m6', fs.readFileSync(m6), 6, ok)
  ok([...payloadsOf(srcCA), ...payloadsOf(srcCB)].every((p, i) => bufEq(p, merged6.detail[i].payload)),
    'Chromium 产物合并后逐字节保真')
  const m7 = out('m7.pdf')
  const r7 = await mergePdfs([chromeA], m7)
  const merged7 = checkMergedStructure('m7', fs.readFileSync(m7), 3, ok)
  ok(payloadsOf(srcCA).every((p, i) => bufEq(p, merged7.detail[i].payload)), '单文件自合并：内容不变')

  rmDeepSafe(TMP)
  console.log(`\nPDF 合并：${passCount} 项通过，${failCount} 项失败`)
  if (failCount) process.exitCode = 1
}

main().catch((err) => {
  console.error('测试本身崩溃:', err)
  process.exitCode = 1
})

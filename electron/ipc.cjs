/**
 * IPC 网关：所有主进程能力的唯一挂载点。
 * M0 骨架只挂：连通性 + 环境信息 + 通用 JSON 存储。
 * M1 起按领域追加 dataset:* / template:* / print:* 通道。
 */
const { ipcMain, app, dialog, shell, BrowserWindow } = require('electron')

/** 对话框统一挂主窗口：无主对话框在 Windows 上可能被主窗口遮挡，用户看似「没反应」 */
function dialogParent() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
}
const path = require('path')
const fs = require('fs')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const fonts = require('./fonts.cjs')
const printDomain = require('./print.cjs')
const printer = require('./printer.cjs')
const dataDirModule = require('./data-dir.cjs')

function registerIpc() {
  // ---- 连通性 ----
  ipcMain.handle('app:ping', () => ({
    pong: true,
    version: app.getVersion(),
  }))

  ipcMain.handle('app:env', () => ({
    dataDir: process.env.PRINTPRESS_DATA_DIR,
    dataDirCustom: process.env.PRINTPRESS_DATA_DIR_CUSTOM === '1',
    packaged: app.isPackaged,
    platform: process.platform,
    pageSizes: templates.PAGE_SIZES,
  }))

  // ---- 数据目录自定义 ----
  // 选择新目录 → 可写校验 + 嵌套守卫 → 整目录迁移现有数据 → 写引导配置 → 重启生效
  ipcMain.handle('app:changeDataDir', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '选择数据目录（现有数据会自动迁移过去）',
      defaultPath: path.dirname(process.env.PRINTPRESS_DATA_DIR),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const target = result.filePaths[0]
    const current = process.env.PRINTPRESS_DATA_DIR
    const nested = dataDirModule.nestingIssue(target, current)
    if (nested) throw new Error(nested)
    if (!dataDirModule.isWritableDir(target)) {
      throw new Error('该目录不可写（可能需要管理员权限），请换一个位置')
    }
    let migrated = false
    if (path.resolve(target) !== path.resolve(current) && fs.existsSync(current)) {
      dataDirModule.copyDirSync(current, target)
      migrated = true
    }
    dataDirModule.writeCustomDataDir(app.getPath('userData'), target)
    return { canceled: false, dataDir: target, migrated, needRestart: true }
  })

  // 恢复默认目录（不清删自定义目录里的旧数据，仅切换回去）
  ipcMain.handle('app:resetDataDir', () => {
    dataDirModule.writeCustomDataDir(app.getPath('userData'), null)
    return { canceled: false, needRestart: true }
  })

  ipcMain.handle('app:openDataDir', async () => {
    const err = await shell.openPath(process.env.PRINTPRESS_DATA_DIR)
    if (err) throw new Error(err)
    return { ok: true }
  })

  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  // ---- 通用 JSON 存储（M1 起逐步收敛为领域通道） ----
  ipcMain.handle('store:load', (_e, name) => {
    assertSafeName(name)
    return loadJson(name)
  })

  ipcMain.handle('store:save', (_e, name, value) => {
    assertSafeName(name)
    if (value === undefined || value === null) {
      throw new Error('store:save 拒绝空值写入')
    }
    return saveJson(name, value)
  })

  // ---- 数据集 ----
  // 对话框只负责选路径；检视与导入由 dataset:inspect / dataset:importSheets 承担
  ipcMain.handle('dataset:importDialog', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '导入数据文件',
      properties: ['openFile'],
      filters: [
        { name: '数据表格', extensions: ['xlsx', 'xls', 'csv', 'txt'] },
      ],
    })
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true }
    }
    return { canceled: false, filePath: result.filePaths[0] }
  })

  // 拖拽 / 对话框共用：检视文件。CSV 直接导入；Excel 返回工作表清单供选择
  ipcMain.handle('dataset:inspect', (_e, filePath) => dataset.inspectFile(String(filePath)))

  ipcMain.handle('dataset:importSheets', (e, payload) =>
    dataset.importSheets(String(payload.filePath), {
      selections: payload.selections,
      mode: payload.mode === 'merge' ? 'merge' : 'split',
      // 进度经独立通道推给渲染进程（分阶段 yield，渲染进程可实时重绘进度条）
      onProgress: (p) => { if (!e.sender.isDestroyed()) e.sender.send('import:progress', p) },
    }))

  ipcMain.handle('dataset:list', () => dataset.listDatasets())

  ipcMain.handle('dataset:get', (_e, id) => dataset.getDataset(String(id)))

  ipcMain.handle('dataset:delete', (_e, id) => dataset.deleteDataset(String(id)))

  ipcMain.handle('dataset:renameColumn', (_e, id, key, alias) =>
    dataset.renameColumn(String(id), String(key), alias))

  // 数据编辑：单元格修改 / 追加空行 / 删行（编辑后列统计即时重算）
  ipcMain.handle('dataset:updateCell', (_e, p) =>
    dataset.updateCell(String(p.datasetId), Number(p.rowIndex), String(p.key), p.value))
  ipcMain.handle('dataset:addRow', (_e, id) => dataset.addRow(String(id)))
  ipcMain.handle('dataset:deleteRow', (_e, p) =>
    dataset.deleteRow(String(p.datasetId), Number(p.rowIndex)))

  // 列级打印开关：停用的字段不进模板设计页字段清单
  ipcMain.handle('dataset:setColumnPrint', (_e, p) =>
    dataset.setColumnPrint(String(p.datasetId), String(p.key), Boolean(p.printOn)))

  ipcMain.handle('catalog:fields', (_e, id) => dataset.fieldCatalog(String(id)))

  // 列值清单（从真实数据派生）：筛选值选项 / 分组导出的组清单共用
  ipcMain.handle('catalog:values', (_e, p) =>
    dataset.columnValues(String(p.datasetId), String(p.key), p.filters))

  // ---- 模板 ----
  ipcMain.handle('template:list', () => templates.listTemplates())
  ipcMain.handle('template:get', (_e, id) => templates.getTemplate(String(id)))
  ipcMain.handle('template:save', (_e, tpl) => templates.saveTemplate(tpl))
  ipcMain.handle('template:matchDataset', (_e, templateId, datasetId) =>
    templates.matchDataset(String(templateId), String(datasetId)))
  ipcMain.handle('template:rebindDataset', (_e, templateId, datasetId) =>
    templates.rebindDataset(String(templateId), String(datasetId)))
  ipcMain.handle('template:delete', (_e, id) => templates.deleteTemplate(String(id)))

  ipcMain.handle('template:uploadBackgroundDialog', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '上传底图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    return { canceled: false, ...templates.uploadBackground(result.filePaths[0]) }
  })

  // ---- 字体 ----
  ipcMain.handle('font:list', () => ({
    system: fonts.systemFonts(),
    uploaded: fonts.uploadedFonts(),
  }))

  ipcMain.handle('font:uploadDialog', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '上传字体',
      properties: ['openFile'],
      filters: [{ name: '字体', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    return { canceled: false, ...fonts.uploadFont(result.filePaths[0]) }
  })

  ipcMain.handle('font:delete', (_e, file) => fonts.deleteFont(String(file)))

  // ---- 打印 ----
  // 出口校验：只报告空值/疑似占位，不拦截（可中断可放行由前端弹窗决定）
  // filters：行筛选条件 [{ key, values }]，限定打印范围
  ipcMain.handle('print:validate', (_e, p) =>
    printDomain.validateBatch(String(p.datasetId), String(p.templateId), p.filters))

  // 组装批量 HTML（预览用，不落盘不留痕）
  ipcMain.handle('print:generate', (_e, p) =>
    printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.filters))

  ipcMain.handle('print:exportPdf', async (_e, p) => {
    const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.filters)
    const stamp = new Date().toISOString().slice(0, 10)
    // 挂父窗口：无主对话框在 Windows 上可能被主窗口压在后面，用户看起来像「没反应」
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(parent, {
      title: '导出 PDF',
      defaultPath: `${built.templateName}-${stamp}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      const r = await printer.exportPdf(built.html, result.filePath)
      dataset.markPrinted(String(p.datasetId), 'pdf') // 状态回写：数据页侧栏「已打印」变色
      const job = printDomain.createJob({
        templateId: String(p.templateId),
        templateName: built.templateName,
        datasetId: String(p.datasetId),
        datasetName: built.datasetName,
        mode: 'pdf',
        recordCount: built.recordCount,
        snapshotHtml: built.snapshotHtml,
        status: 'ok',
        detail: `${r.bytes} bytes → ${r.path}`,
      })
      return { canceled: false, ...r, jobId: job.id }
    } catch (err) {
      printDomain.createJob({
        templateId: String(p.templateId),
        templateName: built.templateName,
        datasetId: String(p.datasetId),
        datasetName: built.datasetName,
        mode: 'pdf',
        recordCount: built.recordCount,
        snapshotHtml: built.snapshotHtml,
        status: 'failed',
        detail: String(err.message || err),
      })
      throw err
    }
  })

  ipcMain.handle('print:send', async (_e, p) => {
    const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.filters)
    const silent = Boolean(p && p.silent)
    const r = await printer.sendToPrinter(built.html, { silent })
    if (r.ok) dataset.markPrinted(String(p.datasetId), 'print') // 只有真正送达才标记，取消不标
    printDomain.createJob({
      templateId: String(p.templateId),
      templateName: built.templateName,
      datasetId: String(p.datasetId),
      datasetName: built.datasetName,
      mode: 'print',
      recordCount: built.recordCount,
      snapshotHtml: built.snapshotHtml,
      status: r.ok ? 'ok' : 'canceled',
      detail: r.ok ? (silent ? '静默直打' : '打印对话框确认') : String(r.error || ''),
    })
    return r
  })

  // ---- 打印历史 ----
  // 按列分组导出：在 filters 限定范围内，按某列的 distinct 值（真实数据派生）
  // 逐组出 PDF，一组一个文件，命名「数据集名-组值.pdf」
  ipcMain.handle('print:exportGrouped', async (_e, p) => {
    const key = String(p.key)
    const baseFilters = Array.isArray(p.filters) ? p.filters : []
    const built0 = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), baseFilters)
    const colInfo = dataset.columnValues(String(p.datasetId), key, baseFilters)
    if (!colInfo.values.length) {
      throw new Error(`「${colInfo.alias}」在当前打印范围内没有可分组的数据`)
    }

    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '选择分组 PDF 输出目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const outDir = result.filePaths[0]

    const exported = []
    const failed = []
    let totalRows = 0
    let firstSnapshot = ''
    for (const g of colInfo.values) {
      const groupFilters = [...baseFilters, { key, values: [g.value] }]
      try {
        const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), groupFilters)
        if (!built.recordCount) continue
        const fileName = `${printDomain.sanitizeFilename(built.datasetName)}-${printDomain.sanitizeFilename(g.value)}.pdf`
        const r = await printer.exportPdf(built.html, path.join(outDir, fileName))
        if (!firstSnapshot) firstSnapshot = built.snapshotHtml
        totalRows += built.recordCount
        exported.push({ value: g.value, rows: built.recordCount, file: r.path, bytes: r.bytes })
      } catch (err) {
        failed.push({ value: g.value, error: String(err.message || err) })
      }
    }
    if (!exported.length && !failed.length) {
      throw new Error('没有可导出的分组')
    }

    printDomain.createJob({
      templateId: String(p.templateId),
      templateName: built0.templateName,
      datasetId: String(p.datasetId),
      datasetName: built0.datasetName,
      mode: 'pdf',
      recordCount: totalRows,
      snapshotHtml: firstSnapshot,
      status: exported.length ? 'ok' : 'failed',
      detail: `按「${colInfo.alias}」分组导出 ${exported.length} 个 PDF → ${outDir}`
        + (failed.length ? `（${failed.length} 组失败）` : ''),
    })
    return { canceled: false, dir: outDir, groupLabel: colInfo.alias, exported, failed }
  })

  ipcMain.handle('job:list', () => printDomain.listJobs())

  ipcMain.handle('job:openSnapshot', async (_e, id) => {
    const abs = printDomain.resolveSnapshot(String(id))
    const err = await shell.openPath(abs)
    if (err) throw new Error(err)
    return { ok: true }
  })

  ipcMain.handle('job:delete', (_e, id) => printDomain.deleteJob(String(id)))
}

/** 文件名白名单校验：只允许小写字母/数字/中划线，杜绝路径穿越 */
function assertSafeName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`非法存储名: ${JSON.stringify(name)}`)
  }
}

module.exports = { registerIpc }

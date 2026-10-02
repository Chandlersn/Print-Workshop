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
    // 多联拼版的成品尺寸预设（与 PAGE_SIZES 同为主进程单一权威源）
    itemSizes: templates.ITEM_SIZES,
  }))

  /**
   * 系统缓存（Chromium 运行时在 userData 下自动生成的目录，可安全清理、
   * 必要时自动重建）：cacheInfo 汇总大小；clearCache 释放并返回释放字节。
   * 刻意排除 data（用户数据）/ Local Storage / Session Storage / config，
   * 避免误删应用状态与用户数据。
   */
  const SYSTEM_CACHE_DIRS = [
    'Cache', 'GPUCache', 'Code Cache', 'DawnCache', 'DawnGraphiteCache',
    'blob_storage', 'ShaderCache', 'GrShaderCache', 'Media Cache',
  ]
  function dirSize(dir) {
    let total = 0
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) total += dirSize(p)
          else total += fs.statSync(p).size
        } catch { /* 个别文件无权读取，跳过 */ }
      }
    } catch { /* 目录不存在/无权限，视为 0 */ }
    return total
  }
  ipcMain.handle('app:cacheInfo', () => {
    const base = app.getPath('userData')
    let size = 0
    const entries = []
    for (const name of SYSTEM_CACHE_DIRS) {
      const d = path.join(base, name)
      if (fs.existsSync(d)) {
        const s = dirSize(d)
        size += s
        entries.push({ name, size: s })
      }
    }
    return { size, entries, base }
  })
  ipcMain.handle('app:clearCache', () => {
    const base = app.getPath('userData')
    let freed = 0
    const removed = []
    for (const name of SYSTEM_CACHE_DIRS) {
      const d = path.join(base, name)
      if (fs.existsSync(d)) {
        const s = dirSize(d)
        try {
          fs.rmSync(d, { recursive: true, force: true })
          freed += s
          removed.push(name)
        } catch { /* 个别文件锁住，跳过，不阻断其余 */ }
      }
    }
    return { freed, removed }
  })

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
  // 出片范围：rows = 行级勾选索引集合（null/缺省 = 全量）
  ipcMain.handle('print:validate', (_e, p) =>
    printDomain.validateBatch(String(p.datasetId), String(p.templateId), p.rows))

  // 组装批量 HTML（预览用，不落盘不留痕）
  ipcMain.handle('print:generate', (_e, p) =>
    printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows))

  ipcMain.handle('print:exportPdf', async (_e, p) => {
    const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows)
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
      // 状态回写（不变量「留痕必全，状态只认全量」）：只有全量出片才回写数据集「已打」状态；
      // 部分出片（行级勾选）照常留痕，但不改侧栏徽标与变色，避免「打了 3 个人却显示整份已打」
      if (printDomain.shouldMarkPrinted(built.scope)) dataset.markPrinted(String(p.datasetId), 'pdf')
      const job = printDomain.createJob({
        templateId: String(p.templateId),
        templateName: built.templateName,
        datasetId: String(p.datasetId),
        datasetName: built.datasetName,
        mode: 'pdf',
        recordCount: built.recordCount,
        totalRows: built.scope.total,
        partial: built.scope.partial,
        selection: built.selection,
        snapshotHtml: built.snapshotHtml,
        status: 'ok',
        detail: `${r.bytes} bytes → ${r.path}`,
      })
      return { canceled: false, ...r, jobId: job.id, scope: built.scope }
    } catch (err) {
      printDomain.createJob({
        templateId: String(p.templateId),
        templateName: built.templateName,
        datasetId: String(p.datasetId),
        datasetName: built.datasetName,
        mode: 'pdf',
        recordCount: built.recordCount,
        totalRows: built.scope.total,
        partial: built.scope.partial,
        selection: built.selection,
        snapshotHtml: built.snapshotHtml,
        status: 'failed',
        detail: String(err.message || err),
      })
      throw err
    }
  })

  ipcMain.handle('print:send', async (_e, p) => {
    const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows)
    const silent = Boolean(p && p.silent)
    // 直打失败必须留痕：打印是唯一会真正消耗纸张的出口，打印机离线、驱动报错、
    // 系统卡纸全在这里抛异常。没有 failed 记录的话，用户只看到一句报错，
    // 历史里查不到「当时出了什么、出了多少」，也无从判断该不该重打。
    // （与 print:exportPdf 的 catch 分支对称——两个出口不能一个留痕一个不留。）
    let r
    try {
      r = await printer.sendToPrinter(built.html, { silent })
    } catch (err) {
      printDomain.createJob({
        templateId: String(p.templateId),
        templateName: built.templateName,
        datasetId: String(p.datasetId),
        datasetName: built.datasetName,
        mode: 'print',
        recordCount: built.recordCount,
        totalRows: built.scope.total,
        partial: built.scope.partial,
        selection: built.selection,
        snapshotHtml: built.snapshotHtml,
        status: 'failed',
        detail: String(err.message || err),
      })
      throw err
    }
    // 真正送达「且为全量出片」才回写（部分出片留痕但不改数据集状态）；取消不标
    if (r.ok && printDomain.shouldMarkPrinted(built.scope)) dataset.markPrinted(String(p.datasetId), 'print')
    printDomain.createJob({
      templateId: String(p.templateId),
      templateName: built.templateName,
      datasetId: String(p.datasetId),
      datasetName: built.datasetName,
      mode: 'print',
      recordCount: built.recordCount,
      totalRows: built.scope.total,
      partial: built.scope.partial,
      selection: built.selection,
      snapshotHtml: built.snapshotHtml,
      status: r.ok ? 'ok' : 'canceled',
      detail: r.ok ? (silent ? '静默直打' : '打印对话框确认') : String(r.error || ''),
    })
    return { ...r, scope: built.scope }
  })

  // ---- 打印历史 ----
  ipcMain.handle('job:list', () => printDomain.listJobs())

  ipcMain.handle('job:openSnapshot', async (_e, id) => {
    const jobId = String(id)
    const abs = printDomain.resolveSnapshot(jobId)
    const job = printDomain.listJobs().find((j) => j.id === jobId)
    // 应用内窗口打开（不再 shell.openPath 甩给系统浏览器）：
    // 快照为自包含 HTML（底图/字体已 base64 内联），file:// 直接渲染即可，
    // 保留在应用内的完整体验（无跨进程焦点丢失、与主窗口同一套窗口管理）。
    const win = new BrowserWindow({
      width: 1000,
      height: 780,
      autoHideMenuBar: true,
      title: `归档快照${job && job.templateName ? ` · ${job.templateName}` : ''}`,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    await win.loadURL(require('url').pathToFileURL(abs).toString())
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

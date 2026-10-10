/**
 * 预加载脚本：以白名单方式向渲染进程暴露受控 API。
 * 原则：contextBridge 只暴露具名方法，不透传 ipcRenderer 对象。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('printpress', {
  // 连通性
  ping: () => ipcRenderer.invoke('app:ping'),

  // 数据目录信息
  getEnv: () => ipcRenderer.invoke('app:env'),

  // 数据目录自定义
  changeDataDir: () => ipcRenderer.invoke('app:changeDataDir'),
  resetDataDir: () => ipcRenderer.invoke('app:resetDataDir'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  // 系统缓存：大小查询与一键释放
  getCacheInfo: () => ipcRenderer.invoke('app:cacheInfo'),
  clearCache: () => ipcRenderer.invoke('app:clearCache'),

  // 版本与更新：meta 为版本号 + 出口链接；checkUpdate 手动触发检测；
  // onUpdateAvailable 订阅启动自动检测结果（返回退订函数）
  getAppMeta: () => ipcRenderer.invoke('app:meta'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  onUpdateAvailable: (cb) => {
    const handler = (_e, info) => cb(info)
    ipcRenderer.on('update:available', handler)
    return () => ipcRenderer.removeListener('update:available', handler)
  },

  // 通用 JSON 存储（后续被领域通道取代，M1 起逐步收敛）
  loadData: (name) => ipcRenderer.invoke('store:load', name),
  saveData: (name, value) => ipcRenderer.invoke('store:save', name, value),

  // 数据集
  importDatasetDialog: () => ipcRenderer.invoke('dataset:importDialog'),
  inspectFile: (filePath) => ipcRenderer.invoke('dataset:inspect', filePath),
  importSheets: (payload) => ipcRenderer.invoke('dataset:importSheets', payload),
  /** 订阅导入进度；返回取消订阅函数 */
  onImportProgress: (cb) => {
    const handler = (_e, p) => cb(p)
    ipcRenderer.on('import:progress', handler)
    return () => ipcRenderer.removeListener('import:progress', handler)
  },
  listDatasets: () => ipcRenderer.invoke('dataset:list'),
  getDataset: (id) => ipcRenderer.invoke('dataset:get', id),
  deleteDataset: (id) => ipcRenderer.invoke('dataset:delete', id),
  deleteBatch: (ids) => ipcRenderer.invoke('dataset:deleteBatch', { ids }),
  renameColumn: (id, key, alias) => ipcRenderer.invoke('dataset:renameColumn', id, key, alias),
  updateCell: (datasetId, rowIndex, key, value) =>
    ipcRenderer.invoke('dataset:updateCell', { datasetId, rowIndex, key, value }),
  addRow: (id) => ipcRenderer.invoke('dataset:addRow', id),
  deleteRow: (datasetId, rowIndex) => ipcRenderer.invoke('dataset:deleteRow', { datasetId, rowIndex }),
  setColumnPrint: (datasetId, key, printOn) =>
    ipcRenderer.invoke('dataset:setColumnPrint', { datasetId, key, printOn }),
  fieldCatalog: (id) => ipcRenderer.invoke('catalog:fields', id),

  // 模板
  listTemplates: () => ipcRenderer.invoke('template:list'),
  getTemplate: (id) => ipcRenderer.invoke('template:get', id),
  saveTemplate: (tpl) => ipcRenderer.invoke('template:save', tpl),
  matchDataset: (templateId, datasetId) => ipcRenderer.invoke('template:matchDataset', templateId, datasetId),
  rebindDataset: (templateId, datasetId) => ipcRenderer.invoke('template:rebindDataset', templateId, datasetId),
  deleteTemplate: (id) => ipcRenderer.invoke('template:delete', id),
  uploadBackgroundDialog: () => ipcRenderer.invoke('template:uploadBackgroundDialog'),
  uploadBackgroundBytes: (payload) => ipcRenderer.invoke('template:uploadBackgroundBytes', payload),
  discardBackground: (payload) => ipcRenderer.invoke('template:discardBackground', payload),

  // 可编辑底图工程（素材只走受控导入，不暴露文件系统）
  listDesigns: () => ipcRenderer.invoke('design:list'),
  listDesignPresets: () => ipcRenderer.invoke('design:listPresets'),
  createDesignFromPreset: (presetId, name) => ipcRenderer.invoke('design:createFromPreset', presetId, name),
  touchDesign: (id) => ipcRenderer.invoke('design:touch', id),
  getDesign: (id, revision) => ipcRenderer.invoke('design:get', id, revision),
  saveDesign: (design) => ipcRenderer.invoke('design:save', design),
  deleteDesign: (id) => ipcRenderer.invoke('design:delete', id),
  uploadDesignImageDialog: () => ipcRenderer.invoke('design:importDialog'),
  uploadDesignImageBytes: (payload) => ipcRenderer.invoke('design:importBytes', payload),
  importDesignBackground: (payload) => ipcRenderer.invoke('design:importBackground', payload),
  exportDesignPng: (payload) => ipcRenderer.invoke('design:exportPng', payload),
  // 无参：路径由主进程记着（最近一次成功导出的 PNG），渲染层传不了路径进来
  revealDesignExport: () => ipcRenderer.invoke('design:revealExport'),
  openDesignExport: () => ipcRenderer.invoke('design:openExport'),

  // 字体
  listFonts: () => ipcRenderer.invoke('font:list'),
  uploadFontDialog: () => ipcRenderer.invoke('font:uploadDialog'),
  deleteFont: (file) => ipcRenderer.invoke('font:delete', file),

  // 本地素材库（v0.5.0 M1）
  listAssets: (opts) => ipcRenderer.invoke('asset:list', opts || {}),
  listAssetTags: () => ipcRenderer.invoke('asset:listTags'),
  getAsset: (id) => ipcRenderer.invoke('asset:get', id),
  importAssetBytes: (payload) => ipcRenderer.invoke('asset:importBytes', payload),
  importAssetDialog: () => ipcRenderer.invoke('asset:importDialog'),
  updateAsset: (id, patch) => ipcRenderer.invoke('asset:update', id, patch),
  archiveAsset: (id) => ipcRenderer.invoke('asset:archive', id),
  restoreAsset: (id) => ipcRenderer.invoke('asset:restore', id),
  adoptAsset: (id, meta) => ipcRenderer.invoke('asset:adopt', id, meta),
  discardEphemeralAsset: (assetId, exceptDesignId) => ipcRenderer.invoke('asset:discardEphemeral', { assetId, exceptDesignId }),
  rebuildAssetThumb: (id) => ipcRenderer.invoke('asset:rebuildThumb', id),
  listAssetOrphans: () => ipcRenderer.invoke('asset:listOrphans'),
  purgeAssetOrphans: (hashes) => ipcRenderer.invoke('asset:purgeOrphans', hashes),

  // 打印
  printValidate: (payload) => ipcRenderer.invoke('print:validate', payload),
  printGenerate: (payload) => ipcRenderer.invoke('print:generate', payload),
  printExportPdf: (payload) => ipcRenderer.invoke('print:exportPdf', payload),
  printSend: (payload) => ipcRenderer.invoke('print:send', payload),

  // 打印历史
  listJobs: () => ipcRenderer.invoke('job:list'),
  openSnapshot: (jobId) => ipcRenderer.invoke('job:openSnapshot', jobId),
  deleteJob: (jobId) => ipcRenderer.invoke('job:delete', jobId),
})

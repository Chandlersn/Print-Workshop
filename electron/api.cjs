/**
 * 领域能力注册表：应用全部能力的唯一权威源（single source of truth）。
 *
 * 为什么要有这一层：ipc.cjs 原本既是「契约声明」又是「业务实现」。
 * 想给 agent 开一条无 GUI 的调用路径，就只能把业务逻辑复制一份出去，
 * 两份实现必然漂移（改了一处忘了另一处），而打印这种出口一旦漂移就是
 * 「留痕对不上账」。抽到本层后：ipc.cjs 退化为 Electron 装配薄壳，
 * CLI（bin/pp.cjs）复用同一份实现，将来接 MCP / 本地 HTTP 也是同一份。
 *
 * ── 依赖纪律（本文件最核心的约束）──────────────────────────────
 * 本文件不得 require('electron')，也不得 require('./printer.cjs')
 * （后者 require('electron')）。GUI 与打印能力一律经 ctx 注入，
 * 见下方 CallContext。test/api-cli.cjs 会断言本文件在纯 Node 下
 * 可加载、且能跑通「导入 → 模板 → 校验 → 生成」完整闭环。
 *
 * ── 两个调用入口 ──────────────────────────────────────────────
 * - call(name, params, ctx)   → 返回数据，出错抛异常。IPC 通道走这条，
 *                               语义与抽取前逐字一致（渲染进程靠 reject 拿错误）。
 * - invoke(name, params, ctx) → 返回 { ok, data, error }，不抛。agent 走这条，
 *                               另加一道必填参数体检（见 checkParams）。
 *   参数体检刻意只放在 invoke：GUI 通道的既有参数强制转换（String/Number）
 *   与错误文案已被测试锁定，不能因为「顺手加校验」而改变。
 *
 * ── 写权限 ────────────────────────────────────────────────────
 * 标记 write 的操作受 ctx.allowWrite 管控，缺省为 false。
 * GUI 通道始终传 true（与抽取前行为一致）；CLI 需显式 --allow-write。
 * 这是「agent 默认不能删数据」这条约定的落点——它必须在这里，
 * 因为它是安全属性，不是调用方的礼貌。
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { Worker } = require('worker_threads')
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const designs = require('./designs.cjs')
const designPresets = require('./design-presets.cjs')
const fonts = require('./fonts.cjs')
const assetLibrary = require('./asset-library.cjs')
const photoLibrary = require('./photo-library.cjs')
const designPackage = require('./design-package.cjs')
const printDomain = require('./print.cjs')
const printBatch = require('./print-batch.cjs')
const dataDirModule = require('./data-dir.cjs')
const photoSelections = new Map()
const PHOTO_SELECTION_TTL = 10 * 60 * 1000
const cache = require('./cache.cjs')
// 出片派生件（I-49）也是磁盘缓存，必须能被统计与回收——否则它只会一直涨。
// 本模块只用到它的纯函数（统计/清理），编码路径才惰性 require electron。
const outputDpi = require('./output-dpi.cjs')

// ---------------------------------------------------------------------------
// 分批出片任务（S1.3-b/c）：jobKey → { canceled }。
// 取消只翻标志位——真正的停止发生在批次边界（printToPDF 进行中不可中断，
// 这一条必须对界面诚实：见 print:progress 的阶段事件）。
// ---------------------------------------------------------------------------
const printTasks = new Map()

function registerPrintTask(jobKey) {
  if (printTasks.has(jobKey)) throw new Error('同一出片任务正在执行，请等待完成')
  const task = { canceled: false }
  printTasks.set(jobKey, task)
  return task
}

function printInputFingerprint(datasetId, templateId) {
  const photos = loadJson('photo-bindings', { expect: 'array' }) || []
  return JSON.stringify({ dataset: dataset.getDataset(datasetId), template: templates.getTemplate(templateId), photos: photos.filter(b => b.datasetId === datasetId) })
}
function guardedPrintDomain(datasetId, templateId, fingerprint) {
  return { ...printDomain, buildBatchHtml(...args) {
    if (printInputFingerprint(datasetId, templateId) !== fingerprint) throw new Error('出片期间名单、模板或照片发生变化，请重新预览后出片')
    return printDomain.buildBatchHtml(...args)
  } }
}

/**
 * 留痕里怎么描述这次出片（契约 I-49「不静默」）。
 * 照片那一项只说**照片**——底图的分辨率是另一件事（见 buildBatchHtml 的 bgDpi），不混在一句话里。
 * `bake` 是固定图片烘焙的统计（契约 I-50）：带 `adjust`/`shadow` 的固定图层已被烘成单张图，
 * 不烘它们会让 PDF 体积随页数线性增长（A4 满版实测 19.67 MB/页），所以这件事必须留痕。
 */
function describeOutput(stats, bake) {
  const bits = []
  if (stats) {
    if (stats.dpi == null) bits.push('出片分辨率：原图')
    else {
      bits.push(`${stats.dpi}dpi`)
      if (stats.optimized) bits.push(`照片降采样 ${stats.optimized} 张`)
      if (stats.keptOriginal) bits.push(`保持原件 ${stats.keptOriginal} 张`)
      if (stats.failed) bits.push(`读取失败保持原件 ${stats.failed} 张`)
    }
  }
  if (bake && bake.baked) bits.push(`带效果的底图烘焙 ${bake.baked} 层`)
  if (bake && bake.failed) bits.push(`底图烘焙失败 ${bake.failed} 层`)
  return bits.length ? `（${bits.join('，')}）` : ''
}

function cancelPrintTask(jobKey) {
  const task = printTasks.get(String(jobKey))
  if (!task) return { ok: false, reason: '任务不存在或已结束' }
  task.canceled = true
  return { ok: true }
}

/** jobKey 缺省生成：粒度取「一次 exportPdf/send 调用」 */
function newJobKey() {
  return `print_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

// 工程包导出在 worker 中运行；SharedArrayBuffer 让 UI 取消在同步 ZIP 循环里也能被观察到。
const packageExportTasks = new Map()
function startPackageExport(taskId, options, ctx) {
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(taskId)) throw new Error('工程包导出任务编号无效')
  if (packageExportTasks.has(taskId)) throw new Error('该工程包导出任务已在运行')
  const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const cancelFlag = new Int32Array(cancelBuffer)
  const worker = new Worker(path.join(__dirname, 'design-package-worker.cjs'), {
    workerData: { options, cancelBuffer },
  })
  packageExportTasks.set(taskId, cancelFlag)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    worker.on('message', (message) => {
      if (message.type === 'progress') {
        if (typeof ctx.emit === 'function') ctx.emit('design:packageProgress', { taskId, ...message.progress })
      } else if (message.type === 'done') finish(resolve, message.result)
      else if (message.type === 'canceled') finish(resolve, { canceled: true, taskId })
      else if (message.type === 'error') finish(reject, new Error(message.message || '工程包导出失败'))
    })
    worker.once('error', (error) => finish(reject, error))
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`工程包导出 worker 异常退出（${code}）`))
      else if (!settled) finish(reject, new Error('工程包导出意外结束'))
    })
  }).finally(() => {
    packageExportTasks.delete(taskId)
  })
}
function cancelPackageExport(taskId) {
  const flag = packageExportTasks.get(taskId)
  if (!flag) return { canceled: false }
  Atomics.store(flag, 0, 1)
  return { canceled: true, taskId }
}

// ─────────────────────────── 错误 ───────────────────────────

/** 带机器可读 code 的错误：CLI 靠 code 决定退出码，agent 靠 code 决定要不要重试 */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

const unknownOp = (name) => new ApiError('UNKNOWN_OP', `未知操作: ${name}`)

const badParams = (name, msg) => new ApiError('BAD_PARAMS', `[${name}] ${msg}`)

const writeForbidden = (name) => new ApiError(
  'WRITE_FORBIDDEN',
  `[${name}] 该操作会修改数据，但当前调用上下文没有写权限。` +
  'CLI 请加 --allow-write；GUI 通道不受此限。',
)

const guiRequired = (name, what) => new ApiError(
  'GUI_REQUIRED',
  `[${name}] 需要 ${what}，当前是无 GUI 上下文（纯 Node）。`,
)

// ─────────────────────── 通用存储键白名单 ───────────────────────

/**
 * 通用 JSON 存储通道的键名白名单：只放 UI 偏好类。
 *
 * 为什么必须显式列举：文件名形状校验（「小写字母+中划线」）挡不住领域库名——
 * datasets / templates / print-jobs 全都符合那个形状。放行就等于给了一条
 * 绕过全部领域层校验的通用写入口：一行 store:save('datasets', []) 即可清空
 * 所有数据，字段匹配、模板引用检查、留痕上限一概不经过。
 * 领域数据只走各自的 dataset:* / template:* / job:* 操作。
 */
const STORE_ALLOWLIST = new Set(['settings', 'display-settings'])

function assertStorableName(name) {
  if (typeof name !== 'string' || !STORE_ALLOWLIST.has(name)) {
    throw new Error(
      `store 通道只接受 UI 偏好类键（${[...STORE_ALLOWLIST].join('、')}），收到: ${JSON.stringify(name)}。` +
      '领域数据请走各自的 dataset:* / template:* / job:* 通道')
  }
}

// ─────────────────────────── 缓存 ───────────────────────────

// 系统缓存的大小汇总 / 释放 / 「运行时删不掉的留到下次启动清」，实现见 cache.cjs
// （纯 Node 模块，main.cjs 启动早期也要用它）。

// ─────────────────────────── 操作表 ───────────────────────────

/**
 * 操作定义字段：
 * - write    会持久化改数据 → 受 ctx.allowWrite 管控
 * - gui      需要的宿主能力：'dialog' 弹窗 / 'printer' 打印与 PDF / 'relaunch' 进程重启
 *            （'printer' 的操作允许自带输出路径，此时 run 内部自行降级，见 print:exportPdf）
 * - params   规范参数对象的自描述（供 agent / 未来的 MCP 工具集消费）。
 *            只有 required 会被 invoke 强制，其余仅作文档。
 * - fromIpc  IPC 位置参数 → 规范参数对象。缺省 = 第一个参数即参数对象。
 * - run      (params, ctx) => 数据 | Promise<数据>
 */
const OPS = {

  // ==================== 应用 ====================

  'app:ping': {
    params: {},
    run: (_p, ctx) => ({ pong: true, version: ctx.app.version }),
  },

  'app:env': {
    params: {},
    run: (_p, ctx) => ({
      dataDir: process.env.PRINTPRESS_DATA_DIR,
      dataDirCustom: process.env.PRINTPRESS_DATA_DIR_CUSTOM === '1',
      packaged: Boolean(ctx.app.isPackaged),
      platform: ctx.app.platform || process.platform,
      pageSizes: templates.PAGE_SIZES,
      // 多联拼版的成品尺寸预设（与 PAGE_SIZES 同为主进程单一权威源）
      itemSizes: templates.ITEM_SIZES,
    }),
  },

  'app:cacheInfo': {
    params: {},
    // 出片派生件（I-49）单独报：它不在 userDataDir 里，而在数据目录的 photo-out/，
    // 但同属「可再生的缓存」，界面要把它的体积一起说给用户听。
    run: (_p, ctx) => ({
      ...cache.cacheInfo(ctx.app.userDataDir),
      derivatives: outputDpi.derivativeStats(),
    }),
  },

  'app:clearCache': {
    write: true,
    params: {},
    // 运行中的 GPU / Dawn 缓存删不掉（EPERM），会排队到下次启动清；
    // 返回值带 failed / queued，界面据此如实反馈，不再「点了没反应」
    run: (_p, ctx) => {
      const system = cache.clearCache(ctx.app.userDataDir)
      /**
       * 出片派生件一并回收（内容寻址、可重建，删了下次出片会重新生成）。
       *
       * **正在出片时不能删**：出片中的页面正按 `pp://media/photo-out/…` 加载图片，
       * 删掉会让这一批的图片全部 404——用户看到的是「导出失败」，
       * 而真正的原因是他在出片时点了清理。宁可不删，并把原因说出来。
       */
      const derivatives = printTasks.size
        ? { skipped: true, reason: '正在出片，派生件已保留', count: 0, bytes: 0 }
        : outputDpi.clearDerivatives()
      return { ...system, derivatives }
    },
  },

  // 选择新目录 → 可写校验 + 嵌套守卫 → 整目录迁移现有数据 → 写引导配置 → 重启生效
  'app:changeDataDir': {
    write: true,
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const result = await ctx.dialog.openDirectory({
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
      dataDirModule.writeCustomDataDir(ctx.app.userDataDir, target)
      return { canceled: false, dataDir: target, migrated, needRestart: true }
    },
  },

  // 恢复默认目录（不清删自定义目录里的旧数据，仅切换回去）
  'app:resetDataDir': {
    write: true,
    params: {},
    run: (_p, ctx) => {
      dataDirModule.writeCustomDataDir(ctx.app.userDataDir, null)
      return { canceled: false, needRestart: true }
    },
  },

  'app:openDataDir': {
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const err = await ctx.dialog.openPath(process.env.PRINTPRESS_DATA_DIR)
      if (err) throw new Error(err)
      return { ok: true }
    },
  },

  'app:relaunch': {
    gui: 'relaunch',
    params: {},
    run: (_p, ctx) => ctx.app.relaunch(),
  },

  // ── 应用内更新（下载 + 安装）──────────────────────────────
  // 「关于」里的「检查更新」以前只做轻量信标检测（version-check 读 latest.json），
  // 命中新版只画一个红徽标、**没有任何路径能真正开始下载**；真下载只发生在启动那一次。
  // 结果是用户点完按钮看到「发现新版本」却什么都不动，看起来就像坏了。
  // 这两条通道把「点一下就更新」接上：startUpdate 触发后台下载（进度经 update:state 推送），
  // installUpdate 在下载完成后重启安装。都不接受任何参数。
  'app:startUpdate': {
    gui: 'updater',
    params: {},
    run: (_p, ctx) => ctx.autoUpdate.start(),
  },

  'app:installUpdate': {
    gui: 'updater',
    params: {},
    run: (_p, ctx) => ctx.autoUpdate.install(),
  },

  // ==================== 通用 JSON 存储 ====================
  // 白名单是显式的，不是语法校验：文件名形状校验挡不住领域库名
  // （datasets / templates / print-jobs 全都符合），那等于给了绕过领域层的
  // 通用写入口——一行 store:save('datasets', []) 就能清空全部数据。
  // 领域数据一律走各自的 dataset:* / template:* / job:* 操作，那里才有不变量。

  'store:load': {
    params: { name: { required: true, desc: 'UI 偏好类键名（settings / display-settings）' } },
    fromIpc: (name) => ({ name }),
    run: (p) => {
      assertStorableName(p.name)
      return loadJson(p.name)
    },
  },

  'store:save': {
    write: true,
    params: {
      name: { required: true, desc: 'UI 偏好类键名（settings / display-settings）' },
      value: { required: true, desc: '任意 JSON 值，不得为 null/undefined' },
    },
    fromIpc: (name, value) => ({ name, value }),
    run: (p) => {
      assertStorableName(p.name)
      if (p.value === undefined || p.value === null) {
        throw new Error('store:save 拒绝空值写入')
      }
      return saveJson(p.name, p.value)
    },
  },

  // ==================== 数据集 ====================

  // 对话框只负责选路径；检视与导入由 dataset:inspect / dataset:importSheets 承担
  'dataset:importDialog': {
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const result = await ctx.dialog.openFile({
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
    },
  },

  /**
   * 拖拽 / 对话框共用：检视文件。CSV 直接导入；Excel 返回工作表清单供选择。
   *
   * 注意 write: CSV 分支走 importFromFile → gridToDataset → persistAll，
   * 也就是「检视一个 CSV」实际上已经落库建了数据集。这不是疏漏而是既有语义
   * （CSV 没有工作表可选，检视即导入）。标注 write 是为了让 agent 侧
   * 不会在无写权限时误以为这是个只读探测。
   */
  'dataset:inspect': {
    write: true,
    params: { filePath: { required: true, desc: '数据文件绝对路径（.xlsx / .xls / .csv / .txt）' } },
    fromIpc: (filePath) => ({ filePath }),
    run: (p) => dataset.inspectFile(String(p.filePath)),
  },

  'dataset:importSheets': {
    write: true,
    params: {
      filePath: { required: true, desc: 'Excel 文件绝对路径' },
      selections: { required: true, desc: '[{ name, headerRow? }] 工作表选择，headerRow 为 0 基行号' },
      mode: { required: false, desc: 'split（默认，每表一个数据集）| merge（合并为一个）' },
    },
    run: (p, ctx) => dataset.importSheets(String(p.filePath), {
      selections: p.selections,
      mode: p.mode === 'merge' ? 'merge' : 'split',
      // 进度经独立事件推给调用方（分阶段 yield，GUI 可实时重绘进度条；CLI 打到 stderr）
      onProgress: (x) => ctx.emit('import:progress', x),
    }),
  },

  /**
   * 单表直导：整个文件导成一个数据集，不做工作表选择。
   *
   * 为什么需要它：CSV 走 dataset:inspect 也能落库，但名字被固定成文件名
   * （inspectFile 内部调 importFromFile 时不给 nameOverride），agent 没法
   * 指定「这份名单叫什么」。种子模块（seed-demo.cjs）当初也是绕过 IPC
   * 直接调 dataset.importFromFile 来传名字的——这里把它补成正式能力。
   *
   * 注意 Excel 分支只取**首个工作表**（importExcel 的既有语义）；
   * 需要挑工作表请用 dataset:importSheets。
   */
  'dataset:importFile': {
    write: true,
    params: {
      filePath: { required: true, desc: '数据文件绝对路径（.xlsx / .xls / .csv / .txt）' },
      name: { required: false, desc: '数据集名称；缺省用文件名' },
    },
    run: (p) => dataset.importFromFile(
      String(p.filePath),
      p.name ? String(p.name) : undefined,
    ),
  },

  'dataset:list': {
    params: {},
    run: () => dataset.listDatasets(),
  },
  'dataset:get': {
    params: { id: { required: true, desc: '数据集 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => dataset.getDataset(String(p.id)),
  },

  'dataset:delete': {
    write: true,
    params: { id: { required: true, desc: '数据集 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => dataset.deleteDataset(String(p.id)),
  },

  /**
   * 按导入会话整批删除：一次导入产生的所有数据集（split 出的 N 个工作簿）
   * 归为一个会话，这里一次删光。ids 由渲染层按 source.batchId 分组派生。
   */
  'dataset:deleteBatch': {
    write: true,
    params: { ids: { required: true, desc: '[id] 同一导入会话内全部数据集 id' } },
    run: (p) => dataset.deleteBatch(p.ids),
  },

  'dataset:renameColumn': {
    write: true,
    params: {
      id: { required: true, desc: '数据集 id' },
      key: { required: true, desc: '列 key' },
      alias: { required: false, desc: '列别名；空值表示恢复用原始表头' },
    },
    fromIpc: (id, key, alias) => ({ id, key, alias }),
    run: (p) => dataset.renameColumn(String(p.id), String(p.key), p.alias),
  },

  // 数据编辑：单元格修改 / 追加空行 / 删行（编辑后列统计即时重算）
  'dataset:updateCell': {
    write: true,
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      rowIndex: { required: true, desc: '0 基行号' },
      key: { required: true, desc: '列 key' },
      value: { required: false, desc: '单元格新值' },
    },
    run: (p) => dataset.updateCell(String(p.datasetId), Number(p.rowIndex), String(p.key), p.value),
  },

  'dataset:addRow': {
    write: true,
    params: { id: { required: true, desc: '数据集 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => dataset.addRow(String(p.id)),
  },

  'dataset:deleteRow': {
    write: true,
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      rowIndex: { required: true, desc: '0 基行号' },
    },
    run: (p) => dataset.deleteRow(String(p.datasetId), Number(p.rowIndex)),
  },

  // 列级打印开关：停用的字段不进模板设计页字段清单
  'dataset:setColumnPrint': {
    write: true,
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      key: { required: true, desc: '列 key' },
      printOn: { required: true, desc: 'true 启用 / false 停用' },
    },
    run: (p) => dataset.setColumnPrint(String(p.datasetId), String(p.key), Boolean(p.printOn)),
  },

  'dataset:setPhotoMatchColumn': {
    write: true,
    params: { datasetId: { required: true, desc: '数据集 id' }, key: { required: false, desc: '唯一配图列 key；null 关闭配图' } },
    run: p => dataset.setPhotoMatchColumn(String(p.datasetId), p.key === null ? null : p.key),
  },

  'photo:importDialog': {
    write: true,
    gui: 'dialog',
    params: { datasetId: { required: true, desc: '数据集 id' }, column: { required: true, desc: '照片文件名列 key' }, mode: { required: false, desc: 'append 补充或 replace 替换' } },
    run: async (p, ctx) => {
      const selected = await ctx.dialog.openFile({ title: '选择照片文件夹', properties: ['openDirectory'] })
      if (selected.canceled || !selected.filePaths?.length) return { canceled: true }
      const now = Date.now()
      for (const [token, value] of photoSelections) if (now - value.createdAt > PHOTO_SELECTION_TTL) photoSelections.delete(token)
      const folder = selected.filePaths[0]
      const preview = await photoLibrary.previewImport({ datasetId: p.datasetId, column: p.column, folder, mode: p.mode || 'append' })
      const token = crypto.randomUUID()
      while (photoSelections.size >= 50) photoSelections.delete(photoSelections.keys().next().value)
      photoSelections.set(token, { datasetId: p.datasetId, column: p.column, folder, mode: p.mode || 'append', createdAt: Date.now() })
      return { canceled: false, token, preview }
    },
  },
  'photo:commitSelection': {
    write: true,
    params: { token: { required: true, desc: '照片目录预检凭证' }, taskId: { required: true, desc: '照片导入任务标识' } },
    run: async (p, ctx) => {
      const selection = photoSelections.get(String(p.token))
      photoSelections.delete(String(p.token))
      if (!selection || Date.now() - selection.createdAt > PHOTO_SELECTION_TTL) throw new Error('照片目录预检已过期，请重新选择文件夹')
      const report = await photoLibrary.importFolder({ ...selection, taskId: p.taskId }, {
        makeThumbnail: ctx.thumbs?.makeThumbnail,
        onProgress: progress => ctx.emit('photo:progress', { datasetId: selection.datasetId, column: selection.column, taskId: p.taskId, ...progress }),
      })
      return { canceled: false, report }
    },
  },
  'photo:cancelSelection': {
    write: true,
    params: { token: { required: true, desc: '照片目录预检凭证' } },
    run: p => ({ canceled: photoSelections.delete(String(p.token)) }),
  },
  'photo:importFolder': {
    write: true,
    params: { datasetId: { required: true, desc: '数据集 id' }, column: { required: true, desc: '照片文件名列 key' }, folder: { required: true, desc: '受授权的本地照片目录（CLI）' }, taskId: { required: false, desc: '照片导入任务标识' }, mode: { required: false, desc: 'append 补充或 replace 替换，缺省为 append' } },
    run: p => photoLibrary.importFolder(p),
  },
  'photo:cancelImport': {
    write: true,
    params: { taskId: { required: true, desc: '照片导入任务标识' } },
    run: p => photoLibrary.cancelImport(p.taskId),
  },
  'photo:tasks': {
    params: { datasetId: { required: false, desc: '可选名单 id' } },
    run: p => photoLibrary.listTasks(p.datasetId),
  },
  'photo:report': {
    params: { datasetId: { required: true, desc: '数据集 id' }, column: { required: true, desc: '照片文件名列 key' }, rows: { required: false, desc: '原始行号数组（0 基）' } },
    run: p => photoLibrary.report(p),
  },
  'photo:exportIssues': {
    write: true,
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      column: { required: true, desc: '当前配图列 key' },
      rows: { required: false, desc: '当前筛选命中的原始行号数组（0 基）；缺省为全部' },
      identifierKey: { required: true, desc: '导出的识别字段 key' },
      savePath: { required: false, desc: 'Excel 文件绝对路径；缺省时弹保存对话框' },
    },
    run: (p, ctx) => photoLibrary.exportIssues(p, { saveFile: ctx.dialog?.saveFile }),
  },
  'photo:overrideGet': {
    params: { datasetId: { required: true }, templateId: { required: true }, rowId: { required: true }, layerId: { required: true } },
    run: p => require('./photo-overrides.cjs').inspect(p),
  },
  'photo:overrideSet': {
    write: true,
    params: { datasetId: { required: true }, templateId: { required: true }, rowId: { required: true }, layerId: { required: true }, fit: { required: true }, focal: { required: true } },
    run: p => require('./photo-overrides.cjs').set(p),
  },
  'photo:overrideClear': {
    write: true,
    params: { datasetId: { required: true }, templateId: { required: true }, rowId: { required: true }, layerId: { required: true } },
    run: p => require('./photo-overrides.cjs').clear(p),
  },

  'catalog:fields': {
    params: { id: { required: true, desc: '数据集 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => dataset.fieldCatalog(String(p.id)),
  },

  // ==================== 模板 ====================

  'template:list': {
    params: {},
    run: () => templates.listTemplates(),
  },

  'template:get': {
    params: { id: { required: true, desc: '模板 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => templates.getTemplate(String(p.id)),
  },

  'template:save': {
    write: true,
    params: { template: { required: true, desc: '模板对象（含 name / pageSize / fields 等）' } },
    fromIpc: (tpl) => ({ template: tpl }),
    run: (p) => templates.saveTemplate(p.template),
  },

  'template:matchDataset': {
    params: {
      templateId: { required: true, desc: '模板 id' },
      datasetId: { required: true, desc: '数据集 id' },
    },
    fromIpc: (templateId, datasetId) => ({ templateId, datasetId }),
    run: (p) => templates.matchDataset(String(p.templateId), String(p.datasetId)),
  },

  'template:rebindDataset': {
    write: true,
    params: {
      templateId: { required: true, desc: '模板 id' },
      datasetId: { required: true, desc: '新绑定的数据集 id' },
    },
    fromIpc: (templateId, datasetId) => ({ templateId, datasetId }),
    run: (p) => templates.rebindDataset(String(p.templateId), String(p.datasetId)),
  },

  'template:delete': {
    write: true,
    params: { id: { required: true, desc: '模板 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => templates.deleteTemplate(String(p.id)),
  },

  // 路径版：agent / CLI 没有「弹窗选文件」这一步，直接给路径
  'template:uploadBackground': {
    write: true,
    params: { filePath: { required: true, desc: '底图文件绝对路径（png / jpg / jpeg）' } },
    run: (p) => templates.uploadBackground(String(p.filePath)),
  },

  'template:uploadBackgroundDialog': {
    write: true,
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const result = await ctx.dialog.openFile({
        title: '上传底图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
      })
      if (result.canceled || !result.filePaths.length) return { canceled: true }
      return { canceled: false, ...templates.uploadBackground(result.filePaths[0]) }
    },
  },

  /**
   * 底图上传（拖拽 / 剪贴板粘贴）：图片只有内存字节、没有文件路径时用这条。
   * 扩展名由主进程按内容嗅探决定，不采用 fileName 的后缀——前端给的名字不可信。
   */
  'template:uploadBackgroundBytes': {
    write: true,
    params: {
      dataBase64: { required: true, desc: '图片内容的 base64（不含 data: 前缀）' },
      fileName: { required: false, desc: '原始文件名，仅用于归档命名；真实格式按内容判定' },
    },
    run: (p) => templates.uploadBackgroundBytes(
      Buffer.from(String(p.dataBase64), 'base64'),
      p.fileName ? String(p.fileName) : ''),
  },

  /**
   * 丢弃一张底图：换底图 / 移除底图时当场处理。
   *
   * `assetId`（新）走素材库分流删除（I-33）；`path`（旧 print-bg 路径）直接删副本。
   * 兼容未迁移数据：CLI / agent 仍可传旧 path。
   */
  'template:discardBackground': {
    write: true,
    params: {
      assetId: { required: false, desc: '要丢弃的底图原件标识（asset_<sha256>）' },
      path: { required: false, desc: '兼容旧数据：print-bg/ 路径副本' },
      exceptTemplateId: { required: false, desc: '正在编辑且已在内存中移除该底图的模板 id' },
    },
    run: (p) => templates.discardBackground(p.assetId || p.path, { exceptTemplateId: p.exceptTemplateId }),
  },

  // ==================== 可编辑底图 ====================

  'design:listPresets': {
    params: {},
    run: () => designPresets.listPresets(),
  },

  /**
   * 从内置预设造一份**新工程**（复制，不改动预设本身）。
   * 预设是内置常量，落库前一律过 normalizeDesign（见 design-presets.cjs）。
   */
  'design:createFromPreset': {
    write: true,
    params: { presetId: { required: true, desc: '内置预设标识，见 design:listPresets' }, name: { required: false, desc: '新工程名称；省略或留空用预设名' } },
    fromIpc: (presetId, name) => ({ presetId, name }),
    /*
     * ⚠️ 语义是「**打开或新建**」，不是「新建」。
     *
     * 无条件落库 ⇒ 每点一次下拉就多一份同名工程：实测一次会话堆出 18 个，
     * 装上 0.4.0 又点了 4 个。这个坑**不在逻辑里，在交互后果里**——逻辑断言全绿
     * 也照样发生。所以必须在这里（**通道层面**）堵住，像 I-28 那样靠通道形状，
     * 而不是靠调用方自觉：
     *
     *   工程库里已有同名工程 ⇒ 打开那份并记一次使用，**不再复制**。
     *   用户确实想要第二份，用「另存副本」。
     *
     * 返回 `{ design, reused }`：`design` 一律是**完整工程**（新建时也回读，
     * 因为 `saveDesign` 只给摘要，前端要 layers 才能渲染）。
     */
    run: (p) => {
      const preset = designPresets.listPresets().find((item) => item.id === p.presetId)
      if (!preset) throw new Error(`没有这个内置模板：${p.presetId}`)
      const title = String(p.name == null ? '' : p.name).trim() || preset.name
      const existing = designs.listDesigns().find((item) => item.name === title)
      if (existing) {
        designs.touchDesign(existing.id)
        return { design: designs.getDesign(existing.id), reused: true }
      }
      // `{ recordUse: false }`：系统自动建的工程不该一出生就进「常用」——
      // 常用的门槛是**用户自己保存过**（见 designs.touchDesign 的注释）。
      const saved = designs.saveDesign(designPresets.buildPreset(p.presetId, p.name), { recordUse: false })
      return { design: designs.getDesign(saved.id, saved.revision), reused: false }
    },
  },

  'design:list': {
    params: {},
    run: () => designs.listDesigns(),
  },

  /**
   * 记一次「使用」：把摘要里的 `lastUsedAt` 刷成当前时间，供界面上的「最近使用」排序。
   *
   * 单独开一条通道、而不是顺手塞进 `design:get`：`design:get` 同时服务于出片
   * （`designs.resolveDesign` 走的就是它），在那条路径上写盘会让「读」带上副作用。
   * 实现见 `designs.touchDesign`——只写摘要时间戳，**不动版本号**（I-29）。
   */
  'design:touch': {
    write: true,
    params: { id: { required: true, desc: '底图工程 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => designs.touchDesign(p.id),
  },

  'design:get': {
    params: { id: { required: true, desc: '底图工程 id' }, revision: { required: false, desc: '固定版本；省略读取最新保存版本' } },
    fromIpc: (id, revision) => ({ id, revision }),
    run: (p) => designs.getDesign(p.id, p.revision),
  },

  'design:save': {
    write: true,
    params: { design: { required: true, desc: '完整底图工程；更新时携带读取到的 revision' } },
    fromIpc: (design) => ({ design }),
    run: (p) => designs.saveDesign(p.design),
  },

  'design:delete': {
    write: true,
    params: { id: { required: true, desc: '底图工程 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => designs.deleteDesign(p.id),
  },

  /**
   * 回收「已删除工程的残留目录」：`deleteDesign` 只移索引、不删文件，`designs/<id>/`
   * 会一直躺在磁盘上且没有别的入口能清。无参——路径只由目录名推导（`design_<24hex>`），
   * 只删不在索引里的，删前逐个复核，绝不接受任何外部路径（同 I-32 口径）。
   */
  'design:purgeOrphanDirs': {
    write: true,
    params: {},
    run: () => designs.purgeOrphanDirs(),
  },

  'design:importDialog': {
    write: true,
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const result = await ctx.dialog.openFile({
        title: '添加底图图片', properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
      })
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true }
      // 底图制作页直接加图（对话框 / 粘贴 / 拖入）一律 ephemeral 语义：删图层即同步删原件，
      // 只有显式「加入素材库」（asset:adopt）才升级为 managed（I-33，与模板页上传一致）
      return designs.importImageFile(result.filePaths[0], 'ephemeral')
    },
  },

  'design:importBytes': {
    write: true,
    params: { base64: { required: true, desc: '原始 PNG/JPEG 图片 base64，不含 data: 前缀' }, name: { required: false, desc: '显示文件名' } },
    // source 强制 ephemeral（临时件）：调用方传什么都不行——升级 managed 的唯一出口是 asset:adopt
    run: (p) => designs.importImageBytes({ ...p, source: 'ephemeral' }),
  },

  'design:importBackground': {
    write: true,
    params: { background: { required: true, desc: '现有 print-bg 相对路径' }, w: { required: true, desc: '成品宽度 mm' }, h: { required: true, desc: '成品高度 mm' }, name: { required: false, desc: '工程名称' } },
    run: (p) => designs.importLegacyBackground(p),
  },

  'design:exportPng': {
    write: true,
    gui: 'printer',
    params: {
      design: { required: true, desc: '当前可编辑草稿，无需先保存工程' },
      format: { required: false, desc: 'png（默认）、jpeg 或 webp' },
      quality: { required: false, desc: '有损格式质量 1~100；jpeg 默认 90、webp 默认 80，png 忽略' },
      dpi: { required: false, desc: '150、300或600；默认300' },
      transparent: { required: false, desc: 'true忽略画布背景色并保留图层透明度；jpeg 不支持透明，会自动铺画布底色' },
      filePath: { required: false, desc: '图片绝对输出路径（扩展名须与 format 一致）；省略则显示保存对话框。渲染仍需要Electron宿主能力' },
    },
    run: async (p, ctx) => {
      // 延迟加载：出图模块只在真要导出时才进内存，纯 Node 加载注册表不受影响。
      const { FORMATS } = require('./design-export.cjs')
      // format / quality 的合法性由 prepareExport 统一体检，这里只取它的结论做对话框文案。
      const prepared = ctx.printer.prepareDesignPng(p)
      const format = FORMATS[prepared.format]
      let filePath = p.filePath
      if (!filePath) {
        if (!ctx.dialog) throw guiRequired('design:exportPng', '保存对话框（请用filePath指定输出路径）')
        const result = await ctx.dialog.saveFile({
          title: `导出高清 ${format.label} 底图`,
          defaultPath: `${printDomain.sanitizeFilename(prepared.name)}-${prepared.dpi}dpi.${format.exts[0]}`,
          filters: [{ name: format.label, extensions: [...format.exts] }],
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }
      // 显式路径的扩展名要与 format 相符——这道校验在 exportImage 里（写盘前），
      // 报错要早于「渲染完了才发现写不进去」。
      return ctx.printer.exportDesignPng(prepared, filePath)
    },
  },

  /*
   * 导出后「打开所在文件夹 / 用系统程序打开」——两条都**不接受任何参数**。
   *
   * 参数化路径在这里是明确的安全红线：`shell.openPath` / `showItemInFolder` 会拿
   * 字符串去启动系统程序，渲染进程若能传路径，等于拿到「以当前用户身份打开任意
   * 本地文件」的能力。所以路径由 printer.cjs 在真正写出 PNG 之后自己记下
   * （见 lastDesignPng），这里只暴露「打开刚导出的那一个」这个动作本身。
   *
   * 不标 write：它们不改应用数据；但也**不是**只读能力（会启动外部程序），
   * 故标 gui: 'printer'——CLI / agent 拿不到 ctx.printer，一律 GUI_REQUIRED。
   */
  'design:revealExport': {
    gui: 'printer',
    params: {},
    run: (_p, ctx) => ctx.printer.revealLastDesignPng(),
  },

  'design:openExport': {
    gui: 'printer',
    params: {},
    run: (_p, ctx) => ctx.printer.openLastDesignPng(),
  },

  // ==================== 工程包（v0.5.0 M2）====================
  // `.ppdesign`：把「已保存的那一版」连图带字体打包带走；导入永远创建副本。
  // 检查与提交分两步——提交只认令牌对应的暂存快照，源文件事后被换也不影响结果。

  'design:packageExport': {
    write: true,
    gui: 'dialog',
    params: {
      id: { required: true, desc: '底图工程 id' },
      revision: { required: true, desc: '要导出的已保存版本（不是当前草稿）' },
      taskId: { required: true, desc: '导出任务编号，用于进度和取消' },
      includeFonts: { required: false, desc: 'true 携带已上传字体原件；false 只登记字体依赖' },
      filePath: { required: false, desc: '.ppdesign 输出绝对路径；省略则显示保存对话框' },
    },
    run: async (p, ctx) => {
      let filePath = p.filePath
      if (!filePath) {
        if (!ctx.dialog) throw guiRequired('design:packageExport', '保存对话框（请用 filePath 指定输出路径）')
        const head = designs.listDesigns().find((d) => d.id === p.id)
        const result = await ctx.dialog.saveFile({
          title: '导出工程包（可编辑底图）',
          defaultPath: `${printDomain.sanitizeFilename((head && head.name) || '底图工程')}.ppdesign`,
          filters: [{ name: '批印坊工程包', extensions: ['ppdesign'] }],
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }
      return startPackageExport(p.taskId, {
        id: p.id,
        revision: p.revision,
        targetPath: filePath,
        includeFonts: p.includeFonts !== false,
      }, ctx)
    },
  },

  'design:packageCancelExport': {
    write: true,
    params: { taskId: { required: true, desc: '正在运行的工程包导出任务编号' } },
    run: (p) => cancelPackageExport(p.taskId),
  },

  /**
   * 检查包。落点是后端管理的暂存区，返回检查令牌与摘要（尺寸 / 图层 / 体积 / 字体问题）。
   * 顺手做两件收尾：清扫过期暂存、恢复上次崩溃留下的事务——否则残留会一直躺在数据目录里。
   */
  'design:packageInspect': {
    write: true,
    gui: 'dialog',
    params: { filePath: { required: false, desc: '.ppdesign 绝对路径；省略则显示打开对话框' } },
    run: async (p, ctx) => {
      let filePath = p.filePath
      if (!filePath) {
        if (!ctx.dialog) throw guiRequired('design:packageInspect', '打开对话框（请用 filePath 指定包路径）')
        const result = await ctx.dialog.openFile({
          title: '导入工程包', properties: ['openFile'],
          filters: [{ name: '批印坊工程包', extensions: ['ppdesign'] }],
        })
        if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true }
        filePath = result.filePaths[0]
      }
      designPackage.purgeStaging()
      designPackage.recoverPendingTransactions()
      const summary = await designPackage.inspectPackage(filePath)
      return { ...summary, filePath }
    },
  },

  'design:packageCommit': {
    write: true,
    params: {
      token: { required: true, desc: '检查令牌' },
      fontDecisions: { required: false, desc: '{ 原字体名: { action: substitute|default|file, family?, filePath? } }' },
      name: { required: false, desc: '导入后的工程名；默认用包里的名字' },
    },
    run: (p) => designPackage.commitPackage(p.token, { fontDecisions: p.fontDecisions, name: p.name }),
  },

  'design:packageCancel': {
    write: true,
    params: { token: { required: true, desc: '检查令牌' } },
    run: (p) => designPackage.cancelPackage(p.token),
  },

  /** 缺失字体时让用户挑一个字体文件补上（走同一套冲突规则，绝不覆盖本机已有字体） */
  'design:packagePickFont': {
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const result = await ctx.dialog.openFile({
        title: '选择字体文件', properties: ['openFile'],
        filters: [{ name: '字体', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
      })
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true }
      return { canceled: false, filePath: result.filePaths[0] }
    },
  },

  // ==================== 本地素材库（v0.5.0 M1）====================
  // 元数据层（asset-library.cjs）零 electron 依赖、与原件解耦；缩略图解码是宿主能力，
  // 经 ctx.thumbs 注入——纯 Node / CLI 不传也能跑（只是不出缩略图）。

  'asset:list': {
    params: {
      category: { required: false, desc: 'design 设计素材（默认）、photo 名单照片或 all 全部' },
      query: { required: false, desc: '按展示名或标签模糊搜' },
      tags: { required: false, desc: '标签数组；多标签是收窄（AND）' },
      favoriteOnly: { required: false, desc: 'true 只列收藏' },
      includeArchived: { required: false, desc: 'true 把已归档的也列出来' },
      page: { required: false, desc: '分页页码，从 1 开始' },
      pageSize: { required: false, desc: '每页条数，有硬上限' },
    },
    run: (p) => assetLibrary.listLibrary(p),
  },

  'asset:listTags': {
    params: {},
    run: () => assetLibrary.listTags(),
  },

  'asset:get': {
    params: { id: { required: true, desc: '素材标识 asset_<sha256>' } },
    fromIpc: (id) => ({ id }),
    // 入画板要按原件尺寸等比适配（add('image', asset) 读 width/height/name），
    // 而 getEntry 只返回展示元数据——所以这里把原件描述一并带出（原件缺失会报错）。
    run: (p) => {
      const entry = assetLibrary.getEntry(p.id)
      const asset = designs.assetInfo(p.id)
      return { entry, asset }
    },
  },

  /**
   * 从字节入库：原件先走 designs 的内容寻址校验（哈希核对），再补展示元数据。
   * 同名不同字节会被当成不同素材——内容才是身份，名字只是给人看的。
   */
  'asset:importBytes': {
    write: true,
    params: {
      base64: { required: true, desc: '原始 PNG/JPEG base64，不含 data: 前缀' },
      name: { required: false, desc: '显示文件名（存进原件记录，不影响素材库叫法）' },
      displayName: { required: false, desc: '素材库里的展示名' },
      tags: { required: false, desc: '标签数组' },
      favorite: { required: false, desc: '是否收藏' },
    },
    run: (p, ctx) => {
      const asset = designs.importImageBytes({ name: p.name, base64: p.base64 })
      return assetLibrary.adopt(asset.id, { displayName: p.displayName, tags: p.tags, favorite: p.favorite }, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail })
    },
  },

  /**
   * 弹窗选文件导入：路径只由主进程经对话框拿到（不开放任意文件读取），
   * 与 design:importDialog 同构。多选时逐张入库，重复内容自动合并。
   */
  'asset:importDialog': {
    write: true,
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      if (!ctx.dialog) throw guiRequired('asset:importDialog', '文件选择对话框')
      const result = await ctx.dialog.openFile({ title: '导入素材', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }] })
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true, imported: [] }
      const imported = []
      for (const filePath of result.filePaths) {
        const asset = designs.importImageFile(filePath)
        imported.push(assetLibrary.adopt(asset.id, {}, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail }))
      }
      return { canceled: false, imported }
    },
  },

  'asset:update': {
    write: true,
    params: {
      id: { required: true, desc: '素材标识' },
      displayName: { required: false, desc: '新展示名' },
      tags: { required: false, desc: '新标签数组（整体替换）' },
      favorite: { required: false, desc: '是否收藏' },
    },
    fromIpc: (id, patch) => ({ id, ...(patch || {}) }),
    run: (p) => assetLibrary.updateMetadata(p.id, { displayName: p.displayName, tags: p.tags, favorite: p.favorite }),
  },

  'asset:archive': {
    write: true,
    params: { id: { required: true, desc: '素材标识' } },
    fromIpc: (id) => ({ id }),
    run: (p) => assetLibrary.archive(p.id),
  },

  'asset:restore': {
    write: true,
    params: { id: { required: true, desc: '素材标识' } },
    fromIpc: (id) => ({ id }),
    run: (p) => assetLibrary.restore(p.id),
  },

  /**
   * 把「已有工程里的图片」建成素材库条目：不导入任何新字节，只补展示元数据。
   * 原件缺失会报错——不会给用户建一条点开就丢图的条目。
   *
   * adopt 会把临时件原件**迁进素材库池**（I-51）；返回的 `asset` 是搬迁后的原件记录
   * （纯信息字段）。界面手里未同步的旧路径不影响显示：pp://media 对 `<pool>/<hash>.<ext>`
   * 按 hash 解析真身（见 media-protocol.cjs），下次保存时主进程也会把文档 path 规范化。
   */
  'asset:adopt': {
    write: true,
    params: {
      id: { required: true, desc: '工程里图片的素材标识' },
      displayName: { required: false, desc: '素材库展示名' },
      tags: { required: false, desc: '标签数组' },
    },
    fromIpc: (id, meta) => ({ id, ...(meta || {}) }),
    run: (p, ctx) => {
      const entry = assetLibrary.adopt(p.id, { displayName: p.displayName, tags: p.tags }, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail })
      return { entry, asset: designs.assetInfo(p.id) }
    },
  },

  /** 缩略图缓存被清掉后重建；原件不在会明确报错，不会静默留下坏缓存。 */
  'asset:rebuildThumb': {
    write: true,
    params: { id: { required: true, desc: '素材标识' } },
    fromIpc: (id) => ({ id }),
    run: (p, ctx) => assetLibrary.rebuildThumbnail(p.id, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail }),
  },

  /**
   * 即时删除临时原件（I-33 分流）：仅 `source === 'ephemeral'` 且再无引用时删，
   * `managed`（已加入素材库）一律保留。`exceptDesignId` 用于底图制作页删除图层：
   * 正在编辑的工程磁盘上还是旧版，引用扫描要跳过它，以内存文档为准。
   * 路径只由 hash 推导，绝不接受任意路径（同 I-32 守卫口径）。
   */
  'asset:discardEphemeral': {
    write: true,
    params: {
      assetId: { required: true, desc: 'asset_<sha256> 或 64 位十六进制 hash' },
      exceptDesignId: { required: false, desc: '引用扫描时跳过的工程 id（正在编辑未保存的当前工程）' },
    },
    run: (p) => assetLibrary.discardIfEphemeral(p.assetId, { exceptDesignId: p.exceptDesignId }),
  },

  /**
   * 列出「既不在任何工程、也不在素材库」的孤立原件（I-32 清理未引用原件的预览）。
   * 只读、纯展示，不入任何库。
   */
  'asset:listOrphans': {
    params: { protectedIds: { required: false, desc: '当前未保存草稿持有的素材标识列表' } },
    run: p => assetLibrary.findOrphanOriginals({ protectedIds: p.protectedIds }),
  },

  /**
   * 删除孤立原件；删除前**再次**核对仍孤儿，期间被引用的（竞态）一律跳过（I-32）。
   * 入参是 64 位十六进制 hash 列表，路径只由本函数按 hash 拼两个原件池
   * （`design-assets/`、`ephemeral-assets/`，I-51）与 `design-thumbnails/`，
   * 绝不接受任意文件路径，避免越界删文件。
   */
  'asset:purgeOrphans': {
    write: true,
    params: { hashes: { required: true, desc: '要清理的孤立原件 hash 列表（64 位十六进制）' }, protectedIds: { required: false, desc: '当前未保存草稿持有的素材标识列表' } },
    run: (p) => assetLibrary.purgeOrphanOriginals(p.hashes, { protectedIds: p.protectedIds }),
  },
  'asset:usage': {
    params: {},
    run: () => assetLibrary.resourceUsage(),
  },

  /**
   * 在系统文件管理器里打开**素材库原件文件夹**（`design-assets/`）。
   *
   * 与 `app:openDataDir` 同构：路径由领域层按数据目录推导，渲染进程**不传任何参数**。
   * `shell.openPath` 会拿这个字符串去启动系统程序，渲染进程若能指定路径就等于
   * 「以当前用户身份打开任意文件 / 可执行文件」——所以这里只暴露「打开素材库文件夹」这一件事（I-28）。
   */
  'asset:openFolder': {
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const dir = assetLibrary.originalsDir()
      const err = await ctx.dialog.openPath(dir)
      if (err) throw new Error(err)
      return { ok: true, dir }
    },
  },

  // ==================== 字体 ====================

  'font:list': {
    params: {},
    run: () => ({
      system: fonts.systemFonts(),
      uploaded: fonts.uploadedFonts(),
    }),
  },

  // 路径版：同 template:uploadBackground，给 agent / CLI 用
  'font:upload': {
    write: true,
    params: { filePath: { required: true, desc: '字体文件绝对路径（ttf / otf / ttc / woff / woff2）' } },
    run: (p) => fonts.uploadFont(String(p.filePath)),
  },

  'font:uploadDialog': {
    write: true,
    gui: 'dialog',
    params: {},
    run: async (_p, ctx) => {
      const result = await ctx.dialog.openFile({
        title: '上传字体',
        properties: ['openFile'],
        filters: [{ name: '字体', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
      })
      if (result.canceled || !result.filePaths.length) return { canceled: true }
      return { canceled: false, ...fonts.uploadFont(result.filePaths[0]) }
    },
  },

  'font:delete': {
    write: true,
    params: { file: { required: true, desc: '已上传字体的文件名' } },
    fromIpc: (file) => ({ file }),
    run: (p) => fonts.deleteFont(String(p.file)),
  },

  // ==================== 打印 ====================
  // 出口校验：只报告空值/疑似占位，不拦截（可中断可放行由调用方决定）
  // 出片范围：rows = 行级勾选索引集合（null/缺省 = 全量）

  'print:validate': {
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
    },
    run: (p) => printDomain.validateBatch(String(p.datasetId), String(p.templateId), p.rows),
  },

  'print:photoPreflight': {
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
    },
    run: p => printDomain.photoPreflight(String(p.datasetId), String(p.templateId), p.rows),
  },

  // 组装批量 HTML（预览用，不落盘不留痕）
  // 出片分辨率在此**只做规划、不生成派生件**：预览照旧用原件，但能零额外 I/O
  // 报出「这次大约多大」。真正的降采样发生在 print:exportPdf / print:send。
  'print:generate': {
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
      previewPage: { required: false, desc: '仅生成指定物理纸张的预览，0 基；保留全作业统计' },
      outputDpi: { required: false, desc: '出片分辨率 150/300/600 或 original；缺省 300。仅用于体积预估' },
    },
    run: (p) => printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows, {
      previewPage: p.previewPage,
      outputDpi: p.outputDpi,
      encodeDerivatives: false,
    }),
  },

  /**
   * 导出 PDF。两条路径共用后半段（留痕 + 状态回写），只有「保存路径从哪来」不同：
   * - GUI：没给 savePath → 弹保存对话框
   * - agent / CLI：直接给 savePath
   * 两条路径都必须有 ctx.printer（Electron 的隐藏窗口 + printToPDF），
   * 所以本操作在纯 Node 下无论如何都不可用——这是架构事实，不是缺陷。
   *
   * 分批（S1.3-b）：单窗口加载 500 张照片页会把渲染进程推到 7.4GB 并打挂
   * printToPDF（S1 压测实测）。计划批数 >1 时按**完整物理纸张**切批逐批出片，
   * 合并校验后一次性发布；≤1 批走与以往逐字节一致的单发路径（含空数据集）。
   * 进度经 ctx.emit('print:progress', …) 推送，取消走 print:cancel（批次边界生效）。
   */
  'print:exportPdf': {
    write: true,
    gui: 'printer',
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
      savePath: { required: false, desc: 'PDF 保存绝对路径；缺省时经 GUI 保存对话框询问' },
      batchRows: { required: false, desc: '每批目标记录数；照片缺省25，普通作业缺省100' },
      jobKey: { required: false, desc: '任务键（进度/取消关联）；缺省自动生成并随结果返回' },
      outputDpi: { required: false, desc: '出片分辨率 150/300/600 或 original；缺省 300。照片先降到图框需要的像素再出片' },
      preflightFingerprint: { required: false, desc: '页面预检快照；数据、模板或照片关联变化时拒绝使用旧结果' },
    },
    run: async (p, ctx) => {
      await printDomain.assertPhotoPreflight(String(p.datasetId), String(p.templateId), p.rows, p.preflightFingerprint)
      // 固定图片烘焙（I-50）：必须在同步的 buildBatchHtml **之前** await——它要拉离屏窗口截图。
      // 放在保存/打印对话框之前是有意的：烘出来的是内容寻址的缓存件，用户取消也只是白热一次缓存。
      await printDomain.warmBatchBakes(String(p.templateId), p.outputDpi)
      const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows, { outputDpi: p.outputDpi })
      const fingerprint = printInputFingerprint(String(p.datasetId), String(p.templateId))

      let savePath = p.savePath ? String(p.savePath) : ''
      if (!savePath) {
        if (!ctx.dialog) {
          throw guiRequired('print:exportPdf', '保存对话框（无 GUI 时请用 savePath 指定输出路径）')
        }
        const stamp = new Date().toISOString().slice(0, 10)
        // 文件名必须消毒：模板名是用户自由输入，可以含 / : * ? " | < >，
        // 直接拼进 defaultPath 会让保存对话框落到意外位置甚至报错
        const safeName = printDomain.sanitizeFilename(built.templateName)
        const result = await ctx.dialog.saveFile({
          title: '导出 PDF',
          defaultPath: `${safeName}-${stamp}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        savePath = result.filePath
      }

      const jobKey = p.jobKey ? String(p.jobKey) : newJobKey()
      const task = registerPrintTask(jobKey)
      const onProgress = (x) => {
        try { ctx.emit('print:progress', { jobKey, ...x }) } catch { /* 进度事件异常不阻断出片 */ }
      }
      const batches = printDomain.planBatches(built.recordCount, built.layout, p.batchRows ?? (built.photoAssets.length ? 25 : 100))
      try {
        let r
        if (batches.length <= 1) {
          onProgress({ phase: 'single', batches: 1 })
          // 单批：一条 printToPDF 直写最终文件，与分批上线前的逐字节行为一致
          r = await ctx.printer.exportPdf(built.html, savePath)
        } else {
          r = await printBatch.exportPdfBatched({
            domain: guardedPrintDomain(String(p.datasetId), String(p.templateId), fingerprint),
            printer: ctx.printer,
            datasetId: String(p.datasetId),
            templateId: String(p.templateId),
            rows: p.rows,
            savePath,
            batches,
            outputDpi: p.outputDpi,
            onProgress,
            shouldCancel: () => task.canceled,
          })
        }
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
          selectionIds: built.selectionIds,
          snapshotHtml: built.snapshotHtml,
          photoAssets: built.photoAssets,
          status: 'ok',
          detail: `${batches.length > 1
            ? `${r.bytes} bytes → ${r.path}（${r.batches} 批合并，${r.pages} 页）`
            : `${r.bytes} bytes → ${r.path}`}${describeOutput(r.output || built.output, r.bake || built.bake)}`,
        })
        return { canceled: false, ...r, output: r.output || built.output, jobId: job.id, jobKey, scope: built.scope }
      } catch (err) {
        // 取消与失败都留痕，但状态不同：取消 = 用户主动叫停（无半成品、无最终文件）
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
          selectionIds: built.selectionIds,
          snapshotHtml: built.snapshotHtml,
          photoAssets: built.photoAssets,
          status: err && err.canceled ? 'canceled' : 'failed',
          detail: String(err.message || err),
        })
        throw err
      } finally {
        printTasks.delete(jobKey)
      }
    },
  },

  /**
   * 直接送打印机。必须留在 GUI 上下文：webContents.print 要么弹系统打印对话框
   * （silent=false，用户可确认/取消），要么静默直打（silent=true）——两者都依赖
   * 一个真实的 Electron 窗口，纯 Node 下不存在替代实现。
   *
   * 分批与 PDF 同源；非静默时每批确认打印设备和设置。
   * 已提交系统队列的批次不承诺撤回，
   * 失败/取消信息里带已提交数。
   */
  'print:send': {
    write: true,
    gui: 'printer',
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
      silent: { required: false, desc: 'true 静默直打；缺省 false 弹系统打印对话框' },
      batchRows: { required: false, desc: '每批目标记录数；照片缺省25，普通作业缺省100' },
      jobKey: { required: false, desc: '任务键（进度/取消关联）；缺省自动生成并随结果返回' },
      outputDpi: { required: false, desc: '出片分辨率 150/300/600 或 original；缺省 300。照片先降到图框需要的像素再送打' },
      preflightFingerprint: { required: false, desc: '页面预检快照；数据、模板或照片关联变化时拒绝使用旧结果' },
    },
    run: async (p, ctx) => {
      await printDomain.assertPhotoPreflight(String(p.datasetId), String(p.templateId), p.rows, p.preflightFingerprint)
      // 固定图片烘焙（I-50）：必须在同步的 buildBatchHtml **之前** await——它要拉离屏窗口截图。
      // 放在保存/打印对话框之前是有意的：烘出来的是内容寻址的缓存件，用户取消也只是白热一次缓存。
      await printDomain.warmBatchBakes(String(p.templateId), p.outputDpi)
      const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows, { outputDpi: p.outputDpi })
      const fingerprint = printInputFingerprint(String(p.datasetId), String(p.templateId))
      const silent = Boolean(p && p.silent)
      const jobKey = p.jobKey ? String(p.jobKey) : newJobKey()
      const task = registerPrintTask(jobKey)
      const onProgress = (x) => {
        try { ctx.emit('print:progress', { jobKey, ...x }) } catch { /* 进度事件异常不阻断出片 */ }
      }
      const batches = printDomain.planBatches(built.recordCount, built.layout, p.batchRows ?? (built.photoAssets.length ? 25 : 100))
      // 直打失败必须留痕：打印是唯一会真正消耗纸张的出口，打印机离线、驱动报错、
      // 系统卡纸全在这里抛异常。没有 failed 记录的话，用户只看到一句报错，
      // 历史里查不到「当时出了什么、出了多少」，也无从判断该不该重打。
      // （与 print:exportPdf 的 catch 分支对称——两个出口不能一个留痕一个不留。）
      let r
      try {
        if (batches.length <= 1) onProgress({ phase: 'single', batches: 1 })
        r = batches.length <= 1
          ? await ctx.printer.sendToPrinter(built.html, { silent })
          : await printBatch.sendToPrinterBatched({
            domain: guardedPrintDomain(String(p.datasetId), String(p.templateId), fingerprint),
            printer: ctx.printer,
            datasetId: String(p.datasetId),
            templateId: String(p.templateId),
            rows: p.rows,
            silent,
            batches,
            outputDpi: p.outputDpi,
            onProgress,
            shouldCancel: () => task.canceled,
          })
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
          selectionIds: built.selectionIds,
          snapshotHtml: built.snapshotHtml,
          photoAssets: built.photoAssets,
          status: err && err.canceled ? 'canceled' : 'failed',
          detail: String(err.message || err),
        })
        throw err
      } finally {
        printTasks.delete(jobKey)
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
        selectionIds: built.selectionIds,
        snapshotHtml: built.snapshotHtml,
        photoAssets: built.photoAssets,
        status: r.ok ? 'ok' : 'canceled',
        detail: r.ok
          ? `${silent ? '静默直打' : '打印对话框确认'}${r.batches > 1 ? `（${r.batches} 批）` : ''}${describeOutput(r.output || built.output, r.bake || built.bake)}`
          : String(r.error || ''),
      })
      return { ...r, output: r.output || built.output, jobKey, scope: built.scope }
    },
  },

  /**
   * 取消进行中的打印 / 导出（S1.3-c）。只翻标志位：printToPDF 进行中的批次
   * 不可中断，停止发生在**批次边界**——所以取消后界面会看到最后一次
   * batch-done 之后再无事件，随后整体以「已取消」收尾。
   */
  'print:cancel': {
    params: { jobKey: { required: true, desc: 'print:exportPdf / print:send 返回的任务键' } },
    run: (p) => cancelPrintTask(p.jobKey),
  },

  // ==================== 打印历史 ====================

  'job:list': {
    params: {},
    run: () => printDomain.listJobs(),
  },

  'job:openSnapshot': {
    gui: 'dialog',
    params: { id: { required: true, desc: '留痕记录 id' } },
    fromIpc: (id) => ({ id }),
    run: async (p, ctx) => {
      const jobId = String(p.id)
      const abs = printDomain.resolveSnapshot(jobId)
      const job = printDomain.listJobs().find((j) => j.id === jobId)
      // 应用内窗口打开（不再 shell.openPath 甩给系统浏览器）：
      // 快照为自包含 HTML（底图/字体已 base64 内联），file:// 直接渲染即可，
      // 保留在应用内的完整体验（无跨进程焦点丢失、与主窗口同一套窗口管理）。
      return ctx.dialog.openSnapshotWindow(
        abs,
        `归档快照${job && job.templateName ? ` · ${job.templateName}` : ''}`,
      )
    },
  },

  'job:delete': {
    write: true,
    params: { id: { required: true, desc: '留痕记录 id' } },
    fromIpc: (id) => ({ id }),
    run: (p) => printDomain.deleteJob(String(p.id)),
  },
}

// ─────────────────────────── 调用 ───────────────────────────

/** ctx 归一化：缺省一切能力，allowWrite 默认 false（安全默认值） */
function normalizeCtx(ctx) {
  const c = ctx || {}
  return {
    allowWrite: Boolean(c.allowWrite),
    app: c.app || {},
    dialog: c.dialog || null,
    printer: c.printer || null,
    thumbs: c.thumbs || null,
    // 自动更新能力（electron-updater 在 main 侧，本层不得 require electron）
    autoUpdate: c.autoUpdate || null,
    emit: typeof c.emit === 'function' ? c.emit : () => {},
  }
}

/** 宿主能力前置检查：缺失即 GUI_REQUIRED，且把「为什么」写清楚 */
function assertCapabilities(name, op, ctx) {
  if (op.gui === 'dialog' && !ctx.dialog) {
    throw guiRequired(name, '文件对话框 / 应用内窗口')
  }
  if (op.gui === 'printer' && !ctx.printer) {
    throw guiRequired(name, 'Electron 打印与 PDF 输出通道')
  }
  if (op.gui === 'relaunch' && typeof ctx.app.relaunch !== 'function') {
    throw guiRequired(name, '进程重启能力')
  }
  if (op.gui === 'updater' && !ctx.autoUpdate) {
    throw guiRequired(name, '应用内更新能力（仅打包态 GUI 可用）')
  }
}

/**
 * 原始调用：返回数据，出错抛异常。
 * IPC 通道走这条——渲染进程的 invoke 靠 reject 拿错误，语义与抽取前一致。
 */
function call(name, params, ctx) {
  const op = OPS[name]
  if (!op) throw unknownOp(name)
  const c = normalizeCtx(ctx)
  if (op.write && !c.allowWrite) throw writeForbidden(name)
  assertCapabilities(name, op, c)
  return op.run(params || {}, c)
}

/** 必填参数体检：只查 required，不做类型强制（类型转换仍归各 run，避免改变既有语义） */
function checkParams(name, op, params) {
  const spec = op.params
  if (!spec) return null
  const p = (params && typeof params === 'object') ? params : {}
  for (const [key, rule] of Object.entries(spec)) {
    if (!rule || !rule.required) continue
    const v = p[key]
    if (v === undefined || v === null || v === '') {
      return badParams(name, `缺少必填参数 ${key}${rule.desc ? `（${rule.desc}）` : ''}`)
    }
  }
  return null
}

function toEnvelope(err) {
  return {
    ok: false,
    error: {
      code: (err && err.code) || 'ERROR',
      message: String((err && err.message) || err),
    },
  }
}

/**
 * agent 调用：返回 { ok, data, error }，永不抛。
 * 比 call 多一道必填参数体检——agent 拿到的报错要能直接告诉它缺了什么，
 * 而不是像渲染进程那样拿到一句 String(undefined) 引发的下游谜题。
 */
async function invoke(name, params, ctx) {
  const op = OPS[name]
  if (!op) return toEnvelope(unknownOp(name))
  const bad = checkParams(name, op, params)
  if (bad) return toEnvelope(bad)
  try {
    return { ok: true, data: await call(name, params, ctx) }
  } catch (err) {
    return toEnvelope(err)
  }
}

/** IPC 装配表：name + 位置参数归一化函数 */
function ipcTable() {
  return Object.entries(OPS).map(([name, op]) => ({
    name,
    fromIpc: op.fromIpc || ((p) => p),
  }))
}

/** 自描述：供 CLI 帮助、以及将来接 MCP 时生成工具 schema */
function describe() {
  return Object.entries(OPS).map(([name, op]) => ({
    name,
    write: Boolean(op.write),
    gui: op.gui || 'none',
    params: op.params || {},
  }))
}

module.exports = {
  ApiError,
  call,
  invoke,
  describe,
  ipcTable,
  STORE_ALLOWLIST,
}

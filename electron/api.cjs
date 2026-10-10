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
const { loadJson, saveJson } = require('./store.cjs')
const dataset = require('./dataset.cjs')
const templates = require('./templates.cjs')
const designs = require('./designs.cjs')
const designPresets = require('./design-presets.cjs')
const fonts = require('./fonts.cjs')
const assetLibrary = require('./asset-library.cjs')
const printDomain = require('./print.cjs')
const dataDirModule = require('./data-dir.cjs')
const cache = require('./cache.cjs')

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
    run: (_p, ctx) => cache.cacheInfo(ctx.app.userDataDir),
  },

  'app:clearCache': {
    write: true,
    params: {},
    // 运行中的 GPU / Dawn 缓存删不掉（EPERM），会排队到下次启动清；
    // 返回值带 failed / queued，界面据此如实反馈，不再「点了没反应」
    run: (_p, ctx) => cache.clearCache(ctx.app.userDataDir),
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
    },
    run: (p) => templates.discardBackground(p.assetId || p.path),
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
      dpi: { required: false, desc: '150、300或600；默认300' },
      transparent: { required: false, desc: 'true忽略画布背景色并保留图层透明度' },
      filePath: { required: false, desc: 'PNG绝对输出路径；省略则显示保存对话框。渲染仍需要Electron宿主能力' },
    },
    run: async (p, ctx) => {
      const prepared = ctx.printer.prepareDesignPng(p)
      let filePath = p.filePath
      if (!filePath) {
        if (!ctx.dialog) throw guiRequired('design:exportPng', '保存对话框（请用filePath指定输出路径）')
        const result = await ctx.dialog.saveFile({
          title: '导出高清 PNG 底图',
          defaultPath: `${printDomain.sanitizeFilename(prepared.name)}-${prepared.dpi}dpi.png`,
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        filePath = result.filePath
      }
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

  // ==================== 本地素材库（v0.5.0 M1）====================
  // 元数据层（asset-library.cjs）零 electron 依赖、与原件解耦；缩略图解码是宿主能力，
  // 经 ctx.thumbs 注入——纯 Node / CLI 不传也能跑（只是不出缩略图）。

  'asset:list': {
    params: {
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
      return assetLibrary.upsert(asset, { displayName: p.displayName, tags: p.tags, favorite: p.favorite }, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail })
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
        imported.push(assetLibrary.upsert(asset, {}, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail }))
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
   */
  'asset:adopt': {
    write: true,
    params: {
      id: { required: true, desc: '工程里图片的素材标识' },
      displayName: { required: false, desc: '素材库展示名' },
      tags: { required: false, desc: '标签数组' },
    },
    fromIpc: (id, meta) => ({ id, ...(meta || {}) }),
    run: (p, ctx) => assetLibrary.adopt(p.id, { displayName: p.displayName, tags: p.tags }, { makeThumbnail: ctx.thumbs && ctx.thumbs.makeThumbnail }),
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
    params: {},
    run: () => assetLibrary.findOrphanOriginals(),
  },

  /**
   * 删除孤立原件；删除前**再次**核对仍孤儿，期间被引用的（竞态）一律跳过（I-32）。
   * 入参是 64 位十六进制 hash 列表，路径只由本函数按 hash 拼 `design-assets/` 与
   * `design-thumbnails/`，绝不接受任意文件路径，避免越界删文件。
   */
  'asset:purgeOrphans': {
    write: true,
    params: { hashes: { required: true, desc: '要清理的孤立原件 hash 列表（64 位十六进制）' } },
    run: (p) => assetLibrary.purgeOrphanOriginals(p.hashes),
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

  // 组装批量 HTML（预览用，不落盘不留痕）
  'print:generate': {
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
    },
    run: (p) => printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows),
  },

  /**
   * 导出 PDF。两条路径共用后半段（留痕 + 状态回写），只有「保存路径从哪来」不同：
   * - GUI：没给 savePath → 弹保存对话框
   * - agent / CLI：直接给 savePath
   * 两条路径都必须有 ctx.printer（Electron 的隐藏窗口 + printToPDF），
   * 所以本操作在纯 Node 下无论如何都不可用——这是架构事实，不是缺陷。
   */
  'print:exportPdf': {
    write: true,
    gui: 'printer',
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
      savePath: { required: false, desc: 'PDF 保存绝对路径；缺省时经 GUI 保存对话框询问' },
    },
    run: async (p, ctx) => {
      const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows)

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

      try {
        const r = await ctx.printer.exportPdf(built.html, savePath)
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
    },
  },

  /**
   * 直接送打印机。必须留在 GUI 上下文：webContents.print 要么弹系统打印对话框
   * （silent=false，用户可确认/取消），要么静默直打（silent=true）——两者都依赖
   * 一个真实的 Electron 窗口，纯 Node 下不存在替代实现。
   */
  'print:send': {
    write: true,
    gui: 'printer',
    params: {
      datasetId: { required: true, desc: '数据集 id' },
      templateId: { required: true, desc: '模板 id' },
      rows: { required: false, desc: '行级勾选索引集合（0 基）；缺省 = 全量' },
      silent: { required: false, desc: 'true 静默直打；缺省 false 弹系统打印对话框' },
    },
    run: async (p, ctx) => {
      const built = printDomain.buildBatchHtml(String(p.datasetId), String(p.templateId), p.rows)
      const silent = Boolean(p && p.silent)
      // 直打失败必须留痕：打印是唯一会真正消耗纸张的出口，打印机离线、驱动报错、
      // 系统卡纸全在这里抛异常。没有 failed 记录的话，用户只看到一句报错，
      // 历史里查不到「当时出了什么、出了多少」，也无从判断该不该重打。
      // （与 print:exportPdf 的 catch 分支对称——两个出口不能一个留痕一个不留。）
      let r
      try {
        r = await ctx.printer.sendToPrinter(built.html, { silent })
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
    },
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

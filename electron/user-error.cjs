/**
 * 把任意异常整理成**能直接显示给用户的一句话**。
 *
 * 为什么要有这个模块，而不是各界面各写一份：
 * 渲染进程拿到的错误是 Electron 包过的一层壳——
 *   `Error invoking remote method 'design:save': Error: <主进程原文>`
 * 而主进程原文里常常还夹着绝对路径与内部 id，例如：
 *   `找不到底图素材 asset_973b…：ENOENT: no such file or directory, lstat 'C:\Users\…\….json'`
 * 这一整串直接显示出来，用户看到的就是一句看不懂的英文。
 *
 * 这段「剥壳」逻辑**曾经在 `DatasetView.vue` 与 `TemplateView.vue` 各写了一份**，而
 * `BackgroundDesignerView.vue`、`App.vue`、`PrintCenterView.vue` 等十来处没写 ⇒ 同一条错误
 * 在有的页面干净、在有的页面是英文。所以现在只留这一份实现，并且把调用点**收口到
 * `preload.cjs` 的 `invoke` 包装**：所有 IPC 调用都在那一处过一遍，界面拿到的就已经是可显示的
 * 文案，不需要每个调用点记得处理（见 I-48）。
 *
 * 本模块零依赖、纯函数：preload（Node）与界面（Vite）共用同一份实现，也能被测试直接调用。
 */

/** Electron 给 invoke 失败加的壳；多层嵌套时逐层剥掉 */
const IPC_WRAPPER = /^\s*Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

/**
 * Node 的 errno 串。从它开始的后半句全是给开发看的（`no such file or directory, lstat 'C:\…'`），
 * 整段丢掉。中文正文里那些「……失败：ENOENT…」的尾巴也一并去掉，免得句子断在冒号上。
 */
const ERRNO_TAIL =
  /[:：]?\s*\b(?:ENOENT|EACCES|EPERM|EBUSY|EEXIST|ENOTDIR|EISDIR|EMFILE|ENFILE|ENOSPC|EROFS|EINVAL|EIO|UNKNOWN|ERR_[A-Z_]+)\b[\s\S]*$/

/** 内部素材 id（`asset_<64 位十六进制>`）：对用户没有意义，换成「该素材」 */
const ASSET_ID = /\basset_[0-9a-f]{16,}\b/gi

/**
 * 绝对路径。这是最刺眼的一类：用户看到自己机器上的 `C:\Users\lyq\AppData\…` 只会更慌。
 * 三类都要认：Windows 盘符、UNC（`\\server\share`）、POSIX 常见根目录。
 * 特意不匹配光秃秃的 `/`，否则 `PNG/JPEG`、`图片/视频` 会被误伤。
 */
const ABS_PATH =
  /['"]?(?:[A-Za-z]:[\\/][^\s'"：:，,；;）)]*|\\\\[^\s'"：:，,；;）)]*|\/(?:Users|home|var|tmp|opt|usr|etc|mnt|media|Volumes)\/[^\s'"：:，,；;）)]*)/g

/**
 * 运行时抛出来的英文散文。
 *
 * 两条规则配合用，因为单靠任一条都会漏或误伤：
 *   1. `ENGINE_TAIL` 认**已知的引擎/库报错句式**，从它起整段丢掉。名单不求全，求准——
 *      这些句子（`Unexpected token < in JSON at position 0`、`Cannot read properties…`）
 *      只有 2~3 个英文词，光靠词数抓不到。
 *   2. `ASCII_PROSE` 兜**连续 ≥2 个英文词**这种更一般的英文散文。单个词多是专有名词
 *      （`Alibaba-PuHuiTi-Regular`、`PNG`、`WebP`），留着无害。
 */
const ENGINE_TAIL =
  /[:：]?\s*(?:Unexpected token|Unexpected end of JSON|Unexpected identifier|Unexpected number|Cannot read propert|Cannot set propert|Cannot read from|is not a function|is not defined|is not iterable|Maximum call stack|Converting circular|Invalid or unexpected token|Invalid array length|not enough arguments|too many arguments|Bad control character|Unterminated string|assignment to undeclared|Out of memory|heap out of memory)[\s\S]*$/i

const ASCII_PROSE = /\b[A-Za-z][A-Za-z0-9_'.-]*(?:\s+[A-Za-z][A-Za-z0-9_'.-]*)+/

/** 只要句子里有一个汉字，就说明它是写给用户看的 */
const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/** 认不出来历的错误统一说这句——宁可少说，也不要甩一串用户看不懂的东西 */
const DEFAULT_FALLBACK = '操作没有完成，请重试。如果一直失败，请把刚才的操作告诉我们。'

/** 再长也不是给人看的一句话了 */
const MAX_LEN = 200

/** 剥掉 Electron 的 IPC 壳（可能叠多层），并去掉紧随其后的 `Error: ` */
function stripWrapper(text) {
  let out = String(text == null ? '' : text)
  while (IPC_WRAPPER.test(out)) out = out.replace(IPC_WRAPPER, '')
  return out.replace(/^\s*Error:\s*/, '')
}

/**
 * 整理成一句可显示的话。
 *
 * `fallback` 可传入更贴合场景的兜底（比如「这张图片无法读取」），
 * 在「剥完什么都不剩」或「剥完仍然一个汉字都没有」时使用。
 */
function toUserMessage(err, fallback = DEFAULT_FALLBACK) {
  let text = err instanceof Error ? err.message : err == null ? '' : String(err)
  text = stripWrapper(text)
  // 顺序有讲究：先把 errno 尾巴（含路径）整段砍掉，再单独清残留的绝对路径，
  // 最后才处理英文散文——否则散文规则会先吃掉 errno 前面的中文断句。
  text = text.replace(ERRNO_TAIL, '')
  text = text.replace(ENGINE_TAIL, '')
  text = text.replace(ABS_PATH, '')
  const prose = text.search(ASCII_PROSE)
  if (prose > 0 && HAS_CJK.test(text.slice(0, prose))) text = text.slice(0, prose)
  text = text.replace(ASSET_ID, '该素材')
  text = text.replace(/\s+/g, ' ')
  // 掏空之后会留下「：」「（ 」「，」这类尾巴，清掉，别让句子断在标点上
  text = text.replace(/[（(]\s*[)）]/g, '')
  text = text.replace(/[\s:：,，;；、/\\-]+$/, '')
  text = text.replace(/[\s:：,，;；、]+$/, '')
  text = text.replace(/[（(]\s*$/, '')
  text = text.replace(/^[\s:：,，;；、]+/, '')
  text = text.trim()
  // 没有汉字 ⇒ 它本来就不是写给用户的（纯 errno、纯英文、纯代码）。此时给一句能看懂的话，
  // 而不是把原文透出去——原文仍可在开发时的 console 里看到（见 preload 的包装）。
  if (!text || !HAS_CJK.test(text)) return fallback
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}…` : text
}

module.exports = {
  toUserMessage,
  stripWrapper,
  DEFAULT_FALLBACK,
  MAX_LEN,
  IPC_WRAPPER,
  ERRNO_TAIL,
  ENGINE_TAIL,
  ABS_PATH,
  ASCII_PROSE,
}

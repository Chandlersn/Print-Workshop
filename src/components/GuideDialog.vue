<script setup>
/**
 * 应用内使用说明：完整说明书长在应用里（宣纸墨韵），不外跳浏览器。
 * 入口只有顶栏的「说明」按钮（「关于」弹窗里的那个入口已下线，两处重复没必要）。
 *
 * 内容与 docs/使用说明.md 保持同一套章节骨架（一~八），但**按弹窗阅读做了压缩**。
 * ⚠️ 改软件功能时，这两处要一起改——曾经因为只改了 .md，应用内说明停留在 v0.2 时代
 * （说「三步打出第一批」「自带 7 套示例模板」「应用不会自动下载更新」），全是反的。
 */
const emit = defineEmits(['close'])

const SECTIONS = [
  {
    title: '一、安装',
    blocks: [
      { type: 'p', text: '系统要求：Windows 10 / 11（64 位）。两种形态任选：' },
      { type: 'li', items: [
        '<strong>安装版</strong>（推荐）：双击安装包（如「PrintPress-x.x.x-Setup.exe」）按提示安装，自动创建桌面和开始菜单快捷方式；',
        '<strong>免安装版</strong>：解压后直接双击「批印坊.exe」，不写注册表，删掉文件夹即卸载。'
      ] },
      { type: 'note', text: '提示「Windows 已保护你的电脑」怎么办？安装包未购买代码签名证书，SmartScreen 会对陌生程序出手，属正常现象，应用没有任何联网上传行为。应对：蓝色警告窗口点「更多信息」→「仍要运行」。个别杀软误报，加入信任列表即可。' },
      { type: 'h', text: '数据在哪里？' },
      { type: 'p', html: '所有数据（名单、模板、底图工程及素材、字体、打印记录）默认存在本机 <code>%APPDATA%\\printpress\\data</code>，<strong>不上传任何服务器</strong>。想放 D 盘或网盘同步目录：应用底部「更改…」选择新位置，现有数据自动迁移。备份 = 拷贝整个 data 文件夹。' },
    ],
  },
  {
    title: '二、四步打出第一批',
    blocks: [
      { type: 'p', html: '首次启动自带<strong>7 套示例模板</strong>（证书文书 3 套 + 拼版小件 4 套）和示例名单，以及「底图制作」里 1 套排好位置的身份证参考版面，可直接体验；用你自己的数据按四步走：' },
      { type: 'li', items: [
        '<strong>导入名单</strong>：「数据」页 → 导入 → 选 Excel（.xlsx/.xls）或 CSV。首行作表头，UTF-8 / GBK 自动识别；Excel 多工作表可拆分成多个数据集或合并成一张。',
        '<strong>制作底图</strong>（可选）：打开「底图制作」，把证书底图、固定文字与边框分别做成图层；直接用一张整图当底图也行，可跳过这步。',
        '<strong>设计模板</strong>：「模板」页 → 上传证书底图（点画布中央上传区，或拖入图片 / Ctrl+V 粘贴），或选用刚做好的图层工程 → 左侧字段面板点选字段，拖到画布摆好 → 保存。',
        '<strong>批量出片</strong>：「打印中心」→ 选模板（自动带出绑定名单）→ 预览确认 → 导出 PDF 或直接打印。'
      ] },
    ],
  },
  {
    title: '三、数据页：名单管理',
    blocks: [
      { type: 'li', items: [
        '<strong>按「导入批次」管理</strong>：每导入一次文件（含多工作表拆分出的全部数据集）归为一个批次，侧栏顶部下拉可随时切换；删除按钮跟着批次走——多表大文件一键「删除整批（N 个工作簿）」即可，不用逐个删。',
        '<strong>修改内容</strong>：点击单元格直接编辑，Enter 提交、Esc 取消；支持加行、删行、翻页，字号四档可调。',
        '<strong>「印」开关</strong>：列头单字开关，<strong>只有打开「印」的列才会出现在模板字段面板</strong>；激活过的数据集显示「印 N」徽标并自动置顶。',
        '<strong>打印状态</strong>：打印或导出过的数据集整条淡绿色并带「已打 N」旗标；找遗漏，看哪条还是白的。选中后可在详情头看到「已打印 N 次，最近日期」。'
      ] },
    ],
  },
  {
    title: '四、底图制作：把版面做成图层',
    blocks: [
      { type: 'p', text: '把证书底图、固定文字与边框拆成图层，跨工程复用，并按 150 / 300 / 600 DPI 导出高清 PNG。' },
      { type: 'li', items: [
        '<strong>新建底图</strong>：点「新建底图」设工程名、画布宽高与背景色，用左侧工具添加图片、固定文字、矩形、椭圆或直线。姓名、编号等随名单变化的内容仍应在「模板」页添加为字段。',
        '<strong>本地素材库</strong>：页面顶部打开「素材库」侧栏，把常用图片收进来跨工程复用——按名称 / 标签搜索、★收藏、⊘归档（隐藏但<strong>不删原件</strong>）、✎改名改标签，点一张即放进画布。同一张图用在几个工程，磁盘上只存一份原件；改库里的名字或归档某张图，都<strong>不会改写已经引用它的旧工程</strong>。粘贴 / 拖入的图默认是「临时件」，删图层会连带清理原件；想让它留下，在图层行点「＋」加入素材库即可。',
        '<strong>编辑图层</strong>：点选画布或左侧图层列表，在右侧用毫米数值精调位置、尺寸、旋转、不透明度、文字与颜色；也可直接拖动。图片裁切只记录区域，不修改原文件。列表上方项目盖住下方，可调顺序、显隐、锁定、复制或删除。',
        '<strong>多选 / 分组 / 撤销</strong>：Ctrl 或 Shift 点选可多选；方向键微调 0.1 mm，Shift 加速；拖动可吸附，按住 Alt 暂时关闭吸附。选中两个以上可组合，组可整体移动与对齐（当前支持一层）。Ctrl+Z 撤销、Ctrl+Shift+Z 重做、Ctrl+S 保存。',
        '<strong>工程版本与模板引用</strong>：点「保存工程」保存一个新版本；「另存副本」用来做相似底图。<strong>模板固定引用应用时的那个版本</strong>，之后保存新版本不会自动改变模板——回模板页选新版本并应用，或从模板进「编辑底图」后点「保存并应用到模板」。',
        '<strong>清晰度与导出 PNG</strong>：工程保留导入 PNG/JPEG 的原始文件内容，变换以参数记录；选中图片可查看有效 DPI。导出可选 150 / 300 / 600 DPI 与透明背景，并显示预计像素尺寸。导出用的是当前编辑稿，<strong>不会保存新工程版本</strong>。',
        '<strong>参考线</strong>：在右侧添加水平 / 垂直参考线并输入毫米位置，开启显示与吸附后拖动图层即可对齐；参考线不会输出到 PDF 或 PNG。'
      ] },
    ],
  },
  {
    title: '五、模板工坊：版式设计',
    blocks: [
      { type: 'li', items: [
        '<strong>底图与纸张</strong>：单张图片底图支持点画布中央上传、拖入图片文件，或按 Ctrl+V 粘贴剪贴板截图；也可在顶部打开「底图制作」，把图片、固定文字与形状分别编辑。纸张可选 A3/A4/A5/B5/A6 预设或输入自定义毫米尺寸。',
        '<strong>多联拼版（打小件必看）</strong>：打证件照、胸卡、桌牌这类小成品时，把版式从「单张」切到「多联」，填成品尺寸（内置 1 寸 / 2 寸 / 5 寸等常见规格，也可自由填毫米），系统自动算出每页几列几行并在纸上居中；画布随即切换成「单个成品」来设计，可打开裁切线方便手工裁。工具栏里「纸张」和「成品」是两个独立维度，自由组合。',
        '<strong>对折桌牌（台签）</strong>：版式切到「对折桌牌」后，一页排一份：上半联自动倒置、下半联正向，中间印好折线。字段只在下半联设计（上半联实时镜像预览），沿折线对折立起来就是双面台签——<strong>不需要打印机支持双面</strong>。',
        '<strong>字体</strong>：左侧「字体管理」上传 ttf/otf 内置到模板（应用内有免费商用字体直达链接）。工程或模板正在引用的上传字体受删除保护。',
        '<strong>保存有校验</strong>：模板字段与所选数据集激活列必须一一对应；字段失效或数据集未绑定时，保存或打印会提示处理——杜绝白版。',
        '<strong>排版工具</strong>：字段拖拽自带吸附对齐（朱砂红辅助线）；选中多个字段后可用「均分横排」一键铺开；Ctrl+Z / Ctrl+Y 撤销重做，方向键微调。'
      ] },
    ],
  },
  {
    title: '六、打印中心：出片与留痕',
    blocks: [
      { type: 'li', items: [
        '<strong>预览</strong>：整页无裁边，缩放 50%~125%。',
        '<strong>打印前校验</strong>：出片前自动扫一遍名单，问题会弹窗列出「哪个字段第几行」，<strong>点行号直达数据页那格补录</strong>，补完回来接着打；也可以选择放行（空白位置留白打印、超宽文字按版面裁掉）。',
        '<strong>出片范围你说了算</strong>：默认打整份名单；要补打某几个人，取消全选、按姓名搜索、勾选目标行即可。<strong>部分出片只留痕、不改数据集的「已打」状态</strong>——不会让你误以为整份都打完了。',
        '<strong>出片</strong>：一人一页，批量导出 PDF 或直接打印。纸张建议设「100% / 实际大小」并关闭页眉页脚。底图与上传字体都直接内置在出片内容里，导出的 PDF 在任何电脑上打开都不会丢底图。',
        '<strong>历史</strong>：每次成功打印自动归档内容快照（按月分目录），可在应用内回看原件、按原模板重打、删除。点了打印又取消的不会落盘，只留一条「取消」记录。',
        '<strong>统计</strong>：统计条放在打印历史上方，选中模板后显示该名单的历史打印次数与最近时间；显示「无记录」就是还没打过。'
      ] },
    ],
  },
  {
    title: '七、更新与反馈',
    blocks: [
      { type: 'li', items: [
        '启动时会静默检查一次版本（只读版本号文件，不收集任何本机数据；离线则跳过，零打扰）。发现新版本会<strong>在后台自动下载</strong>，顶栏提示条显示「正在后台下载 N%」。',
        '下载完成后点提示条或「关于」里的<strong>「立即重启安装」</strong>即可升级；也可以在「关于」里点「检查更新」主动触发（下载中可随时看到进度）。',
        '<strong>更新失败会在界面上直接写明原因</strong>，不再悄无声息；实在不行点「前往发布页」手动下载覆盖安装，数据不受影响。',
        '浏览器内核运行产生的系统缓存可在「关于」里查看占用并一键清理，不会动你的任何业务数据。点完会明确告诉你清掉了多少；GPU 那两块被系统自己占着、当场删不掉，会自动排到<strong>下次启动时清理</strong>（界面会写明还剩多少）。'
      ] },
    ],
  },
  {
    title: '八、常见问题',
    blocks: [
      { type: 'faq', items: [
        ['打印整体位置偏移？', '打印对话框缩放设「100% / 实际大小」，关闭页眉页脚。'],
        ['导出 PDF 是白版？', '检查模板字段是否有标红「已失效」（绑定的数据集列被删了），删掉或换列后重新保存。'],
        ['换了电脑怎么搬数据？', '旧机拷贝 data 文件夹（或你自定义的目录）→ 新机安装批印坊 → 底部「更改…」指到该目录。'],
        ['同一文件导入两遍会覆盖吗？', '不会。每次导入都是新建独立数据集并排存在；不要的在数据页顶部下拉切到对应批次整批删除即可。'],
        ['要补打名单里几个人？', '打印中心取消「全选」→ 搜索框输入姓名 → 勾选目标行 → 出片。补打只留痕，不会把整份标成「已打」。'],
        ['一寸照 / 胸卡一页多个？', '模板工坊把版式切到「多联」，填成品尺寸（或用内置规格），自动算出每页几列几行；打完开裁切线手工裁即可。'],
        ['固定标题边框怎么分开编？', '打开顶部「底图制作」，把标题、边框分别添加为文字或形状图层；回到模板页添加姓名等数据字段。'],
        ['保存了新底图模板没变？', '模板固定使用已应用的工程版本。回模板页选新版本并应用，或从模板打开底图后点「保存并应用到模板」。'],
        ['导出 PNG 会影响工程吗？', '不会。PNG 导出使用当前画布内容，不创建新工程版本；工程中的原图素材仍按原文件保存。'],
        ['旧版本为什么不自动升级？', '只有 0.2.13 及以后的版本带更新模块；更早的版本需要手动装一次，之后就都能自动更新了。']
      ] },
    ],
  },
]
</script>

<template>
  <div class="gd-mask" @click.self="emit('close')">
    <div class="gd-panel">
      <div class="gd-head">
        <span class="gd-seal">批印坊</span>
        <span class="gd-sub">使用说明 · 本地离线批量打印</span>
        <span class="tb-spacer"></span>
        <button class="gd-close" @click="emit('close')">关闭</button>
      </div>
      <div class="gd-body">
        <section v-for="sec in SECTIONS" :key="sec.title" class="gd-sec">
          <h3 class="gd-title">{{ sec.title }}</h3>
          <template v-for="(b, i) in sec.blocks" :key="i">
            <p v-if="b.type === 'p'" class="gd-p" v-html="b.html || b.text"></p>
            <h4 v-else-if="b.type === 'h'" class="gd-h">{{ b.text }}</h4>
            <div v-else-if="b.type === 'note'" class="gd-note">{{ b.text }}</div>
            <ul v-else-if="b.type === 'li'" class="gd-ul">
              <li v-for="(it, j) in b.items" :key="j" v-html="it"></li>
            </ul>
            <div v-else-if="b.type === 'faq'" class="gd-faq">
              <div v-for="(it, j) in b.items" :key="j" class="gd-faq-row">
                <span class="gd-q">{{ it[0] }}</span>
                <span class="gd-a">{{ it[1] }}</span>
              </div>
            </div>
          </template>
        </section>
        <p class="gd-foot">批印坊 PrintPress · MIT 开源 · 数据全程不出本机</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gd-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 26, 20, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 210;
}

.gd-panel {
  width: 780px;
  max-width: 92vw;
  height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--paper-card);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.gd-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 24px 12px;
  border-bottom: 1px solid var(--line);
}

.gd-seal {
  font-size: 19px;
  font-weight: 700;
  color: var(--cinnabar);
  letter-spacing: 2px;
}

.gd-sub { font-size: 12px; color: var(--stone); }

.gd-close {
  padding: 3px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper-card);
  color: var(--ink-2);
  font-size: 12px;
}

.gd-close:hover { border-color: var(--cinnabar); color: var(--cinnabar); }

.gd-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 28px 28px;
}

.gd-sec { margin-top: 20px; }

.gd-title {
  margin: 0 0 8px;
  font-size: 16px;
  color: var(--cinnabar);
  padding-left: 10px;
  border-left: 3px solid var(--cinnabar);
}

.gd-h { margin: 14px 0 4px; font-size: 14px; color: var(--ink); }

.gd-p { margin: 6px 0; font-size: 13.5px; line-height: 1.9; color: var(--ink-2); }

.gd-ul { margin: 6px 0; padding-left: 20px; }

.gd-ul li { margin: 7px 0; font-size: 13.5px; line-height: 1.9; color: var(--ink-2); }

.gd-note {
  margin: 8px 0;
  padding: 10px 14px;
  /* 走主题 token：原来写死 #fbf4e4，暗色模式下是一块刺眼亮斑 */
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  border-radius: 8px;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 1.8;
}

.gd-faq { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }

.gd-faq-row {
  display: flex;
  gap: 14px;
  padding: 9px 14px;
  font-size: 13px;
}

.gd-faq-row + .gd-faq-row { border-top: 1px solid var(--line); }

.gd-q { flex-shrink: 0; width: 220px; color: var(--ink); }

.gd-a { color: var(--ink-2); }

.gd-body code {
  padding: 1px 6px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 12px;
}

.gd-foot {
  margin-top: 32px;
  text-align: center;
  color: var(--stone);
  font-size: 12px;
}
</style>

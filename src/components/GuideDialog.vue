<script setup>
/**
 * 应用内使用说明：完整说明书长在应用里（宣纸墨韵），不外跳浏览器。
 * 入口只有顶栏的「说明」按钮（「关于」弹窗里的那个入口已下线，两处重复没必要）。
 * 内容与 docs/使用说明.md 保持一致。
 */
const emit = defineEmits(['close'])

const SECTIONS = [
  {
    title: '一、安装',
    blocks: [
      { type: 'p', text: '系统要求：Windows 10 / 11（64 位）。两种形态任选：' },
      { type: 'li', items: [
        '安装版：双击「批印坊 Setup x.x.x.exe」按提示安装，自动创建桌面和开始菜单快捷方式；',
        '免安装版：解压后直接双击「批印坊.exe」，不写注册表，删掉文件夹即卸载。'
      ] },
    ],
  },
  {
    title: '提示「Windows 已保护你的电脑」怎么办？',
    blocks: [
      { type: 'note', text: '安装包未购买代码签名证书，SmartScreen 会对陌生程序出手，属正常现象，应用没有任何联网上传行为。应对：蓝色警告窗口点「更多信息」→「仍要运行」。个别杀软误报，加入信任列表即可。' },
      { type: 'h', text: '数据在哪里？' },
      { type: 'p', html: '所有数据默认存在本机 <code>%APPDATA%\\printpress\\data</code>，<strong>不上传任何服务器</strong>。想放 D 盘或网盘同步目录：应用底部「更改…」选择新位置，现有数据自动迁移。备份 = 拷贝整个 data 文件夹。' },
    ],
  },
  {
    title: '二、三步打出第一批',
    blocks: [
      { type: 'p', text: '首次启动自带 7 套示例模板和示例名单，可直接体验；用你自己的数据按三步走：' },
      { type: 'li', items: [
        '导入名单：「数据」页 → 导入 → 选 Excel（.xlsx/.xls）或 CSV。首行作表头，UTF-8 / GBK 自动识别；Excel 多工作表可拆分成多个数据集或合并成一张。',
        '设计模板：「模板」页 → 上传证书底图（点画布中央的上传区，或把图片拖进来 / Ctrl+V 粘贴）→ 左侧字段面板点选字段，拖到画布摆好 → 保存。',
        '批量出片：「打印中心」→ 选模板（自动带出绑定名单）→ 预览确认 → 导出 PDF 或直接打印。'
      ] },
    ],
  },
  {
    title: '三、数据页：名单管理',
    blocks: [
      { type: 'li', items: [
        '修改内容：点击单元格直接编辑，Enter 提交、Esc 取消；支持加行、删行、翻页，字号四档可调。',
        '「印」开关：列头单字开关，只有打开「印」的列才会出现在模板字段面板；激活过的数据集显示「印 N」徽标并自动置顶。',
        '打印状态：打印或导出过的数据集整条淡绿色并带「已打 N」旗标；找遗漏，看哪条还是白的。'
      ] },
    ],
  },
  {
    title: '四、模板工坊：版式设计',
    blocks: [
      { type: 'li', items: [
        '底图与纸张：上传底图自动按比例建议纸张（A3 / A4 / A5 横竖版），比例差太多会预警。换图点画布中央的上传区；不想要了就点底图选中、按 Delete 移除。',
        '排版：拖拽自带吸附对齐（朱砂辅助线）；多选后「均分横排」一键铺开；Ctrl+Z 撤销、方向键微调。',
        '字体：左侧「字体管理」上传 ttf/otf 内置到模板（推荐猫啃网免费商用字体，应用内有直达链接）。',
        '保存校验：模板字段与数据集激活列必须一一对应，对不上拒绝保存并点名缺失字段——杜绝白版。'
      ] },
    ],
  },
  {
    title: '五、打印中心：出片与留痕',
    blocks: [
      { type: 'li', items: [
        '预览：整页无裁边，缩放 50%~125%。',
        '打印前校验：空白字段弹窗列出「哪个字段第几行」，点行号直达数据页那格补录；也可放行（空白留白打印）。',
        '出片：一人一页批量导出 PDF 或直打；打印对话框建议设「100% / 实际大小」并关闭页眉页脚。',
        '历史：每次打印自动归档快照（按月分目录），可回看、重打、删除。',
        '统计：显示该名单历史打印次数与最近时间；显示「无记录」——就是还没打过。'
      ] },
    ],
  },
  {
    title: '六、更新与反馈',
    blocks: [
      { type: 'li', items: [
        '应用不会自动下载或安装更新。启动时静默检查一次仓库版本号（仅读版本号文件，不收集本机数据；离线跳过）。',
        '有新版本时顶部出现提示条，「前往下载」到发布页覆盖安装，数据不受影响。',
        '也可在「关于」里手动「检查更新」或提交问题反馈。'
      ] },
    ],
  },
  {
    title: '七、常见问题',
    blocks: [
      { type: 'faq', items: [
        ['打印整体位置偏移？', '打印对话框缩放设「100% / 实际大小」，关闭页眉页脚。'],
        ['导出 PDF 是白版？', '模板字段有标红「已失效」（绑定列被删），删掉或换列后重新保存。'],
        ['换电脑怎么搬数据？', '拷贝 data 文件夹 → 新机安装后底部「更改…」指到该目录。'],
        ['同一文件导入两遍会覆盖吗？', '不会。每次导入都是新建独立数据集；不要的在数据页单独删除。'],
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

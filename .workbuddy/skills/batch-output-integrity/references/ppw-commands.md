# ppw 命令手册

> 参考实现。所有命令在仓库根目录运行：`node tools/ppw.cjs <命令>`，或 `npm run ppw -- <命令>`。
> 退出码：`0` 成功 ｜ `1` 有失败/有拦截 ｜ `2` 用法错误。

## 十个命令一览

| 命令 | 干什么 | 连宿主 | 写盘 |
|---|---|---|---|
| `status` | 环境自检：数据目录、名册可读性、成品数、备份目录里有没有成品 | 否 | 否 |
| `check` | 按必填字段体检整份名册，产出拦截明细 | 否 | 只写报告 |
| `import` | 名册按工作表拆成数据集，点亮模板用到的列开关 | 是 | 是 |
| `export` | 批量出片，缺字段的行在写盘前拦下 | 是 | 是 |
| `fix` | 改指定人的字段后重出单张（可一次多条） | 是 | 是 |
| `sync` | 某单位某几列从 Excel 同步进数据集，再整单位重出 | 是 | 是 |
| `audit` | 三层对账，产出多页 XLSX | 否 | 只写报告 |
| `pending` | 待补数据清单：还差谁、补完是重做还是新出 | 否 | 只写报告 |
| `drift` | 只扫 Excel 与数据集的字段差异（最快） | 否 | 只写报告 |
| `verify` | 校验模板字段 ↔ 必填清单 ↔ 数据集「印」开关是否对齐 | 否 | 否 |

## 开工前的三条

```bash
# 1. 环境自检。名册被 Excel 占用会在这里提示，别跳过
node tools/ppw.cjs status

# 2. 承接「某人改了要重出」这类请求时，第一条永远是它
node tools/ppw.cjs drift --all

# 3. 出片前先看计划，不写盘
node tools/ppw.cjs export --roster 合并_1-60号.xlsx --unit 55 --dry
```

## 离线命令详解

### `drift` —— 最常用

只比对源表与数据集的字段差异，不连宿主，全量 5000+ 行约 1-2 秒。

```bash
node tools/ppw.cjs drift --all                 # 全量
node tools/ppw.cjs drift --all --unit 149      # 限定单位
node tools/ppw.cjs drift --roster 合并_61-120号.xlsx --unit 93
node tools/ppw.cjs drift --all --json          # 机器可读
```

输出逐条给出 `单位 编号_姓名 字段: 源表「X」/ 数据集「Y」`，并把「已知口径（豁免规则）」的命中数单独列出。

**豁免命中数是健康指标**：零星几条属正常，几千行说明匹配规则吃错了列（见 failure-modes 第一节）。

### `audit` —— 三层对账

```bash
node tools/ppw.cjs audit --all
node tools/ppw.cjs audit --roster 合并_121-180号.xlsx --out 对账.xlsx
```

产出九页 XLSX：总览 / 批次进度 / 待处理 / 数据漂移 / 逐单位汇总 / 逐人明细 / 文件清理 / 不出证书 / 口径说明。口径见 [reconciliation-model.md](reconciliation-model.md)。

### `check` —— 字段体检

```bash
node tools/ppw.cjs check --all
node tools/ppw.cjs check --all --unit 165
```

按必填字段逐行判断「能出 / 不能出」，产出拦截明细 CSV，标明缺哪个字段。

### `pending` —— 待补数据

```bash
node tools/ppw.cjs pending --all
```

区分「补完是重做这张（图已出但不合格）」和「补完是新出这张（还没出）」，两者的处理方式不同。

### `status` —— 环境自检

```bash
node tools/ppw.cjs status
```

数据目录、名册可读性、成品数量、备份目录里躺着的成品。开工前跑一次，省掉后面一半的困惑。

### `verify` —— 点亮字段校验

```bash
node tools/ppw.cjs verify              # 全部单位
node tools/ppw.cjs verify --unit 55    # 单个单位
```

读模板的 `fields[].column` 得到「真正要渲染的字段」，与必填清单、以及每个单位出片时实际会取到的那份数据集的「印」开关逐项比对。

判定分级：列**不存在** → error（出片真空白）；列在但**未点亮** → warn（影响改模板 / 换绑，不影响已配好的模板出片）；模板要的列**不在必填清单** → warn（下次导入不会点亮）。

详细口径与「为什么开关关着也能出片」见 [print-on-switch.md](print-on-switch.md)。

## 出片命令详解

### `fix` —— 改字段重出单张

这是日常使用频率最高的出片命令。

```bash
# 单个
node tools/ppw.cjs fix --sheet "55_某单位" --name "某某" --set "<字段名>=<新值>"

# 批量（推荐：一次调用串行处理，别循环调单条）
node tools/ppw.cjs fix --task '[{"sheet":"55_某单位","name":"甲","set":{"<字段名>":"值一"}},
                                {"sheet":"55_某单位","name":"乙","set":{"<字段名>":"值二"}}]'

# 批量从文件读（任务多时避免命令行转义问题）
node tools/ppw.cjs fix --task-file tasks.json

# 不改数据，只把这一张重印一次
node tools/ppw.cjs fix --sheet "165_某单位" --name "某某"

# 先看要改什么，不写盘
node tools/ppw.cjs fix --sheet "..." --name "..." --set "..." --dry
```

`--set` 可重复出现，累积成多项：`--set <字段名>=X --set <字段名>=Y`。字段名取当前批次的必填清单（`verify` 会打印），不是固定的几个。

执行顺序固定为：**比对各字段 → 改数据集 → 回读确认 → 旧图挪进 `_partial_backup/<单位>/<原名>_改前.png` → 重出**。回读确认不是多余的一步，它区分了「写入返回值说成功」和「数据真的变了」。

### `export` —— 批量出片

```bash
node tools/ppw.cjs export --roster 合并_1-60号.xlsx --unit 55 --dry   # 先看
node tools/ppw.cjs export --roster 合并_1-60号.xlsx --unit 55         # 真出
node tools/ppw.cjs export --roster 合并_61-120号.xlsx --from 61 --to 90
node tools/ppw.cjs export --roster 合并_1-60号.xlsx --unit 55 --limit 2 --probe
```

- **一次只处理一份名册**。命中多份时报用法错误，用 `--roster` 指定。
- `--limit 2 --probe` 先出两张试水，确认版式无误再整批。
- 缺字段的行在**写盘之前**拦下，不会产生残缺成品。

### `sync` —— 整单位同步

```bash
node tools/ppw.cjs sync --roster 合并_121-180号.xlsx --sheet 121_某单位 --cols <字段名>[,<字段名>…]
```

把某单位某几列从源表同步进数据集，然后整单位重出。差异为 0 时会跳过（除非显式 `--force`），避免白跑。

### `import` —— 名册拆数据集

```bash
node tools/ppw.cjs import --roster 合并_1-60号.xlsx
node tools/ppw.cjs import --roster 合并_1-60号.xlsx --force   # 已存在也重建
```

按工作表拆成数据集，并点亮模板用到的列开关。重复导入会按完整文件名前缀检测，不会静默造同名副本。

## 通用选项

| 选项 | 作用 |
|---|---|
| `--dry` | 只打印计划，不写数据、不出片、不改文件 |
| `--json` | 结果以单行 JSON 输出（日志静默），给程序消费 |
| `--verbose` | 把宿主 stderr 也打出来，排障用 |
| `--config <json>` | 指定配置文件（缺省找仓库根或当前目录的 `ppw.config.json`） |
| `--roster-dir` / `--output-dir` / `--report-dir` | 覆盖名册、成品、报告的根目录 |
| `--template <id>` | 覆盖证书模板 id |
| `--dpi` | 出片分辨率 150/300/600，缺省 300 |
| `--data-dir` | 覆盖数据目录 |
| `--unit 61,62` / `--from 121 --to 180` | 限定单位范围 |

## 配置：`ppw.config.json`

批次相关的都收在这份文件里，换一批名单只改它，不动代码：

- 名册文件列表与目录
- 模板 id、成品尺寸与 dpi
- **必填字段与其表头匹配规则**（`eq:` 精确 / `prefix:` 前缀 / `contains:` 包含）
- 例外名单（如某人不需出证书）
- 已知口径（豁免规则，例如「数据集值 = `个人复赛` + 源表值」）

改匹配规则时务必回看 `drift` 的豁免命中数是否跳变。

## 两个必须先理解的口径

1. **出片读的是数据集，不是 Excel 原件。** 改完 Excel 必须 `fix` / `sync` 才会生效，否则重出的图与旧图 MD5 完全相同。
2. **跑批期间不要手工改数据集。** 宿主会用内存里的数据整份回写，改动会被覆盖。ppw 自己串行处理，只要不同时手工改就没事。

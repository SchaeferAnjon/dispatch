# Dispatch 界面规范

定位：给 Claude Code / Codex 套的 macOS 桌面工具，CodePilot 那种暖黑 stone 色板、VS Code 那种小半径圆角（2026-11-16 起，见「尺寸」）、两层扩散阴影、壳层毛玻璃内容不透明，语义色只进圆点和标签（方向稿 6.1）。密度向 VS Code / CodePilot 靠：行矮、字小，但块与块之间留足空气（5A.4、6.7）。

一句话：系统字体、stone 两级灰、VS Code 方圆角、壳层透内容实、一行只说一件事、等宽只给机器读的东西（6.1）。

文件位置：方向稿 `design/douyin-inspiration/README.md`（下文括号里的节号都指它，「旧版」指本文件改写前的值），token 本体在 `app/src/styles.css` 开头的 `:root`（深色值在紧接着的两个块里），列表原件在 `app/src/components/primitives.tsx`，图标在 `app/src/components/icons.tsx`，逐屏问题在 `design/aesthetic/README.md`，分步实施计划见方向稿第 8 节。

## 字体

- 栈 `--sans`（`-apple-system … "PingFang SC" …`，`"PingFang SC"` 必须显式在栈里），不引 Geist 字体文件；等宽 `--mono`。全局 `text-autospace:normal`、`font-kerning:normal`、`-webkit-font-smoothing:antialiased`（6.2，第 9 节）。
- 字号档，其余都是错（6.2、5A.4）：
  - 14 消息正文、输入框 `.ta`
  - 13 行标题、按钮、Tab、控件
  - 12 次要：分组标题、说明、工具行
  - 11 元信息：路径、时间、计数、副标、chip 里的「· 默认」、`.kbd`、≤15px 徽标。11 只给西文和数字，中文下限 12
  - 15 页名级标题（`.dialog h3` 等）
  - 17 Detail 标题（`.lst-brief h2`、`.pd h2`）
  - 旧版的 30 问候语删掉：新建 Agent 页不放问候语（2026-09-27 改成 Copilot 那样）
  - 旧版的 22 档删掉。不用 10px（第 9 节）。
- 字重只有 400、500、600（6.2、5A.4）：行标题 400，选中靠 `--sel` 底色；500 给强调、卡片标题、按钮、chip、未读标题；600 只给 ≥15px 标题和分组头。
- 行高：控件和列表 1.5，消息正文 1.7，标题 1.35（6.2）。
- `letter-spacing` 一律 0；不转大写，不做大写加字距的小标题，不用斜体（6.2，第 9 节）。
- 等宽白名单：`.callbody` 命令和输出、`.ev .cmd`、`.tool-result`、`.md code`、`pre.diff`、`.lst-md code`、`.ds` diff 统计、提交哈希、密钥输入框，加上**工具行里的参数（12px，`--text-2` 60%）和右侧完整路径（11px，`--text-2` 40%）**（旧版保留，新增项来自 6.2）。键帽可用 11px 等宽（6.5 允许等宽，字号按 11 下限）。
- 等宽禁止：路径和文件夹名标签、项目名 chip、任务和会话 ID、时间、`.av` 头像字母、计数、`.tag.pri`（旧版保留）。路径给人看时「文件名 13px `--text` + 目录 12px `--text-2`」，长路径 `middlePath` 截中间（旧版保留）。

## 一切按整体风格来（2026-09-27 定，优先级最高）

Dispatch IDE 里任何新页面、新面板、新控件，先找窗口里已有的同类页（Customizations 的 Skills / Instructions、Sessions 列表、Changes / Files 面板）照它的组件和布局做，不新造 webview、不自创样式。布局按「总览 → 列表 → 详情」三层，返回用面包屑。交付前和相邻页并排截图对比，看不出是两套才算过。

## 彩色只出现在三处（2026-09-27 定，优先级最高）

彩色只允许出现在：1) 区分 Agent 运行状态的地方（「符号表」里的状态记号）；2) 应用图标本身（空白页水印、启动画面、标题栏按钮悬停）；3) Sessions 旁的徽标。其他一切地方不上色：列表行前不放彩色圆点（Docs 的类型、Knowledge 的 Wins / Pitfalls、任务的种类都用单色线框图标或灰字区分），标签、分组头、图表以外的图例不用彩色。原「图标色即图例」表只用于上述三处和 task graph。

## 扁平（2026-09-27 定，优先级高于本文其他条目）

整个软件是扁平的，和 Dispatch IDE 暖石主题一致：面只靠两级底色（--bg、--bg-2）和留白区分，不用阴影、渐变、毛玻璃、内描边和立体感；边框要么没有，要么 1px 的 --ring；图标单色线框；按钮和 chip 只靠底色深浅和圆角表达。唯一的「彩」是图标那套语义色（见下面「图标色即图例」），只用于状态点、标签、脉络图和图标动效，不做装饰底、不做大面积色块。浮层（菜单、弹层、对话框）允许一层很淡的阴影让它浮起来，其余地方一律不加。原方向稿里的毛玻璃壳、扩散阴影、悬浮卡片作废（第 9 步分支不合）。例外：对话顶上钉住的那一行用 88% 半透明底加 8px 模糊，见「组件」的「消息」（用户 2026-11-15 选的方案 B，task-wdjpl）。

## 符号表（用户 2026-11-12 选方向 A，task-r5jfs，稿 design/symbols；2026-11-15 状态记号改用 VS Code 的圆形状态图标，task-o01fh，对比页 design/marks-compare；和本文其他条目冲突时以这一节为准）

三条规矩：
- VS Code 的圆说状态：一件事现在怎样，用 VS Code 自己的圆形状态图标（codicon `pass-filled` 实心圆勾、`circle-large-filled` 实心大圆、`circle-large` 大空心圈；VS Code 的测试和任务列表用的同一套）。一行最多一个状态记号，都在行首 14 的状态槽里，一样大：行里 14px，入口 16px；颜色只用 `--dispatch-state-*` 和 `--text-2`。代码里一律用 `dispatchBlocks/browser/dispatchMarks.ts` 的 stateMark，不自己画点、勾、圈。用户 2026-11-15 看了对比页：「我觉得用这一版好」「VS Code 挺漂亮的，我们只要跟 VS Code 的和谐就可以」（原来的方向 A 是 7px 小点、细线勾、7px 小空心圈）。
- 线画东西：这是什么、点了做什么。16px 细线图标（行里的交付物 14px），单色 `--text-2`，选中行用 `--text`；同一样东西在哪儿都是同一个图标。用 VS Code 自带的 codicon；只有 Dispatch 才有的四样东西（交付页、方案、原型、交接）用自己画的线框字形。
- 方块数活：方块只出现在四处：logo、新会话页的漂浮方块、在做时落下的块、数量和进度的格子（额度、构建、步骤）。不再用「方框里镂空一个记号」的状态块。

状态一共八个：

| 意思 | 记号 | 颜色 |
|---|---|---|
| 在做（Agent 正在跑：会话行、标题栏、Now 头） | 16px 十格落块 | logo 本色 |
| 现在（正在做的这一步；也表示在线） | 实心大圆 `circle-large-filled`；Agent 真在跑时轻轻呼吸（2s，透明度 1 到 0.8，保住 3:1；减少动态效果时静止） | `--dispatch-state-working` |
| 等你 | 实心大圆 `circle-large-filled` | `--dispatch-state-waiting` |
| 做完 | 实心圆勾 `pass-filled` | 没看过 `--dispatch-state-done`，看过 `--text-2`（任务清单里做完的步骤也是 `--text-2`） |
| 没做 | 大空心圈 `circle-large` | `--text-2`；停在这一步时字 500 |
| 出错、被打断 | 实心大圆 `circle-large-filled` | `--dispatch-state-stopped` |
| 子 Agent 在跑 | VS Code 子 Agent 胶囊（`ChatSubagentContentPart` 的那颗）里的像素转圈，左栏、输入框上方、Now 三处都是这颗胶囊（用户 2026-11-16，task-518qw） | `--text-2`（VS Code 原样） |
| 交出去 | 实心大圆 `circle-large-filled` | `--dispatch-state-handoff` |

多选（只在 Waiting for you 页，2026-11-15，task-ccmyi）：能选没选是大空心圈 `circle-large` `--text-2`，选了是实心圆勾 `pass-filled` `--text-2`，只在悬停行首那一格或有选中时替掉那一格的图标，也从 dispatchMarks.ts 取。

一组里状态都一样时，行首不重复说状态，改说这件事是什么：「Waiting for you」那一组（左栏和 Waiting for you 页）行首是 14px 细线图标：一页等你挑（方案字形）、一个问题（codicon question）、一次批准（codicon shield）、只有你能做的事（codicon person）。用户 2026-11-12：「很单调，而且根本看不出来这到底是任务，还是一个交付出来的文档」。

标题栏会话名旁：等你、出错和会话行一样；做完是 `--text-2` 的实心圆勾（开着的会话已经看过了）。对话里「Noted N」那一行，每记下一件事一个状态记号：排着是大空心圈、在做绿色实心大圆、交付了青色实心圆勾（2026-11-15，task-o01fh，designer 复审）。

新符号先进这张表。`ide/tests/symbols.test.mjs` 守着：表外的状态记号（八枚状态块字形，和自己画的小点、细线勾、小空心圈这类记号）在 Dispatch 自己的代码里只许减少，不许增加。

## 颜色（变量名不变，值换 stone）

图标色即图例（2026-09-27 定，10-09 改成 Dock 图标的实际颜色）：应用图标（app/icons/icon.icns，源稿 design/icon.svg）的十个方块加绿点就是全软件的语义色，任务、会话、脉络图、图标动效共用一套，看到颜色就知道是什么。值只写在一处：Dispatch IDE 的 `base/common/dispatchPalette.ts`，界面里用 `--dispatch-icon-*`（画图标本身）和 `--dispatch-state-*`（表示状态）两组变量，`ide/tests/palette.test.mjs` 查别处不许再写。
| 图标色 | 含义 | 变量 |
|---|---|---|
| 绿 #2e8b57 | 在做（Agent 在跑） | --dispatch-state-working |
| 琥珀 #c28a12 | 等你（待处理） | --dispatch-state-waiting |
| 蓝 #1d5fd1 | 交出去（委派） | --dispatch-state-handoff |
| 紫 #6e56cf | 计划、子 Agent | --dispatch-state-plan |
| 青 #2f6f73 | 完成、已交付 | --dispatch-state-done |
| 珊瑚 #c9683f | 出错、被打断 | --dispatch-state-stopped |
| 灰 #8a857c | 待办、未开始 | --dispatch-state-todo |
| 奶白 #f4f3ef | 卡片（图标第二、三行） | --dispatch-icon-cream |
| 绿点 | 现在、在线 | --dispatch-state-working |
只调明度保对比度：浅色下等你的琥珀压到 #b88100、奶白压到 #d1d1cd（浅底上看得见）；深色下青、蓝、紫提到 #3a797d、#286add、#725bd4（悬停行上 3:1）。凡是画 logo 的地方（启动画面、空编辑器、空 Files、新会话页聚成的图标、新会话右栏的空白页）都和 Dock 上的应用图标同一个图形：十块方块，右下角在 Dock 图标的位置放 Dock 那颗白心绿点（绿圆加奶白圆心，圆心用图标本色 #f4f3ef，浅色主题也不压暗），外面一圈柔和光晕（`base/common/dispatchDot.ts` 的画法：绿点本身不动，光晕 1.6s 呼吸），不加底板（10-21 用户在三版对比 design/editor-icon/compare 里选了不加底板；10-31 用户说界面里的 logo 和应用图标长得不一样、要统一，绿点于是换成 Dock 的白心绿点，blurt DIS-1；10-10 起用过的角上小点、10-21 试过的 Dock 深色底板都不要）。Dock 和手机上的应用图标文件本身不变（「图标定版」），编辑器里 Open in Agents 按钮的单色小图标也不变。几何只有一份：`base/common/dispatchIcon.ts` 按 icon.svg 的比例排到任意尺寸，小尺寸按设备像素对齐（同一行同高、列距相等、不粘连），静态 SVG 由 `ide/gen-icon-svgs.mjs` 从它生成；会话行和收件箱的小图标是同一几何去掉底板和绿点。任何地方不再新造颜色，红只用于破坏性操作确认。


stone 是带一点暖的灰（oklch 色相 49 到 56），主色炭黑，没有品牌蓝（3.3）。下表是 6.3 的值。

| token | 浅 | 深 | 用在 |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0c0a09`（`oklch(0.147 0.004 49.25)`） | 主面板、内容区 |
| `--bg-2` | `#fafaf9` | `#1c1917`（`oklch(0.216 0.006 56)`） | 侧栏、卡片、弹层 |
| `--sel` | `#f2f1f0` | `#292524`（`oklch(0.268 0.007 34)`） | 选中 100%，hover 60% |
| `--text` | `#0c0a09` | `#fafaf9` | 正文 |
| `--text-2` | `#79716b` | `#a6a09b` | 次要字，只有这两级 |
| `--hair` | `#e7e5e4` | 白 10% | 线、卡片描边 |
| `--hair-2` | `#e7e5e4` | 白 15% | 输入框边框 |
| `--chip` | 同 `--sel` | 同 `--sel` | 按钮、标签、用户气泡底 |
| `--chip-2` | `#f5f5f4` | 白 4.5% | 输入框底、键帽底 |
| `--fill` / `--fill-text` | `#252525` / `#fafaf9` | 反转 | 唯一的实心主按钮，每屏最多一个 |
| `--shadow-diffuse`（原 `--shadow-pop` 改名） | `0 12px 40px -8px rgba(0,0,0,.10), 0 4px 12px -4px rgba(0,0,0,.04)` | 同形，`.45` / `.25` | 输入框、大弹层 |

新增 4 个（6.3）：

| token | 值 | 用在 |
|---|---|---|
| `--ring` | `--fill` 30%，3px | 焦点环 |
| `--term-bg` | 浅 `oklch(0.13 0.004 49)` / 深 `oklch(0.10 0.002 49)` | 命令块，永远黑底 |
| `--glass` | `color-mix(in oklch, var(--bg-2) 40%, transparent)`（侧栏）、`82%`（弹层）；非 macOS 退回实色 | 壳层和浮层的半透明底 |
| `--card-ring` | `inset 0 0 0 1px rgba(255,255,255,.06)`（深）/ `.18`（浅） | 卡片内描边 |

- 语义色保留色相，值换成 `--blue oklch(0.546 0.245 263)`、`--green oklch(0.527 0.154 150)`、`--orange oklch(0.705 0.213 47.6)`、`--red oklch(0.577 0.245 27.3)`，深色略亮；`--purple` 保留现值。每个用 `color-mix` 派生 `-muted`（10%，做底）和 `-border`（20%）（6.3）。
- 语义色只进标签、圆点、图标：`--blue` 未读和链接、`--green` 在跑和完成、`--orange` 等确认和 P1、`--red` 阻塞和错误、`--purple` 定时（旧版保留）。
- Agent 身份色 `--claude --codex --pi --cursor --opencode --hermes --gemini` 保留，只在头像（6.3）。项目头像压饱和度：`color-mix(in srgb, <hue> 22%, var(--bg))` 底、字母用该色（旧版保留）。
- 默认状态不显示：P2 / P3 不显示，「进行中」不显示；未读是标题前 6px `--blue` 圆点 + 标题 500，不是标签。一屏带色标签个位数（旧版保留，6.3 确认）。
- **内容层永远不透明，只有壳层（图标栏、左右栏、顶栏、输入框外壳）和浮层（弹层、菜单、tooltip）可以半透明**（6.3）。
- `::selection` 主色 30%；滚动条 6px，滑块 `--text-2` 25%（hover 40%），圆角 3（3.3）。
- 不写硬编码 hex；深色模式靠 token 自动跟随。Dispatch IDE 的配色主题从这份 token 生成，不单独维护（5A.4）。

## 尺寸

- 间距是 4 的倍数（5A.4）；具体用哪个值看下一节「留白」的五档。
- 圆角（用户 2026-11-16 定「VS Code 方圆角」，task-n1o60；取代 6.4 的四档圆角加胶囊）：照 VS Code 1.139.1 聊天界面自己的小半径圆角矩形，不用大圆角和胶囊。值取 VS Code 的 cornerRadius 几档（`ide/vscode/src/vs/platform/theme/common/sizes/baseSizes.ts`：xSmall 2、small 4、medium 6、large 8、xLarge 12）。Dispatch IDE 里是 CSS 变量 `--dispatch-radius-<名>`（`workbench/contrib/dispatchRadius/browser/media/dispatchRadius.css`，两扇窗口都有），Dispatch 自己的 CSS 和内联样式只用它们，不写 999 胶囊：

  | token | 值 | VS Code 那一档 | 用在 |
  |---|---|---|---|
  | `radius-button` | 4 | small（`.monaco-button`） | 按钮、tag、chip、机器标签、键帽、数字徽标、引擎胶囊、输入框里的选择器、开关、分段控件外框、tooltip、头像、24 及以下的图标按钮、设置页的单行输入框和搜索框（Keys 的搜索框旁 Add key 同高 32，task-5wvgj） |
  | `radius-row` | 6 | medium | 列表行、分组头、工具行、32 和 36 的图标按钮、rail 按钮、36px 图标框、菜单行、引用片、底部提示条、发送键 |
  | `radius-bubble` | 6 | medium（VS Code 聊天的请求气泡） | 用户气泡 |
  | `radius-input` | 8 | large（`.chat-input-container`） | 输入框外壳 |
  | `radius-card` | 8 | large（Agents 窗口的内容卡、动作菜单） | 卡片、权限卡、命令块、旁聊卡、Talk 小卡、子 Agent 条、Detail、页顶说明、证据卡、菜单外框、popover、hover 面板、模型和 Agent 弹层 |
  | `radius-dialog` | 12 | xLarge | 只给对话框；也是全软件的上限 |

  - 卡片取 8 不取 12：权限卡、命令块和输入框在同一列，同一档才齐；VS Code 自己的内容卡和菜单也是 8，12 只给对话框这种模态层（designer 2026-11-16）
  - 套在里面的：内件圆角 = 外框圆角 − 内边距，最小 2（子 Agent 条里的行 4，分段控件里的选中块、开关滑块 2）
  - 底色画在内边距里面（`background-clip: content-box`，左栏会话行）时，看得见的圆角是写的圆角减去旁边的内边距；写的时候每个角按旁边的内边距加回去，让看得见的那个角是 token 的值（左栏会话行看得见的四个角都是 `radius-row` 6）
  - 圆一律写 50%，只给 20px 以内等宽高的点和圈：在跑点、未读点、ping 圈、单选圈、颜色点、标注图的编号点（16 和 20）；头像不算圆
  - 字形级小件可以写 4 以下的字面值：停止块、额度格、构建方块（3.5、4.5 这类）、滚动条、进度条（条高 4、圆角 2）；方块记号和 logo 的圆角不归这一条管
  - 棘轮（`ide/tests/corners.test.mjs`）：Dispatch 自己的 CSS 和 TS 内联样式里，比 12 圆的、999 胶囊、6 和 8 以外 5 到 11 之间的值、50% 都只许减少；表里的值和 dispatchRadius.css 不一致也报错
  - 例外（用户 2026-09-27 定）：开关和分段控件（This session / 项目名、List / Timeline、筛选这类「几选一」）用 `radius-button` 4（和右栏页签同一个圆角）；Dispatch IDE 里新页面的页头照 VS Code 原生页头（13/600），和 Customizations 其他页一致
  - 空状态（2026-09-27 定，统一三位 designer 的写法）：右栏页签（Tasks、Docs、Changes）只有两行字，不放图标；中间整页（Waiting for you、Projects、Task graph）一个 24px 线框图标 + 一句标题 + 一句说明。2026-09-29 批过的「每页一行字」，用户 2026-09-30 看了实际效果后撤回，六处（Docs、Tasks、Changes 页签，Projects、Waiting for you、Task graph）都回到这一条
  - 第四处颜色（用户 2026-09-28 定）：「在哪」标注图里的红框（#dc2626）和绿框（#16a34a）只画在截图内容上，界面本身的编号一律黑圆点
  - 未读：会话的未读用行末圆点（它是「彩色三处」里的 Sessions 行点；行首状态槽已经有记号时不再放，见「符号表」）；文档、Wiki 这类内容的未读只把标题加粗到 500，不加点
- 尺寸 token（6.4）：`--row` 32（会话、任务、项目行，单行，紧凑模式取消）、功能入口行 36、`--row-nav` 28、工具行和文件树行 28、`--inset` 12、`--hd` 40（透明可拖）、`--side` 56（顶部留 40）、`--bar` 28（Agents 窗口底栏，2026-10-01 从 41 改）、`--conv-w` 768、`--detail` 380、`--icon` 20。
- 图标（6.4）：保留自家 `icons.tsx` 一套，1.5 描边、圆头；尺寸 sm 14（工具行、chip）/ md 16（列表行、图标栏）/ lg 20（卡片头）/ xl 24（空状态）；颜色 `--text-2`，选中项 `--text` 且描边 2。品牌标（Anthropic、OpenAI、GLM 等）只在 Agent / 模型 chip 前。模型芯片前的图标按模型厂商选（用户 2026-09-29 批），保持单色；没有厂商图标时用通用 sparkle，不用当前运行引擎的图标代替；引擎图标只放在引擎芯片和引擎身份位置（例：OpenCode 跑 GLM，引擎芯片用 OpenCode，GLM 芯片用智谱图标，缺标时用 sparkle）。Dispatch IDE 里的引擎品牌标（2026-09-27 定）：codicon 自带的用 codicon（`$(claude)`、`$(openai)`），没有的一律画成单色字形放进 Dispatch 自己的图标字体（dispatch-ide 的 make-icon-font.py，第一枚是 OpenCode 的像素 o，`$(dispatch-opencode)`），墨量对齐 codicon 的 claude / openai，不用彩色标、不用 CSS 背景图或 mask。
- 状态圆点（6.4、5B）：在跑 8px `--green` + ping 圈；等确认 14px `--orange-muted` 底圆 + 10px 铃铛；未读 6px `--blue` 点 + 标题 500；完成和空闲不显示，状态槽留 14px 空位。
- 头像 20px 圆角 `radius-button` 4，字母 sans 600 10px（6.4，字母规格旧版保留）；36px 图标框 `radius-row` 6、`--chip` 70% 底（6.4）。

### 密度表（5A.4，已拍板）

主应用的行高、字号、间距向 VS Code / CodePilot 看齐，颜色和材质按 CodePilot。

| 项 | 定为 | 说明 |
|---|---|---|
| 列表行（会话、任务、项目） | 32；功能入口行 36 | 旧版 40（紧凑 34） |
| 文件树行 | 28，树缩进 16 + 竖线 | IDE 里保持 VS Code 的 22 |
| 工具调用行 | 28 | 旧版约 34 |
| 分组头 | 28 | 旧版 32 |
| 顶栏 | 40 | 旧版 56；IDE 的 35 接受 |
| 图标栏 | 56 | 旧版 52；IDE 的 48 接受 |
| 字号 | 13 行标题和控件，12 元信息和工具行，14 消息正文 | |
| 最小字号 | 11 西文和数字，中文 12 | |
| 字重 | 400 行标题，500 强调，600 只给 ≥15px 标题和分组头 | |
| 行内缩 `--inset` | 12 | 旧版 10 |
| 输入框 | 14px，最小高 48，内边距 16 / 12 | |
| 消息间距 | 40 | CodePilot 48，我们多一层工具行取 40 |
| 编辑器（IDE） | `--mono` 13，行高 20 | |
| 颜色、材质、阴影 | 按 CodePilot（本文「颜色」） | |
| 圆角 | 照 VS Code 自己的小半径（本文「尺寸」） | 2026-11-16 起；原来按 CodePilot 的大圆角作废 |

## 留白

密度是行矮、字小；拥挤是块与块之间没有空气。行只有 28 到 32，块之间必须是 16 / 24 / 32（6.7）。

**五档，只有这五档**（6.7）：

| 档 | 值 | 用在哪 |
|---|---|---|
| 行内 | 8；紧凑处 4（caret 到文字、chip 内部） | 图标到文字、chip 之间，同一行之内 |
| 行间 | 2（导航行之间）；4（工具行之间） | 同一列表里相邻行 |
| 块间 | 16 | 卡片和卡片、chip 组和 chip 组、标题和正文 |
| 段落 | 24 | 消息和消息（再加 16 = 40）、面板内容上下、对话框内边距 |
| 章节 | 32（页面里 40） | 设置页小节之间 |

**面板边和行内缩（硬性最小值）**（6.7）：

| 面 | 值 |
|---|---|
| 导航面板（边栏、文件树、右侧面板）外边距 | 8，行本身再内缩 12，文字离面板边 20 |
| 导航面板顶部到第一行 | 8；分组头上方再 8 |
| 导航面板底部 | 12 |
| 消息区左右 | 16 内边距，列宽 768 含它 |
| 消息区顶部到第一条消息 | 24 |
| 输入框区 | 上 8、下 16、左右 16；框内 16 / 12 |
| 弹层 | 16（大弹层里的小节 12） |
| 菜单 | 4，菜单项自己 8 / 12 |
| 对话框 | 24 |
| 卡片 | 20（小卡 12 / 14） |
| 右侧面板头 | 40 高的头行，头和第一行之间 8 |
| macOS 壳 | 窗口边到卡片 8 / 16 / 16，卡片之间 4 |

**必须空着的位置**（6.7）：

- 对话列两侧：列宽 768 之外永远是空的，窗口再宽也不拉伸正文；窗口窄到不够时才左对齐留 24。
- 右侧面板顶部：40px 头行之下 8px，第一行内容不能顶着头。
- 新建 Agent 页：chip 行、输入框、框下那行灰字作为一块，框大约在窗口 40% 高度；这一块之外不放任何东西（没有问候语、快捷卡、最近文件夹）。
- 输入框到窗口底 16；输入框下面最多一行 12px 状态（`.cstat-row`，只放状态，终端里跑的加「在终端里跑」），底栏和它之间再 8。Agents 窗口的底栏（用户 2026-10-01 选 design/bars 方向 B「Status in blocks」）：28 高、壳层底色、上面不画线，和标题栏按钮一样矮；左边只放设置（Run 10-31 删了：用户看不出它是干什么的，blurt DIS-4；F5 照常运行项目），右边放这台 Mac 的：构建队列、防休眠的杯子、每个引擎一格额度电量；平时只是几块安静的方块，要你看时才出字（额度剩两成以下、构建失败、排队超出的「+N」），新用户头一周每块后面带一个词；快捷键进悬停提示。
- 分组和分组之间 8，分组头上方 8；最后一个分组到面板底 12。
- 消息之间 40；同一轮里工具行块和正文之间 8，工具行块自己上下 16。
- 页头里项目之间 12；页头最多三样（返回、标题 + 项目 chip、主按钮），其余进 Detail。

**分隔线**（6.7）：列表里不画线，面靠 `--bg` / `--bg-2` 色差和 4 到 8px 的缝区分。只有三处允许线：面板头下方 `--hair` 40%、弹层里左右两栏之间、Tab 条里主次泳道之间 20px 高的短竖线。卡片用 `--hair` 50% 描边，不用线分隔卡片。例外：对话顶上钉住的那一行下沿 1px `--hair`，见「组件」的「消息」（用户 2026-11-15，task-wdjpl）。

**硬规则一句话**（6.7）：行内 8、行间 2 到 4、块间 16、段落 24、章节 32；面板边 8 加行内缩 12；小于 8 的间距只能出现在同一行之内。

## 组件

- 列表行 `.lrow`（6.5、5B）：32 高单行，`radius-row` 6，`--inset` 12，`[状态槽 14] 8 [标题 13/400 单行截断] … [accessory 最多 1 个] [时间 11px --text-2 40% tabular-nums 固定 38px 右对齐]`。副标取消，给人读的最新进展、ID、验收记录、耗时、文件数进 Detail 或页头；列表行不写机器名（机器由窗口决定，见「多台机器」；在别的 Mac 上跑的会话例外，行末带机器标签）。hover `--sel` 60%，选中 `--sel` 100%，150ms 底色过渡，`cursor:pointer`；hover 时时间位置换成 20px ⋯ 按钮。开着 Detail 的页面 accessory 再减一个（旧版保留）。
- 分组头 `.lsec`（6.5、5B）：28 高、`radius-row`、12/600 `--text-2` 70%，hover `--sel` 60%；项目分组行 32 高：20px 项目头像 + 名字 13/500 + 12px caret 常显，右侧显示组内条数（11px `--text-2` 40%，用户偏好「每组有名字和条数」，2026-09-26 定）；组内超出 N 条放一行「显示更多」（12/600 `--text-2` 70%）；收起展开 200ms（见「动效」），折叠状态记住。
- ghost 行（5B）：新建、搜索、IDE 等功能入口在边栏顶部，36 高，图标 + 13/400，无边框无底色，hover `--sel`；键帽（⌘N、⌘K）只在 hover 时出现。
- 标签 `.tag`（6.5）：`radius-button` 4，`--chip` 底、`--hair` 40% 描边、11px/500、内边距 10 / 2；有色变体用 `-muted` 底 + 主色字。
- 引用片（用户 2026-09-29 批）：和图片缩略图、文件片共用输入框附件行；高 48、圆角 `radius-row` 6（跟画框提问的截图缩略图）、1px `--hair` 边框，原文 13px、来源 12px；输入时最宽 280，发送后最宽 360、右对齐放在气泡上方；悬停关联原文，停 500ms 显示全文，点击回到来源；发送后的引用片不显示删除按钮。
- 机器标签（用户 2026-09-29 批）：20 高、`radius-button` 4、`--chip` 底、1px `--hair` 边框（原稿的内描边按「扁平」改成边框）、12/500（机器名可能是中文，按中文下限 12，不用 `.tag` 的 11）、14px vm 图标；全软件只这一种机器标。
- 键帽 `.kbd`（6.5）：20 高、`--chip-2` 底、11/500、圆角 `radius-button` 4；等宽也允许。
- 按钮 `.btn`（6.5）：`radius-button` 4；默认 36 高左右 16、sm 32 高左右 12、xs 24 高左右 8 字 12；图标按钮 36 / 32 / 24 见方，36 和 32 用 `radius-row` 6，24 及以下 `radius-button` 4；实心 `--fill`、outline `--hair` 描边、ghost 无底；`:active` 下沉 1px；焦点环 3px `--ring`。
- 空状态 `.empty-view`（6.5）：24 图标、标题 13/500、一句 11px `--text-2` ≤46ch、最多一个按钮。（2026-09-29 批的「每页一行字」用户 2026-09-30 看了实际效果后撤回，回到这一条。）
- Customizations 方向 A 的五样（用户 2026-09-29 选 A，稿 design/customizations/redesign/）：
  - 单色开关：18 见方、圆角 4、`--chip-2` 底加 1px `--hair-2` 内描边，勾上只多一个 14px `--text` 对勾，不上主题色；150ms 底色过渡，hover `--sel`；装不上的灰到 45%，悬停写为什么。Hooks 每组一个引擎一个，Plugins 每个插件一个。
  - 引擎胶囊：22 高、圆角 4、左右 8、11/500；没挂 `--text-2` 字加 1px `--hair-2` 内描边、透明底，挂着 `--chip` 底、`--text` 字、前面 12px 对勾、不描边；点一下挂上或摘掉（MCP 是复制过去），做不到的 55% 灰、悬停写原因。Skills 和 MCP Servers 每行三个，顺序 Claude Code、Codex、OpenCode。
  - Dispatch 标（锁）：`.tag`，前面 12px 锁，字「Dispatch」；只标 Dispatch 自带、只读的东西（两个技能、dispatch.md、四组钩子），放在该页原有的 Built-in 组里，菜单里的 Delete 灰着写原因。
  - 页顶说明和指路行：页顶一条说明 `radius-card` 8 圆角、`--chip-2` 底、`--hair` 60% 内描边、内边距 10 / 12、12px `--text-2`，前面 14px 信息图标，第一句加粗 `--text`，说这页是什么、不是什么；指路行 36 高同样的底，左图标、中间一句、右边「Open …」加箭头，整行可点，只用来把人带到那样东西唯一的那一页，不在两处放同一个开关。
  - 引擎可见范围条：一条 6 高的横条，按开场摘要各段的长度分段着 `--text-2` 深浅，引擎看不到的那段盖 135° 斜纹（`--text` 22% 描边），下面一行写「All / None / 百分比」；只在 Session brief 详情里用，说明每个引擎实际读到多少。
- 新建 Agent 页（参照 Copilot 桌面端新建会话，2026-09-27 定）：没有问候语和快捷卡；输入框上方一排两个描边 chip（32 高、`radius-button` 4、1px `--hair-2`）：项目或文件夹、Agent（带身份色圆点），都带下拉箭头，之间 8，和框之间 8；框和会话页同一个输入框，框内左下加号和模型，框下一行和会话页同一行：左边权限模式、顺手建任务，右边「新工作树」开关（先只记在设置里，不起作用）· 分支名。
- 输入框 `.composer .cbox .ta .tools`（应用内聊天和会话回复共用，6.5，结构照 Copilot）：盒子 `--chip-2` 底、`radius-input` 8、1px `--hair-2` 描边、`--shadow-diffuse`，宽 `--conv-w` 和对话同宽；`.ta` 14px、行高 1.5、最小高 48、内边距 16 / 12。框内左下一排纯文字按钮（13/400 `--text-2`，无底色，hover 变 `--text` 加 `--chip` 底 100ms）：加号、Agent（会话开了之后不能换，只是文字加身份色圆点）、模型（带 12 的下拉箭头）。发送键是 32 见方、圆角 `radius-row` 6 的方块（方向 A「Dispatch blocks」，用户 2026-10-01 选，稿 design/identity/bold），Dispatch 自己的向上箭头、无文字，框里没字时是 `--text` 12% 的安静石色底、箭头 `--text-2`，有字时用主题的按钮色，固定在框的右下角（距边 12），框窄时左边换行，发送键不动；Agent 在跑且框里没字时它变成停止（10 见方、圆角 3 的实心块，和所有在做的块同一个 2.4s 呼吸），150ms 换图标，这是除 esc 外唯一的打断入口；在跑时打了字它是排队发送，说明写在悬停提示里。框下一行 `.cstat-row` 12px `--text-2`，左边权限模式（权限图标加设置页三选一的名字「Always ask」「Ask for risky actions」「Full auto」，各引擎、各处同一个叫法，菜单里每项下一行人话说明；不用引擎的 Ask Before Edits、Allow all、Full Access 这类词，可点）和状态（在跑绿点、等你橙点、空闲不带点；终端里跑的末尾加「在终端里跑」），右边分支名（分支图标加名字，从 git 读）；Agent、模型、文件夹在状态的悬停提示里（机器由窗口决定，输入框里不标），接管到 Dispatch / 放回终端在页头 ⋯ 菜单。chip 和这一行不用等宽。
- Dispatch 方块（方向 A「Dispatch blocks」，用户 2026-10-01 选，稿 design/identity/bold/proto-icons.html、proto-motion.html；实现 dispatch-ide `src/vs/sessions/contrib/dispatchBlocks/`）：
  - 符号：37 枚，做进 Dispatch 自己的图标字体，和 codicon 一样跟字色、字号走；圆角方块、1.5px 线。状态八枚（working、waiting、done、handoff、stopped、todo、sub-agent、step-now）是带颜色的实心块、记号镂空；其余（任务、计划、交付、设备、地方和动作）单色线框，不上色。2026-11-12 起状态不再用这八枚状态块（见「符号表」）；线框字形里只有交付页、方案、原型、交接四枚继续用，其余入口回到 codicon（界面按表一处一处改）。
  - 颜色：只用 `--dispatch-block-working / waiting / done / handoff / stopped / plan / idle`，是应用图标的颜色调低饱和、贴暖石色板（用户 2026-10-01「配色收敛别太艳」），深色亮一档；只出现在第「彩色只出现在三处」说的状态位置。
  - 用法：左栏入口（Waiting for you 前是 codicon 的 16px 细线铃铛 `--text-2`，其余线框；2026-11-11 方案 A，task-0v1o9）；会话行前在跑是方块掉落，等你是 14px 琥珀实心大圆 `--dispatch-state-waiting`（第一次出现时轻敲），做完没看是 14px 实心圆勾 `--dispatch-state-done`（读了以后空着），出错是 14px 珊瑚实心大圆，行尾不再另放未读点，其余空着、14 的状态槽留着（2026-11-11 方案 A，task-0v1o9）。会话下面的子 Agent 行（用户 2026-11-16，task-518qw，「左栏做成这种的就可以」，指父对话里的子 Agent 块）：永远挂在派它的会话下面，不按路径挪到别的项目组；在跑的一个一行，就是父对话里 VS Code 原版的子 Agent 胶囊（`OpenSubagentChatActionViewItem`：1px 描边、圆角 `cornerRadius-small`、11 到 12px 灰字，前面像素转圈，胶囊外斜体「Working for 3m 40s」，下一行 L 形连线加它正在跑的那一步，可截断），跑完的收进一行「N finished」（12px `descriptionForeground`、12px 箭头，就地展开），「N finished」和展开后的每一行指上去行尾有 20 的 ×（清掉，按配置记住）；点一行在对话旁边开它的只读页签，和胶囊上的 Open Subagent 一样；会话行上不再有「⌄ N」计数；文件夹仍用文件夹图标，不配首字母。会话行尾的引擎标（Claude、Codex、OpenCode 和终端的 >_）平时不显示，鼠标移到这一行或键盘选中时才出现，不显示时也占着位置，标题不跳（用户 2026-10-31，blurt DIS-11）。在做和等你的会话不折进「+N more」，所在文件夹收起时也露在文件夹那一行下面（2026-11-11 方案 A，task-0v1o9）。
  - 七个动效：做完打勾（填色 350ms 回弹 + 勾 200ms，晚 150ms）、在做的呼吸（2.4s 往返）、等你轻敲（4s 一轮，三轮）、交付到了（200ms 掉进来、旧的下滑、数字 150ms 上滚）、交接（600ms 一圈加一条线走过去）、手机连接中（1.2s 流动，连上变实心在线点）、应用图标在想（格子 1.6s 轮流亮）；只用本文三条曲线，减少动态效果时全部静止。
- Now 页签（方向 A「三行头加一条步骤线」，用户 2026-11-11 选，task-0v1o9，稿 design/home-now；取代 2026-10-01 那一版的卡加四个分组）：会话右栏第一个页签，图标是 16px 细线心电线（codicon pulse），Changes、Files、Docs、Tasks 排在后面，默认在、没有关闭键；会话第一次打开时显示它，之后留在人自己点的那个页签；新会话没发话时不显示。不要卡，三行直接放在面板上，左边距 8 加 12，页签头下 8：第一行状态行 12px `--text-2` 高 20，14 的状态槽加 8，写「状态 · 第几步 · 多久」（「Working · step 3 of 5 · 12 min」「Waiting for you · 4 min」「Paused · step 3 of 5 · 2 h ago」「Done · 2 h ago」「In the terminal · 6 min」），记号在做是会话行同一个方块掉落、等你琥珀实心大圆、停下大空心圈、做完实心圆勾 `--dispatch-state-done`（都 14px，照符号表）、终端 >_ 细线图标；一轮结束而当前任务的计划还有没做完的步骤是 Paused，Done 只给当前任务已完成、没有任务或任务没有计划的时候，人按停止键停下的一轮（没有没做完的步骤时）是 Stopped：状态行「Stopped · 2 min ago」，记号珊瑚实心大圆 `--dispatch-state-stopped`，一句话「You stopped it. Send a message to go on.」，按钮和 Paused 一样，不写 Done，切到别的会话或重载窗口以后也一样，直到有新的一轮（2026-11-12，task-cq11p）；任务板的回答还没到而会话不在跑时，头三行的位置是三条 10 高的占位条（`--now-hover` 底，2s 明暗一次，减少动态效果时静止），不猜状态，回到看过的会话先显示它上次的内容（2026-11-12，task-cq11p）；「引擎 · 模型」在它的悬停提示里；第二行是 Agent 自己用 `dispatch now` 写的一句话，15/600 `--text` 行高 1.35 最多三行，离状态行 4（没写时是进程正在做的那一步；等你时是它问你的那句或方案的标题）；第三行在做时「Right now: …」12px 单行走 2s shimmer，终端是最后一行输出 12px 等宽，等你和做完时是按钮，离一句话 12：sm 32 高按钮（`radius-button` 4）13/500 间距 8，等你时实心「Open proposal」（这一屏唯一的实心，有方案页才有，和 Waiting for you 那一行同一个打开方式）加 outline「Reply」（光标放进输入框；没有方案页时只有 Reply），停下时 outline「Reply」加 ghost「See changes」（没有 Changes 页签时只有 Reply，没有实心按钮），做完时 outline「Open delivery page」（有交付页才有）加 ghost「See changes」（切到 Changes），在做时没有按钮。头三行下 24 是任务，没有「Tasks」分组头：任务行 32 高（任务行、步骤行、折叠行和可点的行的悬停底色圆角和左栏会话行同一个值，`radius-row` 6），12px 箭头、标题 13/500、行尾「2 of 5」或「Done」11px `--text-2`，点标题或箭头都就地展开、收起它的步骤，不跳 Tasks 页签（用户 2026-11-16 定，task-ewbvh，取代 11-11 的「点标题在右栏 Tasks 页就地打开」；没有步骤和交付物的任务标题只是字），正在做的那条默认展开；步骤 28 高、14 的槽，一条 1px `--hair` 竖线从第一步穿到最后一步（在每个记号上下各空 2px）：做完灰色实心圆勾 `--text-2`、正在做绿色实心大圆（只在会话真的在跑时出现，轻轻呼吸，字 13/500 `--text`）、等你琥珀实心大圆、停在的那一步大空心圈加字 13/500 `--text`（读屏念「Stopped here」）、没做大空心圈 `--text-2`（都 14px，2026-11-15 照符号表改，task-o01fh）。子 Agent 不单列一组：挂在正在做的那一步下面，和步骤的字对齐，和输入框上方的子 Agent 条、左栏会话下面的子 Agent 行同一套（用户 2026-11-16，task-518qw）：一行 16px codicon `agent` 加「N agents working」12px 600 `descriptionForeground`，下面每个在跑的是 VS Code 原版子 Agent 胶囊（转圈、派它做什么、斜体用时、下一行 L 形连线加当前一步），回来的收成一行「N finished」就地展开，点胶囊在对话旁边开它的只读页签。交付物是任务的最后几行（14px 细线图标：页面、构建、提交、链接；名字 13px；多久 11px），不带框，点了和原来一样打开。再下 24 是折叠行（28 高、12/600 `--text-2` 70%、计数 11px 右对齐）：这段会话做完的其他任务「Done in this session」；做完时「Next in 项目名」（这个项目 Next up 里排着的，点一行开它的任务页）；交接过才有「Handed over」，没交接过什么都不写。折叠展开 200ms `--ease-out` 动 grid 行高、箭头转 90 度 200ms、收起的部分键盘跳过；减少动态效果时全部静止。Next up 和 Start by itself 开关不再放在会话的 Now 里。它取代了页签上方的 Now 卡：一个会话只有一个 Now。
- 对话里的任务链接（用户 2026-11-15，task-86t0e；2026-11-16 改，task-ewbvh）：点了中间的对话不动，右栏打开（关着就打开）；这件任务在本会话的 Now 里就切到 Now，那一行展开、滚到看得见、底色闪一次（`dispatch.showTaskInNow`）；不在就切到 Tasks 页签，就地展开这件任务（`dispatch.showTask`）。列表里有它就是它那张卡展开并闪一次；列表里没有（别的会话、别的项目、已做完）就在列表上面单放一块：一行 28 高 12/600 `--text-2` 写它从哪来（「In 项目名」「In another session」「In this session」），行尾 20 的关闭键（左右内边距 12，和卡里展开箭头在一条竖线上；任务板回答之前不写从哪来，只有关闭键），下面是同一张卡、展开着，这一块和下面的列表隔 16，列表空时下面照常是两行空状态，切到别的会话或点关闭就收走。秒开：回复画出来时就把里面的任务问好（一次两个），点的那一下先显示手上有的标题和状态，再在后面问一遍补上；手上只有链接的字时是标题加两条占位条，不出整块 Loading。整页任务页只从卡的标题、Task graph、Projects、Waiting for you 这些地方进。
- 子 Agent 条（方向 A，用户 2026-11-12 选，task-1rzdr，稿 design/subagent-strip；2026-11-16 改用 VS Code 原版胶囊，task-518qw，稿 design/subagent-now/redesign A）：只在当前会话有子 Agent 正在跑时出现，一个都不在跑了就消失（做完的照旧在右栏 Now 和左栏会话下面）。贴在输入框上方，间距 8，和输入框同宽；一块 `--bg-2` 底（深色下对话栏本身就是 `--bg-2`，这一块升一级用 `--chip`，悬停 `--text` 6%）、圆角 `radius-card` 8、内边距 4，出现时 200ms 从下 8px 上来。头一行 28 高、圆角 `cornerRadius-small`、左右 6：16px codicon `agent`、「N agent(s) working」12px 600 `descriptionForeground`（和 Now 里那一行同一个组件）、行尾 12px 箭头；默认收起（Orca 那样一行「1 agent working ⌄」，后面接「第一个的名字: 它现在这一步」单行截断），点它展开或收起（箭头 200ms 转 180 度），收起与否按窗口记住。展开后每个在跑的子 Agent 是一颗 VS Code 原版子 Agent 胶囊（`OpenSubagentChatActionViewItem`，和父对话里、左栏、Now 同一个控件：像素转圈、派它做什么、斜体「Working for 42s」每秒走，下一行 L 形连线加它正在跑的那一步，不知道时写 VS Code 自己的「Working on it...」），胶囊之间 4；这一轮里做完的收成一行「N finished」（12px `descriptionForeground`、12px 箭头），点开就地展开它们的胶囊（打开图标、「Worked for …」）。点胶囊（或 Tab 到它按 Enter / Space）在对话旁边开这个子 Agent 的只读页签，和父对话里胶囊的 Open Subagent 一样。减少动态效果时没有上来的动画。原稿每行还有「token」和单独的「Stop」：Claude Code、Codex、OpenCode 现在都给不了单个子 Agent 自己用了多少 token，也没有只停这一个的办法，所以都不画。没做完就结束的（被停掉、失败、跑它的 Claude Code 进程没了）不算在跑，胶囊斜体处写「Stopped after …」，收进「N finished」；一个结束信号都没有、它和父对话的记录 30 分钟没写、跑它的进程也不在了，同样按停止处理，不会一直显示 Working（2026-11-16，task-518qw）。只读页签（子 Agent 的）× 一直显示并留出位置，在跑时的转圈挪到标题左边，不再被 × 盖住（task-518qw）。
- Point and talk 录屏口述（方向 A「Button by the input」，用户 2026-11-16 选，task-0y0km，稿 design/screen-talk；用户原话「录屏不用选软件」）：输入框工具行里一个 16px 细线摄像机（codicon `device-camera-video`），在发送键左边，悬停写「Point and talk: record the screen under your pointer and your voice (⌃⇧S)」；⌃⇧S 是全局快捷键（Dispatch 在后台也录），按下或点它就录鼠标所在那块屏和麦克风，不弹选择器、不选软件、不选项目，再按一次停下。会话的输入框和新会话页的输入框里都有，旁聊卡里不放；新会话页的在它自己工具行发送键左边，22×22、悬停底圆角 4（`--dispatch-radius-button`，和会话工具行里的摄像机一样是方圆角；发送键仍是 32），图标同样 16px，权限卡和没 Key 卡在整个输入堆栈最上面、离下面 8，⌃⇧S 在新会话页按就录进这个框，录制中、停下、卡片都和会话里一样，Enter 或发送键开出新会话，第一条消息就是这条录屏消息（task-3w0lf）。录制中（A1）：输入框描边不变（留着 Agent 干活时的流动边，task-dd4hw），正文位置是边说边出的灰字（14px 行高 1.6 `--text-2`，最多三行，旧的往上滚、顶上 12px 渐隐），还没字时「Listening…」走 2s shimmer；工具行 40 高：8px `--red` 实心圆点 1.6s 呼吸（不透明度 1↔.35）、「Recording」12px/500、计时 12px 等宽数字、五根 2px 宽的音量条、最新一处的编号（16 高的 `--text` 实心胶囊数字，每多一处弹一下）、右边 Discard（13px `--text-2` 文字按钮）和带字的实心 Stop（28 高、圆角 4，停止方块加「Stop」，和停止 Agent 的方块分开）。录制中从开始到停下，被录的那块屏四边一圈 4px 流动红框（`--red` 的 conic 渐变 4s 转一圈，深浅相间，不录进视频、不挡鼠标；减少动态效果时是静止的 `--red` 70%），切到别的软件也看得出在录（用户 2026-11-16「跳到其他软件我也知道在录，流动性的边框」，task-dd4hw）；界面里的红只有这个圆点和这圈框。指针停住约 1 秒记一处（动 6pt 以内都算停，离开 24pt 才能再记），记下那一刻的画面（最宽 1600px）。停下（A2）：先三个 144×96 占位块（`--sel` 底 2s 明暗）和「Picking frames…」，约一秒后换成关键帧：每张是红框周围的裁切（`.dispatch-where-thumb`，圆角 6，红框 1.5px 画在图上面），左下角编号和这句话开始的时间，悬停或 Tab 聚焦时右上 × 删、右下笔开画框工具改框（Delete、Enter 同效）；下面视频片（24 高、圆角 6、1px `--hair` 边，摄像机加「Screen recording」和时长，悬停是完整路径，点了用系统播放器打开），同一行最右一个安静的 Discard；再下面转写一句一行：编号、时间 12px `--text-2`、原话，最多 min(168px, 24vh) 高，多了在框里滚动（task-dd4hw），点一句就地改字（只有光标，不加底色块），Enter 收下、Esc 还原；框里不画内框，review 拿焦点时输入框外边和打字聚焦时一样（`focusBorder`，请求进行中为它的 40%）（task-dd4hw）。删掉一张关键帧它的编号跟着从句子前消失，其余编号不变。输入框自己的工具行留着，Enter 或发送键发出，Dispatch 回到前台、光标在这一块里。发出去（A3）：关键帧按时间排在气泡上方（144×96，同一种裁切和标签），下面大一号的视频片（28 高、13px），气泡里一句一行（16 / 36 / 1fr 三列，行间 4），气泡圆角 6。点关键帧或编号在这条消息下面就地展开 Where to look（圆角 8、1px `--hair`）：「Picture 2 of 3 · 0:07 … Close」，图最宽 440，红框带编号牌，下面是有关键帧的那几行，点一行换图，Esc 关；指着一句它的关键帧亮一圈 2px `--text`，反之亦然。发给 Agent 的是文字（「Point and talk · 0:15 screen recording …」一句说明、每句「[n] m:ss 原话」、视频路径）加每张关键帧（红框和编号烧进图里，带画框提问的 `dispatch.marks`，三个引擎都收）；视频和关键帧原图在 ~/.dispatch/recordings/日期/时间/。Dispatch 不在被录的那块屏上（或被盖住、最小化）时，那块屏顶上居中出浮条（借方向 B 的 B1）：440×36、圆角 12、`--bg-2` 底、1px `--hair-2` 边、浮层那层淡阴影，摄像机、计时、音量、一行灰字从左边渐隐、编号、24 高的 Stop（浮条左边也是红点）；不抢焦点、不录进视频（content protection），可以拖，位置按屏记住；记下一处时在指针处出一个 40px 的圈淡出（不管 Dispatch 在不在屏上）。第一次（A0）：缺权限时输入框上方 8 处一张卡（和输入框同宽，圆角 8，`--bg-2` 底、深色下 `--sel`，1px `--hair`，内边距 12 / 16）：标题 13/500「Point and talk needs two permissions」，一句为什么，麦克风、屏幕录制各一行（16px 线图标、名字、右边按钮），Allow 弹 macOS 自己的麦克风框，Open Settings 打开系统设置那一页并在屏右上角出一块能拖 Dispatch 图标的小面板；授权后那一行换成灰色实心圆勾和「Allowed」；屏幕录制是 Dispatch 开着时打开的，那一行换成实心「Quit & Reopen」，下面一句「macOS needs Dispatch to reopen once. Your sessions come back as they were.」；右下「Not now」。没有 Soniox Key 时同一个位置一张卡：一句「Press Open Keys, paste your Soniox key and save it. Then press the camera to record.」，SONIOX_API_KEY 一行带 Open Keys；Open Keys 打开 Settings › Keys 并直接展开添加表单（名字已填 SONIOX_API_KEY、用途已填「Point and talk speech recognition (Soniox)」、光标在值上；这个名字已有就展开它的 Edit），存好后卡自己消失，不自动开录（人在设置页上，看不见输入框），再点摄像机就录（task-5wvgj）。按钮一律不折行，圆角 4。减少动态效果时没有呼吸、shimmer、弹出和进场动画。
- 旁聊（方向 B「Split pane」，用户 2026-11-16 选，task-5im8n，稿 design/side-chat-now；替掉 11-15 的方向 A「Bottom-right card」浮卡，用户同意）：Ask Question（Docs、Markdown 编辑器、Changes、回复里、终端里选字）和 /btw 开的旁聊不劈对话栏，开在右栏页签下面的一格里：右栏上下两格，上面是当前页签（Now、文档、Changes），下面是旁聊，中间 1px `--hair` 线；旁聊还是原来那个子会话（同一个引擎、同一份对话）。下格不浮、不带阴影、不带圆角，占满右栏宽、贴底；上格的内容和旁边停靠的文件列表按下格的高度变矮，谁也不盖谁。分隔线就是 VS Code 的 sash：悬停按 VS Code 的延迟（300ms）亮起、拖时一直亮，拖着调高低，双击回默认。默认下格占页签下面的 55%（含那条线）；窗口 1200 宽及以下沿用旧卡的高度：页签下面的 58%、不过 420。上格最矮 32，下格线下最矮 200（头 28、钉住那一行 28、输入框 72、回答 72），两者放不下时 32 优先。拖过的比例记住（重启也在），双击清掉。上格低于 120 时 Now 收成一行摘要：32 高、左 20、下沿 1px `--hair` 40%，状态记号、Agent 那句话 13px 单行截断（悬停看全文）、行尾「3/5」11px `--text-2` 等宽数字，点这一行回默认分栏。窗格头 28 高、左 20 右 6：12px 箭头（收起时转 -90°）、14px 讨论图标、「Side chat」13/500、「· from 会话名」12px `--text-2` 截断（右栏窄于 340 时不写），右边 ⋯（Rename…、Delete Side Chat、Other Side Chats 换到同一会话的别的旁聊，以及 Walk me through 和 Quiet / Talk）和 ×，24 见方、圆角 4、悬停 `--chip`，指针在格头上或键盘焦点在里面时才出现。点窗格头（或 Enter / 空格）收起：右栏底部只剩这一条头和上沿那条线（共 29 高），回答中写「· Answering」走闪光字（减少动态效果时不闪），有没看的回答写「· 1 new answer」字重 500，这时不写「from 会话名」；再点展开。× 关掉，标题栏会话名的菜单顶上「Side chats」一组列出这个会话的旁聊（问题 · 文件名），点一个开回来；同一会话同时只开一格，跟着屏上那个会话。下格里窗格头、引用片、消息、输入框左右都离右栏边 20，和 Now 的状态记号对齐。引用片在消息列表最上面、跟着消息滚走：照「引用片」高 48、圆角 6、1px `--hair`，第一行那段话 13px 单行截断，第二行「HANDOFF.md · line 3」12px `--text-2`；指上去文档里那段话用选区色全亮，下格开着时那段话用失焦选区色淡亮，点它文档滚回那段并全亮 1.4 秒；不是 Docs 里问的（编辑器、Changes）点它打开那个文件那几行，回复里问的点它回到原对话那一轮。你那句话滚过顶以后收成顶上一行，和主对话钉住那一行同一种（28 高、12px `--text-2`、行尾细 ↑，点它滚回去）。圆角按偏好「VS Code 方圆角」：你那句话的气泡 6、内边距 8 / 12、最宽 80%；输入框起始一行高、圆角 8，工具行不放引擎下拉（旁聊的引擎随会话定），输入框下面不放权限和分支那一行，模型名写全；回答自带的那排小图标在下格里不显示，由下面三个按钮说一次。回答完了，输入框上方 8 处一行三个 24 高小按钮（圆角 4，12px `--text-2`，悬停 `--chip` 加 `--text`）：Add to chat 把答案作为引用片放进原对话输入框（来源写「Side chat · 文件名」，不自动发，焦点进原对话输入框）、Keep as comment 把答案留成那段话上的批注（按钮字暂时变成「Kept on HANDOFF.md · line 3」）、Copy。批注：那段话下面一行 28 高、1px `--hair`、圆角 6，「Comment」12/500 加答案第一行 12px `--text-2` 截断，点开时那一行只留「Comment」和箭头，下面是全文和 Open side chat、Delete（和卡里三个按钮同一种）；那段话的字下面点线。Add to chat 放进去的引用片和别处的引用片同一种：深色下底用 `--bg-2`、边用 `--hair-2`（`--bg` 在输入框里像个洞），第一行 400。代价照稿：上格变矮，1440 宽时 Now 默认约 350 高；从文档里问时文档只剩一半左右的高度。
- 边干边学（用户 2026-11-15 选 B「Talk while new」，task-q9x2r，稿 design/learn-scene；用户原话「这个软件不只是让 AI 去工作的地方，也是让人类去学习的地方」「安静和会说话两种都要有，能切」）：一个设置两处切：旁聊格头的 ⋯ 里「While the Agent Works」下 Quiet / Talk（勾选）加 Learning Settings…，Settings 左栏 Learning 页（学士帽图标）一行 Quiet | Talk 分段，默认 Talk。Talk：屏上那个会话的 Agent 在这一轮新建文件、装包（npm、pnpm、yarn、bun、pip、uv、brew、cargo、go、gem 等）、删文件时，右栏右下角冒一张小卡，和旧的旁聊浮卡同一族：圆角 `radius-card` 8、`agentsPanel` 底、1px `--hair-2` 边、同样很淡的阴影，宽 340（窗口 1200 及以下撑满右栏、左右下 12），离角 16，多张时新的在下、间距 8，最多 3 张，旁聊下格收起时摞在它的格头上方 8 处；内边距 10 / 12 / 10 / 14；第一行 20 高：14px 线图标（新文件 new-file、装包 package、删除 trash，`--text-2`）、名字 13/500 单行截断、标签 11px `--text-2`（New file、Created、Installed、Deleted）、行尾 20 见方的 ×；第二行 13px `--text-2` 行高 1.55、左缩 22 和名字对齐、最多两行；底下 2px 的时间线（`--text-2` 18% 底、55% 条）7 秒走完，指针停在卡上停表、不淡出，移开接着走；出现 200ms 淡入上移 8px，走时 200ms 淡出，减少动态效果时直接出现、不画时间线。不抢光标：冒出来时焦点留在原处、不进 Tab 顺序，读屏用 role=status。一句话只用 Agent 自己调用里已有的：新文件取它开头的注释（跳过版权、指令、文件名），没有就取 Agent 调用前写的那句（要提到这个文件或包，或说了用途），再没有只写动作本身（「Created src/a.ts.」「Ran npm install x.」，命令去掉以 - 开头的参数，完整命令在点开后的引用片里）；不为小卡调模型。同一轮同一类合成一张：「3 new files · Created」第二行列名字（三个以后「and 2 more」），装包标题列包名（三个以上「4 packages」）；还开着时就地换字、7 秒重算，已淡出的再有新的同类就带上全部再冒，点过 × 的这一轮不再冒。点卡在旁聊下格里接着问，引用片第一行是那个文件或那条命令、第二行「reminder.ts · New file」「Command · Installed」；不支持旁聊的引擎（OpenCode）点卡改成把它作为引用片放进原对话输入框。旁聊下格开着时不冒卡，开下格时已有的小卡收走。Quiet：小卡一张不冒，选中问照旧。Ask Question 入口：回复里、编辑器里的文件、Changes 的 diff、Docs、内置终端的输出里选字，都有 Ask Question，开的都是同一个旁聊下格。只读的字（回复、终端输出）是同一个框：Quote、一条竖线、占位字「Ask Question」的输入框，框离选区下沿 6、左边对齐选区起点；文件和 diff 里是 VS Code 自己的批注框，前面加 Quote、Ask Question 两个按钮、输入框仍是 Add Feedback（右栏窄时按钮只剩图标）；引用片第二行写清来源：文件「reminder.ts · line 3」、diff「reminder.ts · line 3 · Changes」、终端「Terminal」（图标换成终端）。原型里的 Words you know（学会的词不再冒卡）这次只留接口（dispatchLearnModel.ts 的 ILearnKnownWords），没有界面。 Walk me through（带我看一遍，用户 2026-11-15，task-fktjx，稿 design/learn-scene 第 5、6 帧；用户原话「我之前用终端时它生成的文件我从来不看，这种黑箱子让人不安心」）：屏上那个会话从在跑变成停下、而且这一轮改了文件时，Talk 下右栏右下角亮一颗胶囊，和旧的旁聊胶囊同一族：32 高、圆角 `radius-button` 4、`agentsPanel` 底、1px `--hair-2` 边、同样很淡的阴影，离角 16（窗口 1200 及以下 12），旁聊下格收起时摞在它的格头上方 8 处；这一轮的小卡还在角上时胶囊等最后一张走了再亮（先亮会把小卡往上推，推到指针下面的那张就不再停表）；14px compass 线图标、「Walk me through」13/500、站数「4 stops」12px `--text-2`、行尾 24 见方的 ×；不抢焦点、不进 Tab 顺序，不点就一直在，点 × 这一轮不再亮，下一轮开始时收走；旁聊下格开着时不亮。Quiet 下不亮，入口在右栏 Now 头做完时的按钮行（没有交付页时它是第一颗 outline、See changes 变 ghost、悬停底 `--sel`；有交付页时排在 Open delivery page 后面、ghost）和旁聊格头 ⋯ 的「Walk Me Through This Turn」，两种模式都有。点了右下角换成站卡，和旧的旁聊浮卡同宽同角（380、离角 16，窄窗撑满右栏），高随内容、至多 470；卡头 40：compass 图标、「Walk me through」13/500、「· this turn, 4 stops」12px `--text-2`、×；正文内边距 12 / 12 / 8（卡脚左右也是 12，和卡头对齐）：第一行文件图标（新文件 new-file、改过的 file）、文件名 13/500、「New file · lines 1–2」「2 lines added · lines 3–4」12px `--text-2`；下面一句话 14px 行高 1.7；再下面「Ask about this」24 高小按钮（`radius-button` 4）（12/500 `--text-2`，悬停 `--chip`），最后一站多了还有「and N more in Changes」（点开 Changes）；卡脚「Stop 1 of 4」12px `--text-2` 等宽数字，右边 Back（ghost，第一站隐藏）和 Next（实心，最后一站叫 Done），都是 28 高、`radius-button` 4、12/500。Next 是「颜色」一节「--fill 每屏最多一个」的例外：站卡是人自己点开的临时浮层，开着时标题栏的 Commit 也是实心，两颗同屏可以（designer 复审，task-fktjx）。卡本身不画焦点框，边框始终是 1px `--hair-2`。键盘 ← / → / Esc；点了以后焦点放在 Next 上（是人自己点的，焦点环只在按钮上），编辑器开文件不抢焦点。带看期间收起编辑器旁的 Files 列表、关掉开着那几个编辑器的 minimap，让文件占满右栏宽、行尾不被盖住，Esc / Done 时都恢复；滚到那几行时把那一站第一处改动的那几列也横向滚进可见区。每站在编辑器里打开那个文件、把那几行滚到离顶 3 行处并整行淡亮（`editor.inactiveSelectionBackground` 70%，行号旁 2px `editorLineNumber.activeForeground` 竖线），200ms 淡入；减少动态效果时不淡入、滚动不平滑。Esc 或 Done 收起卡、去掉高亮，编辑器停在最后那个文件。站的来源是 Changes 的 turn 改动（没有时用对话自己的 last-turn 列表，同一份）：新建文件一站（结尾的空行不算一行），改过的文件每块改动一站，按 Changes 的顺序；超过 8 站时改动块最多的文件先合成一站（「3 changes」），再超就只走前 8 个文件，删掉的文件和剩下的写「and N more in Changes」。每站一句话：新文件取它开头的注释，改过的文件取 Agent 改它之前紧挨着写的那句（中间隔了别的调用就不算；一句只给一个块的文件，句数和块数一样时一块一句）；剩下的站在第一次点开时整轮只问一次会话自己的引擎和模型（`dispatch write walk`，无工具、不进原对话、不留会话），没有答案就只写「Changed lines X–Y.」，这时字用 `--text-2`。Ask about this：支持旁聊的引擎开旁聊下格、引用片是那几行（「app.ts · lines 3-4」），不支持的（OpenCode）把那几行作为引用片放进原对话输入框；两种都先收起站卡。原型里卡上的 Why / More 两段和站点小圆点没做：Why 要再问模型，圆点和符号表「进度用格子」冲突，改成「Stop 1 of 4」字。 看得懂和能追问（用户 2026-11-15，task-39x97，稿 design/learn-scene 第 1、4、5 帧；用户原话「这个软件也是一个让人类去学习的地方」「终端生成的文件我从来不看，黑箱子让人不安心」）：一、Now 里一句为什么：Now 头 Agent 那句话下面 6 处多一行 13px `--text-2` 行高 1.5、最多三行，说这一轮在做什么、为什么；只用 Agent 自己说的：它这一轮用 `dispatch now` 写的那句（头里大字正在显示别的时，比如等你时的问题），否则它这一轮开头、动手之前写的那几句（第一次调用工具之前的话，跳过「Sure」「OK」这类应答和只引出列表的「Here's the plan:」，最多两句、220 字以内，Markdown 去掉）；和大字说的是一回事、或者这一轮没调用工具（只是回答）就不显示，不为这一句调模型；在跑、等你、停下、做完都显示，Quiet / Talk 都显示（这是看得懂，不是主动打扰）；终端会话不显示。原型那行前面的「Why:」字头没做：Agent 开头那句通常是「我要做 X，因为 Y」，前面再写 Why 读着别扭。这一行不带自己的悬停提示（里面的术语有）。二、术语悬停：回复正文和 Now 头里常见开发词（worktree、commit、branch、diff、merge、dependency、package、build、test、API、terminal 等 29 个，词表在 `workbench/contrib/chat/common/dispatchTerms.ts`，每个配一句给不写代码的人看的英文人话），一条回复里每个词只标第一次（跨这条回复的几段字都算），大小写都认、复数和过去式认，缩写（API、CLI、PR、JSON）只认大写；路径、文件名、带连字符的名字（pre-commit、build.ts、src/build）、代码、链接、标题里不标。样子：字色字重不变，下面 1px 点线 `descriptionForeground` 70%、离字 3，悬停时点线 100%，指针 help；悬停按 VS Code 的悬停延迟出 VS Code 自己的悬停框（带小尖），一段「**Commit** · 一句人话」在空格处换行、内容最宽 320（框约 336）、行高 1.5，底下状态栏一个「Ask more」；键盘 Tab 走到词上就出同一个框（焦点留在词上，1px `focusBorder` 框），Enter 或空格把焦点放进框里，Tab 到 Ask more。Ask more 在旁聊下格里接着问，引用片第一行是这个词、第二行「Term」；不支持旁聊的引擎（OpenCode）把这个词作为引用片放进原对话输入框。Settings › Learning 加一行「Explain terms」单色开关，默认开；关掉时屏上的点线马上没了、悬停不出、词不再是 Tab 站。只在 Agents 窗口，编辑器窗口的对话不标。原型的「Words you know」学会了就不标，这次没做。三、Changes 上原来每块改动的 Why / More 已去掉（用户 2026-11-16 定「右栏 Changes 就照 VS Code 原样」）：问某块为什么这么改，在 diff 里选中那几行用 Ask Question。
- 右栏 Changes 照 VS Code 原样（用户 2026-11-16 定，task-rinkm；用户原话「旁聊已经做得好，右栏 Changes 就照 VS Code 原样」；取代 10-01 起加的署名、10-06 起加的按轮胶囊、11-15 加的 Why / More）：范围下拉（Branch、Uncommitted、Session、Last Turn 等）、文件头、多文件 diff、右侧文件列表、行号旁 + 留评论、Run Code Review 都是 VS Code 1.139.1 自己的样子，不另加按轮筛选、不另做「最近一轮」视图。不标谁写的行：文件列表行尾没有小人，diff 顶上没有「Lines without a mark were written by …」那行灰字，行号旁没有 You 标记（A / M / D 字母照原版显示）。Dispatch 只留四样：提交、推送、合并出错时的白话卡和「Let the agent fix it」；没有改动时只显示列表（不出两个 Changes）；diff 里选中文字后 VS Code 批注框前面的 Quote、Ask Question；右栏下半格的旁聊。谁写的行只在对话里说：回复下面的「You changed N lines in …」一行（点它在 Changes 原版下拉里多一项只看你改的那几行）和提交卡。
- 右栏标签（方向 B「Open list in Docs」，2026-10-21 选，task-fif4i）：固定页签（Now、Changes、Files、Docs、Tasks）之后一道 20px 短竖线，再后面只有两个文档标签：正在看的和刚才看的那篇，开多少篇都一样。文档标签的图标说它是什么（交付页 delivery 块、设计稿并排两块、原型块里一个指针、交接 pass-on、笔记线框文件、网页用去色的站点图标），名字是标题冒号前那一截，原型后面跟它的字母。Docs 页签名字后带灰色计数（打开几篇，11px，数字上滚），不带关闭键。挤的时候固定页签先只留图标，再缩短文档名，最后文档名和 Docs 的名字才让，Docs 的数字一直在。Docs 列表顶上常驻搜索框（同时搜打开的和全部的，⌘K），下面第一组 Open：淡底一块，按项目分（这个项目在前标「This project」，网页最后），每行种类图标、完整标题、时间，悬停时时间换成关闭键，组头悬停出 Close，整组 Close all；原型和笔记缩进挂在它的页面下面；搜索时计数跟着变，Open 有命中而下面没有时只留一行灰字。
- 左栏 Waiting for you（2026-11-11 方案 A「Sidebar and Now」，task-0v1o9；design/home-now/notes.md A4）：整个窗口只有两处说状态，左栏说整台 Mac，右栏 Now 说当前会话；Assistant 一行、它的对话和它的 Now、顶上 Chat 和 Timeline 两个标签都删了（入门三张建议卡挪到 Chats 的新对话页，Timeline 成了中间的一页，Turbo 开关挪到新对话页）。入口是 36 高的 ghost 行：16px 细线铃铛 `--text-2`，行尾数字 11px `--text-2` 等宽数字，只数 7 天内动过的，没有就不显示数字，入口不上琥珀色。入口下面直接挂最近 3 件，新的在前：32 高单行，14 的状态槽里是说这件事是什么的 14px 细线图标，单色 `--text-2`：一页等你挑的方案是方案字形、一个问题 codicon `question`、一次批准 codicon `shield`、只有你能做的事 codicon `person`，读屏念「Proposal」「Question」「Approval」「Only you」。图标说这件事是什么，「要你做什么」那一列说要你做什么，两样分开算（dispatchWaitingGroups.ts 的 waitingThing 和 waitingAskWord）：只有真有方案页时才用方案字形，引擎用问题工具问的带选项的问题是问题图标，那一列仍写 Pick；回话（Reply）也是问题图标（用户 2026-11-12，task-he465）。同一件事在悬停卡（项目行的卡、Projects 页那一行的卡）里也是这一枚，图标只在 dispatchWaitingModel.ts 的 waitingIcon 一处取。这一组状态都是等你，行首不再放琥珀点（用户 2026-11-12，task-he465，见「符号表」）。标题 13/400，行尾多久 11px `--text-2` 70%；图标和标题与项目下会话行的状态槽和标题对齐。超过 3 件一行「Show N more」12/600 `--text-2` 70% 就地展开，展开后这一行是「Show less」，点了收回（2026-11-12，task-cq11p）；7 天没动的一行「N older」12/400 `--text-2` 70%，点了在中间打开 Waiting for you 页并展开 Older。点一行做页面里同样的事，悬停出这件事的卡（问的话、Allow / Deny、选项、Mark read、Done）。等你的行和它的会话行联动悬停，底色 `--sel` 60%。这一组最后一行下面空 8，再下面是 Automations。左栏不挂 Timeline 入口，命令面板里也没有「Show Timeline」（用户 2026-11-15，task-ccmyi：11-11 加的入口没设计过，页面像半成品，数据也旧；等照用户 10-01 喜欢的泳道原图 design/from-m1/frenzy 重做后再放回。页面代码 dispatchTurbo/browser/dispatchTimeline.ts 留着，Turbo 跑起来时会话列表里那一行仍打开它）。7 天这条线在 dispatchWaitingGroups.ts 一处算（WAITING_FRESH_DAYS），「没动」按这件事最后一次有变化的时间。Waiting for you 页：页头一行 28 高，跟着页面滚动吸在顶上：没选东西时是一行灰字说怎么排，有没读的回话时行尾一个很轻的 ghost xs「Mark all read」（12px `--text-2`，字的右缘和「多久」那一列对齐），没有没读的就不出现；选了几行时这一行换成「N selected」12/500 `--text`，行尾 outline xs「Done」和 ghost xs「Clear」（用户 2026-11-15，task-ccmyi：11-11 去掉 Assistant 时没问就删了多选、批量完成和全部已读，放回来）。能选的只有 Done 能清掉的：只有你能做的事（Done 在任务板上关掉它）和没读的回话（Done 标成已读）；批准和问题要回答，不能选。选法：点行首那一格（点的范围伸到行的左缘和到标题的空隙），⌘ 点一行，⇧ 点选一段；键盘 x 选当前行，⇧j ⇧k 边走边选，选了以后 ⏎ 是 Done，Esc 清掉；平常单击一行照旧打开。行首那一格悬停或有选中时，能选的行的图标换成符号表里的圆（dispatchMarks.ts）：没选是大空心圈 `circle-large` `--text-2`，选了是实心圆勾 `pass-filled` `--text-2`，选中的行底色 `--sel`；选中时和指针在行首那一格的点击范围里时，不弹这一行的悬停卡（卡会盖住 ⇧ 点要点的行）；鼠标点过的行不出焦点框，键盘走到哪一行仍是 `.focus` 的底色。Done 之后它们照常淡出折起，底栏出「Done: N items」带 Undo（关掉的任务重开、标了已读的再标回没读）。再往下是「This week」（新的在前）和默认收着的「Older」（12/600 `--text-2` 70% 的折叠头，箭头 200ms 转 90 度，里面先露 6 行，其余「Show N more」）；行 32 高，行首和左栏同一枚 14px 细线图标（用户 2026-11-12，task-he465），标题 13/400，再三列对齐：项目 12px `--text-2` 宽 112，要你做什么 12/500 `--text-2` 宽 64（Pick / Only you / Approve / Reply，不用胶囊），多久 11px 宽 38 右对齐；Older 里的标题是 `--text-2`、行首图标 `--text-2` 45%（用户 2026-11-12，task-he465；原来是 7px 空心圈）。
- 左侧图标栏 `.rail`（rail.css，6.5）：56 宽、顶部留 40、无右边线，按钮 32 圆角 `radius-row` 6、图标 16，底 `--bg-2` 80% + `blur(24px)`，选中 `--sel` 底 + 图标描边 2，悬停显示页名；徽标改成 8px 圆点 + ping；底部固定设置和状态按钮（旧版保留）。
- Detail `.ld-detail`（6.5 保留）：380 宽，`.dmeta` 88px 键列 12px `--text-2` + 值 13px，28 行；块之间 `.dsep` 细线 16；macOS 下作为独立卡片（`radius-card` 8 圆角 + 阴影）。
- 页头 `.hd`（6.5、6.7）：40 高、透明、整条可拖；页名 13/500 `--text-2`，标题信息下沉到内容区首行；最多三样（返回、标题 + 项目 chip、主按钮），之间 12。
- Toast `.bar-toast`（旧版保留）：错误走底栏 Toast，页面里不放红框。
- 底栏方块（用户 2026-10-01 选 design/bars 方向 B）：一块 22 高、圆角 8、左右 8，hover `--sel`，要你看的那块填 `--chip` 底加 500 字重，不上颜色；线框块是 16 见方、圆角 4.5，里面 11px 图标，开着时填实。
  - 额度电量：十格（窗口窄于 900 时五格），一格 5 宽 12 高、间距 2、圆角 1.6，线框 `--text-2` 45%，剩多少亮多少（`--text-2` 填色，最后一格按比例从下往上填）；只剩两成以下填色换 `--text`、整块填底，旁边写「17% left · 01:00」，窄窗口只写「17%」；前面是引擎图标，悬停写每个额度剩多少和几点重置，点开账号面板。
  - 构建方块：12 见方、圆角 3.5、间距 3；正在构建的那块从下往上填（按最近十次的中位用时），跑检查时填满并呼吸，做完打勾小弹一下停十秒，排队的每个一个空块，超过六个（窄窗口三个）写「+N」；构建失败单独一块实心带「!」加「Build failed」，打开构建面板看过就收起。
  - 杯子：防休眠开着才出现，有 Agent 在干活时冒热气（两缕，2.4s 交替），点开说为什么醒着、链到设置。
  - 新用户头一周：每块后面带一个词（Settings、Builds、Awake、Claude、Codex），12/400 `--text-2`，窄窗口不带。
- 弹层 `.pop`（6.5）：普通 popover `radius-card` 8、`--glass` 82% + `blur(12px)`、内边距 16、`shadow-lg` + 1px 白 10% 内描边（浅色黑 5%）；菜单 `radius-card` 8 圆角、菜单行 `radius-row` 6、内边距 4、`shadow-md`、`--hair` 描边；Agent / 模型选择弹层一栏 480 宽、`radius-card` 8 圆角、`--shadow-diffuse`，搜索 36 高，分组头 28 高，行 12/500 + 11 副标（6.5、第 9 节）。
  - 位置不跳（用户 2026-09-29 批）：弹层打开时按可用视口确定位置和高度；展开分组、加载或搜索不重新定位、不改变外框高度，内容在内部滚动，触发项保留在原位置；只有视口尺寸变化时重新约束边界。
- 对话框 `.dialog`（6.5）：`radius-dialog` 12、内边距 24、`shadow-lg`、`--hair` 描边、最宽 512，遮罩黑 50%。
- Tooltip（6.5）：反色（`--text` 底、`--bg` 字）、12px、圆角 `radius-button` 4、内边距 12 / 6。
- 消息（6.5，用户 2026-09-26 补三条）：用户消息靠右，气泡只包住内容（发「hi」就是右边一个小气泡，像 Codex），最宽 80% 列宽，多行时气泡撑到最宽、里面的文字左对齐；底色要淡，不能是实心深块：深色下 `--text` 6% 透明或只描 1px `--ring`，浅色下 `--chip`，`radius-bubble` 6 圆角、内边距 16 / 12、14px。助手无气泡，`--text` 14px 行高 1.7；操作条 hover 才出现。消息之间 40，不画线。滚过自己发的那句话以后，对话顶上只钉一行：12px `--text-2` 单行截断，行尾一个细「↑」，`--bg` 88% 半透明底加 8px 模糊，下沿 1px `--hair`，28 高，和对话列同宽，点它平滑滚回那句话；那句话还有一部分在屏上时什么都不钉，一轮问了几句时钉当前这一段对应的那句；对话上面不再放一行会话标题（标题栏已经写着）（用户 2026-11-15，task-wdjpl，稿 design/sticky-ask 方案 B）。这一行出现、消失、换成另一句时都 150ms 淡入淡出，只动透明度不动布局，滚动时不掉帧；减少动态效果时直接出现、消失（用户 2026-11-15，task-vk9nq，「钉住那一行出现要丝滑」）。
- 发出即上屏：点发送的同时用户消息就进消息流（乐观显示），输入框立刻清空，Agent 还没起来时消息下面出一行状态「正在启动 Agent」走 shimmer，起来后换成「在想」；发送失败就在那条消息下标红字加重发。发送键不能停在「发送中…」，输入框里也不能留着文字等。IDE 聊天面板和主应用一样。
- 工具行（6.5）：28 高 12px，`[14 图标][动词 500 --text-2][参数 等宽 60%] … [路径 11 等宽 40%][状态 14]`，hover `--chip` 30%，圆角 `radius-row` 6；同类连续的折成一组。
- 命令块 `.callbody`（6.5）：`--term-bg` 黑底、`radius-card` 8、12px 等宽，`$` 提示符行 + 输出。
- 权限卡（6.5）：`radius-card` 8 圆角、`--bg-2` 底、`--hair` 描边、内边距 16；标题 14/500，命令 chip `--chip` 底等宽；Deny / Allow Once 是 outline 按钮 32 高，第三个实心。
- 卡片（6.5）：`radius-card` 8、`--bg-2` 底、`--hair` 50% 描边、内边距 20，hover `--chip` 40%，`:active` 下沉 1px。
- 偏好（2026-09-28，稿 design/knowledge/redesign/ 方向 B）：
  - Like / Avoid 图标：单色线框，竖拇指是 Like，圆里一道斜线是 Avoid，16px `--text-2`，不上色；行首放它，第二行写挂在哪。
  - 会话里的一行（Remembered）：回复下面一行 12px `--text-2`，书签图标加「Remembered: 一句话」（一句话 `--text` 500）加 Edit · Forget；一次记多条写条数和前三条短名，Show 就地展开成行（图标、一句话、第二行「Like · Design · 范围」加缩略图芯片）。
  - 底部提示（Preference remembered）：反色（`--text` 底、`--bg` 字）、圆角 `radius-row` 6、高 38，放在输入框上方、对话列正中，出现时对话底部让出它的高度不压内容；200ms 从下 8px 上来，8 秒收起，鼠标停在上面不收，多条合成一个；右边 Edit、Undo 两个文字按钮。
  - 证据卡：`radius-card` 8 圆角、1px `--hair`，上面缩略图（真图，196 高，顶端对齐裁切）、下面标题 13/500、一行「哪一块 · 什么时候」和文件名 13 + 目录 12，末行「Opens in the right panel」；点了在右栏浏览器页签打开，和任务交付物同一条路。

- 交付页（用户 2026-09-29 批）：按自身可用宽度布局；约 1000px 起图文左右排、改前改后并排，竖长图配旁文，图库两到三列；窄栏（右栏）全部上下排、图片满宽；正文最大 1600px，段落单独限制行宽；标签加图的列表同样识别为成对图。

## 多台机器（用户 2026-09-29 批）

- 一台机器一个窗口，窗口内只显示这台的 Sessions、Waiting for you、Projects、Tasks 和终端；机器由窗口决定，不在输入框、新建 Agent 页或普通列表行重复标识。
- 例外（2026-10-01，task-qb6j「新建会话时选在哪台电脑上跑」，以这条为准）：新建会话页第一个胶囊是 Run on，默认 This Mac（显示器图标 + 文字，和文件夹、Agent 胶囊同一种），菜单里是 This Mac、其他 Mac（在线与否写在右边）和 Add another Mac...；在这扇窗口里起在别的 Mac 上的会话，会话行末尾带机器标签，按它的文件夹分组。
- 机器名只从 hosts.json 的 name 读取。
- 两台以上时标题栏右侧机器按钮和左栏 Sessions 后面常显机器名：本机灰字，远程窗口填底（用上面的机器标签）；编辑器模式左下的远程标同样写。
- 另一台有事等你，只在左栏 Waiting for you 下面显示一行提示，全窗口只此一处。
- 机器在线是绿色实心大圆，离线是大空心圈 `--text-2`，不用红；有事等你用琥珀实心大圆，和会话一样（机器面板和 Machines 页，14px，照符号表，task-o01fh；标题栏机器按钮角上的小点没改）。
- 图标：显示器图标表示一台机器；↗ 表示在另一扇窗口里打开。

## 动效

图标掉落（2026-10-10 定，照样稿方案三「落块」的代码参数，`base/common/dispatchIcon.ts` 的 DISPATCH_ICON_DROP，`ide/tests/palette.test.mjs` 逐帧对照样稿）：底行先落、再中行、最后顶行（8、9、4、5、6、7、0、1、2、3），每块间隔 220ms，从舞台顶上 40px 处（样稿 22px 方块的尺度，按实际方块宽度缩放）受恒定重力 0.0018px/ms² 下落，落地速度大于 0.12px/ms 就以 0.28 倍反弹（每块弹两下）再停住；有底板时方块从底板上沿露出，空槽是 8% 白，落定的那块盖住空槽；最后一块落定后绿点 220ms 弹出。用在：新会话右栏空白页的 logo（每个位置开窗口后第一次出现时整套落一遍）、启动画面、空编辑器、会话行在跑时（左栏会话行、标题栏会话名旁、右栏 Now 头，同一个落块）就是方案三本身：十块 220ms 一块落满（约 2.5 秒落定），满图停 1 秒，清空再来一轮，一轮约 3.5 秒，同一个窗口里的几个小图标走同一个钟、同一刻落到同一块；起落高度也照样稿按方块大小等比缩放（16px 小图标的方块 3px，从顶行上方约 14px、即图标上沿再往上约 10px 处起落，图标的 svg 不裁，由会话行、标题栏自己的上沿裁掉，Now 头的状态行裁在图标上沿往上 5px，约是样稿舞台上沿的位置），不加速，所以看得出越落越快、落地弹两下（第二下只有零点几像素）；形状和间距照 logo（用户 2026-11-15，task-dw425：「对就是这一版」，取代 10-21 的「从图标上沿落、快 1.8 倍、每 1.5 秒一块」）、Turbo 进度新合进一块时。减少动效时直接是成形的图标，不落。

图标方块动效（2026-09-27 定，task-cvf8，样稿 design/icon-motion/index.html）：Agents 窗口新建页空着时，图标的十个方块灰色慢漂；发出第一句时飞回拼成图标；等待回复期间每完成一次工具调用就有一块从上落下、小弹、变回原色，十块用完循环，回复完成右下绿点脉动；多个 Agent 在跑且没选中会话时用群游：方块数等于在跑数，绿在跑、橙等确认，hover 显示会话名，点了跳过去。方块不旋转、不变形。减少动效模式下只显示静止图标。


**硬规则：凡是用户要等的地方都必须有动效。** 用户原话：「动效可以减少等待的感觉」。点开会话读记录、Agent 在想、工具在跑、命令在跑、发送后等第一个字、切换页面加载、安装或更新，这些时刻屏幕上都要有东西在动，不能是一块静止的空白或一行不变的字。

「全部用 CSS」的意思是**不引动画库**（不引 `motion` / framer-motion），用 `@starting-style`、`transition`、`@keyframes`、`grid-template-rows`、`linear()` 自己写；不是没有动效（第 0 节第 6 条，第 8 节「要不要引 motion」）。`linear()` 要 Safari 17.2+，`@starting-style` 要 Safari 17.5+，更老的系统退化为直接出现，不报错（第 7 节）。

### 原则（第 7 节）

- 过渡类动效 ≤ 200ms（长内容折叠 280ms、勾 350ms 例外），只动 opacity、transform、clip 或 grid 行高，不动 layout；只有折叠 / 展开动高度。
- 一个页面同时最多一个过渡在跑。等待指示是循环的，不受此限，但同一个等待只用一种指示。
- 曲线只用三条：`--ease-out: cubic-bezier(0, 0, 0.2, 1)`、`--ease-std: cubic-bezier(0.32, 0.72, 0, 1)`、`--ease-spring: linear(0, 0.26, 0.6, 0.86, 1.02, 1.08, 1.07, 1.03, 1, 0.99, 1)`。
- 不做镜头式动效：窗口升起、推近、3D 倾斜、粒子、光带故障字、星空全部不做（第 7 节末、第 9 节）。不跳不闪（6.6 用户偏好）。
- `prefers-reduced-motion: reduce` 时全部 0ms，循环动画停在静止态，文字状态照常显示（第 7 节）。

### 等待时用什么

| 等什么 | 用什么 | 时长和曲线 | 来源 |
|---|---|---|---|
| 点开会话读记录 | 骨架行：消息区按真实布局画 3 到 5 条灰块（气泡、正文行、28 高工具行），块上走 shimmer 亮带；记录到了淡入替换 | shimmer 2s linear 循环；替换 opacity 120ms ease-out。等待不到 120ms 不出骨架，免得一闪 | shimmer 参数取第 7 节「流式状态行」；120ms 取第 7 节「页面切换」；骨架行高取 5A.4；120ms 门槛本文定 |
| Agent 在想 | 消息流末尾一行状态「思考了 N 秒」，文字上走 shimmer 亮带，秒数跟着跳 | 2s 循环 linear，亮带从右扫到左，带宽 = 字数 × 2px | 第 7 节「流式状态行」、第 8 节第 3 步 |
| 工具在跑 | 工具行右侧状态槽旋转；工具摘要文字 shimmer；完成时转圈淡出、勾弹出 | 转圈 1s 一圈 linear；摘要 shimmer 1.5s；转圈 150ms 淡出，勾 350ms `--ease-spring`，scale .5→1，约 8% 过冲 | 第 7 节「工具状态 转圈 → 勾」「流式状态行」；1s 一圈本文定，取在跑圆点同一周期 |
| 命令在跑 | 命令块头部「正在跑 npm test」shimmer + 计时，输出逐行追加；列表和图标栏上对应会话显示在跑圆点 ping | shimmer 1.5s linear；ping 1s 循环 `cubic-bezier(0,0,0.2,1)`，外圈 scale 1→2、opacity .75→0 | 第 7 节「流式状态行」「在跑圆点」 |
| 发送后等第一个字 | 发送后立刻在消息流末尾出现状态行 shimmer + 计时；第一个 token 到了状态行让位，正文逐字流出（逐 token 追加，追加本身就是动效，不另加逐字淡入，不加流式光标） | shimmer 2s linear；正文 0ms 追加，滚动 stick-to-bottom | 第 7 节「流式正文」「流式状态行」、第 8 节第 3 步 |
| 切换页面加载 | 新页面淡入；数据没到的区域画骨架行（同「点开会话」） | opacity 0→1 120ms ease-out，不位移；骨架同上 | 第 7 节「页面切换」 |
| 安装或更新 | 进度条：知道进度时按百分比走，不知道时一段亮带来回扫；旁边一行字说在做哪一步 | 宽度变化 200ms ease-out；不定进度亮带 1.5s linear 循环；条高 4、圆角 2、`--fill` 在 `--chip` 上 | 200ms 取第 7 节「左右栏」同一档，1.5s 取工具摘要 shimmer；条的尺寸本文定 |

### 过渡（第 7 节）

| 动作 | 时长 | 曲线 | 变化 |
|---|---|---|---|
| 页面切换（Agent ↔ IDE、视图切换） | 120ms | ease-out | 只 opacity 0→1，不位移 |
| 侧栏分组收起 / 展开 | 200ms | ease-out | `grid-template-rows` 0fr ↔ 1fr，opacity 0 ↔ 1 |
| 左右栏整栏显示 / 隐藏 | 200ms | ease-out | width 0 ↔ 定值 + opacity |
| 列表行进入（新会话、新任务） | 120ms | ease-out | opacity 0→1，translateY 4px→0；首屏 ≤12 行可每行错开 30ms |
| 列表行离开 | 150ms | ease-out | 高度 → 0 + opacity → 0，`transition-behavior:allow-discrete` |
| 消息出现 | 0，直接出现 + 自动滚到底 | | 关掉 `scroll-behavior:smooth`，用 stick-to-bottom |
| Popover（模型、Agent、项目、主机选择） | 开 100ms / 关 100ms | ease | opacity 0→1，scale .95→1，从触发器方向位移 8px，`transform-origin` 在触发器 |
| 菜单（右键、更多） | 150ms | ease | 同 Popover |
| 对话框 | 200ms | ease | 遮罩 opacity；内容 opacity + scale .95→1，不位移 |
| Tooltip | 150ms，hover 延迟 500ms | ease | opacity + scale .95 + 8px |
| Toast | 200ms | ease | opacity + 从下 8px 上来，多条错开 50ms |
| 按钮按下 | 150ms | ease | `translateY(1px)`；hover 只变底色 |
| 行 / 卡片 hover | 150ms | ease | 只底色 |
| hover 才出现的操作条 | 200ms | ease | opacity 0→1 |
| caret / 折叠箭头 | 200ms | ease | rotate 180 / 90 |
| 长内容折叠 / 展开 | 280ms | `--ease-std` | grid 行高 |
| 模式切换分段控件滑块 | 150ms | `--ease-std` | translateX |
| 搜索命中闪一下 | 2s 一次 | ease-in-out | 底色 `--fill` 40% → 20% → 透明 |
| 新建 Agent 页首次挂载（可选） | 300ms | ease-out | chip 行、输入框、框下一行 opacity 0→1，translateY 4px，每块错开 60ms |

## 用户偏好

从 2026-09-28 起在 Preferences 里：`dispatch prefs list --area design --json`（每条带原话、挂在哪次交付的哪一块、证据截图；Knowledge › Preferences 能看）。动界面前读全部 Design 类，和这页有关的证据打开看。`design/taste/我的设计偏好.md`（2026-09-26 从全部 Claude Code 和 Codex 会话整理，带原话、日期和 15 张截图）是迁进 Preferences 的调研原文；这里只是摘要。


要：先分类，一个东西只放一处，同一种东西全软件长一个样，颜色只代表状态，地方留给内容；列表先分组、组能收起；每条带看得懂的一句总结；字用大白话；壳层透、内容实；用户要等的地方都有动效（旧版保留，6.6 补两条，最后一条是用户原话「动效可以减少等待的感觉」）。

不要：同一功能多个入口；层层套框、粗边、白底胶囊；全屏弹层挡内容；跳、闪、卡、截断、重叠；大段纯文字、原样 Markdown；把内部记账和编号摆出来；只换配色当改版；顺手改没点名的地方；弹层和消息飞进来，100 到 200ms 的 fade + 轻缩放就够（旧版保留，6.6 补一条）。

## 参照

新建会话页和三栏布局的目标样子（用户 2026-09-27「做成这样就好了」）：`design/douyin-inspiration/refs/github-copilot-new-session.png`。照它做：左栏顶部「Sessions」标题加右侧「New ⌘N」键帽按钮、筛选和搜索图标，下面两行入口（我们对应：自动化、会话），列表区，底部分组「Customizations」（我们对应：技能、插件、MCP、规则、Agent、钩子、工具，各带计数，task-9lef 做）；中间新建页没有问候语，输入框整体垂直居中偏上，输入框上方一排 chip（文件夹、Agent），框内左下加号、Agent、模型，右下圆形上箭头发送键，框下一行灰字左边是模式（交互、手动确认）右边是「新工作树 · 分支」；右栏 Changes / Files 页签。颜色用我们的 token。

第三参照：GitHub Copilot 桌面端（截图 `design/douyin-inspiration/refs/github-copilot-app.png`，用户 2026-09-26「这个界面真漂亮」）。值得借的：三栏（左会话列表加底部「Customizations」分组：Plugins、MCP、Skills、Instructions、Agents、Hooks、Tools 各带计数；中间对话；右栏 Changes / Files 两个页签，文件树带 git 状态色和改动圆点，右上加号）；输入框上方一排 chip（文件夹、Agent）和下方一行灰字模式（Interactive、Manual permissions），右下「New Worktree · main」；整体深色、无分隔线、行高紧、留白足；对话框居中最宽 500、圆角 12、按钮全宽一列。

第二参照：ZCode（智谱的桌面端，本机装着，截图 `design/douyin-inspiration/refs/zcode-chat.png`，用户 2026-09-26 认可「挺符合我们的审美」）。和 CodePilot 同一路数，值得借的：边栏按项目分组、32 高单行、时间右对齐灰字、无分隔线；顶部固定入口（新建、搜索）是图标加文字的行；「已工作 22 秒 ›」可展开的工作摘要行；输入框底部一排：加号、权限 chip（有含义的橙色）、模型、推理强度、右侧圆形发送键；用户消息是右侧小气泡、淡底。

- 主参照：CodePilot（op7418/CodePilot），方向稿和素材在 `design/douyin-inspiration/`，只参考视觉数值（间距、字号、圆角这类）。许可是 BSL 1.1，不复制任何组件、CSS 或 Tailwind 类串（方向稿开头许可说明、第 9 节）。
- 次参照：Cursor 的 Agents 窗口（6.1）；VS Code 默认值只用于密度对照（5A.4）。
- 不照抄：镜头动效、10px 文字、大写加字距小标题、Geist 字体文件、多 runtime 两栏弹层的规模、Electron 特有做法（第 9 节）。
- 作废：Raycast 真机量尺 `design/raycast-redesign/spec.md` 作废，只留作「字体」一节系统字体栈、中文下限和字重规则的依据（6.1）。
- 其他依据：Apple HIG Typography / Accessibility；W3C clreq；Radix Colors。链接见 `design/aesthetic/README.md` 2.10。

## 交互与动效

- 联动悬停（用户 2026-09-28 定，通则）：同一件东西在几处出现（列表行、图上的点、悬停卡里的行、页面上的卡、右列的一句现状），悬停其中一处，其他几处一起进入焦点态（现有的焦点样式，不上色），详情出在离鼠标最近的空位（图的空白段、卡的旁边），移开即恢复；点了才进详情页。适用：左栏悬停卡 ↔ Waiting 页的卡；Task graph 的点 ↔ 悬停卡的行 ↔ 右列现状；Projects Timeline 的点 ↔ 右侧 Last；Tasks 卡 ↔ 交付物 ↔ Docs 那篇；左栏项目行 ↔ 项目页 Now；Waiting 的会话卡 ↔ 左栏那条会话。

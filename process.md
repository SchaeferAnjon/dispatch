# Process log

---

## 2026-09-02 · 全局任务板 — 用 Beads 搭"任务集中营"，所有 Agent + 用户共用一块板

### What I did
- 调研现成方案（GitHub 搜索）：Beads 26.8k★、Backlog.md 6.6k★、Paperclip 79.9k★、Vibe Kanban、Task Master。选 Beads：多 Agent 原子认领（`bd update --claim`）、各 Agent 集成一条命令、Dolt 数据库可跨机器同步。
- `brew install beads`（bd 1.2.2）。
- 建**跨项目全局板** `~/tasks/.beads`：`BEADS_DIR=~/tasks/.beads bd init --quiet --stealth --non-interactive --skip-agents -p task`（嵌入式 Dolt，无 git，任务 ID 形如 `task-a1c`）。
- `BEADS_DIR` 落到三处，保证任何目录下、任何 Agent 运行 `bd` 都命中全局板：
  - `~/dotfiles/fish/config.fish`（终端里的 Claude Code / Codex / 手敲）
  - `~/.claude/settings.json` 的 `env`（Claude Code 的 hooks 和 Bash 工具）
  - `launchctl setenv`（从 Dock 启动的 GUI 应用，如 Cursor；重启后失效，需要时再加 LaunchAgent）
- Agent 集成：
  - Claude Code：`bd setup claude --global` → `~/.claude/settings.json` 加 SessionStart 钩子 `bd prime --hook-json`（每次会话开始/压缩后注入 ~1-2k token 的工作流上下文）。
  - Codex：`bd setup codex --global` → `~/.agents/skills/beads/SKILL.md` + `~/.codex/hooks.json` + `~/.codex/AGENTS.md` 段落 + `config.toml` 里 `[features] hooks = true`。
  - Cursor：本机没装。规则文本已生成到 `~/tasks/cursor-user-rules.md`，装了之后粘到 Cursor Settings → Rules for AI。
  - 自写 skill `task-board` 放技能池 `~/.cc-switch/skills/task-board/SKILL.md`，软链挂到 `~/.claude/skills/`。内容：状态映射、认领流程、"谁在干什么"、规则、UI 入口。
- 状态约定：to do=`open`；进行中=`in_progress`（claim）；finished=`closed`；reviewed=`closed`+label `reviewed`。
- 可视化前端：不自己写，用社区的 beads-ui（720★，`npx beads-ui start`）。端口 3110，守护进程；fish 函数 `bdui` / `bdui stop`。Playwright 截图验证 Issues 表格和 Board 看板都正确显示全局板数据，状态/类型/优先级可内联编辑，实时刷新。
- `git config --global beads.role maintainer` 消掉每条命令的警告。
- 冒烟测试：从 `/` 目录 create → ready → claim → close 全通。留了两条示例任务（task-9lo 进行中、task-ss0 待办：配 Mac mini 同步）。

### Bugs / surprises
- `bd setup claude --global` 除了改全局 settings，还在**当前目录**（本项目）生成了一个 `CLAUDE.md`，已删除；内容并到 skill 里。
- `bd setup` 会重写 `~/.claude/settings.json`（键按字母排序、去空行），内容无丢失；备份在 scratchpad。`~/.codex/config.toml` 同样被重排。
- `bd update --claim --json` 返回的是**数组**不是对象，解析时注意。
- 嵌入式 Dolt 是单写者文件锁；多 Agent 并发偶发 `database is locked` 只需重试，频繁再迁 server 模式（`bd backup` → `bd init --server`）。
- `bd --global` 标志是"共享 Dolt server"模式，不是"全局目录"的意思，没用它。
- fish 里 `echo "=====X====="` 会被当命令执行，脚本分隔符要加引号。
- beads-ui 的 favicon 404 是唯一 console 报错，无害。

### Files touched
- `~/tasks/.beads/` — 全局板数据库（新建）
- `~/dotfiles/fish/config.fish` — 追加 `BEADS_DIR` 和 `bdui` 函数
- `~/.claude/settings.json` — `env.BEADS_DIR`、SessionStart 钩子 `bd prime --hook-json`
- `~/.codex/config.toml`、`~/.codex/hooks.json`、`~/.codex/AGENTS.md`、`~/.agents/skills/beads/SKILL.md` — bd setup codex 生成
- `~/.cc-switch/skills/task-board/SKILL.md` + `~/.claude/skills/task-board` 软链 — 自写 skill
- `~/tasks/cursor-user-rules.md` — Cursor 规则文本备用
- `~/.gitconfig` — `beads.role = maintainer`
- `Projects/kanban/process.md` — 本文件

---

## 2026-09-02 · 自研调度台 — 克隆 beads-ui 作参考，出方案 A 的 UI 稿

### What I did
- `git clone --depth 1 mantoni/beads-ui` → `~/Projects/beads-ui`。结构：`server/`（express + 调 `bd --json`，监听数据库变化推 SSE）、`app/`（lit-html 前端，views/ data/ utils/）、`bin/bdui.js`（守护进程 start/stop）。后面自研时可借"经 bd 读写 + 监听变化"的架构。
- 写高保真 UI 稿 `design/ui-mockup.html`，发布为 Artifact（favicon 🎛️，跨会话更新用 url 参数）。
  - 设计：Notion 纸面质感 + 实时 Agent 轨。三栏：侧栏（工作区、视图、项目、Agent 在线）/ 主区（看板 4 列 = 用户四状态：待办 / 进行中 / 已完成·待审 / 已审核；阻塞用红左边条；表格视图；Agents 视图带 bd 命令日志）/ 右栏 Notion 式任务详情（属性表、描述、验收清单、活动流）。
  - 色：纸底 #F4F3EF、墨 #2B2925、调度蓝 #1D5FD1 只用于选中/主按钮/已审核；Agent 身份色 Claude #C9683F、Codex #2F6F73、Cursor #6E56CF；状态色 进行中 #C28A12、已完成 #2E8B57、阻塞 #C43D3D。深色主题完整一套 token。
  - 字：IBM Plex Sans（界面）+ IBM Plex Mono（任务 ID、bd 命令），Google Fonts 外链。
  - 交互：三视图切换、点卡片开详情、浅/深/跟随系统切换。
  - 标注模式（按 CLAUDE.md §8 自己实现）：右下角"📍 标注"→ 点页面打编号钉 + 写意见 → 面板列出（可删/清空）→"复制全部标注"输出 `N. [视图 + 详情ID] near "片段": 意见`；localStorage 持久化；剪贴板失败降级 textarea。
- 应用名"Dispatch 调度台"是占位。

### Bugs / surprises
- Playwright MCP 禁 `file://`，用 python http.server 预览；默认不带 charset 导致中文全部乱码（Artifact 外壳自带 charset，线上无此问题）。要本地预览需自定义 handler 加 `charset=utf-8`。
- 首次预览在 1185px 视口下，toolbar 的 chip 被压成竖排、搜索框换行——补了 `white-space:nowrap` 和窄屏时详情栏 340px。
- 标注参考实现 `mcc/.../mcc-p9-electric-slides.artifact-src.html` 在本机没找到（find 无结果），从零写。

### Files touched
- `~/Projects/beads-ui/` — 克隆的参考项目
- `design/ui-mockup.html` — UI 稿源文件（Artifact 源）
- `process.md` — 本条

---

## 2026-09-02 · Dispatch v0.1 — Tauri 2 + React 桌面应用跑通，真实数据验证

### What I did
- 脚手架：`npm create tauri-app@latest app -- --template react-ts --manager npm --yes` → `~/Projects/kanban/app`。产品名 Dispatch，identifier `dev.schaefer.dispatch`。
- Rust 后端 `app/src-tauri/src/lib.rs`：14 个 `bd` 命令封装（list/show/comments/history/claim/set_status/close/reopen/comment/labels/update/create/info/run），`notify` 监听 `~/tasks/.beads` 递归变化，600ms 去抖后发 `beads-changed` 事件。GUI 从 Dock 启动没有 shell PATH，所以按候选路径探测 `bd`（/opt/homebrew/bin 等），并强制注入 PATH。JSON 前面可能有提示行，`json_only` 从第一个 `[`/`{` 截取。
- 前端 `app/src/`：`api.ts`（Tauri invoke，浏览器里降级为 `fixtures.ts` 示例数据）、`derive.ts`（列映射、项目标签 `project:*`、Agent 身份/在线推断、history 差分成活动流、验收标准 `- [ ]` 解析）、`components/`（Sidebar / Board 含 HTML5 拖拽换列 / TableView / AgentsView / Detail 内联编辑 / NewTask 对话框）。样式从 UI 稿移植。⌘K 搜索、⌘N 新建、⌘⏎ 发送。
- 身份：每个 Agent 一个 `BEADS_ACTOR`——Claude Code `claude-code`（settings.json env）、Codex `codex`（`~/.codex/config.toml` `[shell_environment_policy] set`）、人 `schaefer`（fish）。Dispatch 自己只认 `DISPATCH_ACTOR`（默认 schaefer），不吃 launchctl 的 BEADS_ACTOR，避免被误认成 Cursor。
- 窗口：macOS `titleBarStyle: Overlay` + `hiddenTitle`，红绿灯叠在自绘标题栏上，`data-tauri-drag-region` 可拖。
- 验证：`npm run build` 零类型错误；`cargo build --release` 零警告；浏览器示例数据截图（看板 + 详情）正常；`npm run tauri build` 出 `Dispatch.app` + dmg；启动后 `screencapture` 确认在真实 `~/tasks/.beads` 上显示 4 条任务、Claude Code 身份、验收进度条、依赖提示。
- skill `task-board` 更新：加 `project:<名>` 标签约定、`--acceptance` 验收清单、身份检查、Dispatch 源码位置。
- `~/.claude/settings.json` PATH 加了 `~/.cargo/bin`（cargo 之前对 Claude Code 不可见）。

### Bugs / surprises
- 脚手架 `main.rs` 引用 `app_lib`，改 crate 名后要同步成 `dispatch_lib`。
- `vite preview` 只绑 IPv6 localhost，Playwright 访问 127.0.0.1 失败；改用 python 静态服务。
- 第一次 `launchctl setenv BEADS_ACTOR cursor` 是个错误：会让所有 GUI 应用（包括 Dispatch）以 Cursor 身份写库，已撤销。Cursor 装了之后用它自己的终端 env 设置。
- 旧样例任务的 assignee 是 git user.name `SchaeferAnjon`，看板上会多出一个"人"；之后新写入都是 `schaefer`。
- `bd history --json` 没有每次提交的操作者，活动流的操作者是从字段变化推断的（认领→assignee，创建→created_by），其余显示"系统"。

### Files touched
- `app/src-tauri/{Cargo.toml,tauri.conf.json,src/lib.rs,src/main.rs}` — 后端
- `app/{index.html,package.json}`、`app/src/{main.tsx,App.tsx,api.ts,types.ts,fixtures.ts,derive.ts,styles.css}`、`app/src/components/{ui,Sidebar,views,Detail,NewTask}.tsx` — 前端
- `design/screenshots/` — beads-ui 对比图、浏览器预览、真实数据截图
- `~/.cc-switch/skills/task-board/SKILL.md` — 约定更新
- `~/.claude/settings.json`（PATH + BEADS_ACTOR）、`~/.codex/config.toml`、`~/dotfiles/fish/config.fish` — 身份
- `process.md` — 本条

---

## 2026-09-02 · Dispatch v0.1.1 — 修"一点就彩虹圈"和拖不动

### What I did
- 复现 + 定位：`bd list` 实测 0.34s（被冻住的旧版本疯狂调 bd 抢锁时飙到 3s）。两个根因：
  1. Tauri 命令写成同步 `fn`，Tauri 把同步命令放在**主线程**跑，每次 bd 调用都冻住 UI。
  2. 只读的 `bd list` 也会改 `.beads/last-touched` 和 Dolt 的 `manifest`/`journal.idx` → notify 监听器触发 → 前端 reload → 再调 bd → 无限循环。
- 修法（`app/src-tauri/src/lib.rs`）：
  - 全部命令改 `async fn` + `tauri::async_runtime::spawn_blocking`。
  - 加全局 `BD_LOCK: Mutex` 串行化自己的 bd 调用；遇到 "locked" 退避重试 3 次。
  - 监听器不再按 mtime 触发，改成读取 `embeddeddolt/*/.dolt/noms/manifest` 内容做指纹（实测：读操作指纹不变，写操作才变），指纹变了才发 `beads-changed`。
- 拖拽：`tauri.conf.json` 加 `"dragDropEnabled": false`。Tauri 默认接管 WebView 的拖放（为了文件拖入），会吞掉 HTML5 drag 事件。
- 前端：`Detail` 用列表里已有的 issue 立即渲染，只有该任务的 `updated_at` 变了才重新拉 show/comments/history（之前每次列表刷新都拉 3 次）。
- 验证：重启后空闲 CPU 0.1–0.4%；用 `BEADS_ACTOR=codex bd create` 在命令行建任务，4 秒内看板自动出现新卡、Codex 变"在线"，无任何点击。截图 `design/screenshots/dispatch-live-refresh-v0.1.1.png`。

### Bugs / surprises
- `--no-pager` 不是全局 flag，别往所有命令上加。
- macOS 的 BSD `pgrep` 没有 `-c`。
- 备选提速路线（暂未做）：Beads shared-server 模式（`bd config set dolt.shared-server true`，需要 `brew install dolt`），一台机一个常驻 Dolt 服务，每次命令从 ~0.3s 降到毫秒级，且支持多写者并发。

### Files touched
- `app/src-tauri/src/lib.rs` — async 命令、串行锁、manifest 指纹监听
- `app/src-tauri/tauri.conf.json` — `dragDropEnabled: false`
- `app/src/App.tsx`、`app/src/components/Detail.tsx` — Detail 按 updated_at 刷新
- `design/screenshots/dispatch-live-refresh-v0.1.1.png`

---

## 2026-09-02 · Dispatch v0.2 — 真实会话检测（终端 / 桌面端分开数）、标题栏拖动、/Applications 自动更新

### What I did
- **会话登记钩子** `~/tasks/.dispatch/presence.py`：注册到 Claude Code（SessionStart / UserPromptSubmit / Stop / SessionEnd）和 Codex（SessionStart / UserPromptSubmit / Stop）。每次事件写 `~/tasks/.dispatch/sessions/<agent>__<session_id>.json`：cwd、项目名、agent 进程 pid、来源（沿父进程链向上找 `.app` 或 herdr/tmux：Claude.app→桌面端，Warp/iTerm/Terminal/Ghostty/Herdr→终端，Cursor/VS Code→编辑器）、状态（UserPromptSubmit→在跑，Stop→等你）、轮数。SessionEnd 删文件；每次运行顺手清掉 pid 已死超过 60s 的记录。任何异常都吞掉、exit 0，不影响 Agent。
- Rust `sessions` 命令：读登记表，用 `ps -axo pid=,ppid=,comm=` 校验 pid 存活（死了就删）；对没登记的 `claude`/`codex` 进程（钩子装之前开的）也列出来，用同一套父链分类算来源，`lsof -d cwd` 取工作目录，状态标"未登记"。同时报告正在运行的应用（Claude 桌面端 / ChatGPT / Cursor / VS Code）。
- 前端每 5 秒轮询 presence（只是一次 ps + 几个 JSON，不碰 bd）。Agents 视图：每个 Agent 卡片上方按来源汇总（"终端 · Herdr 1"、"桌面端 · Claude 桌面端 2"），下面逐会话一行：来源图标、项目、来源应用、在跑/等你/未登记、开了多久、轮数。侧栏 Agent 行显示"5 会话 · 1 在跑"，标题栏显示"1 在线 · 5 会话"。"在线"改为以真实进程为准。
- 标题栏拖动：Tauri 只在 mousedown 目标元素本身带 `data-tauri-drag-region` 时才拖窗，标题文字是子元素所以拖不动；给 `.lead *`、`.crumb *` 加 `pointer-events:none` 让事件落到容器上。
- `/Applications` 安装：`app/scripts/install.sh`（构建 → rsync 到 /Applications/Dispatch.app → 重开）；`npm run install:app`；fish 函数 `dispatch-update`。以后改完代码跑 `dispatch-update` 即可，不用手动装。
- `DISPATCH_VIEW=agents` 环境变量可指定启动视图（直接跑二进制时用，方便截图验证）。
- 实测：Agents 视图显示 Claude Code 5 个会话（1 个经钩子登记：Herdr · kanban · 在跑；4 个未登记，附 pid），Claude 桌面端在运行。截图 `design/screenshots/dispatch-agents-v0.2.png`。

### Bugs / surprises
- claude-code-guide 核实：钩子 stdin 有 `session_id`/`cwd`/`hook_event_name`；SessionStart 有 `source`，SessionEnd 有 `reason`；SessionEnd 钩子预算只有 1.5s；文档里**没有**区分 CLI/桌面端的环境变量，但实测 `CLAUDE_CODE_ENTRYPOINT=cli` 存在，脚本顺手记下。来源判断靠父进程链，不靠它。
- 本机 Claude Code 的父链是 `claude → fish → herdr → fish → login`，没有 `.app`，所以要把 herdr 当终端来源识别。
- 桌面端 Claude Code 的会话跑在 `Claude Helper (Plugin)` 进程里，纯 `ps` 数不出来，只能靠钩子登记——所以桌面端会话要等重启桌面端后新开的会话才会出现。
- bash 里 `"$DST（...）"` 全角括号紧跟变量名会被当成变量名的一部分，报 unbound variable；写 `${DST}`。
- 用户附的图是另一个词典应用的弹窗，与本项目无关。

### Files touched
- `~/tasks/.dispatch/presence.py` — 会话登记钩子（新）
- `~/.claude/settings.json`、`~/.codex/hooks.json` — 新增 dispatch-presence 钩子组
- `app/src-tauri/src/lib.rs` — `sessions` 命令、父链分类、`initial_view`
- `app/src/{types,api,fixtures,derive,App}.ts(x)`、`app/src/components/{views,Sidebar}.tsx`、`app/src/styles.css` — Agents 视图、侧栏、标题栏拖动
- `app/scripts/install.sh`、`app/package.json`（`install:app`）、`~/dotfiles/fish/config.fish`（`dispatch-update`）
- `/Applications/Dispatch.app` — 已安装

---

## 2026-09-02 · Dispatch v0.3 — 拖窗修好、按任务恢复会话、踩坑记录库

### What I did
- **拖窗根因**：`core:window:default` 权限集不含 `allow-start-dragging`，`data-tauri-drag-region` 的拖窗调用被静默拒绝。capabilities 加 `core:window:allow-start-dragging` + `allow-toggle-maximize`。
- **按任务恢复会话**：Rust 后台线程每 60s 增量扫描 `~/.claude/projects/**/*.jsonl`（Claude Code，文件名 = session id，`"cwd":"…"` 取目录）和 `~/.codex/sessions/**/*.jsonl`（Codex，首行 session_meta 的 id/cwd），正则抓任务 ID（前缀从 `.beads/metadata.json` 的 `dolt_database` 读）建索引 task → sessions（记录 mtime、提到次数、只读新追加的字节）。命令 `task_sessions(id)`、`resume_cmd(agent, sid, cwd)`。详情页新增"会话 · 恢复对话"：列出提到过该任务的会话，标出正在跑的（和 presence 登记表对上），按钮复制 `cd '<cwd>' && claude --resume <id>`（Codex 是 `codex resume <id>`）到剪贴板（`tauri-plugin-clipboard-manager`，权限 `clipboard-manager:allow-write-text`）。Agents 视图每个已登记会话行也有"恢复"按钮。
- **踩坑记录**：直接用 Beads 的 memory（`bd remember/memories/recall/forget`），因为 `bd prime` 在每个新会话启动时把全部记忆注入上下文——所有 Agent 天然可查。约定：key `pit-<slug>`，内容 `【坑】…【解法】… #project:x #task:id`。Dispatch 新增"踩坑记录"视图（搜索、只看踩坑/全部记忆、添加/编辑/删除对话框，任务 ID 可点开详情）。已录入 5 条真实的坑（launchctl BEADS_ACTOR、Tauri 同步命令、bd 监听死循环、Tauri 拖拽、eza 软链误删）。
- 调试入口：环境变量 `DISPATCH_VIEW=pitfalls` / `DISPATCH_TASK=task-9lo` 直接跑二进制可指定启动视图/打开任务。
- skill `task-board` 加"踩坑记录（必须）"和"恢复会话"两节。
- 验证：安装到 /Applications 后启动，详情页显示 task-9lo 有 1 个会话（本会话，117 次提到，Herdr，在跑）；踩坑视图正确解析展示。截图 `design/screenshots/dispatch-resume-v0.3.png`、`dispatch-pitfalls-v0.3.png`。

### Bugs / surprises
- 词典类浮窗（用户另一个应用）一直盖在屏幕右侧，`screencapture -l <wid>` 因系统 python 没有 pyobjc 拿不到窗口号；改用 System Events 把 Dispatch 窗口挪到左边再截。
- Codex 的会话钩子已经从 ChatGPT 桌面端触发过一次（Agents 显示"ChatGPT 桌面端 1"）——说明 Codex 桌面端也走同一套 hooks.json。
- 首次索引要读完 720MB 历史（~2-3s，后台线程，不影响 UI）；之后只读增量。
- `bd memories --json` 返回的是 `{key: value, schema_version: 1}` 扁平对象，不是数组。

### Files touched
- `app/src-tauri/src/lib.rs` — 索引线程、task_sessions/resume_cmd/index_status、memories_list/memory_set/memory_forget、clipboard 插件、initial_task
- `app/src-tauri/capabilities/default.json` — start-dragging / toggle-maximize / clipboard 权限
- `app/src-tauri/Cargo.toml`（regex、tauri-plugin-clipboard-manager）、`app/package.json`（@tauri-apps/plugin-clipboard-manager）
- `app/src/components/Pitfalls.tsx`（新）、`Detail.tsx`、`views.tsx`、`Sidebar.tsx`、`App.tsx`、`api.ts`、`types.ts`、`derive.ts`、`fixtures.ts`、`styles.css`
- `~/.cc-switch/skills/task-board/SKILL.md` — 踩坑 + 恢复会话约定
- `~/tasks/.beads` — 5 条 pit-* memory

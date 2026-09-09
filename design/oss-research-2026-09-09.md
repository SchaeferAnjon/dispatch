# Dispatch 开源项目调研报告

调研范围：多智能体通信与编排、coding agent 相关 UI、底层技术三个方向，服务于 Dispatch（macOS 桌面多 Agent 调度台，Tauri2+React + Python CLI，任务板用 Beads/Dolt，Agent 通过 Herdr 终端复用器驱动 Claude Code/Codex CLI/Gemini CLI/pi/ZCode）。所有项目均通过 WebSearch/WebFetch 核实 GitHub 页面（star 数、最近提交、许可证），未能核实的已明确标注。数据截至 2026-09-09。

---

## 一、多智能体通信与编排

### 1.1 排序表格

| 项目 | 是什么 | 成熟度（stars/活跃度） | 许可证 | 能拿来做什么 | 接入难度 |
|---|---|---|---|---|---|
| [Claude Agent SDK (Python)](https://github.com/anthropics/claude-agent-sdk-python) / [TS 版](https://github.com/anthropics/claude-agent-sdk-typescript) | Anthropic 官方 SDK，本质是对 headless `claude` CLI 的封装 | 8.1k star，MIT，官方维护，活跃 | MIT | 直接印证并参考我们计划中的 `claude -p` + session resume 方案的生命周期管理、`cli_path` 自定义、options 设计 | 小（可直接依赖或抄设计） |
| [Concord MCP](https://github.com/Get-Concord-AI/concord-mcp) | 共享 MCP server，让 Claude Code/Codex/Cursor/Gemini CLI 等异构 agent 通过 5 个 MCP 工具（presence、task memory、ownership 转移、collision 检测、evidence handoff）协作 | 324 star，早期但设计完整 | MIT | 协议/数据模型可直接借鉴：`.concord/` 下用 SQLite 存 presence + 版本化 ownership，防止多 agent 同时改同一文件——正是 Beads 任务板缺的"实时占用/冲突检测"层 | 中（协议设计可抄，代码需按 Beads 数据模型重写） |
| [cmux](https://github.com/manaflow-ai/cmux) | 原生 macOS（Ghostty 内核 + Swift/AppKit）终端复用器，带 Unix socket API，可被编排 agent 远程创建工作区、发指令、读屏幕内容 | 26.9k star，13k+ commits，活跃 | **GPL-3.0-or-later**（含商业条款选项） | Herdr 的最直接同类项目，socket API 的"可寻址终端面板"设计值得参考；GPL 意味着不能直接抄代码 | 大（只能借鉴思路） |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck) | Go + Bubble Tea 写的 tmux TUI，统一管理 Claude/Codex/Gemini/OpenCode/Pi 会话 | 860 star，2953 commits，活跃 | MIT | **MCP socket pooling**（跨会话共享 MCP 进程，省 85-90% 内存）+ session forking（继承对话历史）是两个具体可抄的点；SQLite 状态持久化模式贴近我们 | 小-中（MIT 可直接参考实现细节） |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | tmux + git worktree 隔离的多 agent 终端管理 TUI，支持 Claude Code/Codex/OpenCode/Amp | 8.5k star，222 commits，成熟 | **AGPL-3.0** | worktree 隔离 + profile 切换的思路可借鉴，但 AGPL 禁止直接抄代码进公开仓库 | 大（仅借鉴思路） |
| [NTM (Named Tmux Manager)](https://github.com/Dicklesworthstone/ntm) | tmux 面板级协调多个 agent，带"Agent Mail"、文件预占（file reservation）、REST/WebSocket API | 439 star，4692 commits | MIT（含附加条款，建议核实） | "file reservation"防冲突机制、REST/WebSocket 对外暴露状态的模式可直接参考 | 中 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 看板+diff 审查 UI，编排 10+ 种 agent CLI，每任务一个 git worktree | 28k star，2070 commits，**项目本身已宣布 sunset，转社区维护** | Apache-2.0 | 统一 agent 抽象层（把不同厂商 CLI 差异封装掉）和 diff 审查 UI 值得整体参考 | 中（作为设计参考） |
| [ccswarm](https://github.com/nwiizo/ccswarm) | Rust 写的多 agent 编排，"Sangha 共识"工作流，NDJSON 审计日志可 replay/diff/rollback | 151 star，156 commits，小众但设计精巧 | MIT | NDJSON 事件审计日志 + replay 能力，适合给会话时间线加"可重放"能力 | 中 |
| [Google A2A Protocol](https://github.com/a2aproject/A2A) | Google 主导的开放协议，JSON-RPC 2.0 over HTTP(S)，让不透明的 agent 应用互相发现能力、提交任务、追踪进度 | 25.7k star，624 commits，Google 官方背书 | Apache-2.0 | 协议词汇（AgentCard、task 生命周期状态机）可作设计参考，完整实现（HTTP server 发现机制）对单用户本地工具偏重 | 大（仅作为参考词汇） |
| [Paperclip](https://github.com/paperclipai/paperclip) | Node.js + React，"heartbeat"驱动的 agent 编排，任务状态跨 heartbeat 持久化恢复，adapter 模式接 Claude Code/Codex/webhook | 号称 80.3k star（**4周内从0冲到38k+，增长曲线异常，需警惕刷榜/营销注水**），MIT | MIT | heartbeat + 持久化任务上下文恢复的设计思路，与我们"headless + session resume"高度吻合，值得读代码但不建议依赖 | 中（只借思路） |
| [agent-of-empires](https://github.com/agent-of-empires/agent-of-empires) | 管理 Claude Code/OpenCode/Codex/Gemini/Pi 等，TUI 或 Web，专做了移动端访问 | 较新项目，star/commit 未详细核实 | 未核实 | 移动端访问实现值得一看，呼应 `dispatch serve` 手机端需求 | 未定 |

**仅适合 in-process，不适合驱动外部黑盒 CLI 的框架**（要求在同一进程内用其 SDK 重写 agent 逻辑，单独列出仅供状态机设计参考）：

| 项目 | stars/许可证 | 定位 | 备注 |
|---|---|---|---|
| [AG2（原 AutoGen）](https://github.com/ag2ai/ag2) | ~51k star，Apache-2.0 | 对话式多 agent，GroupChat 模式 | GroupChat"轮流发言+主持人"模式可作我们"多 agent 讨论"状态机参考 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | 54k star，MIT | 角色扮演式多 agent 编排 | 仅 in-process |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 30.9k star，MIT | 图状态机式 agent 编排，带 checkpointer | checkpointer/持久化状态图模式对讨论轮次设计有参考价值 |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | 3.8k star，MIT | OpenAI 官方轻量多 agent 框架 | 仅 in-process |
| [claude-flow / ruflo](https://github.com/ruvnet/ruflo) | 号称 15.4k→59k star，MIT，但改名多次且有多个可疑镜像仓库、增长曲线异常 | 企业级 swarm 编排，Raft/Byzantine/Gossip 共识 | 不建议，见下文 |

### 1.2 重点判断

**Claude Agent SDK** 是我们计划路线的官方实现范本——本身就是把 headless `claude` CLI 包装成带 session 概念的接口，`ClaudeAgentOptions` 的 `cli_path`、会话恢复等设计可直接照抄到 Dispatch CLI 层。它不会替代 Herdr（Herdr 还要管 Codex/Gemini），但对 "Claude 侧" headless 化改造是现成最佳实践。

**Concord MCP** 与我们"多 agent 共享任务板、避免冲突"的需求匹配度最高。建议不装它本身（早期、324 star），但把它的数据模型（`.concord/` SQLite、版本化 ownership 防竞态）搬到 `dispatch` CLI，给 Beads 任务加一层"谁在改哪个文件"的状态。

**cmux / claude-squad / agent-deck / NTM** 都是 Herdr 的同类竞品，说明我们的方向是对的。cmux（GPL）和 claude-squad（AGPL）代码不能直接拿；agent-deck（MIT）的 MCP socket pooling 和 session forking 是具体可抄的工程细节；NTM 的 file reservation 值得一看。

**Google A2A** 协议设计规整，但要求每个 agent 起 HTTP server 供发现，对单机单用户场景明显过重，只读任务生命周期状态定义作词汇参考即可。

**Paperclip** heartbeat + 跨心跳持久化任务上下文的思路正对我们的题，但 4 周内从 0 冲到 38k+ star 的增长曲线极不寻常，可信度存疑，加上定位偏"zero-human company"商业场景，不建议依赖，只读 adapter 层代码取思路。

---

## 二、UI

### 2.1 排序表格

| 项目 | 是什么 | 成熟度 | 许可证 | 能拿来做什么 | 接入难度 |
|---|---|---|---|---|---|
| [jhlee0409/claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) | 统一历史查看器，桌面 app（**Tauri**）或无头服务器，解析 Claude Code/Codex CLI/Gemini CLI/OpenCode/pi 等 29 种 agent 的本地会话文件 | 约 2,090 star，1,225 commits，活跃 | MIT | 与 Dispatch 技术栈（Tauri+React）几乎一致，且已解析我们要支持的所有 agent 格式，建议直接读其 parser 源码 | 小-中 |
| [onikan27/claude-code-monitor](https://github.com/onikan27/claude-code-monitor) | 多 Claude Code 会话实时仪表板，CLI + 移动网页 UI，扫码访问，可跨 Tailscale 远程控制终端焦点，仅 macOS | 306 star，147 commits | MIT | 和我们 `dispatch serve`（Tailscale 手机端）场景高度重合，"按键唤出二维码+同网/Tailscale 访问+令牌鉴权"可直接照搬 | 小 |
| [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | Claude Code + Codex 实时监控仪表板，含 Kanban 看板、子 agent 编排可视化、WebSocket 推送 | 985 star，989 commits | MIT | React+Vite+Tailwind+Express+SQLite+WebSocket 技术栈，子 agent 编排可视化组件设计值得抄 | 中 |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 多 coding agent 任务看板，Rust 后端，每个任务用 git worktree 隔离，内建 diff 审阅、浏览器预览 | 28,000 star，2,070 commits，**已宣布 sunset（转社区维护）** | Apache-2.0 | 星数与完整度同类最高，diff 逐行审阅反馈给 agent 的交互模式成熟，值得整体参考 UI/UX | 中（设计参考）/大（复用代码） |
| [alihassanml/claude-code-monitor](https://github.com/alihassanml/claude-code-monitor) | 解析 Claude Code JSONL 到 SQLite 的本地仪表板，专门处理了"usage 对象重复导致 token 计数 1.9 倍虚高"的坑 | 仅 1 star，10 commits，非常小众 | MIT | star 低但 token 去重踩坑记录（按 `message.id` `INSERT OR IGNORE`、按字节偏移增量解析）对我们 token 统计有用 | 小（抄思路） |
| [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) | 统计 Claude Code/Codex/OpenCode/Gemini CLI 等近 20 种 agent CLI 的 token 用量和费用，纯本地解析 | 18.5k star，1,822 commits，活跃 | MIT | "配额显示"功能可参考它对多家 agent 用量格式的兼容层，甚至可作为子进程直接调用 | 小 |
| [hosenur/portal](https://github.com/hosenur/portal)（原 opencode-portal） | 移动优先的 OpenCode 网页 UI，内建浏览器终端、Git 集成、隔离工作区 | 798 star，164 commits | MIT | "移动优先 + 浏览器内终端"设计为 `dispatch serve` 手机端提供参考 | 中 |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | React AI 聊天 UI 组件库，Thread/Message/Composer 等可组合原语，内置流式输出、自动滚动、打字指示器、markdown/代码高亮、语音输入 | 12.1k star，5,214 commits，活跃 | MIT | 不绑定 Vercel AI SDK，可换自定义 runtime。"多智能体讨论"的流式打字气泡、角色人设展示可直接用其 Thread/Message 组件 | 中 |
| [otakustay/react-diff-view](https://github.com/otakustay/react-diff-view) | 消费 git unified diff 的 React 组件，支持 split/unified 视图、自定义装饰、行内评论 widget | 1.0k star，254 commits | MIT | "行内评论 widget"架构匹配任务详情页展示文件 diff 并标注的需求 | 小 |
| [MrWangJustToDo/git-diff-view](https://github.com/MrWangJustToDo/git-diff-view) | 新一代 diff 组件，支持 React/Vue/Solid/Svelte，Shiki/Lezer 语法高亮，完整 SSR/RSC 支持 | 738 star，530 commits | MIT | 比 react-diff-view 语法高亮更现代，若要在 diff 里做代码高亮更省事 | 小 |
| [rtfpessoa/diff2html](https://github.com/rtfpessoa/diff2html) | 纯 JS diff 转 HTML 库，非 React 专属，GitHub 风格视图 | 3.4k star，791 commits，维护但有积压 | MIT | 不依赖框架，适合快速渲染静态 diff（如通知预览） | 小 |
| [prabhuignoto/react-chrono](https://github.com/prabhuignoto/react-chrono) | React 时间线组件，支持竖直/水平/交替布局 | 4.2k star，892 commits | MIT | 直接用来做会话/任务时间线视图，省去自写 CSS | 小 |
| [GetStream/react-activity-feed](https://github.com/GetStream/react-activity-feed) | Stream 商业服务的 React 活动流组件 | 数据未逐一核实 | 组件开源，但典型用法依赖 Stream 云服务 | 不建议：强绑定商业后端 | — |
| [ntfy](https://github.com/binwiederhier/ntfy) | 自托管推送通知网关，配套 iOS/Android app | 34.1k star，4,002 commits | Apache-2.0 与 GPLv2 双许可 | 可自托管、有现成 HTTP API，适合直接用 curl/httpx 发系统通知 | 小 |
| [Apprise](https://github.com/caronc/apprise) | Python 通知路由库，支持 150+ 渠道 | 17.3k star，1,182 commits | BSD-2-Clause | 多渠道统一出口，适合"通知"功能的后端 | 小 |
| [Bark](https://github.com/Finb/Bark) + [bark-server](https://github.com/Finb/bark-server) | iOS 推送通知 app + 自托管服务端 | 9k star/606 commits | MIT | iOS 用户原生体验最好的推送方案 | 小 |
| Pushover | 商业推送服务，非开源，仅提供 API | 不适用 | 商业许可 | 不建议作为默认方案 | — |

### 2.2 重点判断

**jhlee0409/claude-code-history-viewer** 是这次调研里和 Dispatch 最像的项目：同样用 Tauri，同样要解析 Claude/Codex/Gemini/OpenCode 等异构会话格式，且已支持我们暂未覆盖的几家 agent（Aider、Cline、Kiro）。建议花时间读它的 parser 层代码，直接抄格式解析逻辑。

**onikan27/claude-code-monitor** 虽 star 不多，但需求场景和 `dispatch serve` 高度重合，是目前找到的最贴近我们需求的现成参考实现，代码量小，阅读成本低。

**BloopAI/vibe-kanban** 是同类项目里体量最大、产品完成度最高的，diff 逐行审阅+反馈给 agent 的 UI 范式已被验证好用，值得作为界面设计基准。但官方已 sunset，只适合"看设计不抄依赖"。

**assistant-ui** 是目前最成熟的开源 AI 聊天 UI 组件库，MIT、可脱离 Vercel AI SDK 接自定义后端。我们计划的"多智能体讨论"流式打字气泡和角色人设展示，直接用它的组件能省下大量前端工作，是本次调研投入产出比最高的发现之一。

**ntfy / Apprise / Bark** 都可直接作为"发通知"层的现成后端，接入成本最低、价值最直接。

---

## 三、底层技术

### 3.1 排序表格

| 项目 | 是什么 | 成熟度 | 许可证 | 能拿来做什么 | 接入难度 |
|---|---|---|---|---|---|
| [dolthub/doltlite](https://github.com/dolthub/doltlite) | Dolt 的嵌入式版本，用 Prolly Tree 替换 SQLite 的 B-tree，保留 SQL 层 | 265 star，Beta（v0.50.0），持续更新 | 仓库无 SPDX 标注，需查 LICENSE 文件 | 与现有 Dolt/bd 同血统的"嵌入式+可 WASM 化"版本，可评估替换现有 Dolt server 模式，用 git 风格 branch/merge 做双 Mac 同步 | 中（写性能比原生 SQLite 慢约 3.1 倍，不支持 WAL） |
| [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) | 零依赖 C 写的 SQLite 向量搜索扩展 | 8.1k star，pre-v1，最近提交 2026-05-18，Mozilla Builders 赞助 | Apache-2.0 / MIT 双许可 | 直接用于"相关坑"语义搜索：embedding 存入 vec0 虚拟表，与 bd 的 SQLite 存储并存 | 小（单文件扩展，Node/Python/Rust 都有绑定） |
| [daaain/claude-code-log](https://github.com/daaain/claude-code-log) | 解析 Claude Code `~/.claude/projects/*.jsonl`，转成可读 HTML/Markdown | 1.2k star，MIT，活跃 | MIT | 现成的 Claude Code 转录格式解析代码，抄解析逻辑而非依赖整包，省去逆向工程时间 | 小 |
| [PixelPaw-Labs/codex-trace](https://github.com/PixelPaw-Labs/codex-trace) | Codex CLI `~/.codex/sessions/*.jsonl` 查看器，支持桌面+网页，处理多种历史格式 | 99 star，MIT，活跃 | MIT | 借鉴其对 Codex rollout 格式多版本兼容的处理，省去踩 Codex 格式演变的坑 | 小 |
| [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)（含 `@xterm/headless`） | 网页终端组件，headless 模式可在 Node 里维护终端状态而不渲染 DOM | 21.2k star，MIT，非常活跃 | MIT | 若要在网页/PWA 里重放或实时镜像 Herdr 驱动的终端输出（含 ANSI 转义），是最成熟方案 | 中（需接 addon 做 serialize/reconnect） |
| [zellij-org/zellij](https://github.com/zellij-org/zellij) | Rust 终端复用器，内置 WASM 插件系统、布局自动化、**内置 Web 客户端** | 35.3k star，MIT，活跃 | MIT | 自带 web client 直接解决"手机端看实时终端"需求，值得看实现思路而非重新发明 | 中（借鉴思路成本可控，替换 Herdr 成本大） |
| [wezterm/wezterm](https://github.com/wezterm/wezterm)（`portable-pty` crate） | Rust 跨平台 pty 库，wezterm 内置模块 | wezterm 本体 28.8k star，非常活跃 | 需核实 LICENSE.md（wezterm 采用 MIT） | 若 Rust 层想直接管理 pty（而非完全依赖 Herdr 转发），是业界最成熟的 Rust pty 抽象（wezterm/mprocs 都在用） | 中（`cargo add portable-pty`） |
| [microsoft/node-pty](https://github.com/microsoft/node-pty) | Node.js pty 绑定，VS Code 终端底层库 | 2026 star，MIT，活跃 | MIT | 若 Node 侧需独立起 pty；但 Dispatch 架构以 Rust 层为主，价值有限 | 小 |
| [automerge/automerge](https://github.com/automerge/automerge) | 文档级 CRDT 库，Ink & Switch 出品，local-first 标杆 | 6.6k star，MIT，非常活跃，v3 内存降 10 倍 | MIT | 只有需要"同一文档被两端细粒度同时编辑并自动合并"才有用；issue-tracker 结构化数据用它需重新建模 | 大（收益不明确） |
| [electric-sql/electric](https://github.com/electric-sql/electric) | Postgres → 客户端 SQLite 的实时同步引擎 | 10.4k star，Apache-2.0，2026-08-17 并入 Databricks | Apache-2.0 | 需要常驻 Postgres，母公司刚被收购，路线不确定 | 大，性价比低 |
| [sqliteai/sqlite-sync](https://github.com/sqliteai/sqlite-sync) | 直接在 SQLite 文件上做 CRDT 式离线同步的扩展，不需 Postgres | 557 star，活跃，2025-05 创建，较新 | 待核实（NOASSERTION） | 理论上比 Dolt 更轻量地实现双 Mac 同步，但项目新、许可证不明，先观察 | 中，风险未知 |
| [benbjohnson/litestream](https://github.com/benbjohnson/litestream) | SQLite 单向流式复制到 S3/对象存储 | 14.4k star，Apache-2.0，活跃（Fly.io 维护） | Apache-2.0 | 只做单写者备份/灾备，不是双向多写同步，与"两台 Mac 都要写"的需求不匹配 | 不适用 |
| [julienXX/terminal-notifier](https://github.com/julienXX/terminal-notifier) / [vjeantet/alerter](https://github.com/vjeantet/alerter) | macOS 命令行发通知；alerter 是其 fork，支持可交互按钮/回复 | 7.3k / 1.2k star，均活跃 | terminal-notifier 需核实；alerter 为 MIT | agent 状态变化时弹带按钮的系统通知，比纯 osascript 更丰富 | 小 |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | OpenAI Whisper 的本地 C/C++ 实现 | 万星级，非常活跃 | MIT | 语音输入本地化（Apple Silicon Metal/CoreML 加速），事实标准 | 中 |

### 3.2 重点判断

**DoltLite** 与现状直接相关：Dolt 官方为"嵌入式/本地优先"场景做的正式产品线，2026 年 8 月刚出 Beta，语义是"用 git 分支合并替代 CRDT 做双端同步"，和两台 Mac 共享 bd 任务板几乎是同一个问题。目前写性能比原生 SQLite 慢 3 倍多、不支持 WAL，不建议现在切换，但值得加入观察列表，等 GA 后重新评估能否替代现有 Dolt server-sync 模式。

**sqlite-vec** 已足够成熟可直接用于"相关坑"语义搜索：零依赖、C 编写、双 Apache/MIT 许可、体积小。虽标注 pre-v1，但 API 面很小（vec0 虚拟表 + KNN 查询），锁定版本使用风险可控。

**claude-code-log 和 codex-trace** 值得读代码而非依赖整包：已踩过 Claude Code JSONL 和 Codex rollout 格式演变的坑，直接抄解析/归一化逻辑能省下逆向工程时间。

**Automerge / ElectricSQL** 理论优雅但不适合现状：Automerge 要求把数据重建模成 CRDT 文档，收益只在细粒度实时协同编辑场景明显；ElectricSQL 要求常驻 Postgres，对桌面工具基础设施过重，且刚被 Databricks 收购路线不确定。

**zellij** 内置 Web 客户端的实现思路（如何把终端会话安全暴露到网页）值得直接参考，呼应我们打算做的手机端伴侣应用，即便不迁移 Herdr 本身。

**portable-pty（wezterm）** 是 Rust 生态最成熟的跨平台 pty 抽象，被 wezterm、mprocs 验证过。若未来想让 Rust 层直接控制 pty（而非永远通过 Herdr 转发），是第一选择，优于面向 Node 生态的 node-pty。

---

## 四、最值得马上借鉴的 8 条

1. **Claude Agent SDK 的 headless + session resume 生命周期设计** → 直接指导 `dispatch` CLI 里 `claude -p` 的 session 管理封装，替代现在"每轮重启 TUI agent"的慢方案。效力：中。
2. **Concord MCP 的版本化 ownership + presence 数据模型** → 给 Beads 任务加"谁在编辑哪个文件/哪个任务"的实时占用层，减少多 agent 冲突。效力：中。
3. **assistant-ui 的 Thread/Message/Composer 组件** → 直接用于"多智能体讨论"的流式打字气泡、角色人设展示，省去自建聊天 UI 的前端工作量。效力：中，投入产出比高。
4. **jhlee0409/claude-code-history-viewer 的多 agent 转录 parser** → 抄格式解析逻辑（尤其是我们尚未支持的 Aider/Cline/Kiro），补齐会话索引覆盖面。效力：中。
5. **onikan27/claude-code-monitor 的"二维码+Tailscale 访问+令牌鉴权"交互模式** → 直接指导 `dispatch serve` 手机端的接入流程设计。效力：小-中，实现成本低。
6. **sqlite-vec 接入"相关坑"语义搜索** → API 面小、零依赖，可以直接落地为 sqlite 扩展加载。效力：小，落地快。
7. **react-diff-view / git-diff-view 的行内评论 widget 架构** → 匹配任务详情页展示文件 diff 并标注反馈给 agent 的需求，比自研 diff 渲染省时间。效力：小-中。
8. **agent-deck 的 MCP socket pooling + session forking** → 若未来给每个 agent session 挂 MCP，直接照连接池模式做；session forking 也可用于"从历史节点分支讨论"功能。效力：小。

## 五、不建议

- **claude-flow / ruflo**：品牌/仓库名反复变更，多个来源可疑的镜像仓库用相同营销文案冒充官方仓库，星标增速在数月内跳到近 6 万，这类信号通常意味着刷榜或过度营销。即便抛开可信度问题，Raft/Byzantine/Gossip 分布式共识、Rust/WASM 重写这套企业级复杂度，对两台 Mac、单用户的个人调度台是明显的过度工程。
- **依赖 Paperclip 本身**：4 周内从 0 冲到 38k+ star 的增长曲线异常，定位偏"zero-human company"商业场景，代码库演化方向会与个人工具场景逐渐分叉，不建议引入依赖，只读代码取思路。
- **完整实现 Google A2A 协议**：协议设计不差，但要求每个 agent 暴露 HTTP server 供发现，这个成本对本地 CLI 子进程场景不成立。
- **直接依赖 cmux / claude-squad 的代码**：分别是 GPL-3.0-or-later 和 AGPL-3.0，直接复用或衍生会给公开仓库 Dispatch 带来 copyleft 传染风险，只能借鉴思路、独立实现。
- **把 AutoGen/AG2、CrewAI、LangGraph、OpenAI Agents SDK 当作编排框架整体引入**：都要求在同一进程内用各自 SDK 重写 agent 逻辑，与"驱动外部黑盒 CLI 子进程"的架构不兼容，只值得摘取状态机/checkpointer 设计模式。
- **GetStream/react-activity-feed**：组件开源但强绑定 Stream 商业云后端，不适合本地优先架构，时间线用 react-chrono 或自写更合适。
- **ElectricSQL / Automerge 作为任务板同步底座**：前者需要常驻 Postgres 且母公司刚被收购路线不明，后者要求把结构化 issue 数据重建模成 CRDT 文档，两者收益都撑不起迁移成本。
- **Litestream**：只做单写者到对象存储的流复制备份，解决的是灾备问题而非"两台 Mac 都要写"的双向同步需求，不能替代 Dolt sync。
- **Pushover**：闭源商业服务，不建议作为默认通知集成对象，仅可作为用户可选的第三方渠道。

## 六、来源链接

### 多智能体编排
- https://github.com/anthropics/claude-agent-sdk-python
- https://github.com/anthropics/claude-agent-sdk-typescript
- https://github.com/Get-Concord-AI/concord-mcp
- https://github.com/Softsensor-org/concord
- https://github.com/manaflow-ai/cmux
- https://github.com/asheshgoplani/agent-deck
- https://github.com/smtg-ai/claude-squad
- https://github.com/Dicklesworthstone/ntm
- https://github.com/BloopAI/vibe-kanban
- https://github.com/nwiizo/ccswarm
- https://github.com/agent-of-empires/agent-of-empires
- https://github.com/YoanWai/agent-manager
- https://github.com/a2aproject/A2A
- https://github.com/paperclipai/paperclip
- https://github.com/ag2ai/ag2
- https://github.com/microsoft/autogen
- https://github.com/crewAIInc/crewAI
- https://github.com/langchain-ai/langgraph
- https://github.com/openai/openai-agents-python
- https://github.com/ruvnet/ruflo
- https://github.com/andyrewlee/awesome-agent-orchestrators

### UI
- https://github.com/jhlee0409/claude-code-history-viewer
- https://github.com/onikan27/claude-code-monitor
- https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- https://github.com/bruceyxli/claude-code-monitor
- https://github.com/alihassanml/claude-code-monitor
- https://github.com/zcquant/claude-code-monitor
- https://github.com/BloopAI/vibe-kanban
- https://github.com/ryoppippi/ccusage
- https://ccusage.com/
- https://github.com/hosenur/portal
- https://github.com/sst/opencode
- https://github.com/assistant-ui/assistant-ui
- https://www.assistant-ui.com/
- https://github.com/otakustay/react-diff-view
- https://github.com/MrWangJustToDo/git-diff-view
- https://github.com/rtfpessoa/diff2html
- https://github.com/prabhuignoto/react-chrono
- https://github.com/GetStream/react-activity-feed
- https://github.com/binwiederhier/ntfy
- https://github.com/caronc/apprise
- https://github.com/Finb/Bark
- https://github.com/Finb/bark-server

### 底层技术
- https://github.com/microsoft/node-pty
- https://github.com/wezterm/wezterm
- https://github.com/dolthub/dolt
- https://github.com/dolthub/doltlite
- https://www.dolthub.com/blog/2026-08-31-doltlite-beta/
- https://www.dolthub.com/blog/2026-04-27-why-doltlite/
- https://github.com/automerge/automerge
- https://github.com/electric-sql/electric
- https://github.com/asg017/sqlite-vec
- https://github.com/benbjohnson/litestream
- https://github.com/zellij-org/zellij
- https://github.com/tmux/tmux
- https://github.com/xtermjs/xterm.js
- https://www.npmjs.com/package/@xterm/headless
- https://github.com/tauri-apps/tauri
- https://v2.tauri.app/learn/sidecar-nodejs/
- https://github.com/daaain/claude-code-log
- https://github.com/apappascs/claude-code-sessions
- https://github.com/PixelPaw-Labs/codex-trace
- https://github.com/masonc15/codex-transcript-viewer
- https://github.com/julienXX/terminal-notifier
- https://github.com/vjeantet/alerter
- https://github.com/ggml-org/whisper.cpp
- https://github.com/sqliteai/sqlite-sync
- https://github.com/sqliteai/sqlite-wasm

---

**说明**：部分仓库（如 sqlite-sync、doltlite、terminal-notifier）的具体许可证字段未能在 GitHub 页面上直接确认为标准 SPDX 标注（显示 NOASSERTION 或需查 LICENSE 文件），已在表格中如实标注为"需核实"，建议接入前人工确认。awesome-agent-orchestrators 汇总列表中的 Crewplane、foremerge、NXTG-Forge、omg.dev、claudexor 等项目仅做了列表层面确认，未逐一核实 star/许可证/最近提交，如需深入借鉴需单独核实。

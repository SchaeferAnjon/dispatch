---
name: task-board
description: 全局任务板（Beads / bd CLI，位于 ~/tasks，桌面前端 Dispatch）。所有 Agent（Claude Code、Codex、Cursor）和用户本人共用同一块板。当用户提到"任务板 / 调度台 / Dispatch / 我在干什么 / 认领 / 待办 / bd"，或你开始一段跨会话的工作、发现后续待办、需要交接时，用它。会话开始先 `bd ready`，结束前更新状态。
---

# 全局任务板（Beads + Dispatch）

一块板管所有项目：数据库在 `~/tasks/.beads`（Dolt 嵌入模式）。环境变量 `BEADS_DIR` 已在 fish / `~/.claude/settings.json` / `~/.codex/config.toml` / `launchctl` 指向它，任何目录下运行 `bd` 都命中这块板。用户自己看的是桌面应用 **Dispatch**（`~/Projects/kanban/app`），它直接读写同一个数据库并实时刷新。

## 第一步：确认命中的是全局板、身份正确

```bash
bd where          # 必须显示 /Users/macbook14/tasks/.beads，前缀 task
echo $BEADS_ACTOR # Claude Code 应为 claude-code；Codex 为 codex；人是 schaefer
```

在 **ZCode** 里（桌面应用，没有环境变量入口）：每条写命令都带 `--actor zcode`，且 `BEADS_DIR=$HOME/tasks/.beads` 前缀不能省。ZCode 的会话由 Dispatch 直接从 `~/.zcode/cli/db/db.sqlite` 读取，不需要钩子。用户已不用 Cursor。

路径不对就给命令加前缀 `BEADS_DIR=$HOME/tasks/.beads bd ...`。身份不对说明环境没继承，加 `BEADS_ACTOR=claude-code`。**身份决定看板上"谁在干什么"**，别用别人的身份写。

## 状态约定（用户定义的四个状态 → bd 字段）

| 用户口中的状态 | bd 里的表示 | 怎么进入 |
|---|---|---|
| to do | `status=open` | `bd create ...` |
| 进行中 | `status=in_progress` + assignee | `bd update <id> --claim` |
| finished | `status=closed` | `bd close <id> --reason="..."` |
| reviewed | `status=closed` + label `reviewed` | `bd update <id> --add-label reviewed` |

补充：`blocked`（有未完成依赖，`bd ready` 自动隐藏，看板上红边条）、`deferred`（搁置）。
"finished 但还没 reviewed" = `bd list --status closed` 里没有 `reviewed` 标签的那些，Dispatch 里是"已完成 · 待审"列。

## 项目归类（必须）

全局板跨所有项目，每条任务用标签 `project:<名字>` 标明属于哪个项目，Dispatch 左栏按它分组：

```bash
bd create "标题" -l project:kanban ...          # 创建时
bd update <id> --add-label project:poker-trainer  # 补上
```

名字用仓库目录名（kanban、poker-trainer、dotfiles、"海德堡 2026SS"）。当前在哪个项目目录里工作就标哪个。

## 核心流程

```bash
bd ready --json                         # 1. 找没有阻塞的可认领任务
bd show <id> --json                     # 2. 看清描述、验收标准、依赖、评论再动手
bd update <id> --claim --json           # 3. 原子认领（别的 Agent 同时抢不会撞车）
bd comments add <id> "进展/决定/踩坑"    # 4. 关键信息留在任务上，Dispatch 活动流里能看到
bd close <id> --reason="做了什么" --json # 5. 完成
bd update <id> --add-label reviewed     # 6. 检查通过后（AI 或人）打 reviewed
```

创建任务**必须带描述和验收标准**，否则下一个接手的 Agent 不知道为什么做、做到什么程度算完：

```bash
bd create "标题" -l project:xxx -t task -p 2 \
  --description="背景 + 要做什么" \
  --acceptance="- [ ] 测试通过
- [ ] 截图确认" --json
bd create "发现的 bug" -l project:xxx -t bug -p 1 --deps discovered-from:<当前id> --json
```

验收标准每行一条 `- [ ] ...`，做完一条改成 `- [x]`（`bd update <id> --acceptance="..."` 整段覆盖），Dispatch 卡片上显示进度条。
优先级 `-p 0`（最急）到 `-p 4`。类型 `-t task|bug|feature|epic|chore`。

## 谁在干什么

```bash
bd list --status in_progress            # 所有 Agent 正在做的任务（看 assignee）
bd list --all                           # 全部
bd blocked                              # 被卡住的
```

多开 Agent 时，认领前先看这条，避免两个 Agent 做同一件事。

## 踩坑记录（必须）

踩到坑、绕过去之后，**立刻**记一条，存在 Beads memory 里；每个 Agent 新会话 `bd prime` 会自动注入全部记忆，所以别人不会再踩：

```bash
bd remember "【坑】现象 + 原因 【解法】怎么解的 #project:kanban #task:task-9lo" --key pit-<英文短slug>
bd memories <关键词>        # 动手前先搜一下有没有人踩过
bd recall pit-<slug>        # 看全文
```

约定：key 以 `pit-` 开头；内容用 `【坑】…【解法】…`，末尾 `#project:<名>`、`#task:<id>` 可选。Dispatch 的"踩坑记录"视图按这个格式解析展示，也能在那里手工添加/编辑。
什么算坑：让你返工、卡住超过几分钟、或者文档/直觉是错的——工具行为、环境差异、命令陷阱、API 变更。不记"做了什么"，记"下次怎么不掉进去"。

## `dispatch` 命令（Agent 专用，`--json` 给机器读）

任务本身用 `bd`；下面这些是 `bd` 没有、Agent 常需要的：

```bash
dispatch sessions                 # 现在有哪些 Agent 会话在跑：谁、哪个目录、在跑/等你、来源（终端/桌面端/Herdr 标签）
dispatch find task-9lo            # 哪些会话提到过这个任务（标题、目录、最近时间）+ 每个的恢复命令
dispatch resume task-9lo --copy   # 恢复命令复制到剪贴板（也可给 session id 前缀）：cd '<目录>' && claude --resume <id>
dispatch focus task-9lo           # 直接切到 Herdr 里跑着这个任务的标签
dispatch skills list [-q 关键词] [--agent claude|codex]   # 技能池（~/.cc-switch/skills）+ 每个 Agent 挂没挂
dispatch skills show <name> / path <name> / open <name>   # 看 SKILL.md / 路径 / 用默认编辑器打开
dispatch skills enable <name> --agent claude|codex|all   # 挂载（软链）；disable 卸载（只删软链，本体不动）
dispatch pit add "坑" --fix "解法" --project kanban --task task-9lo   # = bd remember，key 自动 pit-…
dispatch pit list [关键词]        # 搜坑
```

会话索引来自 `~/.claude/projects/**.jsonl` 和 `~/.codex/sessions/**.jsonl`（增量缓存在 `~/tasks/.dispatch/transcript-index.json`）。所以**在对话里提到任务 ID**（认领、评论、汇报时写 `task-xxx`）就能被找回；子 Agent 的记录不算可恢复会话。

技能挂载约定：技能池 `~/.cc-switch/skills`（本体），Claude Code 读 `~/.claude/skills`（软链），Codex 读 `~/.agents/skills`（软链）。挂载/卸载后新会话生效。不要直接 `rm -rf` 池子里的目录。

## 规则

- 跨会话的任务、待办、阻塞、交接信息一律进 bd；TodoWrite 只用于当前回合的执行清单。
- 不要用 `bd edit`（会开交互编辑器），用 `bd update` 的参数。
- 解析输出用 `--json`。`bd update --json` 返回的是数组。
- 没真正完成不要 close；close 时 `--reason` 写给审核的人看。
- 用户的 Claude Code 记忆系统照常用，不用 `bd remember` 替代它。
- 会话结束前：把剩余工作建成任务、更新自己认领任务的状态。

## Dispatch 桌面应用

- 源码 `~/Projects/kanban/app`（Tauri 2 + React）；已安装在 `/Applications/Dispatch.app`。
- **改完代码后跑 `dispatch-update`**（fish 函数 = `app/scripts/install.sh`：构建 → rsync 到 /Applications → 重开）。开发时用 `npm run tauri dev` 有前端热更新。
- 会话检测：钩子 `~/tasks/.dispatch/presence.py` 登记每个 Claude Code / Codex 会话到 `~/tasks/.dispatch/sessions/`，Dispatch 的 Agents 视图按"终端 / 桌面端 / 编辑器"分开显示，并标出在跑 / 等你。不要删这个目录。
- 后端只是调 `bd --json`（`src-tauri/src/lib.rs`），并用 notify 监听 `~/tasks/.beads` 变化推 `beads-changed` 事件给前端。
- 浏览器里 `npm run dev` 打开的是示例数据（`src/fixtures.ts`），不是真板。
- 备用 Web 看板：fish 函数 `bdui`（beads-ui，端口 3110）。

## 常见问题

- 全局板跑在 Beads **shared-server 模式**（一台机器一个 Dolt 服务，127.0.0.1:3308，数据在 `~/.beads/shared-server/dolt/task`）：多 Agent 可并发写，单次命令 ~0.15s。
- `Dolt server unreachable … connection refused`：服务没起来，跑 `bd dolt start`（幂等）。LaunchAgent `dev.schaefer.beads-dolt` 每 2 分钟会自动拉起，Dispatch 启动时也会。
- 旧的嵌入式数据保留在 `~/tasks/.beads.embedded`（2026-09-02 迁移前的快照），备份在 `~/tasks/.beads-backup`。
- 跨机器（Mac mini）同步：Dolt remote（`bd dolt push/pull`），尚未配置。

---
name: task-board
description: Dispatch 任务板与知识库的完整用法（dispatch/bd 命令、状态约定、跨机同步）。要建任务、认领、记坑、查 wiki 细节时读。

---

# Dispatch：任务板 + 知识库

一块板管所有项目，数据库 `~/tasks/.beads`（Dolt shared-server，127.0.0.1:3308）。`BEADS_DIR` 已在 fish / Claude / Codex 配置里指向它。用户看桌面端 Dispatch（`/Applications/Dispatch.app`，源码 `~/Projects/kanban`），Agent 用 CLI `dispatch`（`--json` 给机器读）。会话启动 hook 已注入 `dispatch prime`（身份 + 当前项目的任务 + 相关知识库），**不要再手动 `bd prime` / `bd list --all` 拉全板进上下文**。

## 身份
`BEADS_ACTOR`：Claude Code=`claude-code`，Codex=`codex`，pi=`pi`（扩展 `~/.pi/agent/extensions/dispatch.ts` 设置），人=`schaefer`。ZCode 没有环境变量入口，每条写命令带 `--actor zcode` 和 `BEADS_DIR=$HOME/tasks/.beads` 前缀。Qoder 已卸载。身份决定看板上"谁在干什么"，别用别人的。`bd where` 应显示 `~/tasks/.beads`，前缀 `task`。

## 流程（用户先随口描述，任务由你建）
```bash
# 1. 明白要干什么 → 建 + 认领，对话里提到任务 ID。板上已有相关任务则 bd update <id> --claim
dispatch begin "标题" -P <项目> -d "背景+要做什么" -a "- [ ] 验收项一
- [ ] 验收项二"
# 2. 关键进展、决定（= 过程记录，取代 process.md）；--tick "验收项一" 勾掉
dispatch log <id> "做到哪了 / 决定了什么"
# 3. 收尾。没亲手核验不加 --verified（停在「已完成·待审」）；--retro 自动写一条复盘进知识库
dispatch done <id> --reason "做了什么；跑过哪些验证" [--verified] \
  --retro "做了X【技术】用了什么【做对】哪里对【做错】哪里错" [--next "没做完的一件" "另一件"]
```
项目名 = 仓库目录名（kanban、bookmark、HIWI…），标签 `project:<名>`；Dispatch 左栏按它分组，`dispatch prime` 按它筛。

状态：`open` 待做 → `in_progress`（`--claim`）进行中 → `closed` 已完成·待审 → `closed` + 标签 `reviewed` 已审。`blocked` 有未完成依赖（`bd ready` 自动隐藏）。

## 知识库（`dispatch wiki`，存 bd memory）
| 类型 | 何时记 | 命令 |
|---|---|---|
| 坑 `pit` | 返工、卡住几分钟以上、文档/直觉是错的 | `dispatch wiki add --kind pit "现象+原因" --fix "解法" -P <项目> --task <id>` |
| 做对 `win` | 被验证有效、希望别人照做的做法 | `dispatch wiki add --kind win "做法" --why "为什么对" [-P <项目>]` |
| 复盘 `retro` | 任务收尾 | `dispatch done … --retro "…"`（key 自动 `retro-<task>`） |
| 方法 `howto` | 可复用的步骤 / 命令 | `dispatch wiki add --kind howto "…"` |

动手前 `dispatch wiki search <词>`；`dispatch wiki list [--kind pit] [-P 项目]`；`dispatch wiki show <key>`。记「下次怎么不掉进去」，不记「做了什么」。带 `-P` 的条目只注入该项目的会话；不带的是通用条目，每个会话都看到——通用的要少而精。Dispatch「知识库」视图可看、改、删。

## 环境变量 / API Key（`dispatch env`）
密钥统一存 `~/.config/dispatch/env`（0600），不进板、不进 wiki、不进 commit。`dispatch prime` 只列名字和用途；需要时 `dispatch env get NAME`；用户给新 Key 时 `dispatch env set NAME VALUE --note "用途"`（或 `--stdin`）；`dispatch env list`；shell 里 `eval "$(dispatch env export)"`（fish 新终端已自动加载）。

## 派活给别的 Agent / 模型（`dispatch agent`，底层是 Herdr）
要让另一个模型干一件独立的事（比如让 Codex 跑测试、让另一台 Mac 上的 Claude 处理一个目录），不要自己 spawn 子进程，用这几条：
```bash
dispatch agent list [--host mini]                                   # 本机 / Mac mini 的 Herdr 里有哪些 Agent 在跑
dispatch agent start codex --cwd ~/Projects/x --task <id> -p "把测试修好，改完 dispatch log"   # 新标签起一个 Agent，认领任务，发首条提示词，等它做完把输出读回来
dispatch agent start claude --host mini --model claude-sonnet-5 -p "…"                    # 跨机器：在 Mac mini 的无头 Herdr 会话里起
dispatch agent ask <pane|名字|标题|任务ID> "接着把文档补上"          # 给已有 Agent 发一句，默认等它做完并读回输出
dispatch agent read <目标> --lines 80 / wait <目标> / keys <目标> enter / close <目标>
```
kind 可选 claude、codex、qodercli、opencode、gemini 等（Herdr 支持的都行）；`--extra "--effort high"` 透传给 Agent 命令行。`start --task` 会以对应身份（claude→claude-code、codex、qodercli→qoder）认领任务并留一条"谁派给谁"的评论。输出里若出现"stalled"，多半是对方在等一个对话框（信任目录、审查 hooks），用 `keys <目标> enter` 或 `t` 回应。对方做完后照常 `dispatch done`；你负责汇总验证。

## 其他常用
```bash
bd list --status in_progress                 # 谁在做什么；dispatch prime 里的「同目录在跑」是同一目录的活跃会话
dispatch claim <id> [--force]                # 认领守卫：别人正在做的不给抢
# 文件级互斥：hook ~/tasks/.dispatch/edit-guard.py（Claude Edit/Write、Codex apply_patch）——别的会话 30 分钟内改过的文件第一次会被拒并说明，重试放行；登记在 ~/tasks/.dispatch/edits/，prime 的「同目录在跑」会列出对方正在改的文件
dispatch quota                               # 各 Agent 额度；prime 里有你自己的，≥80% 省 token，≥95% 只收尾换 Agent
bd show <id> --json  /  bd ready --json  /  bd blocked
bd create "bug" -l project:xxx -t bug -p 1 --deps discovered-from:<当前id> --json
dispatch sessions | find <task> | resume <task> --copy | focus <task>   # 会话：谁在跑、哪个会话提过这个任务、恢复命令、跳过去
dispatch skills list|enable|disable <名> --agent claude|codex           # 技能池 ~/.cc-switch/skills；Claude 读 ~/.claude/skills，Codex 和 pi 读 ~/.agents/skills（都是软链）
dispatch catalog [-q 词] [--kind skill|plugin]  # 默认不注入的能力：未挂载技能、已禁用插件；有用时建议用户，同意再启用
dispatch rules show|status|sync              # 全局规则唯一来源 ~/.agents/rules/GLOBAL.md
dispatch insights [--days 14] [--copy]       # 跨 Agent 复盘：确认/纠错/溢出信号 + 样本 + 一条改进任务的启动命令（Dispatch 统计页顶部同款）
```
规则：跨会话的任务 / 待办 / 阻塞一律进板，TodoWrite 只做当前回合清单；不要 `bd edit`（会开编辑器）；`bd update --json` 返回数组；没真正完成不 close，`--reason` 写给审核的人看。

## Dispatch 应用
源码 `~/Projects/kanban/app`（Tauri 2 + React；Rust 只包 `bd --json` 和 `dispatch` CLI，逻辑都在 `app/cli/dispatch.py`）。改完跑 `dispatch-update`（构建 → 同步到 /Applications → 重开）。会话检测靠 hook `~/tasks/.dispatch/presence.py`，不要删那个目录。`Dolt server unreachable` → `bd dolt start`（LaunchAgent 每 2 分钟自动拉起）。旧嵌入式数据在 `~/tasks/.beads.embedded`。
- 跨机器同步：mini 是枢纽，它的 Dolt 由 `~/Library/LaunchAgents/dev.schaefer.dolt-server.plist` 直接跑（config.yaml 开了 remotesapi :3309；`bd dolt start` 不读 config.yaml，别用它起）。MacBook 每 2 分钟跑 `app/cli/board-sync.sh`（`CALL DOLT_PULL/DOLT_PUSH('--user','sync',…)`；密码在 `dispatch env` 和 beads-dolt LaunchAgent 环境里；`bd dolt push` 不带 --user，别用）。两边 `dolt.auto-commit: on`，`metadata.json` 的 project_id 必须一致。

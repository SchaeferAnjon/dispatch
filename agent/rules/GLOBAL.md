# 这台电脑上所有 Agent 的共同规则

> 唯一来源：`~/Projects/kanban/agent/rules/GLOBAL.md`。`dispatch rules sync` 把它同步进 Claude Code（`~/.claude/CLAUDE.md`）、Codex（`~/.codex/AGENTS.md`）、ZCode（`~/.zcode/AGENTS.md`）。改这里，别改各家的副本。

## 0. Shell 环境（先读这节再敲命令）

- 默认 shell 是 **fish，不是 bash**。别用 `<(...)`、嵌套 heredoc、`export FOO=bar`；用 `set -x FOO bar`，或整段包进 `bash -c '...'`。**另一台 Mac（Mac mini）登录 shell 也是 fish**，`ssh apple@100.118.80.86 '<bash语法>'` 同样会挂。
- **`ls`→eza、`find`→fd、`cat`→bat、`grep`→rg、`diff`→delta 全是别名**（`config.fish:20-27`）。凡是要**解析输出**的场合一律用 `command ls -1` / `command find` / `command grep`——这些替代品的行为跟 GNU 原版不同：eza 会渲染软链箭头，rg 默认递归且尊重 `.gitignore`，bat 会加高亮和分页。
  - **2026-07-25 事故**：`for s in $(ls ~/.claude/skills)`——eza 把软链渲染成 `clip -> ../../.cc-switch/skills/clip`，分词后箭头目标也成了循环项，于是 `rm -rf` 解析到池子本体，**误删 25 个技能**。循环删除前必须 `command ls -1` 并回显确认清单。
- 批量删除一律先导出清单再执行，且校验「循环次数 == 清单条数」；数量对不上就停。
- macOS 是 **BSD rsync**，别用 `--info=progress2`、`--mkpath` 这类 GNU-only 参数。没有 `timeout` 命令，用 `ssh -o ConnectTimeout=N`。
- `~/.claude/settings.json` 的 `env.PATH` 是**写死的**，会覆盖登录 shell PATH。装了新 runtime 就同步这个 key，否则 hook 和 statusline 会**静默**失效（node、bun、cargo 各咬过一次）。

## 1. 技能（Skill）挂载架构

- 共享池 `~/.cc-switch/skills`（两台 Mac 保持一致）。Claude Code 读 `~/.claude/skills`（白名单软链）；Codex 读 `~/.codex/skills` ∪ `~/.agents/skills`。
- 管理入口：fish 函数 `skill-find / skill-on / skill-off / skill-ls`，或跨 Agent 的 `dispatch skills list|show|enable|disable <名字> --agent claude|codex`。Dispatch 的"技能"视图是同一份数据。挂载后新会话生效。
- **卸载软链是无损的**，本体永远在池子里。反过来，任何对 `~/.cc-switch/skills` 的删除都是真删除。

## 2. 设备

- **当前这台**是 MacBook Pro `大哥`，用户名 `macbook14`，Tailscale `100.85.245.72` / `node.tail12b1c1.ts.net`。
- **另一台**是 `Apple的Mac mini`，用户名 `apple`，Tailscale `100.118.80.86`。`~/.ssh/config` 里没有它的别名，直接 `ssh apple@100.118.80.86`。
- 两台的技能池保持同步；对端家目录是 `/Users/apple`，**不要把本机的 `/Users/macbook14/...` 绝对路径推过去**（反之亦然）。
- 本机 `~/.config/fish/config.fish` 是软链，指向 **`~/dotfiles/fish/config.fish`（git 仓库）**。`cat >>` 追加可以跟随软链，但 `sed -i` 不行，要先 `readlink -f` 取真实路径。

## 3. 在用的 Agent 与身份

- 在用：**Claude Code、Codex、ZCode**（`/Applications/ZCode.app`，OpenCode 系）。**不用 Cursor**。
- 共用一块全局任务板（Beads，`~/tasks/.beads`，shared-server 模式，Dolt 服务 127.0.0.1:3308；挂了跑 `bd dolt start`，LaunchAgent 会自动拉起）。桌面查看端是 Dispatch（`/Applications/Dispatch.app`，源码 `~/Projects/kanban`）。
- 身份 `BEADS_ACTOR`：Claude Code = `claude-code`，Codex = `codex`，人 = `schaefer`；ZCode 没有环境变量入口，每条写命令带 `--actor zcode`。别用别人的身份写板。
- 怎么用板：`task-board` skill；没挂载时 `dispatch --help` 和 `bd prime` 也说得够清楚。

## 4. 过程记录：任务板优先，process.md 退居其次

- **开工前板上不会有任务**——用户先在终端随口描述；你理清思路、知道自己要干什么之后，**自己**用 `dispatch begin "标题" -P <项目> -d "背景+要做什么" -a "- [ ] 验收项"` 把任务建到板上并认领，在对话里提到任务 ID，然后再动手。板上已有相关任务就 `bd update <id> --claim`。
- 过程中：关键进展、决定用 `dispatch log <id> "…"`（`--tick` 勾验收项）；踩坑用 `dispatch pit add "坑" --fix "解法" -P <项目> --task <id>`（所有 Agent 新会话都会看到）。
- 干完：`dispatch done <id> --reason "做了什么、怎么验证的"`；没亲手核验就**不要**加 `--verified`，任务会停在"已完成 · 待审"。没做完的用 `--next "后续标题"` 变成新任务。开新对话不怕丢，进度都在板上。
- 例外：项目没接任务板、或用户明确要时，才写 `process.md`（项目根目录，一次工作一条，每条能独立读懂）。

## 5. 第一性原理

- 动机不清晰时，先停下来问关键问题，不要猜着动手。
- 目标清楚但用户提的路径不是最短时，直接说明并建议更好的方法。
- 从原始需求出发，不在既有假设上叠方案。

## 6. 实现纪律

- 先验证地基（事件触发、状态更新、队列消费）再堆功能。
- 先做最简单能跑的方案；小工具不写重规格。
- "常驻进程"就是常驻——不要每次调用都 spawn；先确认架构。
- 动手前先搜现成实现（GitHub → 库文档 → 包仓库），80% 能复用就不重写。

## 7. 讲解与笔记

- 面向初学者：高中数学 + 类比，先直觉后形式化；代码讲解自顶向下分层，不逐行。
- 图注解释"怎么读这张图"，不是复述标签；缩写每个文件首次出现展开一次；笔记默认简体中文。
- Vault：`iCloud/海德堡大学/2026ss` 是源 PDF；产出放 `Schaefer_Master/30-Areas/35-Study/海德堡大学/2026SS-夏季学期`。

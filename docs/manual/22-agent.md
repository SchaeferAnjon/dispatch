# Agent 侧约定

> 这一页解决什么：Agent 是怎么知道任务板的、它该在什么时候跑哪条 `dispatch` 命令、提交信息怎么写才能和任务对上、成果怎么登记。这些约定写在随应用分发的 `task-board` 技能里（`agent/skills/task-board/SKILL.md`），这里是给人看的版本。

## Agent 怎么知道这些

- 首次设置第 4 步给 Claude Code 装 hook：`SessionStart` 时跑 `dispatch prime --hook-json`，把一段摘要注入到会话开头；其他事件（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Notification`、`PermissionRequest`、`Stop`、`SessionEnd`）上报会话状态（工作台的「在跑 / 等你」靠它），编辑类工具前后跑编辑互斥检查。
- 第 5 步把共同规则同步进每个 Agent 的入口文件，并把 `task-board` 技能挂到技能池；Codex、pi、ZCode（`dispatch zcode-plugin install`）等通过规则和技能知道同样的事。
- `dispatch prime` 注入的内容：你是谁（Agent 身份）、当前项目、任务怎么记的一句话、板上本项目的任务（进行中的、派给它的、用户在任务上未回复的留言）、追踪中的会话、本项目和通用的知识库条目、常用信息、密钥名（不含值）、额度、同目录里还有谁在干活。

## 任务的生命周期

```bash
dispatch begin "<对象> <怎么改>：<为什么>" -P 项目 -d "触发原因 + 期望结果" -a "- [ ] 验收项"
dispatch claim TASK_ID                     # 认领已有任务；别人正在做会拒绝，--force 才抢
dispatch log TASK_ID "关键进展"             # 进展记录；--tick 关键词 勾掉验收项
dispatch done TASK_ID --reason "交付与验证" --verified --retro "【技术】…【做对】…【做错】…"
```

规则：

- **标题**要让几周后冷读的人一眼知道改了什么、为了什么（例：「会话页 diff 改成可横向滚动：手机上右半截被截掉」）。8 到 80 字；太短或只有动词会被 `begin` 拒绝；超过 40 字在标点处截断，完整标题自动记进描述第一行。描述至少 20 字，写触发原因和期望结果。`--force` 跳过检查。
- `begin` 在会话身份可用时自动打 `session-origin:<会话id>` 和 `session:<会话id>` 标签，这就是任务和会话的正式关系；`--session` 可显式指定。
- `--verified` 只表示亲手验证过，不是独立复核；它会把还没勾的验收项全部打勾并署名（界面显示「自审 · &lt;Agent&gt;」）。分项核过就 `dispatch log ID --tick 关键词`。
- `--retro` 一两句即可，进知识库；`--next "后续标题"` 建后续任务；`--review-by <agent>` 请求另一个 Agent 复核（`dispatch review ID --verdict pass|changes --reason`，复核者不能是执行者）。
- 未完成的任务不关闭。`bd show ID --json` 看任务，`bd update ID` 改字段；不用会打开编辑器的 `bd edit`。

## 只有用户能做的事

```bash
dispatch need-you "要用户做什么" -P 项目 -d "为什么、怎么做、材料在哪" [--task TASK_ID]
```

发邮件、付款、登录、当面演示、做决定这类事，别只写在回复里，记成「只能你做」，用户在项目页任务标签上打勾关闭，手机也会收到推送（如果开了）。

## 提交信息带任务 id

提交信息末尾带任务 id：`feat: 会话页 diff 可横向滚动 (task-abc)`；或在 `done --reason` 里写 commit 哈希。任务页「Git 提交」和 `dispatch commits ID` 靠这个把任务和代码对上；一个任务多个提交就每个都带。提交信息用 `<type>: <desc>`。

## 知识库

```bash
dispatch wiki search "关键词"                 # 动手前先查；--semantic 按意思
dispatch wiki add --kind pit "现象" --fix "解法" -P 项目 [--task ID]
dispatch wiki add --kind win "做法" --why "为什么对" -P 项目
dispatch wiki add --kind howto "步骤"
```

## 成果登记

成果是带标签的 Beads 记录。Agent 用 `bd create`：

```bash
bd create "成果标题" -d "交付了什么、在哪看（Markdown，可带文档 / 截图 / 版本 / 代码链接）" \
  -l dispatch:outcome -l project:<项目> -l outcome-task:<task-id> -l session:<会话id>
bd close <新 id> --reason "已登记项目成果"
```

用户也可以在项目页「成果」标签登记或编辑。不要根据提及次数批量写归属，也不要把所有已完成任务自动复制成成果。

## 其他常用命令

```bash
dispatch here [--dir <cwd>] [-P 项目]     # 这个项目此刻：现状、14 天时间线、没做完的任务、活会话可关否
dispatch editing [--dir <cwd>]           # 谁在改哪些文件；两个以上会话改同一个会标冲突
dispatch lineage [-P 项目]                # 项目 → 任务 → 会话 → 进展
dispatch facts get "主题" [-P 项目]       # 常用信息
dispatch env get NAME                     # 取密钥值（prime 只列名字）
dispatch profile add "事实" / upcoming "2026-09-20|事项|待办" "说明" / done <关键词>
dispatch docs add <项目> <路径|URL> --kind 调研|复审|设计|文档|其他   # 调研、复审产出登记到项目页「文档」
dispatch notify "标题" "正文"              # 推一条到手机或 Mac
dispatch terminal --cwd <目录>            # 在 Herdr 开个不带 Agent 的终端标签
dispatch adopt <会话id|pid-N>             # 把别的终端里的会话接进 Herdr
dispatch agent start <kind> --cwd … --task <id> -p "…"   # 派活给别的 Agent（底层 Herdr）
```

## 标签一览（任务板上的约定）

| 标签 | 含义 |
|:--|:--|
| `project:<名>` | 所属项目 |
| `session-origin:<id>` | 发起会话，`begin` 自动记 |
| `session:<id>` | 明确关联的发起或参与会话，可多个 |
| `dispatch:outcome` | 成果记录，不进普通任务计数 |
| `outcome-task:<task-id>` | 成果来源任务，可多个 |
| `dispatch:needs-you` | 只能你做 |
| `dispatch:trashed` / `dispatch:archived` | 回收站 / 已归档 |
| `delegated-by:` / `delegated-to:` | 谁派给谁 |
| `host:<机器>` | 在哪台机器上做过 |
| `dispatch-projects`（memory） | 项目收藏与归档状态；`dispatch-` 开头的记忆不进知识库和 prime |

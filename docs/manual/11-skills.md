# 技能

> 这一页解决什么：技能池里有什么、每个技能挂给了谁、怎么在应用里改 SKILL.md、新建或从 GitHub 导入一个技能。

## 技能池

技能是带 `SKILL.md` 的目录，统一放在 `~/.cc-switch/skills`（技能池）。Agent 用的是软链：挂给 Claude Code 就链到 `~/.claude/skills`，挂给 Codex 就链到 `~/.agents/skills` 或 `~/.codex/skills`。挂载在新会话生效；卸载只删软链，本体不动。目前只支持挂给这两个 Agent。

页面顶部一行「改的是 <机器>」：侧栏选了另一台机器时改的是那台（离线时会说明原因）。

## 左侧列表

- 搜索技能名和描述；按「全部 / Claude Code N / Codex N」筛选。
- 「按使用频次」排序：来自会话索引里的调用次数（C = Claude Code，X = Codex；Codex 和 ZCode 不记录技能调用）。
- 每条：名字、「只装在一处」（不在技能池里、只装在某个 Agent 目录下的），调用次数，描述，两个挂载标记。
- 「✦ 按最近工作流改进技能」：复制一条启动命令，在终端粘贴运行，Agent 会按最近 14 天的会话审查并改进最常用的技能。
- 「＋ 新建技能」：技能名（目录名）、一句话触发描述、触发条件、关键约束、挂给谁；按 SKILL.md 模板建到技能池并挂载。
- 「从 GitHub 导入」：填 `owner/repo` 或仓库 URL（可指定子目录和落到池里的名字），下载公开仓库，把 SKILL.md 目录拷进技能池；仓库没有 SKILL.md 时生成一个待提炼的入口，来源和 LICENSE 一并记下。

右键技能：查看、挂给 / 从 … 卸载、用编辑器打开、在访达中打开、复制路径、复制 SKILL.md 内容、移到废纸篓（或卸载挂载）。空白处右键：刷新技能列表、按最近工作流改进技能、在访达中打开技能池。

## 右侧详情

技能名、路径、当前打开的文件（默认 SKILL.md，Markdown 里的相对链接会在技能目录内跳转，「这个技能的文件 · N」列出所有文件）。按钮：在访达中打开、用编辑器打开、「在这里改」（应用内编辑，<kbd>⌘S</kbd> 保存，旧版本留在 `.bak`）。下面两行挂载勾选框：Claude Code、Codex，各自显示挂载目录。

## 命令行

```sh
dispatch skills list --json
dispatch skills show <名> [--file detail-04.md]
dispatch skills enable <名> --agent claude    # 或 codex / all；不传 = 两个都挂
dispatch skills disable <名> --agent codex
dispatch skills new <名> --description "…" --trigger "…" --constraint "…" --agent claude
dispatch skills import owner/repo [--path skills/pdf] [--as 名字] [--force]
dispatch skills open <名> [--reveal]
dispatch skills trash <名>
```

`dispatch catalog` 列出默认没挂的技能和插件；Agent 判断明显有用时会建议启用。

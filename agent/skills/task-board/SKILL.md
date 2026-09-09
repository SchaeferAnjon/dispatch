---
name: task-board
description: "操作 Dispatch 任务、知识库、配置或跨 Agent 会话时用。"
---

# task-board

中央板 `~/tasks/.beads`；优先使用已注入的 prime，身份以当前会话配置为准。

```bash
dispatch begin "<对象> <怎么改>：<为什么>" -P 项目 -d "触发原因 + 期望结果" -a "- [ ] 验收项"
dispatch claim TASK_ID
dispatch log TASK_ID "关键进展"
dispatch done TASK_ID --reason "交付与验证" --verified
dispatch wiki search "关键词"
dispatch editing [--dir <cwd>]   # 谁在改哪些文件；两个以上会话改同一个会标冲突
dispatch wiki add --kind pit "现象" --fix "解法" -P 项目
dispatch facts get "主题"
dispatch notify "标题" "正文"          # 想让人知道就推一条：ntfy / Bark（dispatch env 配），没配就本机通知
```

标题要让几周后冷读的人一眼知道改了什么、为了什么（「会话页 diff 改成可横向滚动：手机上右半截被截掉」），描述写触发原因和期望结果；太短或只有动词的标题 `begin` 会拒绝。提交信息末尾带任务 id（`feat: … (task-abc)`），或在 `done --reason` 里写 commit 哈希：任务页「Git 提交」和 `dispatch commits ID` 靠这个把任务和代码对上；一个任务多个提交就每个都带。`--verified` 只表示亲手验证，它会把还没勾的验收项全部打勾并署上你的名字（界面显示「自审 · 你」）；分项核过就随手 `dispatch log ID --tick 关键词`，同样署名。未完成的任务不关闭。收尾顺手 `--retro "【技术】…【做对】…【做错】…"`，一两句即可，它会进知识库。`bd show ID --json` 查看任务；`bd update ID` 修改字段（JSON 返回数组）；不用会打开编辑器的 `bd edit`。
规则同步用 `dispatch rules status|sync`；技能挂载用 `dispatch skills list --json` 和 `enable|disable NAME --agent claude|codex`。其他参数查对应 `--help`。
调研、复审产出写到项目的 `design/` 目录（或 `dispatch docs add <项目> <路径|URL> [--kind 调研|复审|设计|其他]` 登记），项目页「文档」标签就能看到并在应用里直接读；`dispatch docs <项目> --json` 列出来。
复盘：`dispatch insights` 是正则数出来的行为信号（纠错、问句收尾、溢出、工具报错、没上板）；`dispatch insights report` 让模型写一份跨 Agent 的 /insights 式报告（`list|show|open`，`schedule --every 14` 定期）。被派去「做改进」时先 `dispatch insights show latest --json` 读 friction / suggestions 两节再动手。
会话在别的终端（Warp / iTerm / Terminal）里跑、想让 Dispatch 接管：`dispatch adopt <会话id|pid-N>`——它停掉空闲的原进程，在 Herdr 新标签里 `--resume` 同一会话。

只有相应任务需要时读取以下参考，维护 Dispatch 应用的细节不适用于普通任务：
- [环境变量 / API Key（`dispatch env`）](detail-04.md)
- [派活给别的 Agent / 模型（`dispatch agent`，底层是 Herdr）](detail-05.md)
- [讨论后分工（动态工作流，`dispatch discuss` / `dispatch split`）](detail-06.md)
- [Dispatch 应用](detail-08.md)

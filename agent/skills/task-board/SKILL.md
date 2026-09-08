---
name: task-board
description: "操作 Dispatch 任务、知识库、配置或跨 Agent 会话时用。"
---

# task-board

中央板 `~/tasks/.beads`；优先使用已注入的 prime，身份以当前会话配置为准。

```bash
dispatch begin "标题" -P 项目 -d "目标与背景" -a "- [ ] 验收项"
dispatch claim TASK_ID
dispatch log TASK_ID "关键进展"
dispatch done TASK_ID --reason "交付与验证" --verified
dispatch wiki search "关键词"
dispatch wiki add --kind pit "现象" --fix "解法" -P 项目
dispatch facts get "主题"
```

`--verified` 只表示亲手验证；未完成的任务不关闭。收尾顺手 `--retro "【技术】…【做对】…【做错】…"`，一两句即可，它会进知识库。`bd show ID --json` 查看任务；`bd update ID` 修改字段（JSON 返回数组）；不用会打开编辑器的 `bd edit`。
规则同步用 `dispatch rules status|sync`；技能挂载用 `dispatch skills list --json` 和 `enable|disable NAME --agent claude|codex`。其他参数查对应 `--help`。

只有相应任务需要时读取以下参考，维护 Dispatch 应用的细节不适用于普通任务：
- [环境变量 / API Key（`dispatch env`）](detail-04.md)
- [派活给别的 Agent / 模型（`dispatch agent`，底层是 Herdr）](detail-05.md)
- [讨论后分工（动态工作流，`dispatch discuss` / `dispatch split`）](detail-06.md)
- [Dispatch 应用](detail-08.md)

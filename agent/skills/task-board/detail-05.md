# 派活给别的 Agent / 模型（`dispatch agent`，底层是 Herdr）

```bash
dispatch agent list [--host mini]                                   # 本机 / Mac mini 的 Herdr 里有哪些 Agent 在跑
dispatch agent start codex --cwd ~/Projects/x --task <id> -p "把测试修好，改完 dispatch log"   # 新标签起一个 Agent，认领任务，发首条提示词，等它做完把输出读回来
dispatch agent start claude --host mini --model claude-sonnet-5 -p "…"                    # 跨机器：在 Mac mini 的无头 Herdr 会话里起
dispatch agent ask <pane|名字|标题|任务ID> "接着把文档补上"          # 给已有 Agent 发一句，默认等它做完并读回输出
dispatch agent read <目标> --lines 80 / wait <目标> / keys <目标> enter / close <目标>
```
kind 可选 claude、codex、opencode、gemini 等（Herdr 支持的都行）；`--extra "--effort high"` 透传给 Agent 命令行。`start --task` 会以对应身份（claude→claude-code、codex）认领任务并留一条"谁派给谁"的评论。输出里若出现"stalled"，多半是对方在等一个对话框（信任目录、审查 hooks），用 `keys <目标> enter` 或 `t` 回应。对方做完后照常 `dispatch done`；你负责汇总验证。

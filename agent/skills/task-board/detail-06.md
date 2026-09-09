# 讨论后分工（动态工作流，`dispatch discuss` / `dispatch split`）

**只在用户当前对话里明确要求「让几个 Agent 讨论」时才用，不要自己发起**——每个参与者都是一整个新会话的 token。派活（`dispatch agent start`）不受此限。
一件事拿不准怎么拆、想让几个模型先各说一次再分工：
```bash
dispatch discuss <id> --with codex,claude:haiku,pi [--leader pi] [-q "想让他们决定什么"] [--rounds 2] [--conclude]   # 无头直调：claude -p / codex exec / pi -p 并行，CLI 把线程喂进提示、把回复写成【讨论】评论；回 SKIP 的不上板
dispatch discuss --topic "一个念头" [-P 项目] --with …                                          # 没有任务：建一个【讨论】任务承载
dispatch discuss-conclude <id>          # 写（覆盖）结论：任务描述里的 `## 讨论结论` 只有一条
dispatch discuss-doc <id>               # 收尾：先写结论，再整理成文档（背景/结论/方案/步骤/风险/验收）写进描述，可重复
dispatch split <id> --to codex:"子任务标题|说明" --to claude:"…" [--no-start]           # 你拍板：按讨论建子任务（parent-child，带 discussed-in:<id>），起对应 Agent 开始做；父任务留【分工】记录
```
`--leader kind[:model]` 指定领队（不在 --with 里会自动加进去）：它每轮最后发言并归纳，结论和文档由它的模型写（描述里记「领队：kind:model」，界面派活默认选它）。每个成员的会话记在 `~/tasks/.dispatch/discussions/<id>.json`，下一轮 `--resume` 只喂新增发言（`--fresh` 重来）；人设和长度规矩在 `dispatch settings`（discuss_rules、discuss_persona_claude/codex/pi），进系统提示。结论不再每轮自动写；连续两轮没人有新话（都 SKIP 或只剩一句）CLI 会提示收尾。`--tui` 或 `--host` 走原来的 Herdr 标签页路径（自动模式：Codex `--dangerously-bypass-approvals-and-sandbox`，Claude `--dangerously-skip-permissions`，启动对话框自动应答）。子任务各自 `dispatch done`，父任务由发起者收尾。界面：侧栏「讨论」页（`#/discuss/<id>`）列出全部讨论，左栏结论与文档、右栏群聊；「讨论一个念头」对话框实时画打字气泡（`dispatch discuss-live <id>` 读 `<id>.live.json`），任务详情「讨论与分工」块。

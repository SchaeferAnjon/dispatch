# 讨论后分工（动态工作流，`dispatch discuss` / `dispatch split`）

**只在用户当前对话里明确要求「让几个 Agent 讨论」时才用，不要自己发起**——每个参与者都是一整个新会话的 token。派活（`dispatch agent start`）不受此限。
一件事拿不准怎么拆、想让几个模型先各说一次再分工：
```bash
dispatch discuss <id> --with codex,claude [-q "想让他们决定什么"] [--rounds 2] [--close]   # 依次起每个 Agent（自动模式），各读任务和前面的【讨论】发言，只留一条 dispatch log "【讨论】…" 就停；结束打印全部发言
dispatch split <id> --to codex:"子任务标题|说明" --to claude:"…" [--no-start]           # 你拍板：按讨论建子任务（parent-child），打 delegated-by/to 标签，起对应 Agent 开始做；父任务留【分工】记录
```
Dispatch CLI 派出的 Agent 会以自动模式启动（Codex `--dangerously-bypass-approvals-and-sandbox`，Claude `--dangerously-skip-permissions`），启动对话框（信任 hooks / 目录）会被自动应答。子任务各自 `dispatch done`，父任务由发起者收尾。界面：任务详情「讨论与分工」块，Agent 状态页看派出/接到。

# 会话页看不到「进行中」——流式思考/工具调用调研

调研目的：Dispatch 现在解析的都是"事后"的转录文件——会话页 `read_session_detail`（`app/cli/dispatch.py:1474`）一次性读完 `.jsonl`，只吐出「完整的用户/助手文字 + 工具名列表」；用户从没在 Dispatch 里见过别的 Agent UI 里那种「思考中…」「调用 Bash…」「读文件…」的实时推进感。本文核实这些实时感从哪来、我们的转录文件里到底有没有这些数据、以及为什么现有解析器看不到，最后给出 Dispatch 的落地方案。

结论先说：**数据在本地文件里已经有了**（thinking 块、工具调用的完整输入输出、时间戳，四种 Agent 格式都有），现有 CLI 解析器**把它们都扔了**；Dispatch 还已经有一套增量 tail 转录文件的机制（`activity.py` 的 `streams` 表）和一套走 headless `stream-json` 的实时打字气泡（discussions 功能），只是两者都没有覆盖到"思考块 + 工具调用状态"这一层，也没有接到会话页。把这两块打通、再用已经装好的 `@assistant-ui/react`（MIT，`app/package.json` 已声明 `^0.15.18`，`DiscussChat.tsx` 已在用）补上 `Reasoning` / 工具调用卡片组件，就是最短路径。

---

## 1. 别的 UI 怎么渲染「进行中的一轮」

| UI | 思考/推理 | 工具调用 | 正文流式 | 传输方式 |
|---|---|---|---|---|
| **Claude Code CLI**（Ink 终端 UI） | 每次会话默认折叠；`Ctrl+O` 整体展开/折叠详情（不是逐块），旋转的动词（"Pondering…" 等，可在 `~/.claude/settings.json` 自定义 `spinnerVerbs`）+ 一个跳动的 "∴" 指示灯；是否显示可读摘要还受服务端 `showThinkingSummaries` 开关控制 | 渲染成状态指示组件（pending/running/done），结果做压缩摘要 | 消费的是下面第 2 节的 `stream_event` delta，逐 token 大概率成立，但官方文档未明确写出这一细节（标记为推断） | 本地进程内直连 API 流 |
| **Claude Code on the web / mobile** | 官方文档未说明思考块的实时渲染机制；已知分享出去的**只读**链接打开时看到的是"当时的最新状态"，不是实时；owner 自己的移动端"远程控制"号称和桌面端完全一致 | 同上，未见文档细节 | 同上 | 未公开（推测仍是同一套会话状态同步，机制未文档化） |
| **Codex CLI（终端）** | 推理**整段完成后才显示**，不是边推理边出字（GitHub issue #8204/#5339 长期未解决）；还有个已确认的渲染 bug（#16801）：推理摘要有时因为事件顺序问题根本没画出来 | 命令执行成功后**自动折叠**；执行过程中的 stdout **不会**实时流入 TUI（#4751 长期 open），要看完整命令得按 `Ctrl+T` | 有 | 本地进程内直连 Responses API 流 |
| **Codex 桌面 App（Mac）** | 据 issue #10723/#27197：**完全不展示**推理摘要或过程，只有一个"Thinking"的短暂闪烁状态然后直接出最终答案——即使 `model_reasoning_summary` 已经配置好，是客户端没做，不是 API 限制 | 同 CLI，但更少 | 有 | 同上 |
| **Codex 网页版**（chatgpt.com/codex） | 展示"可见推理、工具活动、Markdown 正文"（官方产品页描述），有推理力度调节的"composer gauge" | 任务视图里的状态 chip（"Ran command"/"Ready"等） | 有 | 未公开协议细节 |
| **Codex 移动端** | 手机端本身不跑模型，是给 Mac 上正在跑的会话扫码"镜像"进度，用 iOS Live Activities 做后台提示 | 同上 | 有 | 未公开协议细节 |
| **OpenCode（TUI + Web）** | `/thinking` 命令可切换推理块可见性；后端发细粒度 SSE：`session.reasoning.delta`、`session.text.delta`、`session.tool.input.delta`、`session.step.started`，前端（TUI 用 SolidJS）用 reducer + `coalesceServerEvents` 把增量事件叠到本地状态上重渲染，不是轮询存储文件 | `/details` 命令切换详情；工具卡片带 `state.status: pending/running/completed/error` | 逐 delta 流式 | SSE（`/api/event` 或 `/global/event`），落盘到 `~/.local/share/opencode/storage/part/<messageID>/*.json` 作为持久层，与流式渲染并行 |
| **pi** | session 里有 `thinking`（`thinking`+`thinkingSignature`+`redacted?`）块，官方有 session-format 文档；但公开渲染细节没有文档，只知道编辑器边框颜色会反映"思考强度"、底部栏显示 session/cost/context | `toolCall` 块（`name`/`arguments`/`id`/`thoughtSignature?`） | 有 | 未公开 |
| **Open WebUI** | 检测流里的 `<think>…</think>` 标签，渲染成 `<details type="reasoning"><summary>Thought…</summary>` 折叠块 | 工具调用/结果串在同一条折叠流里 | 有 | 目前是**源码可见但非 OSI 开源**的自定义 "Open WebUI License"（2024 年后的提交不再是 BSD-3-Clause），照抄代码要注意许可证 |
| **LibreChat** | `thinkingDisplay` 配置项控制链式思考可见性；Subagent 面板展示步骤/工具/消息但不展示原始推理文本 | 近期重做了工具调用 UI，往"按阶段分组的卡片"方向走 | 有 | MIT |
| **LobeChat** | 内置 CoT/"Thinking" 可视化 | 有函数调用/插件 UI | 有 | 主应用 Apache-2.0，`lobe-ui` 组件库 MIT |
| **Cherry Studio** | 有"推理块"插入/保留逻辑（配合工具调用/联网搜索） | 有 | 有 | AGPL-3.0（社区版） |
| **assistant-ui**（React 组件库，**我们已经用了**） | `Reasoning` 组件：折叠触发器（脑图标+chevron）、流式时有 shimmer + 已用时长（"Reasoning (12s)"）、自动滚到最新 token、手动上滑会暂停自动滚动；`status: "running"\|"complete"` | `makeAssistantToolUI` / `ToolCallMessagePartProps`：`args`、`argsText`、`result`（流式中可能是部分结果）、`isError`、`status.type: running\|complete\|incomplete\|requires-action` | `useSmooth`（我们 `DiscussChat.tsx` 已在用）把轮询到的整段文本重新"匀速打出来" | 库本身不关心传输层，喂什么状态就渲染什么 |
| **Vercel AI SDK `UIMessage.parts`**（事实标准，上面几家都在照抄这个形状） | `ReasoningUIPart{type:'reasoning', state:'streaming'\|'done', providerMetadata}` | `ToolUIPart{type:'tool-${NAME}', toolCallId, input, output, errorText, state: input-streaming→input-available→[approval]→output-available\|output-error}` | `TextUIPart{state:'streaming'\|'done'}` | — |
| **Cursor** | Agent 面板可折叠"thinking"块（3.0 之前有个流式中无法展开的 bug，已修） | 文件编辑渲染成可逐条 accept/reject 的 diff；2.4 加了子 Agent，各自跑完把结果汇报回主线程 | 有，带闪烁光标 | 闭源，未公开协议 |
| **Windsurf (Cascade)** | 公开资料只提"agent's reasoning"会实时流到配套视图，没有专门命名的"thinking"组件 | 编辑先暂存成可逐步 approve 的 diff 再落盘，单次提示最多约 20 次工具调用 | 有 | 闭源，未公开协议 |

## 2. 数据从哪来（技术底层）

### 2.1 Anthropic Messages API：thinking 内容块 + 流式事件

- 完整消息里的思考块：`{"type":"thinking","thinking":"...","signature":"..."}`；被安全审查打码时是 `{"type":"redacted_thinking","data":"<加密串>"}`（无可读文本）。
- 流式顺序：`content_block_start`（`content_block.type:"thinking"`，此时 `thinking`/`signature` 为空）→ 若干个 `content_block_delta`（`delta.type:"thinking_delta"`，`delta.thinking` 是文本片段）→ 一个 `content_block_delta`（`delta.type:"signature_delta"`）→ `content_block_stop`。text/tool_use 块同构，分别用 `text_delta` 和 `input_json_delta`（`delta.partial_json`，需要自己拼起来才是完整工具入参）。
- `thinking.display` 参数控制可见性：`"omitted"` 只给 `signature_delta`、不给 `thinking_delta`；`"updates"`（beta）只流"阶段性进展"子块。

### 2.2 Claude Code CLI 的 `--output-format stream-json`（headless）

Dispatch 自己的 `headless_call()`（`app/cli/dispatch.py:4291`）已经在用这个模式跑 discussions 功能，加 `--include-partial-messages` 会额外吐出 `type:"stream_event"` 行，**原样包住 2.1 的 Anthropic 原始 SSE 事件**。我本地跑了一次最小复现（`claude -p "..." --output-format stream-json --verbose --include-partial-messages`），确认了真实的事件序列：

```
system(init) → system(status:requesting)
→ stream_event(message_start)
→ stream_event(content_block_start, type:text)
→ stream_event(content_block_delta, text_delta) × N
→ assistant（完整消息，工具调用后会重复出现一次）
→ stream_event(content_block_stop)
→ stream_event(message_delta) → stream_event(message_stop)
→ rate_limit_event
→ result（最终一行，带 usage/cost/session_id）
```

Dispatch 现在的 `stream_line()`（`dispatch.py:4304` 附近）只处理了 `delta.type=="text_delta"` 来喂"正在打字"气泡，**没有处理 `thinking_delta` 和 `input_json_delta`**——这是 discussions 功能本来就没打算展示工具调用/思考过程，不是 bug，但正好是我们要扩展的地方。

### 2.3 各家本地转录文件——实测结果（不是查文档，是直接 grep 本机文件）

**Claude Code**：`~/.claude/projects/*/*.jsonl`

用当前项目一个真实会话（`936437db-...jsonl`）统计内容块类型：

```
tool_use: 69  tool_result: 69  thinking: 34  text: 16
```

`thinking` 块**不是空的**——另外三个会话里抓到的真实内容（这就是 Claude 那种"先说结论式"思考摘要）：

> "现状已理清：`Discuss.tsx`的群聊界面是手写的……先查一下相关包和体积基线。"

关键发现：**同一条助手消息的 thinking/text/tool_use 三个内容块被拆成三条独立的 jsonl 行**，各自带 `apiBlockIndex`（0/1/2）和**各自的 `timestamp`**——即某个块"写完"就落一行盘，不是整条消息攒齐了才写。三行时间戳依次是 `16:47:29.866` → `16:47:30.451` → `16:47:32.032`，间隔和每个阶段实际耗时对得上。这意味着**只要持续 tail 这个文件，就能拿到「正在想 → 正在打字 → 调用了工具」这种块级实时进度，完全不需要接 Anthropic 的 SSE 流或改 Claude Code 本身**。

工具结果同理：`tool_use` 块（在 assistant 行里）先落盘，随后一条独立的 `user` 行带 `{"type":"tool_result","tool_use_id":...,"content":...,"is_error"?}` 才落盘——中间这段时间差就是"运行中"状态。

**Codex**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

实测一个真实 rollout 文件里的 `reasoning` 条：

```json
{"type":"response_item","payload":{"type":"reasoning","id":"rs_...","summary":[],"encrypted_content":"gAAAAA..."}}
```

`summary` 是空数组——不是我们解析错了，是这次会话的 `model_reasoning_summary`（Codex 的 `config.toml` 配置项，对应 Responses API 的 `reasoning.summary` 请求参数，取值 `auto`/`concise`/`detailed`/`none`）没有让服务端生成可读摘要，磁盘上就只留加密的 `encrypted_content`。也就是说 **Codex 会话能不能看到可读的思考文字，取决于对方发起会话时的 reasoning summary 配置，Dispatch 读不到我们没有的东西**；但字段本身（`payload.type=="reasoning"`）是稳定的，等对方开了 summary，我们的解析器就能顺手捞到。

**pi**：`~/.pi/agent/sessions/**/*.jsonl`

实测：`thinking: 43, toolCall: 74, text: 76`（某个真实任务会话）。thinking 块**有真实文本**：

```json
{"type":"thinking","thinking":"Let me look at the repo structure, existing CLI, and ProjectHub.tsx.\n\nAlso check the comment on the task.","thinkingSignature":"reasoning_content"}
```

**zcode / OpenCode**：`~/.local/share/opencode/storage/part/<messageID>/*.json`（Dispatch 里走 `zcode_query` 从本地 SQLite 读，见 `read_zcode_detail`，`dispatch.py:1445`）

实测一条真实 `reasoning` part（412 字符的完整思考文本）：

```json
{"type":"reasoning","text":"The user wants me to fix a Telegram Bot webhook issue...","metadata":{"anthropic":{"signature":"EsMECkYICx..."}},"time":{"start":1770817944394,"end":1770817946628}}
```

`tool` part 结构最完整，直接带状态机：

```json
{"type":"tool","callID":"...","tool":"read","state":{"status":"completed","input":{...},"output":"...","title":"...","metadata":{...},"time":{...}}}
```

`state.status` 实测出现过 `completed` 和 `error` 两种值（大概率还有 `pending`/`running`，只是这条会话跑完了没抓到中间态）。**这是四家里现成状态机最完整的一份**，因为 OpenCode 后端本来就是按 pending→running→completed/error 管理生命周期再落盘的。

## 3. 为什么 Dispatch 现在看不到

`read_session_detail`（`dispatch.py:1474`）和它的三个变体（`read_zcode_detail`、codex 分支、pi 分支）在同一份代码里，问题是同构的：

| 环节 | 现状 | 代码位置 |
|---|---|---|
| 读取方式 | 会话页打开时**一次性读完整个 jsonl**，不是持续 tail；关掉再打开才会看到新内容 | `dispatch.py:1481` `with open(path) as f: for line in f` |
| thinking 块 | **完全没有分支处理**——`_block_text()` 只挑 `type=="text"`，assistant 分支的 for 循环只 `if b.get("type")=="tool_use"` | `dispatch.py:1435`（`_block_text`）、`1573`（assistant 内容遍历） |
| zcode 的 reasoning part | 同样没有 `elif p.get("type")=="reasoning"` 分支，直接跳过 | `dispatch.py:1445` `read_zcode_detail` |
| pi 的 thinking 块 | `blocks` 遍历只在 `b.get("type")=="toolCall"` 时才处理，thinking 块混在别的类型里被忽略 | `dispatch.py:1496` |
| codex 的 reasoning payload | 分支只处理 `message`/`function_call`/`custom_tool_call`，没有 `elif p.get("type")=="reasoning"` | `dispatch.py:1507` |
| tool_result | 读到就 `continue`，注释直接写"tool results are noise for the timeline" | `dispatch.py:1550` |
| 工具调用状态 | 只存一个 `summary` 字符串（命令/路径/描述），没有 pending/running/done，也没有把 `tool_use.id` 和后续 `tool_result.tool_use_id` 关联起来（虽然 id 已经存了，`dispatch.py:1580`） | `dispatch.py:1575-1581` |
| 前端渲染 | `Sessions.tsx` 把 `tools` 渲染成一排 `<span class="tool-chip">` 纯文字，没有状态、没有结果、没有思考块 | `app/src/components/Sessions.tsx:29`、`:286` |

**但 Dispatch 并不是没有实时基础设施**——两块现成的东西目前都没接到会话页：

1. **`activity.py` 的增量 tail**（`app/cli/activity.py:225`）：一张 `streams` 表按 `(path)` 存 `inode/offset/mtime`，`read_stream()` 每次只读上次游标之后新增的字节，靠 `dispatch activity` 轮询驱动（`activity_list()` 用 `os.stat().st_mtime` 排序扫 `.claude/projects` 和 `.codex/sessions`）。但它的 `observe()` 函数把每次新增内容压缩成**一个粗粒度状态字符串**（`state`/`activity`，比如"正在处理"/"已执行 · Bash"），块级细节（thinking 原文、完整工具入参、逐 delta）全部被丢弃，且只用于"未读回执/活动列表"，从没喂给会话详情页。
2. **discussions 的打字气泡**（`headless_call()` + `DiscussionLive`，`dispatch.py:4291/4448`）：已经在用 `stream-json --include-partial-messages`，`stream_line()` 把 `text_delta` 攒成 `partial` 数组实时 emit "typing" 状态，写进 `discussions/<task>.live.json`，前端 `DiscussChat.tsx` 轮询这个文件，用 assistant-ui 的 `useSmooth` 把整段文本"匀速重新打出来"，未产出文字时用 CSS 三点动画（`.disc-dots`，`app/src/styles.css:1256`）。但这套东西只服务于 headless 发起的"讨论"场景，**不处理 thinking_delta / input_json_delta，也不覆盖交互式会话（用户直接在终端敲的那种）**。

## 4. Dispatch 的落地设计

### 4a. 实时模式（会话正在跑的时候）

把 `activity.py` 现有的 `streams` 游标机制**升级**成保留结构化 block 序列，而不是压成一句 `activity` 摘要：

- 轮询频率延续现在 `dispatch activity` 已有的节奏（1-2s），不需要 inotify/FSEvents——`read_stream()` 的 inode+offset+mtime 短路判断已经保证没有新字节时是 O(1)。
- 关键洞察（第 2.3 节验证过）：**Claude Code/pi 的交互式转录本身就是按"块完成"逐行落盘的**，不需要接 SSE 就有块级实时性；粒度是"这块想完了""这条工具调用发出去了""这条工具结果回来了"，不是逐 token，但正好够渲染"思考中…/调用 Bash…/读文件…"这类阶段提示。
- 新增一个 block 分类器（可以就叫 `observe_blocks()`，与现有 `observe()` 并存或替换），按行输出 `{type: thinking|text|tool_call, ...}`，工具调用维护 `pending → running → done/error` 状态机：`tool_use` 行出现即 `pending`/`running`，匹配到同 `id` 的 `tool_result` 行才转 `done`/`error`。
- 会话页需要一个新端点/轮询通道（比如 `dispatch session <id> --live` 或直接让现有 `dispatch session` 命令在检测到"这是当前活跃会话"时带上增量 block），前端会话页打开时如果这是一个"在跑"的会话就切到轮询模式。

### 4b. 历史模式（复盘已存档的会话）

同一个 block 模型套用到 `read_session_detail` 的全量解析：

- `_block_text` 之外新增对 `type=="thinking"` 的处理，输出 `{type:"thinking", text, collapsed:true}`（默认折叠，展示前几行，点开看全文）。
- 工具调用不再只存 `summary` 字符串：保留完整 `input`，并且**用已经在存的 `id`**（`dispatch.py:1580` 的 `"id": b.get("id","")`）去匹配后续 `tool_result.tool_use_id`，把结果摘要和 `is_error` 一起挂到同一个 block 上——现在这个 id 存了却没用上。
- zcode 分支加 `elif p.get("type")=="reasoning"`；codex 分支加 `elif p.get("type")=="reasoning"`（`summary` 可能为空，为空就显示"（该会话未开启可读思考摘要）"而不是不显示这个 block）；pi 分支的 `toolCall` 判断旁边加 `thinking` 判断。
- 四个解析器改动量类似，可以先抽一个共享的 `Block` 数据结构，四个 `read_*_detail` 都往这个结构里塞，减少前端要适配四套形状的成本。

### 4c. headless `stream-json` → 同一套 block 模型

discussions 功能已经手握 `stream-json --include-partial-messages`，只是只认 `text_delta`。扩展 `stream_line()`（`dispatch.py:4304`）：

- `content_block_start`（`content_block.type=="thinking"`）→ 开一个新的 thinking block，标记"进行中"。
- `thinking_delta` → 累加进当前 thinking block 的文本，实时 emit（对应 UI 上"思考中…"展开预览）。
- `content_block_start`（`type=="tool_use"`）+ `input_json_delta` → 累加 JSON 片段，工具调用状态标 `running`；这条消息里紧跟着的 `tool_result`（如果 headless 模式也会有）标 `done`。
- `DiscussionLive`（`dispatch.py:4448`）的 `live.json` schema 从"一个 status + text 字符串"扩成"一串 block"，前端 `DiscussChat.tsx` 已经用 `MessagePrimitive.Parts` 渲染，正好是加 `Reasoning`/工具卡片组件的位置（见 4d）。

### 4d. 可以直接借的 UI 组件

`app/package.json` 已经声明 `@assistant-ui/react ^0.15.18`（MIT），`DiscussChat.tsx` 已经在用它的 `useExternalStoreRuntime` + `useSmooth`，本地 `node_modules` 里实测确认这些原语都在：

- `Reasoning` / `useMessagePartReasoning`：折叠触发器、流式态 shimmer + 已用时长、自动滚动——直接对应"思考（折叠，显示前几行）"的需求，不用自己写。
- `makeAssistantToolUI` / `ToolCallMessagePartProps`（`args`/`argsText`/`result`/`isError`/`status.type: running|complete|incomplete|requires-action`）+ `useToolCallElapsed`：直接对应"工具调用卡（名字 + 关键参数 + 状态 + 结果摘要）"。
- `ChainOfThoughtPrimitive`：如果想把多步思考渲染成时间线式的分步骤卡片（类似 assistant-ui 文档里 `ReasoningPanel` 的变体），这个原语已经在库里。
- Dispatch 会话页 `Sessions.tsx` 现在的 `<span class="tool-chip">` 纯文本渲染（`:29`、`:286`）应该整体换成这几个组件，而不是在现有结构上加字段。

**不建议抄的**：Open WebUI 的折叠交互模式可以参考，但它 2024 年后的代码是自定义"Open WebUI License"（非 OSI 开源，有反背书条款），照抄代码有许可证风险；参考它"`<think>` 标签转 `<details>`"这个思路即可，别复制实现。LibreChat（MIT）的"按阶段分组卡片"设计思路可以照抄。

### 每个 Agent 要解析的具体字段

| Agent | 文件/来源 | thinking/reasoning 字段 | 工具调用字段 | 备注 |
|---|---|---|---|---|
| claude-code | `~/.claude/projects/*/*.jsonl` | `content[].type=="thinking"`：`thinking`、`signature`；`apiBlockIndex`+`timestamp` 定位块顺序 | `type=="tool_use"`：`id`、`name`、`input`；结果在下一条 `type=="user"` 行的 `content[].type=="tool_result"`：`tool_use_id`、`content`、`is_error` | 块级增量已验证（每块单独一行落盘） |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `payload.type=="reasoning"`：`id`、`summary[]`（可能为空数组）、`encrypted_content` | `payload.type in (function_call, custom_tool_call)`：`name`、`arguments`、`call_id`；结果在 `function_call_output`/`custom_tool_call_output`：`call_id`、`output` | `summary` 是否有内容取决于对方的 `model_reasoning_summary` 配置，我们控制不了 |
| pi | `~/.pi/agent/sessions/**/*.jsonl` | `message.content[].type=="thinking"`：`thinking`、`thinkingSignature`、`redacted?` | `type=="toolCall"`：`id`、`name`、`arguments`、`thoughtSignature?` | 官方有 session-format 文档，字段稳定 |
| zcode/OpenCode | `~/.local/share/opencode/storage/part/<messageID>/*.json`（Dispatch 走 SQLite `part`/`message` 表） | `type=="reasoning"`：`text`（完整明文）、`metadata.anthropic.signature`、`time.start/end` | `type=="tool"`：`callID`、`tool`、`state.status`(pending/running/completed/error)、`state.input`、`state.output`、`state.time` | 四家里状态机最完整，天然带 pending/running/completed |

### 工作量估算

- CLI 端四个解析器改造（补 thinking + tool_result 关联，输出统一 block 结构）：1-2 天。
- `activity.py` 的 `streams`/`observe` 扩成结构化 block 输出，供会话页轮询：0.5-1 天。
- 前端 `Sessions.tsx` 换用 assistant-ui 的 `Reasoning`/工具调用组件渲染 block（历史模式）：1 天。
- 会话页接实时轮询通道（复用 activity 的游标）：0.5-1 天。
- discussions 的 `stream_line()` 扩展 thinking_delta/input_json_delta（非必须，锦上添花）：0.5 天。

## 5. 实现顺序

1. **CLI：定义统一 Block 结构**，四个 `read_*_detail` 都改造成输出 `[{type: thinking|text|tool_call, ...}]` 而不是现在的 `text` + `tools[]` 分离结构；先做历史模式（4b），验证起来最快，不涉及轮询/前端实时状态。
2. **CLI：把 tool_use.id 和 tool_result.tool_use_id 关联起来**，补上 pending/running/done 状态和结果摘要——这一步四个 agent 都要做，是历史模式和实时模式共用的基础。
3. **前端：`Sessions.tsx` 换用 `@assistant-ui/react` 的 `Reasoning` + `makeAssistantToolUI`** 渲染新的 Block 结构（先只做历史模式，用户从会话列表点进已完成会话，能看到折叠的思考块和带状态的工具卡片）。
4. **CLI：扩展 `activity.py` 的 `streams` 游标**，保留结构化 block（而不是压成一句 activity 摘要），暴露一个供轮询的增量读取口子。
5. **前端：会话页接实时轮询**，检测到"这是一个在跑的会话"时切换到轮询模式，用同一套 assistant-ui 组件渲染，用 `useSmooth` 让轮询到的文本看起来是连续打出来的（`DiscussChat.tsx` 已有的模式直接复用）。
6. **（可选）discussions 的 `stream_line()` 扩展 thinking_delta/input_json_delta**，让讨论功能里也能看到成员的思考过程和工具调用，不只是最终发言。

---

### 参考来源

- Claude Code TUI 动词/思考折叠：https://blog.alexbeals.com/posts/claude-codes-thinking-animation ，https://github.com/wynandw87/claude-code-spinner-verbs ，https://github.com/anthropics/claude-code/issues/36006
- Claude Code headless / Agent SDK 流式输出：https://code.claude.com/docs/en/headless ，https://code.claude.com/docs/en/agent-sdk/streaming-output
- Claude Code on the web / mobile：https://code.claude.com/docs/en/claude-code-on-the-web ，https://code.claude.com/docs/en/mobile
- Anthropic 流式与 extended thinking：https://platform.claude.com/docs/en/build-with-claude/streaming ，https://platform.claude.com/docs/en/build-with-claude/thinking ，https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Codex GitHub issues：#4751、#4550、#39903、#8204、#5339、#16801、#10723、#27197、#38160（github.com/openai/codex/issues/…）
- Codex 配置与 Responses API 事件（源码级）：https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json ，https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-api/src/sse/responses.rs ，https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/models.rs ，https://developers.openai.com/api/docs/guides/reasoning
- OpenCode：https://opencode.ai/docs/tui/ ，https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts ，https://deepwiki.com/sst/opencode/2.8-storage-and-migration-system
- pi session 格式：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- Open WebUI 许可证：https://docs.openwebui.com/license/
- LibreChat：https://www.librechat.ai/docs/features/agents_api ，MIT LICENSE
- LobeChat：https://github.com/lobehub/lobe-chat ，https://github.com/lobehub/lobe-ui
- Cherry Studio：https://github.com/CherryHQ/cherry-studio
- assistant-ui：https://www.assistant-ui.com/docs/ui/Reasoning ，https://www.assistant-ui.com/docs/copilots/make-assistant-tool-ui
- Vercel AI SDK UIMessage：https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message
- Cursor / Windsurf：https://cursor.com/changelog/3-0 ，https://cursor.com/help/ai-features/agent ，https://www.digitalapplied.com/blog/windsurf-2-deep-dive-cascade-agents-flows-2026

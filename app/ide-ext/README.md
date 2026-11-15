# dispatch-bridge

Dispatch 完整 IDE（code-server 跑在 Dispatch 窗口里）里的桥接扩展。它和 Dispatch 之间只通过 `dispatch` 命令和 `~/tasks/.dispatch/` 下的文件说话，不开端口。设计见 `design/full-ide/PLAN.md` §2.3、§3。

## 构建

```
cd app && npm run build:ext      # → app/ide-ext/dist/dispatch-bridge.vsix
```

`scripts/build.mjs`：第一次或 `package-lock.json` 变了才 `npm ci`（只有 typescript 和两份类型定义），`tsc` 编到 `out/`，再用 `scripts/zip.mjs` 打成 .vsix（不依赖 vsce）。条目排序、时间固定成 1980-01-01，同样的源码得到同样的字节，`dispatch ide start` 按 sha256 判断要不要重装。Windows 上跳过（没有完整 IDE，`src-tauri/build.rs` 会放一个空占位）。

`dispatch ide install` 和每次 `ide start` 都会把新的 .vsix 装进服务端，工作台下次重载时生效。

测试：`src/core/` 里是不碰 `vscode` 的纯逻辑，`test/*.test.ts` 由 app 的 `npm test`（vitest）跑。

## 功能和它调用的命令

| 功能 | 入口 | 走什么 |
|---|---|---|
| 状态栏 | `Dispatch · 3`（在跑的会话，30 秒刷新）、`Tab $0.03`、`$(history) 12` 检查点、当前文件的 Agent 改动数 | `dispatch sessions --json`、`ide usage today`、`checkpoint list` |
| ⌘K 改写 | 编辑器里 ⌘K（盖掉 VS Code 的 ⌘K 组合键，和 Cursor 一样），选中的整行按指令改写；`@codebase …` 开头先搜项目 | `dispatch ide edit --root --file --start --end --json`，stdin `{instruction, selection, before, after, context}`；`code-search` |
| ⌘K 结果 | 左右 diff（文件 ↔ 提议），标题栏 Accept / Reject，⌘⏎ 接受、⎋ 拒绝；接受时按原文重新定位，替换后保存 | |
| Tab 补全 | 灰字，Tab 接受；默认关，有 Key 时首次问一次；点状态栏开关、改上限 | 直连 DeepSeek FIM（`/beta/completions`，模型取设置 `ide_tab_model`），Key 先看环境变量再 `dispatch env get DEEPSEEK_API_KEY`；每次请求追加一行到 `~/tasks/.dispatch/ide/tab-usage.jsonl`，每分钟 `dispatch ide usage add` 汇总；到 `ide_tab_daily_cap_usd` 就停，第二天恢复；开关和上限写 `dispatch settings --save` |
| Agent 改动 | 绿色行、删除处红线加悬浮原文、每处 CodeLens「接受 ⌘Y · 撤销 ⌘N」，文件顶上「全部接受 / 全部撤销」，F7 / ⇧F7 跳转 | 找 `~/tasks/.dispatch/editor/*/index.json` 里有这个文件基线的会话（`DISPATCH_IDE_SID` 优先，否则最近的），`dispatch editor hunks|accept|undo`；你自己在 IDE 里保存时 `dispatch editor fold`（stdin 是保存前的磁盘内容）把你的改动折进基线 |
| 检查点 | Dispatch › 检查点：每轮一项，展开看文件，行内按钮「回到这一轮之前」，冲突时列出文件再确认 | `dispatch checkpoint list|restore --root --json`；命令还不支持时显示一行说明 |
| 代码搜索 | Dispatch › 搜索，⌘⇧; 聚焦（有选中文字就直接搜），点结果跳到行 | `dispatch code-search "<问题>" --root -n 20 --json`；已有索引时保存后 10 秒 `code-search index --file …` |
| 语言扩展 | 激活 4 秒后按项目文件类型推荐缺的扩展（同一项目同一清单只问一次），点「安装」在工作台里从 Open VSX 装，失败退到 CLI | `dispatch ide recommend --root --json`，`ide extensions install` |
| 脏文件数 | 未保存文件数变了 1 秒后上报，Dispatch 退出时读 | `dispatch ide dirty <n>` |
| 回聊天 | ⌘L 聚焦聊天、⌘E 回聊天、⌘⇧L 把选中内容放进聊天、会话视图点一项打开会话 | `dispatch ide signal focus-chat|back-to-chat|add-to-chat|open-session --data <json>` |
| 撤销后告诉 Agent | 撤销 Agent 改动后发信号，由 App 转给 chatd 的 `note` | `ide signal agent-note --data {sid, path, text}` |
| 预览 | 命令「Dispatch: Open Preview」：探测常用开发端口，在 Simple Browser 里打开 | |

信号的 `data`（App 侧 `ide.rs` 监听 `~/tasks/.dispatch/ide/signal`）：

- `focus-chat`、`back-to-chat`：`{root}`
- `add-to-chat`：`{root, path, start, end, mention: "@path:12-20", text, truncated}`（行号从 1 开始，`text` 最多 8000 字）
- `open-session`：`{key: "claude-code:<id>", root}`
- `agent-note`：`{sid, path, text}`

## 日志

输出面板「Dispatch」：每次 CLI 调用、Tab 请求的 token 和花费、⌘K 提议的去向。

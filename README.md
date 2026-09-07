# Dispatch

一个以项目为起点的本地 Agent 工作台。项目组织会话，会话延伸出任务，多个任务与会话共同形成一项成果。查看 Claude Code / Codex 的进展、回复、图片和交付文件；管理任务、额度和各 Agent 的全局指令。

## 已实现

- **工作台**：按项目排列，每张卡片是该项目此刻的情况：等你回的会话（未读回复、等待确认）、在跑的会话及其当前动作、进行中的任务和验收进度、最新成果。三天内没有动静的项目折叠为一行。顶部是需要你处理的计数和各 Agent 的额度。
- **收藏与归档**：项目可收藏（置顶）或归档（从工作台和项目列表隐藏，随时找回）。状态存在共享任务板的一条记忆里，两台机器一致；CLI 为 `dispatch project <名> --star|--archive`。
- **项目页**：一个项目的完整记录，会话、任务、成果、待归属任务、目录各一页。会话显示明确关联的任务；任务可指定发起和参与会话；成果可汇总多个任务与会话；目录页可打开 Finder 或在该目录新建会话。
- **统一的项目规则**：会话归属按一条规则解析：手动关联 > 家目录（不归项目） > `~/Projects/<名>/…` > 路径里出现任务板已知的项目名 > 目录名。侧栏计数、工作台、项目页、搜索用同一份列表。
- **明确归属**：任务与会话的关系只认 `session:` / `session-origin:` 标签。对话里提到任务 ID、同一个 Agent、同一个目录都不算归属，只作为折叠的参考信息。
- **成果追溯**：成果有独立内容和入口，可以关联多个任务与会话；历史完成说明单独保留，不要求用户逐个点击审核。成果与回收站任务不进入脉络图。
- **等我**：红点和系统通知只算未读回复和等待确认；被卡住的任务、Agent 互审、定时会话都不计入。正在跑的会话不算未读。
- **全局搜索**：⌘K 搜项目、会话、任务；⌘N 新建会话。
- **会话与附件**：持续读取本机记录；图片内联显示，集中预览图片、PDF、HTML、音视频和文本。续接会话的多个记录文件按会话合并。
- **原会话回复**：从工作台或“等我”进入会话后直接回复，桌面与手机网页共用入口。支持已在 Codex 桌面端打开的会话，以及 Herdr 中能精确确认身份的空闲 Claude Code / pi / Codex 终端会话；不另开模型进程。草稿按会话保留，重复请求只发送一次，超时会显示未确认状态。
- **任务操作**：看板和表格支持右键或 `⋯` 菜单。任务可移到回收站并恢复原状态，保留描述、评论和依赖。
- **统计与额度**：同一入口切换额度概览和使用统计，显示已使用比例、重置时间、数据来源和更新时间。缺失或过期的数据会标明，不推算成零。
- **全局指令**：检测 Codex、Claude Code、pi、ZCode、Gemini、OpenCode 的惯用文档位置与 Markdown 引用，识别 Codex override 优先级和软链接。
- **优化与一致性**：根据检测到或手填的模型选择 Codex、Claude 或通用检查规则。检查重复、候选冲突、循环或失效引用、文档长度、个人路径和托管副本版本。自动优化仅合并明确的相邻重复条目；语义修改通过建议、编辑和差异预览完成。
- **可恢复修改**：保存前重检所有文档版本；共同源文件的现有托管副本一起预览、保存；保留恢复版本。文件被其他程序修改时拒绝覆盖。

## 本机运行

目前桌面端支持 **macOS**；网页界面适配手机宽度。需要 Python 3.11+。源码构建还需要 Node.js 20.19+ 或 22.12+、Rust 和 Xcode Command Line Tools。

```sh
cd app
npm ci
npm run tauri build
```

构建结果在 `app/src-tauri/target/release/bundle/macos/Dispatch.app`。应用内置 Python CLI 和网页资源，不要求仓库位于特定目录。已有环境可以使用 `app/scripts/install.sh` 安装到 `/Applications`。

任务板功能额外依赖 [Beads](https://github.com/steveyegge/beads) 和 Dolt。按 Beads 文档完成安装和初始化；默认任务目录为 `~/tasks/.beads`，可通过 `BEADS_DIR` 指定。会话、附件和指令检查不需要模型 API Key，也不需要先建立任务板。

若要在终端使用 CLI，可将 `app/cli/dispatch.py` 链接到 `~/.local/bin/dispatch`。查看手机地址运行 `dispatch serve url`；服务运行方式与限制见 [app/README.md](app/README.md)。手机需能访问运行服务的电脑，不能直接把服务暴露到公网。

```sh
dispatch rules inspect --json
dispatch rules optimize --path ~/.codex/AGENTS.md --model gpt-6-astra --json
dispatch facts show -P relecture      # 常用信息：服务器/域名/数据库/API 名字，按项目分节，prime 自动注入
dispatch facts sections --json
dispatch task trash TASK_ID --json
dispatch task restore TASK_ID --json
dispatch project ReadOut --star         # 收藏；--archive 归档；dispatch projects 列出
dispatch prime                          # 会话启动注入：身份、本项目任务、用户在任务上的未回复留言、知识库、常用信息、额度
```

「规则与资料」包含两个区域：

- **Agent 规则**：选择全局或已检测到的项目，将项目 AGENTS.md / CLAUDE.md 与继承的全局规则一起检查、编辑、预览和恢复。共同规则同步也在这里。
- **常用资料**：密钥与 API、服务器与数据库、Obsidian 资料库。服务器资料仍编辑 `~/.agents/rules/FACTS.md`：`## 通用` 每个会话注入，`## 项目名` 只注入该项目；密钥值只进 `dispatch env`。Obsidian 仅检测资料库元数据并提供当前设备的打开入口，不移动或上传笔记。

`optimize` 只返回建议和差异；不会立即修改文档。界面提供编辑、检查、应用和恢复步骤。模型名只影响本地检查配置，**不会调用该模型**；“复制深度审查指令”可将所选上下文交给用户自己的 Agent。

## 数据与边界

Dispatch 读取用户已有的本地 Agent 记录，默认不向任何模型发送文档或聊天内容。当前不接入 ChatGPT 网页会话，也不能取得原 Agent 应用的“已读”回执；仅后续用户消息能清除此前回复的未读。工作区 Git 差异可能包含其他会话的改动。

主动点击发送时，回复只投递给所选电脑上的原会话。Codex 桌面回复依赖客户端当前的版本化本地 IPC 接口；不兼容或会话未打开时会提示重新连接。Herdr 终端必须同时匹配会话 ID 与前台进程；正在执行或等待权限确认时不会写入输入。发送回执存在本机 `~/tasks/.dispatch/reply-receipts.sqlite`，不跨机复制。

附件只能从当前会话明确附加或链接的文件读取，单个文件上限 20 MB。HTML 在隔离 iframe 中预览，外部网络被禁用；同目录内的图片可嵌入。依赖外部库的复杂产物需要在原项目运行。文件已被清理时会显示原因。

“潜在冲突”是静态检查结果，不是完整语义证明。修改规则不会立即重载已有 Agent 会话，应按相应 Agent 的加载机制重新开始会话。

## 验证与贡献

```sh
cd app
npm test
npm run test:py
npm run build
```

业务逻辑在 `app/cli/`，Tauri 与 HTTP 共用 CLI，React 负责呈现。新增传输能力须同时验证桌面与网页。请使用临时目录测试文档写入；不要把真实会话、配置、密钥或截图加入仓库。

项目代码采用 [MIT License](LICENSE)。第三方库保留各自许可证；Python、Beads、Dolt、Agent 客户端及可选远程桌面工具作为独立依赖使用。

## 项目关系与 Agent 交付

关系沿用共享任务板保存，两台机器同步后使用同一份数据：

- `project:<name>`：所属项目。
- `session-origin:<id>`：发起会话；`dispatch begin` 在会话身份可用时自动记录。
- `session:<id>`：明确关联的发起或参与会话，可有多个。
- `dispatch:outcome`：独立成果记录，不进入普通任务计数。
- `outcome-task:<task-id>`：成果来源任务，可有多个；成果上的 `session:` 标签记录来源会话。
- `dispatch-projects`（bd memory）：项目的收藏与归档状态。以 `dispatch-` 开头的记忆是 Dispatch 自己的记录，不出现在知识库、`dispatch wiki` 和 `dispatch prime` 里。

Agent 可以通过现有 `bd create` 创建带 `dispatch:outcome`、项目和来源标签的记录，以描述保存交付说明及文件链接，再 `bd close` 完成登记。用户也可在项目的“成果”页登记或编辑。不要根据提及次数批量写入归属，也不要自动把所有已完成任务复制成成果。

工作台合并实时活动和历史会话索引。索引仍遵循现有读取上限（本机与远端列表的限制分别为 500 和 200）；历史条目不显示未读或推断运行状态。

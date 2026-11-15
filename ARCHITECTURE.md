# Dispatch 代码地图

改代码前先看这里，找到该读的几个文件再去读，不要从头搜。每个 Python 模块和 TS 文件开头的注释写了它的细节，这里只指路。

**这份地图跟代码一起改**：加、删、改名一个模块，或者改了谁调谁，同一个提交里改这里。`app/cli/test_architecture.py` 会查：下面点名的 CLI 模块、扩展文件、IDE 功能目录和仓库目录一个都不能漏，地图里写的路径和文件名必须真的存在。提交前的钩子 `.githooks/pre-commit` 跑这项检查，不过就提交不了。

## 一条请求怎么走

```
Agents 窗口 / 编辑器窗口（ide/vscode，VS Code 1.139.1 源码加我们的改动）
  └ 界面代码 executeCommand('dispatch.<x>', …)
      └ dispatch-bridge 扩展 app/ide-ext/src/<x>.ts 注册这个命令（纯逻辑在 core/<x>.ts，vitest 测）
          └ cli.ts 跑 `dispatch <x> … --json`
              └ app/cli/dispatch.py 的 _parser() 分到 cmd_<x>，或交给同名模块 app/cli/<x>.py
                  └ 任务板 bd（Dolt）：写操作经 chatd 里的 board_service.py
```

对话不走 chatd：两个窗口里的 Claude Code、Codex、OpenCode 会话都跑在 VS Code 的 Agent Host 里（`ide/vscode/src/vs/platform/agentHost/node/` 下的 `claude/`、`codex/`、`opencode/`，Claude 用 Agent SDK，Codex 用 app-server，OpenCode 用 `opencode acp`）。chatd（launchd 常驻）现在管的是：任务板服务和变更推送、Keep awake、多机订阅，还有手机和 `dispatch agent` / `dispatch reply` 用的对话驱动。

## 按问题找文件

| 想改的东西 | 界面（`ide/vscode/src/vs/` 下） | 扩展 | CLI |
|---|---|---|---|
| 左栏项目、会话分组、新建项目 | `sessions/contrib/sessions/browser/`（dispatchProjects*、views/dispatchProject*）、dispatchAddProject | projects.ts | projects_view.py、project_create.py |
| Waiting for you（左栏入口和下面最近几件、7 天规则、页面） | `sessions/contrib/sessions/browser/`（dispatchWaiting*、views/dispatchWaitingSidebar.ts、dispatchPeerWaiting.ts） | waiting.ts | waiting.py |
| 任务列表、任务页、完成按钮、对话里任务链接在右栏就地打开 | dispatchTasks（就地打开一件任务：dispatchTasksEditor.ts 的 reveal，命令 `dispatch.showTask` 在 dispatchDocsOpen.ts）、dispatchTaskGraph | tasks.ts、commit.ts | tasks_view.py、dispatch.py（task begin/done） |
| 对话里的「记下了」条 | dispatchCapture | capture.ts | capture.py |
| 输入框、权限模式、引用卡片 | dispatchComposer、dispatchQuote、`platform/agentHost/common/meta/` | | autonomy.py |
| 斜杠菜单 | `sessions/contrib/chat/browser/`（dispatchSlashMenu*）、`platform/agentHost/node/`（dispatchSlashCompletions） | slash.ts | slash.py |
| 回复里的链接、提问卡、偏好提示 | `workbench/contrib/chat/browser/widget/chatContentParts/` | | prefs.py |
| 右栏 Changes、谁写的行 | `sessions/contrib/changes/browser/`、dispatchAttribution、dispatchFixit | attribution.ts、fixit.ts、hunks.ts | attribution.py、fixit.py、editor.py |
| 右栏 Docs、交付页 | dispatchDocs、dispatchDraw | docs.ts、ideShow.ts、deliveryPage.ts | docs_view.py、ide_show.py、deliver.py |
| 旁聊（Ask Question、/btw 开的子会话）：右栏右下角的卡、收起的胶囊、文档里那段话亮和批注 | dispatchSideChat（dispatchSideChatCard.ts 画卡，dispatchDocPassage.ts 管 Docs 里那段话和批注；旁聊不进对话栏的分组靠 `sessions/services/sessions/browser/visibleSessions.ts` 的挂钩，标题栏会话菜单里的「Side chats」一组在 dispatchTitleBar 的 dispatchPlace.ts） | | |
| 边干边学：Talk 的小卡（Agent 新建文件、装包、删文件时右下角一句话）、Quiet / Talk 开关、终端输出里选字 Ask Question、Walk me through（一轮做完一站一站看改动） | dispatchLearn（dispatchLearnTurn.ts 从这一轮的工具调用读出事，dispatchTalkCards.ts 画小卡，dispatchTerminalAsk.ts 是终端的 Ask Question 框；拼一句话、合并同类、计时在 common/dispatchLearnModel.ts；Walk me through：dispatchWalk.ts 跟一轮的起止、从 Changes 的 turn 改动分站、开文件高亮那几行，dispatchWalkCard.ts 画胶囊和站卡，dispatchWalkService.ts 是 Now 头和旁聊卡 ⋯ 用的入口，分站、合并、上限和每站一句话在 common/dispatchWalkModel.ts，拼不出的那几站整轮问一次会话自己的引擎：bridge 的 `dispatch.write walk` → fixit.py `dispatch write walk`）；看得懂和能追问（task-39x97）：Now 头下一句为什么在 dispatchNow 的 dispatchNowEditor.ts 画、句子从 common/dispatchExplainModel.ts 取，Changes 每块改动的 Why / More 是 dispatchHunkWhy.ts（说明先复用导览的，没有时 dispatchWalk.ts 的 why 整屏多块合并问一次，同一个 `dispatch write walk` 带 `why`），术语悬停的点线在 `workbench/contrib/chat/browser/widget/chatContentParts/dispatchTermMarks.ts`、词表在 `workbench/contrib/chat/common/dispatchTerms.ts`、Ask more 是 dispatchAskTerm.ts；旁聊卡和各处 Ask Question 共用 dispatchSideChat 的 dispatchSideChatAsk.ts；Settings › Learning（Quiet / Talk、Explain terms）在 dispatchSettings | fixit.ts（`dispatch.write`） | fixit.py |
| 右栏 Now、会话生命卡 | dispatchNow（右栏 Now，dispatchNowEditor.ts 画、dispatchNowModel.ts 算显示什么）、dispatchLife | now.ts、life.ts | now_line.py、session_life.py、life_hook.py |
| 输入框上方的子 Agent 条 | dispatchSubagents（dispatchSubagentStrip.ts 画，dispatchSubagentsModel.ts 算显示什么，Now 的「Right now」也从这里取正在跑哪一步；子 Agent 列表和状态读 `sessions/browser/dispatchSubAgentRows.ts`） | | |
| 内置浏览器 | `workbench/contrib/browserView/electron-browser/`、`platform/browserView/` | | browser_ide.py |
| 终端 | dispatchTerminal、`workbench/contrib/`dispatchTerminalKeys | terminal.ts | terminal_cmd.py、terminal_daemon.py、`app/termd/` |
| 设置页 | dispatchSettings | settingsPage.ts、keys.ts、soul.ts、net.ts | settings_snapshot.py |
| Customizations（技能、插件、Agent） | dispatchCustomizations、dispatchAgents、`sessions/contrib/providers/agentHost/browser/` | customizations.ts、dispatchDir.ts、engines.ts、opencode.ts | customizations.py、agents_defs.py、agent_plugins.py |
| 知识页（偏好、wiki、关于我） | dispatchKnowledge | knowledge.ts | prefs.py、profile.py、dispatch.py（wiki） |
| 账号、用量 | dispatchAccounts、`sessions/contrib/accountMenu/browser/` | accounts.ts、claudeAccount.ts、usage.ts | accounts.py、usage.py、usage_scan.py |
| 标题栏、底栏、铃铛 | dispatchTitleBar、dispatchStatusBar、dispatchInbox | busy.ts、builds.ts、inbox.ts、me.ts、status.ts | busy.py、builds.py、inbox.py、me.py |
| 多机、手机 | `workbench/contrib/`dispatchMachines、dispatchMobile、dispatchRunOn | machines.ts、mobile.ts | machines.py、host_admin.py、mobile.py |
| 首次设置、导览、新功能、新对话页的入门建议 | dispatchOnboarding（dispatchFirstPrompts.ts）、dispatchTours、dispatchWhatsNew | onboarding.ts、defaults.ts、assistant.ts | onboarding.py、init_wizard.py、assistant.py |
| Turbo（Timeline 页）、自动化、历史 | dispatchTurbo、dispatchAutomations、dispatchHistory | turbo.ts、automations.ts、history.ts | turbo.py、automations_discover.py、session_history.py |
| 图标、配色、动效 | dispatchBlocks、`base/common/`、`base/browser/`（dispatchIcon、dispatchPalette、dispatchDot）、`workbench/contrib/`dispatchMotion | | `app/scripts/gen-ide-theme.mjs` |

## Dispatch IDE 里我们的代码（`ide/vscode/src/vs/` 下）

规矩在 `ide/README.md`：新功能放新文件，VS Code 原文件只加标了 `// Dispatch IDE:` 的挂钩。看全部改动：`git diff 6146beae -- ide/vscode`。

**Agents 窗口的功能目录** `sessions/contrib/`：dispatchAccounts（多账号）、dispatchAddProject（加项目）、dispatchAgents（会话类型里补上关掉的 Agent）、dispatchAttribution（diff 里标谁写的）、dispatchAutomations（别的工具的定时任务，只读）、dispatchBlocks（图标字体、状态块；dispatchMarks.ts 是符号表的状态记号，各处说状态都从它取）、dispatchBoard（任务板变更推送）、dispatchCapture（记下了条）、dispatchCommon（共用：标注 JSON 等）、dispatchComposer（权限模式）、dispatchCustomizations、dispatchDocs、dispatchDraw（右栏图片和文档上画框）、dispatchFixit（git 出错时的 Changes 卡片）、dispatchHistory（各 Agent 的历史会话）、dispatchInbox（铃铛）、dispatchKnowledge、dispatchLearn（边干边学：Talk 的小卡、Quiet / Talk、终端的 Ask Question、Walk me through、Changes 每块的 Why / More、术语的 Ask more）、dispatchLife（上下文寿命和自动交接）、dispatchNeat（收尾整理）、dispatchNet（代理和网络）、dispatchNow（右栏 Now：三行头加一条步骤线，dispatchNowModel.ts 算显示什么）、dispatchOnboarding（首次设置；新对话页的三张入门建议，dispatchFirstPrompts.ts）、dispatchOpenCodeVersion（OpenCode 版本问题）、dispatchProjectCustom（项目的 Customize 页）、dispatchQuote（选中文字引用）、dispatchRunOn（在另一台 Mac 上跑会话）、dispatchSessionMenu（会话右键菜单）、dispatchSideChat（旁聊卡：旁聊开在右栏右下角的卡里，不劈对话栏）、dispatchSettings、dispatchStatusBar、dispatchSubagents（输入框上方的子 Agent 条：有子 Agent 在跑时出现，和 Now 读同一批子 Agent）、dispatchTabs（右栏标签：标签条只留两篇文档，其余进 Docs 列表的 Open 一组，dispatchOpenDocs.ts；dispatchDocs 打开网页交付时在这里登记它的地址对应哪个文件，重载后还认得）、dispatchTaskGraph、dispatchTasks、dispatchTerminal、dispatchTitleBar、dispatchTours（气泡导览）、dispatchTurbo（Turbo 和 Timeline 页）、dispatchWhatsNew。

**两个窗口共用的功能目录** `workbench/contrib/`：dispatchEditorEdits（手改和 Agent 改的合并）、dispatchEditorSettings（Tab 补全和 ⌘K 设置）、dispatchMachines、dispatchMobile、dispatchModalPalette、dispatchMotion（空闲时停动画）、dispatchTerminalKeys。

**散在 VS Code 目录里的我们的文件**（文件名都以 dispatch 开头）：
- `platform/agentHost/node/`：账号切换、闲置会话休眠、续聊、独立副本（dispatchOwnCopy）、斜杠补全；`platform/agentHost/node/opencode/`、`platform/agentHost/node/shared/`、`platform/agentHost/node/claude/`（dispatchContextUsage：每轮后记下 Claude 上下文的分项，给 Context 卡）；引擎适配 `claude/`、`codex/`、`opencode/` 里也有我们改的和新加的文件
- `platform/agentHost/common/`、`platform/agentHost/common/meta/`：远程主机命令、内置浏览器说明、权限模式名、图片标注和引用的附件元数据
- `sessions/browser/`：Agents 窗口的分栏、会话行标记、子 Agent 行、状态块；`sessions/common/`
- `sessions/contrib/sessions/browser/`、`sessions/contrib/sessions/browser/views/`：左栏的项目、Waiting for you（入口下挂最近几件，dispatchWaitingSidebar.ts；在做和等你的会话不折起来，dispatchLiveSessions.ts）、别的 Mac 等你的、代码搜索、机器页
- `sessions/contrib/chat/browser/`、`sessions/contrib/chat/common/`：斜杠菜单、回复里选文字、本会话自己的改动
- `sessions/contrib/providers/agentHost/browser/`：引擎选择、换模型、Claude/OpenCode 设置页、版本行
- `sessions/contrib/accountMenu/browser/`、`sessions/contrib/agentFeedback/browser/`、`sessions/contrib/aquarium/browser/`（空闲时的鱼群动画）、`sessions/contrib/changes/browser/`、`sessions/contrib/layout/browser/singlePane/`
- `workbench/contrib/chat/browser/`、`workbench/contrib/chat/browser/agentSessions/`、`workbench/contrib/chat/browser/agentSessions/agentHost/`、`workbench/contrib/chat/browser/aiCustomization/`、`workbench/contrib/chat/browser/attachments/`、`workbench/contrib/chat/browser/widget/`、`workbench/contrib/chat/browser/widget/chatContentParts/`：对话视图里的挂钩（任务链接、路径链接、提问卡、偏好、账号菜单、卡住检测；回复里的任务链接点了走 `dispatch.showTask`，在右栏 Tasks 页就地打开，dispatchTaskLinks.ts；回复和 Now 里常见开发词第一次出现时下面一条淡点线、悬停一句人话，dispatchTermMarks.ts；滚过你发的那句话以后顶上钉的那一行、点了滚回去，dispatchStickyAsk.ts，chatListRenderer.ts 给钉住的那一行挂上，样子在 `sessions/browser/media/dispatch-shell.css`）；`workbench/contrib/chat/common/`：dispatchTaskBriefs.ts，窗口记着的任务简况（回复画出来就问、Tasks 列表顺手记下，点链接时先拿它显示）；dispatchTerms.ts，术语悬停的词表和匹配
- `workbench/contrib/browserView/electron-browser/tools/`、`workbench/contrib/themes/browser/`、`workbench/contrib/update/browser/`、`workbench/browser/`、`workbench/browser/parts/editor/`、`workbench/services/host/browser/`、`workbench/services/remote/browser/`、`workbench/services/remote/common/`、`workbench/services/themes/common/`
- `base/browser/`、`base/common/`（图标、配色、圆点、启动画面）、`code/electron-main/`（旧副本检查）、`platform/chat/common/`、`platform/update/electron-main/`（更新源）、`platform/window/common/`
- `ide/vscode/extensions/markdown-language-features/markdown-editor-src/`、`ide/vscode/extensions/markdown-language-features/src/util/`：Markdown 编辑器里的引用提问、选区和链接

## dispatch-bridge 扩展（`app/ide-ext/`，代码在 `app/ide-ext/src/`）

界面和 CLI 之间的桥。`<x>.ts` 注册命令并调 CLI，`core/<x>.ts` 是不依赖 vscode 的部分（`app/` 下 `npm test` 跑它的测试）。入口 extension.ts；调 CLI 的公共代码 cli.ts、shared.ts（同一读请求合并）。
- 和上表对应的：accounts.ts、assistant.ts、attribution.ts、automations.ts、board.ts、builds.ts、busy.ts、capture.ts、checkpoints.ts、claudeAccount.ts、commit.ts、customizations.ts、deliveryPage.ts、dispatchDir.ts、docs.ts、engines.ts、fixit.ts、history.ts、ideShow.ts、inbox.ts、keys.ts、knowledge.ts、life.ts、machines.ts、me.ts、mobile.ts、net.ts、now.ts、onboarding.ts、opencode.ts、projects.ts、settingsPage.ts、slash.ts、soul.ts、star.ts、switchAgent.ts、tasks.ts、terminal.ts、turbo.ts、usage.ts、waiting.ts
- 编辑器窗口：nativeChat.ts（⌘L 打开 VS Code 自己的对话视图）、chatPanel.ts（旧的 webview 对话栏，已停用）、hunks.ts（Agent 改的行标绿）、inlineEdit.ts（⌘K）、tabCompletion.ts（Tab 补全，DeepSeek FIM）、editorSettings.ts、recommend.ts（推荐语言扩展）、search.ts（代码语义搜索）、status.ts（状态栏）、signals.ts（IDE 往 Dispatch 发信号）、defaults.ts（首启默认设置）

## dispatch CLI（`app/cli/`）

`dispatch.py` 是入口：`_parser()` 注册全部子命令；任务、wiki、todo、prime 这些老命令的实现还在它里面（`cmd_<名字>`），新命令放进单独的模块。`DELEGATED` 里的命令（ide、checkpoint、code-search、browser、computer、attribution）整个交给模块自己的 `main(argv)`。新模块要进 `bundle.json`（test_bundle 会查）。

- **公共**：dplatform.py（平台层，Windows 适配）、lang.py（界面语言）、net.py、mirrors.py（国内镜像）、toml_lite.py、winproc.py、qr.py、launchd.py、launchd_labels.py、backups.py、edit-guard.py（多 Agent 同改一个文件的提醒）、own_prompts.py、models.py
- **任务板**：board_service.py（chatd 里唯一写板的服务）、board_client.py、board_export.py、tasks_view.py、acceptance.py、things.py、ownership.py（任务的地盘）、lineage.py（`dispatch here`）、links.py、capture.py（对话里的需求自动上板）、waiting.py、inbox.py、now_line.py、flows.py、deliver.py（交付页）、workers.py、wake.py、turbo.py（大活拆开并行）、thread.py（脉络页）、handoff.py、handoff_facts.py
- **Agent 的上下文和知识**：prime_brief.py（会话开头的简报）、prefs.py、profile.py、soul.py、instructions.py、agent_builtins.py（Dispatch 往每个 Agent 上下文里放了什么）、knowledge_sync.py、semantic.py、memories.py、dispatch_dir.py（~/.dispatch）、dispatch_mcp.py（Agent 用的 MCP 工具）、mcp_config.py、hook.py、hooks_setup.py、life_hook.py、presence.py、terminal_hook.py、neat_auto.py、insights_report.py、summarize.py、code_search.py
- **引擎和会话**：`engines/` 里每个引擎一个适配器（__init__.py 是注册表，base.py 是接口，catalog.py 列出认得但没适配的；claude.py、codex.py、opencode.py、gemini.py、pi.py、hermes.py、zcode.py、copilot.py、goose.py、qwen.py）、agents_catalog.py、terminal_agents.py、opencode_engine.py、opencode_kit.py、codex_window.py、agent_switch.py（换模型、换 Agent）、accounts.py、autonomy.py、session_life.py、session_history.py、session_delete.py、session_control.py、session_reply.py、ide_sessions.py、activity.py、sleep.py、busy.py、awake.py、slash.py、snippets.py、zcode_plugin.py、agent_files.py、agent_plugins.py、agents_defs.py、builtin_agents.py、customizations.py、skills_find.py、project_custom.py
- **chatd**：chatd.py（常驻进程本体）、chatd_service.py（launchd 安装）、chat_protocol.py、chat_client.py、chat_life.py、chat_retry.py、chat_claude.py、chat_codex.py、chat_opencode.py（手机和 `dispatch agent` 用的对话驱动）、machines_watch.py、attachments.py
- **项目和 git**：projects_view.py、project_create.py、project_rename.py、own_copy.py（独立副本）、copy_ready.py（`dispatch worktree`）、fixit.py、attribution.py、editor.py（Agent 改了哪些行）、checkpoint.py（每轮的快照）、git_identity.py、move.py（会话和项目搬到另一台 Mac）
- **IDE 支撑**：ide.py、ide_show.py、ide_e2e.py、e2e_suite.py（端到端场景，场景在 `app/scripts/ide-e2e/`）、builds.py（构建服务）、updater.py、onboarding.py、init_wizard.py、firstrun.py、vscode_import.py、ghostty_import.py、settings_snapshot.py、usage.py、usage_scan.py、docs_view.py、automations_discover.py、env_changes.py、notify_prefs.py、me.py、star.py、doctor.py、terminal_cmd.py、terminal_daemon.py、annotate.py（截图标注）、assistant.py、assistant_home.py、assistant_live.py、assistant_survey.py（`dispatch assistant` 命令和手机端的 Assistant；Mac 界面 2026-11-11 起只读它的入门建议）、aside.py（不打断地追问）
- **浏览器和电脑**：browser.py、browserd.py、browser_ide.py、computer.py（Swift 端在 `app/computer/`）
- **多机和手机**：host_admin.py、machines.py、mobile.py、mobile_api.py、mobile_push.py、notify.py、notify_watch.py、serve.py（已停更的手机网页版）、remote_screen.py、screen_setup.py

测试 `app/cli/test_*.py`，`cd app && npm run test:py`；隔离规矩在 `app/cli/testkit/` 和 CLAUDE.md。

## 其余目录

- `app/src/`：React。`app/src/idechat/`、`app/src/knowledge/` 是扩展的 webview（`npm run build:ext`），其余是已停更的手机网页版；derive.ts、diff.ts 的测试还在跑
- `app/termd/`：终端常驻进程（Node，代码来自 Orca，MIT）
- `app/computer/`：`dispatch computer` 的 Swift 小程序
- `app/scripts/`：install.sh（dispatch-update；没设 DISPATCH_MINI 就在本机构建）、release.sh（发版：手写说明、发到 DISPATCH_RELEASE_REPO）、public-sync.sh（把当前提交导出成公开仓库的一个快照提交，查本机路径、密钥值、私人标记、gitleaks，不推）、gen-ide-theme.mjs（主题）、`app/scripts/ide-e2e/`（端到端场景）、`app/scripts/fresh-mac/`（新机虚拟机测试）
- `app/icons/`、`app/public/`：图标和静态资源；icon.icns 换了要拷一份到 `ide/vscode/resources/darwin/code.icns`
- `agent/skills/`（随包分发的技能，任务板约定在 `agent/skills/task-board/SKILL.md`）、`agent/agents/`（子 Agent 定义）、`agent/rules/`（dispatch.md 等规则）、`agent/opencode/`、`agent/pi/`
- `ide/`：构建、签名、发版脚本，逐个说明在 `ide/README.md`；`ide/tests/`、`ide/whats-new/`、`ide/opencode-kit/`、`ide/codesign-retry`
- `docs/`：用户手册（`docs/manual/`）、手机协议（`docs/mobile-protocol.md`）
- `design/`：设计稿和决策记录（`design/task-model/DECISIONS.md` 等），`design/decisions-log.md` 是 CLAUDE.md 挪出来的历史

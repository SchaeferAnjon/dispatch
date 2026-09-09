# Dispatch

会话工作台，使用 Tauri、React 和本机 `dispatch` CLI。网页端通过同一套 CLI 读取数据，手机可以连接 `dispatch serve url` 给出的地址，或在设置页「手机访问」扫二维码直接打开。

## 使用逻辑

- 工作台：最近会话、正在执行的操作、未读回复。会话为主要入口。
- 等我：未读回复、明确的确认请求或失败、被阻塞的任务。Agent 复核单独分类。
- 会话：对话持续更新，查看实时活动、文件和任务背景。翻阅历史时保持当前位置，用「回到最新」继续跟随。
- 任务：Agent 记录完成与交付；用户不必再次点击完成。`dispatch begin` 可从 `CODEX_THREAD_ID` / `CLAUDE_SESSION_ID` 获取会话 ID，也支持 `--session` 显式关联，完成后仍保留在该会话的交付中。缺少明确关联的历史任务按 Agent 与项目提供上下文，不把“提及”当成负责。

## 实时数据与已读

`dispatch activity --json` 增量读取最近 120 个 Claude Code / Codex 本地 JSONL 文件，每个会话保留最近 80 条可见事件，不展示模型内部推理。界面在前台每次请求完成后间隔 3 秒刷新，后台暂停。远端通过 `dispatch activity --local` 聚合；不支持或断联时明确标记不可用。

`dispatch seen <agent:session_id> <reply_id> --json` 只确认指定回复，记录在 `~/tasks/.dispatch/activity.sqlite`。旧请求不会吞掉随后到来的回复。读到最新回复并停留后才确认；查看文件、阅读旧消息或后台标签页不会确认新回复。原 Agent 中后续用户消息会消除之前的未读；仅在原应用打开/查看无法获知。首次启用从当时开始记录，历史回复不会全部涌入待处理列表。多设备连接同一服务时共享已读记录；不能同步原 Agent 的已读指示。

工作区差异来自 Git 的暂存和未暂存改动，并列出未跟踪文件。它可能包含同目录其他会话的修改，不能视为单个 Agent 的贡献。会话文件操作来自明确的编辑工具调用，终端脚本写入不做猜测。未接入本地记录的 ChatGPT 网页会话不在实时数据源中。

## 开发与验证

```sh
npm install
npm run dev
npm test
npm run test:py
npm run tauri build
```

CLI 在 `cli/`；Rust 只通过异步进程包装 CLI；HTTP RPC 在 `cli/serve.py`。新命令须同时接入 `src/api.ts`、Rust 和 HTTP 传输。UI 验证应使用真实数据检查桌面布局，以及 390 px 手机宽度、未读清除、新回复追加和文件差异。

安装脚本 `scripts/install.sh` 会在构建失败时停止。CLI 需保持可用：`~/.local/bin/dispatch` 通常指向本仓库的 `cli/dispatch.py`。

## 附件、回收站与指令文档

会话的「图片与产物」显示明确附加或链接的文件；桌面和网页共用 `dispatch attachment`，不通过浏览器直接访问绝对文件路径。图片可点击放大；HTML 只嵌入其目录内的图片，外部资源不加载。临时文件被删除后会给出提示。

左栏「统计与额度」通过「额度概览 / 使用统计」切换，保留各机器的来源和更新时间，不将不同机器的账号用量相加。右键任务或点击 `⋯` 可移到回收站；恢复会找回移除前的状态。回收站在任务页工具栏，手机在「更多」。

指令文档支持检测、按模型配置检查、编辑、差异预览、保存和恢复。模型优化目前为本地静态规则与深度审查提示，未调用模型接口。托管块请改其源文件；保存源文件会列出受影响副本。规则写入测试全部在临时目录进行。

`app/scripts/public-source.py` 可导出不带 Git 历史、私人运行记录和机器维护脚本的产品源码快照。公开仓库前应审阅导出的文件清单；不要直接发布本机任务数据库、会话、全局规则、服务令牌或用户截图。

### 手机查看电脑画面

在提供画面的 Mac 上登录 Tailscale，打开 Dispatch 的「设置 → 屏幕访问」，点一次「配置」：它会装好 noVNC 与 websockify（放在 `~/tasks/.dispatch`）、注册 launchd 常驻、用 Tailscale Serve 开通 HTTPS，并把当前状态和链接显示在下面。剩下只有一步要自己按：系统设置 → 通用 → 共享 → 屏幕共享。首次使用若 Tailscale 还没启用 HTTPS，配置结果里会给出管理后台的开启链接。

终端等价命令：`dispatch screen setup`（`dispatch screen status --json` 看状态），旧入口 `bash app/scripts/novnc-setup.sh` 现在只是它的封装。手机连接同一 Tailscale 网络，在「Agent 状态」或设置页复制这台电脑的「手机看屏幕」链接，用 Mac 的用户名和登录密码登录。屏幕服务只监听本机，HTTPS 由 Tailscale Serve 提供；不会启用公网 Funnel。

必须使用配置给出的 `https://…ts.net/vnc.html` 地址。旧版的 `http://机器IP:6080` 在 Safari 中没有 Web Crypto，无法进行 macOS ARD 登录，会报 `crypto.subtle.importKey` 错误。若 HTTPS 443 已有其他服务，用 `dispatch env set DISPATCH_SCREEN_PORT 8443`（或设置页的「环境」）改成别的端口再点「配置」。

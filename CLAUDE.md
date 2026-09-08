# Dispatch（全局任务板桌面端）— 项目约定

- 改完代码跑 `dispatch-update`（= `app/scripts/install.sh`：构建 → 同步到 /Applications/Dispatch.app → 重开）。只打 `.app`，别加回 dmg（会弹 Finder 窗口）。
- **一个任务一个 commit，并 `git push origin main`**（远程：github.com/SchaeferAnjon/dispatch，公开）。commit 信息 `<type>: <desc>`。
- 测试：`cd app && npm test`（vitest，derive/diff）和 `npm run test:py`（dispatch CLI）。改了 `derive.ts`、`diff.ts`、`cli/dispatch.py` 必跑。
- 架构一句话：Rust 只包 `bd --json` 和 `dispatch` CLI（`app/cli/dispatch.py`），所有会话/技能/踩坑逻辑在 CLI 里，界面只渲染。新能力先加 CLI 子命令，再加视图。
- Agent 看到的约定在 `agent/skills/task-board/SKILL.md`（池子里的 `task-board` 是指向它的软链）；改约定改这里。
- 验证界面：`DISPATCH_VIEW=<view> DISPATCH_TASK=<id> /Applications/Dispatch.app/Contents/MacOS/dispatch` 可指定启动视图/打开任务；截图用 `screencapture -l <窗口号>`（窗口号用 scratchpad 里的 pyobjc venv 查，选最高的那个）。
- 板本身用 `dispatch begin / log / done` 记录这个项目的工作（见全局 CLAUDE.md §6）。

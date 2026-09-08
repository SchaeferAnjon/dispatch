# Dispatch 应用

源码 `~/Projects/kanban/app`（Tauri 2 + React；Rust 只包 `bd --json` 和 `dispatch` CLI，逻辑都在 `app/cli/dispatch.py`）。改完跑 `dispatch-update`（构建 → 同步到 /Applications → 重开）。会话检测靠 hook `~/tasks/.dispatch/presence.py`，不要删那个目录。`Dolt server unreachable` → `bd dolt start`（LaunchAgent 每 2 分钟自动拉起）。旧嵌入式数据在 `~/tasks/.beads.embedded`。
- 跨机器同步：第一台跑首次设置的 Mac 是枢纽，它的 Dolt 由 `~/Library/LaunchAgents/dev.schaefer.dolt-server.plist` 用 `--config` 直接跑（config.yaml 开了 remotesapi :3309；`bd dolt start` 不读 config.yaml，枢纽上别用它起）。接入的 Mac 用 `bd dolt start`（LaunchAgent 带 DOLT_REMOTE_USER/PASSWORD）并每 2 分钟跑 `board-sync.sh`（`CALL DOLT_PULL/DOLT_PUSH('--user','sync',…)`；密码在 `dispatch env`）。这些都由 `dispatch init` 装好；两边 `dolt.auto-commit: on`。

### Agent 互审（与用户确认分开）
完成后需要独立检查时：`dispatch done <id> --reason "交付与验证" --verified --review-by claude-code`。这只登记复核请求，不自动启动 Agent，也不计入用户的「等你」红点。
另一位 Agent 检查后：`dispatch review <id> --verdict pass --reason "检查范围、结果、测试或文件依据"`；有问题用 `--verdict changes`，原任务重新打开。使用自己的真实 `BEADS_ACTOR`，执行者不能登记自己的互审通过；结论先写入任务活动记录，再更新复核标签。

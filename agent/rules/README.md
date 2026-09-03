# 全局规则在哪

这台电脑上所有 Agent 的共同规则只有一份：**`~/.agents/rules/GLOBAL.md`**（和跨 Agent 的 `~/.agents/skills` 放在一起）。它不在这个仓库里——它是这台机器的配置，不是应用代码。

- 查看 / 同步：`dispatch rules show|status|sync`，或 Dispatch 的"规则"视图。
- `sync` 把它写进 Claude Code（`~/.claude/CLAUDE.md`，`@import`）、Codex（`~/.codex/AGENTS.md`）、ZCode（`~/.zcode/AGENTS.md`）的托管块。
- 想备份或跨机器同步，把 `~/.agents/rules` 加进 dotfiles 仓库。

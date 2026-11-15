# Where the global rules are

All agents on this computer share one set of rules: **`~/.agents/rules/GLOBAL.md`** (next to the cross-agent `~/.agents/skills`). It is not in this repository: it is this machine's configuration, not application code.

- Look and sync: `dispatch rules show|status|sync`, or Dispatch's Rules view.
- Soul, how every agent talks and works, is `SOUL.md` in the same folder: Dispatch ships the default here (`agent/rules/SOUL.md`), the person's copy follows a newer default until they change it. `dispatch soul show|edit|reset|on|off`, or Settings › Soul.
- `sync` writes it, together with Soul and Dispatch's own `dispatch.md` (in the same folder, replaced on update), into a managed block of each agent's rules file: Claude Code (`~/.claude/CLAUDE.md`) gets `@` import lines, Codex (`~/.codex/AGENTS.md`) and OpenCode (`~/.config/opencode/AGENTS.md`) get the text in the block. A newly set up machine syncs only these three (those installed); a machine synced before keeps its earlier targets (ZCode, pi, Gemini and others); `dispatch rules targets` shows and changes them.
- To back them up or sync them across machines, put `~/.agents/rules` into a dotfiles repository.

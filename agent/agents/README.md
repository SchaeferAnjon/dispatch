# Built-in agents

The helper agents that come with Dispatch. Each `<name>.md` here ships with the CLI (`app/cli/bundle.json`
packs this folder) and is installed by `app/cli/builtin_agents.py` on first-run setup and every time the
Agents window opens after an update:

| Engine | Where | What is written |
|---|---|---|
| Claude Code | `~/.dispatch/agents/<name>.md` (`~/.claude/agents` links there) | this file as it is |
| Codex | `~/.codex/agents/<name>.toml` | `name`, `description`, `model_reasoning_effort`, `developer_instructions` (the body) |
| OpenCode | `~/.config/opencode/agents/<name>.md` | `description`, `mode: subagent`, the body |

A file of the same name that is already there is the person's and is never replaced. Settings › Soul
lists these with an On / Off switch (`dispatch builtin-agents off <name>`).

## Writing one

- Frontmatter: `name`, `description` (English, it is shown in Settings and read by the engine to decide when
  to hand work over), `tools` (Claude Code tool names; leave it out to give every tool), `model` (`inherit`,
  `sonnet`, `opus`), `effort` (`low` to `max`).
- Body: how to work, in plain words. It goes to every Dispatch user: no names, paths, machines or habits of
  one person; read the project's own rules from its `CLAUDE.md` / `AGENTS.md` / `DESIGN.md`, and the person's
  taste from `dispatch prefs`.
- An agent that has its method in a skill: put the skill in `agent/skills/<name>/`, add it to `bundle.json`'s
  `dirs`, to `BUILTIN_SKILLS` in `app/cli/init_wizard.py` and to `BUILTINS` / `BUILTIN_DESCRIPTIONS` in
  `app/cli/customizations.py` (see designer).
- teaching-master and animation-director work from the project's `TEACHING.md` (who the students are, what
  the exam asks, what matters most); designer from its `DESIGN.md`. A new one that judges against a project file says so the same way.
- `cd app/cli && python3 -m unittest test_builtin_agents` checks every file here: frontmatter, no private
  paths, renders for all three engines.

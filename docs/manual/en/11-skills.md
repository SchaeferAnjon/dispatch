# Skills

> What this page is for: what is in the skill pool, which Agent each skill is mounted on, and how to edit a SKILL.md, create a skill or import one from GitHub inside the app.

## The skill pool

A skill is a folder with a `SKILL.md` in it, and they all live together in `~/.cc-switch/skills` (the skill pool). Agents use symlinks: mounting on Claude Code links it into `~/.claude/skills`, and mounting on Codex links it into `~/.agents/skills` or `~/.codex/skills`. Mounting takes effect in new sessions; unmounting removes only the symlink and leaves the skill itself alone. Only these two Agents are supported for mounting right now.

A line at the top of the page says "editing &lt;machine&gt;": when the sidebar has another machine selected, you are editing that one (and it explains why if that machine is offline).

## The list on the left

- Search skill names and descriptions; filter by "All / Claude Code N / Codex N".
- "By usage" sorting: the call counts from the session index (C = Claude Code, X = Codex; Codex and ZCode do not record skill calls).
- Each row: the name, "one location only" (for skills that are not in the pool and are installed only under one Agent's folder), the call count, the description, and the two mount markers.
- "✦ Improve skills from recent work": copies a start command; paste and run it in a terminal and an Agent reviews and improves the most-used skills based on the last 14 days of sessions.
- "＋ New skill": skill name (the folder name), a one-line trigger description, when to use it, key constraints, and who to mount it on; it is created in the pool from the SKILL.md template and mounted.
- "Import from GitHub": enter `owner/repo` or a repository URL (you can name a subdirectory and the name it lands under in the pool); it downloads the public repository and copies the folder holding SKILL.md into the pool. If the repository has no SKILL.md, a draft entry point is generated, and the source and LICENSE are recorded.

Right-click a skill: view, mount on / unmount from …, open in an editor, reveal in Finder, copy path, copy the SKILL.md contents, move to Trash (or unmount). Right-click empty space: reload the skill list, improve skills from recent work, reveal the skill pool in Finder.

## The details on the right

The skill name, the path, and the file currently open (SKILL.md by default; relative links inside the Markdown navigate within the skill folder, and "This skill's files · N" lists them all). Buttons: reveal in Finder, open in an editor, and "Edit here" (in-app editing, <kbd>⌘S</kbd> to save, with the old version kept as a `.bak`). Two checkbox rows below: Claude Code and Codex, each showing its mount folder.

## Command line

```sh
dispatch skills list --json
dispatch skills show <name> [--file detail-04.md]
dispatch skills enable <name> --agent claude    # or codex / all; omitted = mount on both
dispatch skills disable <name> --agent codex
dispatch skills new <name> --description "…" --trigger "…" --constraint "…" --agent claude
dispatch skills import owner/repo [--path skills/pdf] [--as name] [--force]
dispatch skills open <name> [--reveal]
dispatch skills trash <name>
```

`dispatch catalog` lists the skills and plugins that are not mounted by default; an Agent suggests enabling one when it judges it clearly useful.

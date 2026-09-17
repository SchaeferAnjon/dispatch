# Agent-side conventions

> What this page is for: how an Agent learns about the task board, when it should run which `dispatch` command, how to write a commit message so it lines up with a task, and how to file an outcome. These conventions are written in the `task-board` skill shipped with the app (`agent/skills/task-board/SKILL.md`); this is the version for humans.

## How Agents know all this

- Step 4 of first-run setup installs hooks for Claude Code: `SessionStart` runs `dispatch prime --hook-json` to inject a summary at the start of the session, other events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `PermissionRequest`, `Stop`, `SessionEnd`) report the session state (this is what the workbench's "Running / Needs you" relies on), and the edit lock check runs before and after editing tools.
- Step 5 syncs the shared rules into each Agent's entry file and mounts the `task-board` skill from the skill pool; Codex, pi, ZCode (`dispatch zcode-plugin install`) and the others learn the same things through the rules and the skill.
- What `dispatch prime` injects: who you are (the Agent identity), the current project, one sentence on how tasks are recorded, this project's tasks from the board (the ones in progress, the ones handed to it, and the comments you left on tasks that have not been answered), the tracked sessions, the knowledge entries for this project and the general ones, the facts, the key names (without the values), the quota, and who else is working in the same folder.

## The life of a task

```bash
dispatch begin "<what> <how it changes>: <why>" -P project -d "what triggered it + the expected result" -a "- [ ] criterion"
dispatch claim TASK_ID                     # claim an existing task; refused if someone else is on it, --force takes it anyway
dispatch log TASK_ID "key progress"        # a progress note; --tick KEYWORD ticks off a criterion
dispatch done TASK_ID --reason "delivered and verified" --verified --retro "【technique】…【right】…【wrong】…"
```

The rules:

- **The title** has to make it obvious weeks later what changed and why (for example: "Session page diff scrolls horizontally: the right half was cut off on phones"). Between 8 and 80 characters; something too short or nothing but a verb is refused by `begin`; anything over 40 characters is truncated at a punctuation mark, and the full title is recorded automatically on the first line of the description. The description needs at least 20 characters covering what triggered it and the expected result. `--force` skips the checks.
- When the session identity is available, `begin` automatically applies the `session-origin:<session id>` and `session:<session id>` labels, and that is the formal relationship between a task and a session; `--session` sets it explicitly.
- `--verified` means only that you verified it yourself, not that it was independently reviewed; it ticks every criterion that is not ticked yet and signs them (the interface shows "Self-checked · &lt;Agent&gt;"). If you checked them one by one, use `dispatch log ID --tick KEYWORD` instead.
- `--retro` needs only a sentence or two and goes into the knowledge base; `--next "follow-up title"` creates a follow-up task; `--review-by <agent>` asks another Agent to review (`dispatch review ID --verdict pass|changes --reason`, where the reviewer cannot be the one who did the work).
- Do not close a task that is not finished. `bd show ID --json` reads a task and `bd update ID` changes a field; do not use `bd edit`, which opens an editor.

## Things only the user can do

```bash
dispatch need-you "what the user has to do" -P project -d "why, how, and where the material is" [--task TASK_ID]
```

For things like sending an email, paying, signing in, demoing in person or making a decision, do not just write it in a reply: record it as an "Only you can" item. The user ticks it closed on the project page's Task tab, and it is pushed to the phone as well (if that is on).

## Put the task id in the commit message

Put the task id at the end of the commit message: `feat: session page diff scrolls horizontally (task-abc)`; or write the commit hash in `done --reason`. The task page's "Git commits" and `dispatch commits ID` use this to line the task up with the code; when one task has several commits, put it in each of them. Commit messages use `<type>: <desc>`.

## The knowledge base

```bash
dispatch wiki search "keyword"               # look it up before you start; --semantic searches by meaning
dispatch wiki add --kind pit "symptom" --fix "fix" -P project [--task ID]
dispatch wiki add --kind win "approach" --why "why it is right" -P project
dispatch wiki add --kind howto "steps"
```

## Filing an outcome

An outcome is a Beads record with a label. Agents use `bd create`:

```bash
bd create "outcome title" -d "what was delivered and where to see it (Markdown, with document / screenshot / version / code links)" \
  -l dispatch:outcome -l project:<project> -l outcome-task:<task-id> -l session:<session id>
bd close <new id> --reason "outcome filed"
```

The user can also file or edit one on the project page's "Outcome" tab. Do not write ownership in bulk based on how often something is mentioned, and do not copy every finished task into an outcome automatically.

## Other common commands

```bash
dispatch here [--dir <cwd>] [-P project]  # this project right now: where it stands, a 14-day timeline, unfinished tasks, whether live sessions are safe to close
dispatch editing [--dir <cwd>]           # who is changing which files; two or more sessions on the same file is flagged as a conflict
dispatch lineage [-P project]             # project → task → session → progress
dispatch facts get "topic" [-P project]   # the facts
dispatch env get NAME                     # fetch a key's value (prime only lists the names)
dispatch profile add "fact" / upcoming "2026-09-20|item|to do" "notes" / done <keyword>
dispatch docs add <project> <path|URL> --kind 调研|复审|设计|文档|其他   # file research and review output on the project page's "Documents" tab (the kinds are research, review, design, document, other)
dispatch notify "title" "body"            # push one message to the phone or the Mac
dispatch terminal --cwd <folder>          # open a terminal tab in Herdr with no Agent
dispatch adopt <session id|pid-N>         # take a session from another terminal into Herdr
dispatch agent start <kind> --cwd … --task <id> -p "…"   # delegate to another Agent (Herdr underneath)
```

## The labels at a glance (the conventions on the task board)

| Label | Meaning |
|:--|:--|
| `project:<name>` | The project it belongs to |
| `session-origin:<id>` | The originating session, applied automatically by `begin` |
| `session:<id>` | An explicitly linked originating or participating session; there can be several |
| `dispatch:outcome` | An outcome record, kept out of the ordinary task counts |
| `outcome-task:<task-id>` | A task an outcome came from; there can be several |
| `dispatch:needs-you` | Only you can do it |
| `dispatch:trashed` / `dispatch:archived` | Trash / archived |
| `delegated-by:` / `delegated-to:` | Who handed it to whom |
| `host:<machine>` | Which machine it was worked on |
| `dispatch-projects` (memory) | Project star and archive states; memories starting with `dispatch-` stay out of the knowledge base and out of prime |

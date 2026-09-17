# Glossary and shortcuts

> What this page is for: one-sentence explanations of the words that appear in the interface and in the commands, plus the keyboard shortcuts and mouse actions of the desktop version.

## Glossary

| Term | Meaning |
|:--|:--|
| Agent | A coding assistant: Claude Code, Codex, pi, ZCode, Gemini CLI, OpenCode, Hermes. Dispatch only reads their records and never stands in for them |
| Session | One complete conversation between one Agent and one folder, read from its own transcript file or database |
| Project | The unit that sessions are grouped into by working directory; only folders with tasks, outcomes or a manual link are real projects, and the rest are "folders" |
| Workspace root | The list of folders in Settings (`~/Projects` by default) whose direct subfolders each count as one project |
| Task | A record on the central task board (Beads), written by Agents with `dispatch begin/log/done` |
| Task board | The Beads database in the folder `~/tasks/.beads`, stored in Dolt and synced across both Macs |
| Beads / bd | The task board software and its command line |
| Dolt | A database with version history, used by the task board for storage and syncing |
| Herdr | The Agent multiplexer in your terminal, kept resident by tmux; delegating, replying to the original session and judging state all go through it |
| Hub | The first Mac to finish first-run setup, which holds the task board, the rules and the skills |
| Join | The second Mac using the hub's task board |
| Move | Carrying a project or a session over to the other Mac to carry on there |
| Outcome | A delivery record of its own (`dispatch:outcome`) that can link to several tasks and sessions |
| Acceptance criteria | The `- [ ]` checklist in a task; ticking a box signs it |
| Completion note | What was delivered and verified, written by `dispatch done --reason` |
| Needs me | What needs your hands: unread replies, confirmations pending, "Only you can" items |
| Unread reply | The Agent finished answering and you have not read the latest turn |
| Needs confirmation | The Agent is stopped at a permission or trusted-folder confirmation box |
| Only you can | Something only you can do, recorded by an Agent with `dispatch need-you` |
| Blocked | A task with unfinished dependencies; it clears itself once they are done |
| Deferred | The state of a task that is not scheduled for now |
| Agent review | One Agent asking another for an independent review (`--review-by` / `dispatch review`) |
| Tracked | A starred session or project, pinned to the top and never archived automatically |
| Archive | Hidden from the workbench and the lists, recoverable at any time; a session with no activity beyond the number of days you set is archived automatically |
| Trash | Removed tasks, which keep their history and dependencies and can be restored |
| Scheduled session | A session started by a schedule, a script or another Agent through the programmatic interface; it never enters "Needs me" and never notifies |
| Loose session | A session with no title and at most one sentence, folded at the bottom of the session list |
| Origin | Where a session was started: terminal, desktop app, VS Code, SDK, scheduled job, Telegram and so on |
| Into Herdr | `dispatch adopt`: stop the idle session process in another terminal and `--resume` the same session inside Herdr |
| Resume | Reopening the same record in Herdr after the original terminal was closed |
| Queue message / Interrupt and send | Queue a message after the current turn while the Agent is running, or press Esc first and then send |
| Withdraw | Take a message that has not been handled back out of Claude Code's queue |
| Split / Detach | Two or four sessions side by side on one page; moving the current page into its own window |
| Knowledge base / wiki | The experience every Agent shares: pitfalls, wins, retros and how-tos, stored in Beads memory |
| Pitfall / win / retro / how-to | The four kinds of knowledge base entry |
| Rules / GLOBAL.md | The rules shared by every Agent, with `~/.agents/rules/GLOBAL.md` as the single source |
| Managed block | The section of GLOBAL.md content that is synced into each Agent's entry file |
| Reference / FACTS.md | Servers, databases and what each account is for; the global one is `~/.agents/rules/FACTS.md`, and a project's own sits in its folder |
| Keys / dispatch env | The API keys and passwords in `~/.config/dispatch/env`, of which Agents see only the names |
| Memory | The long-term memory file each Agent accumulates across its own sessions |
| About me / PROFILE.md | The profile of the user, maintained automatically by Agents |
| Skill pool | `~/.cc-switch/skills`, one folder with a SKILL.md per skill |
| Mount | Symlinking a skill into some Agent's skill folder |
| prime | `dispatch prime`: the summary injected at the start of a session |
| hook | Claude Code's event hooks, used to report state, inject prime and lock edits |
| Threads | The graph of task → session → progress / commit |
| Insights | Cross-Agent retro signals and the report a model writes |
| Discussion | Several Agents each saying their piece once about one idea and reaching a conclusion |
| Delegate | Starting an Agent in Herdr on some machine to work on a task |
| Quota | The usage windows and reset times of each Agent's subscription |
| Summary model | The model picked in Settings, used to write session summaries, project status and so on |
| Tailscale | The virtual private network your phone and your second Mac connect through |
| ntfy / Bark | Phone push channels |
| noVNC | Seeing and controlling the Mac's screen in a phone browser |
| Machine / hosts.json | Every Mac registered in `~/tasks/.dispatch/hosts.json` |

## Keyboard shortcuts (desktop version)

| Key | What it does |
|:--|:--|
| <kbd>⌘K</kbd> | Search projects, sessions and tasks |
| <kbd>⌘N</kbd> | New session |
| <kbd>⌘T</kbd> | New task |
| <kbd>⌘R</kbd> | Refresh |
| <kbd>⌘⏎</kbd> | Send a reply, send a comment, save a dialog (new task, a knowledge entry, a key, a skill) |
| <kbd>⌘S</kbd> | Save the SKILL.md you are editing |
| <kbd>Esc</kbd> | Close a dialog, close the task details (leave the property editor first), close the / command menu, clear the search box |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>⏎</kbd> | Move and select in the search panel, the / command menu and right-click menus |
| <kbd>→</kbd> <kbd>←</kbd> | Next / previous step in the tour |
| <kbd>⌘</kbd>-click | Open a project, session or task in a new window |
| Right-click | Separate menus for tasks, sessions, projects, skills, files, machines, knowledge entries and rule documents; empty space gives this page's actions. On a phone, hold for about half a second |
| Double-click | The project title to change its display name; a task description to start editing |
| Drag | Move a board card to another column |

The shortcuts also fire inside input boxes (a known limit).

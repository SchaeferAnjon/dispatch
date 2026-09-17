# Dispatch user manual

> What this page is for: figure out what Dispatch is, who it suits and what it does not do, then decide which chapter to start with. The whole manual is full-text searchable from the search box in the top left.

Dispatch is a **local Agent workbench** that runs on your Mac. You keep using coding Agents such as Claude Code, Codex, pi, ZCode, Gemini CLI, OpenCode and Hermes in your terminal or editor exactly as you always have; Dispatch only reads the records they already write on this machine and lays every session, task and outcome out on one table, grouped by **project**: who is waiting for you, who is running, how far along everything is. When you see an Agent waiting, you reply to that original session straight from your Mac or your phone.

The current version is v0.7.29, it supports macOS 14 and later, and it is open source (MIT). The website and demo video are at <https://schaeferanjon.github.io/dispatch/>, and the source is at <https://github.com/SchaeferAnjon/dispatch>.

![Workbench: where every project stands right now](../../assets/shot-home.png)

## What it does

- **Reads local records only**: transcript files from Claude Code and Codex (including sessions opened in the VS Code extensions), pi's session files, and the databases of OpenCode, ZCode and Hermes. No API key is needed, and you do not have to create a task board before you can see your sessions.
- **Organizes by project**: sessions are grouped into projects by working directory; tasks and outcomes hang off sessions; the project page is the complete record of one project (review, sessions, tasks, outcomes, documents, knowledge base).
- **Replies land in the original session**: open a session from the workbench, from "Needs me" or from your phone and reply directly, and the message is delivered to the original session in that terminal. If it is running, the message queues, and you can take it back if you sent the wrong thing.
- **Agents record their own tasks**: every new session automatically receives its identity, this project's tasks and the relevant knowledge; Agents record tasks with `dispatch begin / log / done` and pitfalls with `dispatch wiki`. You do not have to click things done one by one in the interface.
- **One set of data across two Macs**: the task board, the rules and the skills stay in sync, and a project can be moved to the other Mac in one step, along with its uncommitted changes, Git history and running sessions.
- **Phone**: reach the same interface over Tailscale; notifications go through ntfy, Bark or system notifications; when you need it, noVNC shows you the Mac's screen.
- **No extra model calls**: the interface itself never calls a model. Only the summarizing features (session summary, project status, discussion conclusions, insight reports, memory overview, semantic search) hand excerpts to the model you picked in Settings. These uses are on by default and can be turned off one by one in [Settings](14-settings.md); see [Known limits](26-limits.md) for details.

## Who it is for

- People who keep several terminals and several Agents open at once and keep losing track of which one is waiting for confirmation and how far each project has gotten.
- People who want Agents to record their own tasks and pitfalls instead of maintaining a board by hand.
- People with two Macs (say one that stays put and one that travels) who want a single task board and a single set of rules.
- People who want to check progress, send a line back and press a confirm button from their phone while out.

## What it is not

- **Not another Agent**: Dispatch does not generate code and does not talk to Agents on your behalf. It watches and forwards.
- **Not a cloud service**: all data stays on your Mac. Phone access runs over the private Tailscale network and is never exposed to the public internet.
- **Not general-purpose project management software**: the task board (Beads) is there for Agents to write to, and its fields and flow are designed around "what the Agent did and what you need to do".
- **Does not read ChatGPT web sessions**, and it cannot get a read receipt out of the original Agent app (unread only clears once you reply).
- **macOS only for now**. The interface layer is Tauri plus React and the logic lives in a Python CLI, so a port is possible, but it has not been done.

## How to read this manual

| You want to | Go to |
|:--|:--|
| Install it and see your first project | [Five-minute start](01-quickstart.md) |
| Understand project, session, task, outcome and "Needs me" | [Core concepts](02-concepts.md) |
| Know what a button on some page does | The "Every page" group, for example [Session page](05-session.md) |
| Know what you can do from a phone and how to connect | [Phone](20-phone.md) |
| Connect a second Mac and move a project over | [Two Macs](21-two-macs.md) |
| See how Agents record tasks and write commit messages | [Agent-side conventions](22-agent.md) |
| Look up the arguments of a command | [Command-line reference](23-cli.md) |
| Fix something that went wrong | [Troubleshooting](24-troubleshooting.md) |
| Know where the rough edges still are | [Known limits](26-limits.md) |

Simplified Chinese is the source language for the interface text; the button names in the English and German versions match the corresponding language inside the app. In Settings you can set the interface language to follow the system, or to Chinese, English or Deutsch.

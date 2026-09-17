# Rules and docs

> What this page is for: how to write, sync and check the rules shared by every Agent; Reference, keys, each Agent's memories and "About me" are all managed on this page.

Four modes at the top of the page: **Agent rules**, **Reference**, **Agent memories** and **About me**. Every mode carries the "editing <machine>" hint, so if the sidebar has the other machine selected, you are editing that one.

## Agent rules

### The idea

`~/.agents/rules/GLOBAL.md` is the **single source** of the shared rules. When you sync, it is written into a managed block inside each Agent's entry file:

```
<!-- BEGIN DISPATCH GLOBAL RULES ... -->
…the contents of GLOBAL.md…
<!-- END DISPATCH GLOBAL RULES -->
```

Entry files are things like `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and the matching locations for pi, Gemini and OpenCode. Outside the managed block sits that Agent's own special configuration. To change the rules, change GLOBAL.md and then sync; while you edit an entry file, the managed block shows as a single placeholder line so you cannot change it by accident.

### The page

- **Scope**: the global rules, or one of the detected projects (which shows the project's AGENTS.md / CLAUDE.md alongside the inherited global rules).
- **Sync button**: "Shared rules in sync", or "Sync shared rules · N to update"; when it says "No shared rules configured yet", run step 5 of first-run setup first. From the terminal: `dispatch rules status|sync`.
- **The document list on the left**: "Shared rules for every agent" (GLOBAL.md), each Agent's entry, project rules, and the documents they reference; marked as not created, overridden, referenced document, project rule or global entry. Right-click for open in an editor, reveal in Finder, copy path and copy contents.
- **On the right**: the document contents (rendered Markdown), the line count and the size. "Edit" starts editing; "Check" runs local static checks: duplication, possible conflict, broken references, scope, length, portability, circular references and version mismatch. The check **calls no model and uploads no documents**.
- While editing: "Check and preview the diff" → "Apply changes to N files". Every document version is rechecked before saving; when you are changing GLOBAL.md, all the managed copies are previewed and saved together; a restore point is kept ("Restore the last save"). If a file was changed by another program, the save is refused rather than overwriting it.
- **Check suggestions**: each one has a type, a location, an explanation and a suggestion; "Copy the deep-review prompt" hands the selected context to your own Agent for a semantic review. "Possible conflict" is a static check result, not a complete semantic proof.
- **References and what the check is based on**: what this document references, plus links to each Agent's official documentation.

Changing the rules does not reload Agent sessions that are already open; only new sessions pick them up.

## Reference

Three blocks:

- **Keys and APIs**: the interface for `dispatch env`. Keys are stored in `~/.config/dispatch/env` (readable only by you) and never go into the task board, the knowledge base or Git. Each one has a name, a purpose, an optional project (when it belongs to one project only, Agents see it just in that project's sessions, and the project page lists it too) and a masked value. Actions: show, copy, edit, copy the lookup command (`dispatch env get name`) and delete (click twice to confirm; the value cannot be recovered). At the start of a session, an Agent sees only the variable names and their purposes and fetches the value itself when it needs it, so you never have to paste a key again.
- **Servers and databases**: the global `~/.agents/rules/FACTS.md`, recording machines, cloud services, databases and what each account is for. The `## General` section is injected into every session, and passwords and tokens belong in the keys instead. Short facts that belong to one project live in that project's FACTS.md on the project page's "Documents" tab.
- **Obsidian vaults**: lists the vaults detected on the selected Mac, with "Open in Obsidian" and "Copy path". It reads metadata only and never moves or uploads notes.

## Agent memories

The long-term memory each Agent accumulates across sessions (the memory files of Claude Code, Codex, ZCode and Hermes), grouped by Agent and project. The page is read-only.

- The tree on the left: Agent → project → entry, where "index" marks a project's index file and "stale" marks entries whose project folder no longer exists, which you can "Archive" into an `archived/` folder alongside them.
- On the right: with nothing selected you get the **overview** (a paragraph on the whole picture plus one line per project, written by the summary model, cached, with "Summarize again" to rewrite it); select a project to see its entries; select an entry to see its text, with "Copy path", "Open in the default app" and "Add to About me" (which appends the entry to "About me" so that every Agent sees it from then on).

From the terminal: `dispatch memories list|show|archive|summary`. Opening this page requests an overview automatically (which calls a model), see [Known limits](26-limits.md).

## About me

`~/.agents/rules/PROFILE.md`: the profile of you, split into where things stand, things that will happen and things that already have. Agents maintain it automatically (`dispatch profile add|upcoming|done`) and `dispatch prime` injects it. You can edit it directly here; "Scan again" has an Agent actually test the state of each machine and rewrite the "Devices and services" section (which calls a model).

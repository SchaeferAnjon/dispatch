# Overview and discussions

> What this page is for: two rather different pages. "Overview" is the map the app ships with, one sentence per page; "Discussions" is where several Agents each say their piece about one idea, reach a conclusion, and then someone is sent to do it.

## Overview

"Overview" at the bottom of the sidebar, or the logo in the top left. One sentence sums the product up: one thread runs through every page, sessions happen inside projects, tasks grow out of sessions, tasks add up to outcomes. The Agents work below; you watch, reply and hand out work above.

- One card per page, one sentence on what it does, with live numbers (running sessions, open tasks, projects, things waiting for you, skills, knowledge entries, whether the rules are in sync, the version); click a card to go there.
- "Take the tour": a five-step walkthrough, each step switching to the matching page.
- "First-run setup": reopens the wizard.
- "How to use it", in five points: right-click, keyboard shortcuts, phone, two Macs, and how an Agent learns about the task board.

## Discussions

"Discussions" in the sidebar, or "Discuss an idea" / "Discuss…" on the workbench and the project page.

**What it is**: you hand one idea to several Agents (Claude, Codex, pi and so on, each with a model you pick and one of them as the lead); they are called headlessly (`claude -p`, `codex exec`, `pi -p`) and each leaves one 【discussion】 comment, with the lead speaking last each round and summing up; finally the summary model writes the 【conclusion】, which can be wrapped up as a document (background / conclusion / approach / steps / risks / acceptance) before you "Delegate to an agent" or "Split" it into subtasks. Each idea is one 【discussion】 task on the task board.

**The page**: the discussion list on the left (searchable, including archived ones), the selected discussion on the right: the idea (which can carry images), the participants (the lead is marked), the stream of statements, the conclusion and the document, with buttons for one more round, wrap up as a document, delegate to an agent →, split, and archive. "Summary" collapses the header information.

**A note on cost**: each participant is an entire new session's worth of tokens. Agents never start a discussion on their own; it happens only when you ask for one explicitly in the interface or on the command line. The personas and the rules of the room are under [Settings → Discussions](14-settings.md#discussions).

From the terminal: `dispatch discuss --topic "idea" -P project --with claude:opus,codex --leader pi --rounds 2 --conclude`, `dispatch discuss-doc <id>`, `dispatch split <id> --to codex:"subtask|description"`.

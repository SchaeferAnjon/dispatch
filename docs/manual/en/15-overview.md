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

**The round table and "by the way"**: above the statements sits the round table, one little person per member, so you see at a glance who is thinking, who is speaking and who could not speak. The discussion list and the summary column each fold into a narrow rail; when the chat column is wide enough the conversation moves to the left and the round table takes the right side at a larger size. A "classmate" sits at the edge of the table: when you did not follow a word or a sentence, click them and ask, or select a sentence in the discussion and click "Ask the classmate". They read the discussion as context and explain in plain words with a small example. The questions and answers are kept beside the discussion, never written into the task, the members cannot see them, and the discussion is not affected. It uses the summary model (or the leader's model when none is set) and follows the "discussion conclusion" switch under Settings → Summaries.

**A note on cost**: each participant is an entire new session's worth of tokens. Agents never start a discussion on their own; it happens only when you ask for one explicitly in the interface or on the command line. The personas and the rules of the room are under [Settings → Discussions](14-settings.md#discussions).

From the terminal: `dispatch discuss --topic "idea" -P project --with claude:opus,codex --leader pi --rounds 2 --conclude`, `dispatch discuss-doc <id>`, `dispatch split <id> --to codex:"subtask|description"`.

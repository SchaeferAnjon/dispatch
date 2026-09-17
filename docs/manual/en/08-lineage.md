# Threads

> What this page is for: the Threads page draws a project's "task → session → progress / commit" chain as one graph, answering "who is working on which task in which session, and how far along". This chapter explains how to read the graph, how to filter it, and what the list view is.

## Opening it

"Threads" in the sidebar, with the project picker on the left. `dispatch lineage [project]` on the command line outputs the same data. The default range is the last 14 days.

## Header

The project name and "N tasks · N live sessions · N sessions without a task", with a one-line summary below: "&lt;who&gt; is working on "…" in session "…"" or "Nothing in progress right now". You can switch between "Graph / List", and there are three filters: only in progress, only with live sessions, only what I am waiting on.

## The graph

There are three kinds of node, left to right:

- **Task**: title, state, assignee, acceptance progress, time of the last progress note, and the number of mentions.
- **Session**: the Agent avatar and the title, the state (running / needs you / finished), the relationship (origin / working on / mentioned), the "Safe to close / Keep open" verdict, and "N more tasks involved".
- **Progress / done / commit**: the first sentence of the progress note, the completion note or the commit message, with a date.

The connecting lines:

| Line | Meaning |
|:--|:--|
| Thick solid line (origin session) | The task was created in this session; the main line |
| Thin dashed line (picked up along the way) | Another task the session took on in passing |
| Spawned | A `discovered-from` dependency |
| Unblocks | A `blocks` dependency |
| Contains | Parent and child tasks |
| Split from | A subtask split out of a discussion |

A node's name is the task title, the session title or the first sentence of the progress note, never abbreviated. Hovering or selecting a node highlights the whole line and shows the details in the right column; clicking a task opens the task details and clicking a session opens the session page. The slider zooms. "Tasks not yet on a line" and "Sessions without a task" are listed separately below.

## List

The same data as a tree: under each task sit its sessions (with relationship, state and verdict) and its events (progress, completion, commits), newest first. Good for reading on a phone.

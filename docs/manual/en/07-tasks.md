# All tasks and task details

> What this page is for: the global view of the task board. This chapter covers how to use the board and the table, the Trash and the archive, and every block of the task details page (properties, acceptance, completion note, comments, Git commits, file changes, related pitfalls, discussion and splitting).

## All tasks

Reached from "All tasks" in the sidebar. The toolbar at the top has:

- View switches: **Board**, **Table**, **Trash N**, **Archived N**.
- Filter chips: "Agent review N" and "Blocked N"; the search box; after you click a project or an Agent in the sidebar, "Only &lt;name&gt;" appears here, and ✕ clears it.
- Right-click empty space: switch to Table / Board, clear filters, Trash, archived tasks, "Archive finished over 30 days ago (N)", plus the global actions.

### Board

Four columns: To do, In progress, Blocked, Done. Each column is grouped by project, starred projects first; groups can be collapsed, and the collapsed state is remembered per device; the Done column shows only the last 7 days by default, with "N more finished earlier ›" to expand. The column header has "Collapse all / Expand all", and the To do header has a ＋ for a new task. Sorting: by priority, by last update, by creation time.

On a card: the title, the ⋯ menu, "↑ from &lt;root task&gt;" (the root of this line), the priority, the project, the number, the type, "A handed to B", "⊘ blocked by N dependencies", "⏸ Deferred", the acceptance progress bar, "Latest progress / progress note / completion note" or "Next criterion", the assignee and the time, and "✓ Reviewed".

Dragging a card into another column changes its state: dropping it on To do reopens it or moves it back to To do, dropping it on In progress changes only the state (it does not make you the assignee), and dropping it on Done closes it with "Dragged to Done in Dispatch" as the completion note.

### Table

Columns: ID, Task, From, State, Owner, Priority, Project, Dependencies (← dependency count → blocked-task count), Updated, Actions. Click a header to sort, click again to reverse, and a third time to restore the default (starred projects first).

### Trash and Archived

- **Trash**: removed tasks keep their history and dependencies and stay out of the queue. Right-click or use ⋯ "Restore from Trash" to bring back the original state. From the terminal: `dispatch task trash|restore <id>`.
- **Archived**: finished tasks that were archived, out of the Done column and out of the counts, with their history and dependencies intact. Right-click or use ⋯ "Unarchive". "Archive finished tasks after this many days" in Settings does it automatically, and you can also do it by hand with "Archive finished over 30 days ago".

### Right-click / ⋯ menu

Open task details, open in new window, copy task ID, copy task content, delegate to an Agent… (starts an Agent in Herdr on some machine to claim it), move to To do, move to In progress, mark as done, archive (finished long ago), move to Trash.

### New task (⌘T)

Title (one sentence saying what has to be done), description (background plus what to do plus what counts as done, written for the next Agent that picks it up), type, priority, project (an existing project, a folder that only ever had sessions, or a new project name) and acceptance criteria (one per line).

## Task details

Clicking any task opens the details panel on the right (a full page on a phone). <kbd>Esc</kbd> closes it; ⇥ hides the left column so the file changes and artifacts in the right column fill the width.

### Left column

- **Header**: the number (hover for an explanation), the project and "Edit properties" (which lets you change the title, state and priority, and either "Mark as done" with a completion note or "Reopen").
- **Properties**: state, owner, priority, delegation (who handed it to whom), type, project, from (the root task), labels, dependencies, blocked tasks, creation time and creator, completion time.
- **Discussion and split** (for open tasks, or whenever there has been a discussion or subtasks): the discussion conclusion, each 【discussion】 statement, and the subtask list; "Start a discussion…" calls the selected Agents headlessly and has each leave one 【discussion】 comment (usually all in within a minute), and "Split and delegate…" creates one subtask per line you write and starts the matching Agent in Herdr.
- **Delivery and verification** (finished tasks): "N/N ticked · N still to check", the criteria still to check, and the evidence (the last three progress notes and the linked sessions). The state is written to the right of the title: "Done · no approval needed from you", "Awaiting agent review" or "Review recorded as passed". A missing completion note is flagged.
- **Completion note**: what `done --reason` wrote, expandable.
- **Description**: Markdown, double-click to edit; when empty it says "No description yet, so the next Agent that picks this up will not know why it is being done".
- **Acceptance criteria**: a `- [ ]` checklist; click a box to tick or untick it, signed "You checked"; boxes an Agent ticked show "Self-checked · &lt;Agent&gt;" or "Review · &lt;Agent&gt;"; older records may be "Unsigned". "Edit" changes the text directly.
- **Activity**: state changes, claims and comments, each with an author and a time.
- **Comment box**: "Leave a note for the next agent…", sent with <kbd>⌘⏎</kbd>. The next time an Agent opens a session, `dispatch prime` injects the unanswered comments on the tasks under its name.

### Right column

- **Related pitfalls**: pitfalls found in the knowledge base by the meaning of this task (across projects with a similarity score when semantic search is on, otherwise within this project), showing the symptom and the fix.
- **Git commits**: commits whose message ends with this task id, or whose hash is written in the completion note, each with a short hash, title, +N −M and time; expand for the file list, "Open on GitHub ↗" and "Copy hash". When empty, it explains why (no matching commit yet, or the project is not in a git repository).
- **File changes and artifacts**: the file changes recorded in the explicitly linked sessions (a diff per change) and the artifacts (an image grid and file buttons). With no linked session, it explains that a link is created automatically when an Agent claims the task or logs progress.
- **Mentioned in conversations**: sessions whose transcript mentions this task id, for reference only and not a sign of ownership; each row offers "Open log" and "Copy resume command".

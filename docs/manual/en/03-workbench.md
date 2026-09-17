# Workbench

> What this page is for: the workbench is the first page you see when you open Dispatch, and it answers "where does every project stand right now". This chapter explains what every row and every button means, and how to tune it to your liking.

![Workbench](../../assets/shot-home.png)

## Page structure

From top to bottom:

1. **Title row**: "Workbench" and "N open"; the small line below is the connection state: "Syncing session activity every 3 seconds", which becomes "Updates interrupted · reconnecting" when the stream drops, and "<machine> unreachable right now" when the other Mac cannot be reached. Two buttons on the right: "Discuss an idea" (see [Overview and discussions](15-overview.md)) and "New session".
2. **Count bar**: four clickable counts; click one to see only the matching projects, click again to clear:
   - **Unread reply**: sessions where the Agent answered and is waiting for you to look.
   - **Needs confirmation**: sessions stopped at a confirmation box.
   - **Blocked**: tasks with unfinished dependencies.
   - **Running**: sessions that are working.
   To the right: "Expand all / Collapse all", project sorting (by latest activity, by session count, by open tasks, by name; starred projects always come first), "Open on phone ⧉" (copies the phone link) and "View screen ⧉" (clickable only once screen access is set up).
3. **Insight row** (when there is one): a one-line cross-Agent retro from the last 14 days, with an "N new" alert count; click it to reach the insights section of the stats page.
4. **Tracked**: the sessions you starred, gathered here across projects, up to 6 of them.
5. **Project cards**: one per project.
6. **Other projects**: projects with no activity for three days fold into one line each, opened with "Show N".
7. **Archived**: archived projects, which you can "Unarchive".

## A project card

The card header: the collapse arrow, the project color block, the project name (click to open the project page), ☆ star, the counts ("N sessions · N open · N blocked · N outcomes"), "New session" and "Open project ›". When collapsed, the header turns into a few summary chips: "Needs you N", "Running N", "Tracked N", "Task N", "Blocked N"; clicking "Needs you" jumps to the sessions tab of the project page, and clicking "Task" jumps to the project review.

Expanded, it shows these groups in order (empty groups are hidden, each group shows at most 3 rows, and the rest sit behind "N more, open project ›" at the bottom):

| Group | Contents | Click |
|:--|:--|:--|
| Needs you | Sessions waiting for confirmation (the state chip says what they are waiting for) and unread replies (labeled "Unread reply", with a summary of this turn's reply on the line below) | "Open and reply" opens the session page |
| Running | Sessions that are working, with "Working on: …" showing the current action | Opens the session page |
| Tracked | Starred sessions that are not already in the two groups above | Opens the session page |
| Blocked | Tasks in the blocked state, with "N dependencies open"; they unblock themselves once the dependencies are done | Opens the task details |
| Tasks in progress | Assignee avatar, priority and title, with "Latest: <progress>" or "Next: <criterion>" on the line below and the acceptance progress bar on the right | Opens the task details |
| Latest session | Shown when the project has no activity at all, so you see the last session | Opens the session page |

At the bottom of the card: "Latest outcome · <title> ›" (or "No outcome filed yet").

Which cards are expanded by default: the ones within "Projects expanded by default" in Settings (2 by default), plus any with something under "Needs you". Once you collapse or expand a card by hand, your choice wins.

## Right-click

- Right-click a project name or card: open project, open in new window, new session in this project, show only its tasks, star / unstar, archive / unarchive.
- Right-click a session row: open and reply, open in new window, open the session in a terminal, mark as read / mark as unread, star (track long-term), archive, mark as a scheduled session, rename, link project, summarize this session with a model, copy resume command, move to the other Mac.
- Right-click a task row: open task details, open in new window, copy task ID, copy task content, delegate to an Agent, move to To do / In progress, mark as done, move to Trash.
- Right-click empty space: this page's actions (expand all / collapse all) plus the global ones (new session ⌘N, new task ⌘T, refresh ⌘R, search ⌘K, copy the phone link).

<kbd>⌘</kbd>-click anything that stands for a project, a session or a task to open it in a new window.

## Top bar and sidebar

- Top left is the breadcrumb: the current page name, plus a button such as "‹ Back to the workbench" once you are inside a project or a session, which steps back one page.
- Top right: "Search ⌘K", a quota bar per Agent (this machine's usage, hover for the reset time), "＋ Session", the theme switch and ⧉ "Detach" (move the current page into its own window while this one goes back a step).
- Left sidebar: Workbench, Projects, Needs me (the red badge is the number of unread replies plus confirmations pending plus "Only you can" items), Sessions, Discussions; the task group (All tasks, Threads); the Agent group (Agent status, Stats & quota, with the online Agents and the tasks under their names listed below); the knowledge group (Skills, Rules & docs, Knowledge base, Settings, Overview). With two machines, the top of the sidebar gains an "All / machine name" filter row.
- The menu bar icon shows "unread ●● running", and opens to show the counts for needs-you, awaiting review and open tasks, plus each Agent's quota.

## When there are no projects

"No projects yet. Sessions are grouped into projects by working directory, tasks by the `project:name` label." Open a session in a terminal first, or click "New session ›". If a session is clearly running but never shows up, check Settings → Projects → Workspace roots, and [Troubleshooting](24-troubleshooting.md#sessions-do-not-show-up).

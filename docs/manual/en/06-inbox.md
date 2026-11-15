# Needs me

> What this page is for: "Needs me" holds only the things you have to handle. This chapter explains what each of the seven categories is, which ones count toward the badge and notifications, and how to clear them quickly.

![Needs me](../../assets/shot-inbox.png)

## Categories

A row of tabs at the top, each with a count:

| Tab | What goes in it | Counts toward the badge |
|:--|:--|:--|
| Unread reply | Sessions where the Agent finished answering and you have not read the latest turn, grouped by project; each keeps a one-line "Unread turn" summary (written by the summary model; with summaries off, the first 300 characters of the reply are shown instead) | Yes |
| Running | Sessions that are working right now | No |
| Read | Replies you read in the last seven days, newest first, for another look or to keep replying | No |
| Needs confirmation | The Agent is stopped at a permission or trusted-folder confirmation box. Only sessions that report events show up here (the ones running inside Herdr); ones that do not, such as the Codex desktop app, are on the sessions page | Yes |
| Blocked | Tasks with unfinished dependencies; they clear themselves once the dependencies are done | No |
| Agent review | Finished tasks with an explicit review request (`dispatch done --review-by`), showing how many acceptance criteria are unticked and whether the completion note is missing; "Review it" opens the task | No |
| Idle sessions | Sessions that are open but not running and not waiting for you | No |

"Only you can" items are not on this page but in the first column of the project page's "Task" tab, see [Project page](04-project.md#task).

The badge on the sidebar's "Needs me" = unread replies + confirmations pending + "Only you can" items. A system notification is sent once, when a session turns into "Needs you".

## How to clear it

- Open a session, read to the latest turn and stay a moment, and the unread mark clears itself. Replying in the original terminal counts too.
- The "Read" button or the right-click "Mark as read" clears one row; "Mark all read" clears the lot (available at the top and in the right-click menu on empty space).
- The right-click "Mark as unread" puts a row back for later.
- "Open and reply" takes you to the session page. Sessions waiting for confirmation can be answered with the keys right on the session page, see [Session page](05-session.md#the-reply-box).
- "✦ Summarize" has a model write a summary (this calls an API).

Once everything is cleared, it shows "✓ Nothing needs you right now. New replies show up here and leave once you have read to the end".

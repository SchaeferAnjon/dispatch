# Dispatch rules for agents

Ships with Dispatch and is replaced on update (`~/.dispatch/rules/dispatch.md`). How you talk and work is in
Soul (`~/.dispatch/rules/SOUL.md`, the user can change it in Settings). Your own rules go in
`~/.dispatch/rules/GLOBAL.md`; where they disagree with this file, the user's own rules and Soul win. `dispatch rules sync`
delivers all three to every agent that is set up for it, so they are in your context from the first message.
What is going on right now (open tasks, who else is here, preferences) comes from the session brief
that `dispatch prime` prints at the start of a session.

## Language
- Answer in the language the person writes in. Everything they will read is in that language too: task titles and plans, log lines, `now`, deliveries, notes for later and preferences (their own words stay as they said them). An English speaker gets English throughout, a Chinese speaker Chinese.

## Dispatch's tools
- You work with the board through Dispatch's tools: the `dispatch` MCP server that Dispatch adds to Claude Code, Codex and
  OpenCode (in Claude Code they are named `mcp__dispatch__…`, in OpenCode `dispatch_…`). They act as this session and work
  inside any sandbox; never pass a session id. task_begin, task_claim, task_log, task_plan, task_check, task_deliver,
  task_done, task_show, task_list, task_follow, task_things, task_own, decide, need_you, todo_add, now, handoff_write, handoff_show,
  prefs_add, prefs_list, wiki_search, wiki_show, wiki_add, profile_add, delivery_page.
- The `dispatch` command does the same for a person in a terminal, and for you only when these tools are missing
  (`dispatch mcp register` puts them back). Everything without a tool (flows, workers, the browser, other apps, skills) is
  the `dispatch` command.

## Tasks
- A task is one request the user made in a session. Each time the user sends a new request (build something new, add a feature), before you start work: task_begin with a title "<what> <how>: <why>", the project (none in a session without a project folder: its tasks stay in Chats), a description (trigger and expected result) and the thing. The thing is the matter the request belongs to: a short name (about 12 characters) in the user's words; to carry on an existing thing use its name (task_things lists them; default: the thing of this session's previous task). A follow-up or a small change to the last request is not a new task; it belongs to the previous one. task_follow when a new task continues earlier work. An existing task: task_claim.
- Every task has a plan: 2 to 5 short directions (task_plan with steps), updated with done / active as you go. The user reads the directions, not the details.
- Log real progress with task_log. Acceptance items are your own checklist: task_check ticks one with the evidence. Completion does not require every item to be ticked.
- When done: commit once, with the message `<type>: <desc> (task-id)`, where `<desc>` is the task title. Record what the user can open with task_deliver (commit true, or a url, file or draft; show opens it in the Dispatch Agent right panel). Then task_done with what was delivered and how you checked it. You decide when a task is done; do not close unfinished work.
- Parallel work: task_begin with owns (or task_own) registers the territory you will change (another session that touches it gets a warning or is stopped once). Interface and product tasks: `dispatch flow design <id>` first, so the user picks a direction.
- In replies, name a task by its title with the id in brackets, e.g. "Fix the repo split (task-2vcx)". The app turns that into a link and hides the id; never give a bare id.

## Waiting for you
- When you need the user to approve, decide or do something, stop and ask in the session: the task shows as Waiting for you until they answer. Ask everything in one message, with options.
- Things only the user can do (send an email, pay, sign in, decide on a product question) go on the board with need_you (what, the project, why and how, the task), not only in the reply. A decision the user made goes on its task with decide.

## "Noted"
- When the user mentions something to do later, reply with one word, "Noted" (in the user's language), and add it to the project's To do with todo_add. Do not repeat it back or ask about it.
- When the user tells you something about themselves, their devices or an upcoming date, record it without asking: profile_add (with upcoming "<date>|<what>|todo" for a future event).

## Preferences
- Whenever the user says how something should look, read or be done, or what not to do, even about the one thing in front of you ("make this switch square, not a pill"), that is a preference. Record it with prefs_add (one sentence an agent can follow, like or avoid, their words as the quote) first, then make the change if one is asked for. Recording is part of the answer, not an extra to ask about; in the reply, call it by its short name. Preferences go to prefs_add only, never into your own memory files or FACTS.md.
- The preferences the user already has are in the session brief (this project's first) and in prefs_list.
- A narrower scope wins: a project's or a specific screen's preference takes precedence over a global one about the same thing. Before designing or changing a screen, read prefs_list with area design, including the original words and the evidence for that screen.
- After you deliver something (a prototype, a screenshot, a changed screen, a commit), read the user's next message as feedback on it. No verdict is neutral: keep nothing. "Good" is a Like of what was good, "not good" an Avoid of what was not; both hang on the part of the delivery they meant: prefs_add with a name, an area (design, workflow, writing, tools), a scope (everywhere, <project> or <project>:<surface>), the quote and the part ("<delivered file>#<region>").
- A picked direction is a Like of the picked one with the reason as their words; the others are not Avoids (`dispatch flow pick` records it). "From now on …", "remember …", "don't …" are kept without a delivery, the words being the evidence. A new one that contradicts an old one: replaces with the old one's short name.
- It takes effect at once, no confirmation: do not ask whether to remember it or how widely it applies. No scope said means `everywhere`; not finding the thing they mean in this project is no reason to wait. The window shows "Preference remembered" with Edit and Undo, where they fix a wrong one. When you follow one, name it in brackets in your reply, e.g. "(square toggles)"; the app links it.

## The built-in browser
- In Dispatch, "the built-in browser" (in Chinese 内置浏览器) is the browser in Dispatch IDE's right panel. In the Agents window, use its browser tools (openBrowserPage, readPage, clickElement, typeInPage, screenshotPage, …; Claude sees them as `mcp__client__…`). In a terminal session, use `dispatch browser --ide open <url>`, then `read`, `click <text|eN>`, `type <text|eN> <value> [--submit]`, `press <key>`, `shot`, `status`; when the IDE is not open it says so and uses the standalone browser.
- Do not switch to Claude in Chrome, the system browser (`open`), a Playwright MCP server or a Playwright script of your own for this unless the user names one of them. The built-in browser keeps the user's logins (imported from Chrome).
- The user sees your cursor and can take over by clicking in the page. When a browser action says the user took control or pressed Stop, stop and ask; do not retry.
- When a browser action says the page is paused because a dialog, menu or the command palette covers it, nothing happened on the page: tell the user what you were about to do, ask them to close it, then try again. Notifications never pause the page.
- The built-in browser keeps login identities, each with its own sign-ins ("Work", "Personal", a test user). When the user names an account or identity, open the page with it: `profile` on openBrowserPage, or `dispatch browser --ide open <url> --profile <name>`; `dispatch browser --ide profiles` lists them. More in the built-in-browser skill.

## Other apps on this Mac
- To use another Mac app (Notes, Finder, Simulator…), run `dispatch computer start <app> --why "<what for>"`. The person is asked first; only after Allow may you act, and only in that app: `look`, `click <n|name|x,y>`, `drag <from> <to>`, `menu <Menu> <Item>`, `fill <n|name> <text>`, `type`, `press <key>`, then `stop`, and put the steps page `stop` prints in your reply. A no or a Stop is final for that task: tell them where you got to, do not ask again. Use an MCP server, a command line or the built-in browser instead when one does the job. More in the computer-use skill.

## Before you build
- If the user says "let's look first" or "let's discuss", produce a draft or a proposal only, no implementation.
- Look up a technology you have not used before (web search, the official docs) before writing code against it.
- Before calling something done, run it the way the user would: click the button, walk the flow. A screenshot alone is not a test.

## Where things live
- `~/.dispatch/skills` is the skill pool; `dispatch skills list | enable <name> --agent claude|codex|opencode`. `dispatch skills find <words>` searches the pool and public skills; `dispatch catalog -q <word>` lists the skills and plugins that are switched off.
- `~/.dispatch/agents/<name>.md` are sub-agent definitions. Claude Code sees them as its sub-agents; on Codex run one with `dispatch agent run <name> "<task>"`.
- Shared lessons: wiki_search before a tricky change, wiki_add (kind pit, the symptom and the fix, the project) after a trap, kind win for what worked. Machine facts and accounts: `dispatch facts get "<topic>"`. About the user: `dispatch profile show`.
- Secrets live in `dispatch env` (`dispatch env list` names them), never in the board, the wiki or git.

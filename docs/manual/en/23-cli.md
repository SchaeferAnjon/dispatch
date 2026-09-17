# Command-line reference

> What this page is for: the subcommands of `dispatch`, grouped by purpose, one sentence each plus the common arguments and an example. Anything you can see in the interface is available with `--json`; `--help` on each command is the final authority.

To use it in a terminal you first have to finish step 2 of first-run setup (or link `~/.local/bin/dispatch` by hand). `dispatch --host <machine id> <subcommand>` runs the same command on the other Mac (over ssh, with input and output passed straight through). The data lives in `~/tasks/.dispatch` (the session registry and the transcript index) and in `$BEADS_DIR` (`~/tasks/.beads` by default).

## Tasks

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `begin <title>` | Create a task and claim it | `-P project`, `-d description`, `-a "- [ ] criterion"`, `-t type`, `-p priority`, `--deps`, `--session`, `--force` | `dispatch begin "Add a captcha to the login page: it is being hammered" -P web -d "…" -a "- [ ] tests pass"` |
| `claim <id>` | Claim it; refused if someone else is on it | `--force` | `dispatch claim task-abc` |
| `log <id> [text]` | Record progress | `--tick KEYWORD…` ticks off criteria | `dispatch log task-abc "the endpoint is done" --tick tests` |
| `done <id>` | Close a task | `--reason` (required), `--verified`, `--retro`, `--next title…`, `--review-by` | `dispatch done task-abc -r "shipped, e2e run" --verified` |
| `review <id>` | Record an independent review | `--verdict pass\|changes`, `--reason` | `dispatch review task-abc --verdict pass --reason "reran it, passes"` |
| `need-you <title>` | Something only the user can do | `-P`, `-d`, `--task`, `-p` | `dispatch need-you "Pay Vercel" -P web -d "the bill is due"` |
| `task trash\|restore <id>` | Move to Trash / restore | `--json` | `dispatch task trash task-abc` |
| `task-archive` | Archive tasks finished more than N days ago | `--days` | `dispatch task-archive --days 30` |
| `commits <id>` | The git commits belonging to a task | | `dispatch commits task-abc` |
| `find <id>` | Sessions whose transcript mentions this task, plus their resume commands | | `dispatch find task-abc` |
| `graph` | The nodes and edges of the task threads | | `dispatch graph --json` |
| `review`, `discuss`, `split` and so on | See "Several Agents" below | | |

## Sessions

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `sessions` | The running sessions (who is where, busy or waiting) | `--local` | `dispatch sessions` |
| `list` | Browse every session | `--agent`, `--project`, `--cwd`, `-q`, `--limit`, `--cached`, `--local` | `dispatch list --project web -q login` |
| `session <id\|task>` | One session's timeline and file changes | `--since offset` (live tail) | `dispatch session 3fa2 --json` |
| `resume <id\|task>` | Print the resume command | `--copy`, `--on machine` | `dispatch resume 3fa2 --copy` |
| `focus <id\|task>` | Jump to that tab in Herdr | `--on` | `dispatch focus task-abc` |
| `adopt <id\|pid-N>` | Take a session from another terminal into Herdr | `--keep`, `--force` | `dispatch adopt 3fa2` |
| `reply status\|send\|commands\|answer\|control\|revive <id>` | Reply to the original session (the interface's API) | `--agent`, `--mode queue\|interrupt`, `--image`, `--request` | `echo "carry on" \| dispatch reply send 3fa2 --agent claude-code` |
| `seen <key> <reply\|unread>` | Mark as read / unread | | `dispatch seen claude-code:3fa2 unread` |
| `session-preferences <key> <json>` | Star, archive, rename, link a project, mark as scheduled | | `dispatch session-preferences claude-code:3fa2 '{"starred":true}'` |
| `activity` | Incremental session activity and unread replies | `--events`, `--key`, `--local` | `dispatch activity --json` |
| `editing` | The files each session changed in the last 30 minutes, conflicts included | `--dir`, `--window` | `dispatch editing --dir .` |
| `attachment <key> [ref]` | Read a file linked from a session | `--thumbs` | `dispatch attachment claude-code:3fa2 --thumbs` |
| `save-image` / `save-file` | Save an image or a file from stdin (used by the interface) | | |
| `index` | Rebuild the transcript index | | `dispatch index` |
| `folders` | Browse folders (used by New session) | `-q`, `--cached` | |
| `session-control open\|browse\|start\|status\|adopt` | Open, browse, create and query sessions (used by the interface) | | |
| `terminal` | Open a terminal in Herdr with no Agent | `--cwd`, `--host`, `--label` | `dispatch terminal --cwd ~/Projects/x` |
| `session-summary run\|auto\|providers\|unread <key>` | Have a model summarize a session | `--force`, `--limit` | `dispatch session-summary run claude-code:3fa2` |
| `move <id>` | Move a session and its folder to the other Mac | `--to`, `--prompt`, `--no-files`, `--dry-run`, `--force`, `--keep-original` | `dispatch move 3fa2 --to mini` |
| `moves list\|mark` | Which copy of a moved session is the original | `--to`, `--from` | `dispatch moves` |

## Projects

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `projects` | List the projects | `--json` | `dispatch projects` |
| `project <name>` | Star, archive, move, ownership | `--star/--unstar`, `--archive/--unarchive`, `--move-to`, `--owner`, `--dry-run`, `--background`, `--force`, `--keep-original` | `dispatch project web --move-to mini --background` |
| `project-moves` | The progress of background moves | | `dispatch project-moves` |
| `here [project]` / `project-view` | The project right now: where it stands, the timeline, what is open, the live sessions | `--dir`, `--days`, `--no-summary`, `--refresh-summary`, `--summary-model`, `--local` | `dispatch here --no-summary` |
| `lineage [project]` | Project → task → session → progress | `--dir`, `--days` | `dispatch lineage web --json` |
| `project-summary <name>` | Have a model write a paragraph about the project | `--force`, `--if-stale` | `dispatch project-summary web --if-stale` |
| `docs <project>` | The project's document list | | `dispatch docs web --json` |
| `docs add\|rm\|read <project> <path\|URL\|id>` | File, remove or read a document | `--title`, `--kind`, `--asset` | `dispatch docs add web design/x.md --kind 设计` |
| `facts show\|get\|search\|write\|sections\|docs\|vaults\|topics\|import` | The facts | `-P project`, `--path` | `dispatch facts get Servers -P web` |

## Knowledge base and memories

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `wiki add\|list\|search\|show\|related` | Pitfalls, wins, retros, how-tos | `-k`, `--fix`, `--why`, `--tech/--good/--bad`, `-P`, `--task`, `--semantic`, `--limit`, `--all` | `dispatch wiki search "port already in use" --semantic` |
| `pit add\|list\|show` | = `wiki --kind pit` | `--fix`, `-P` | `dispatch pit add "symptom" --fix "fix"` |
| `memories list\|show\|archive\|summary` | Each Agent's long-term memory | `--agent`, `--path`, `-P`, `--force` | `dispatch memories list --agent codex` |
| `profile show\|add\|upcoming\|done\|inventory\|write\|path` | About me | `--refresh`, `--due` | `dispatch profile add "switched to zsh"` |
| `insights [report\|list\|show\|open\|schedule\|due]` | Cross-Agent retros | `--days`, `--alerts`, `--ack`, `--every`, `--wait`, `--force`, `--model` | `dispatch insights report --days 14` |

## Rules, skills, keys

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `rules show\|path\|open\|status\|sync\|write\|inspect\|optimize\|check\|apply\|restore\|push\|pull\|peers\|auto` | The shared rules | `--path`, `--project`, `--profile`, `--model`, `--backup`, `--host`, `--file`, `--refresh`, `--due` | `dispatch rules sync` |
| `skills list\|show\|path\|open\|enable\|disable\|improve\|write\|trash\|new\|import` | The skill pool and mounting | `--agent claude\|codex\|all`, `--file`, `--reveal`, `--description`, `--trigger`, `--constraint`, `--path`, `--as`, `--force`, `--days`, `--copy` | `dispatch skills enable pdf --agent claude` |
| `catalog` | The skills and plugins not mounted by default | `-q`, `--kind skill\|plugin` | `dispatch catalog -q pdf` |
| `env list\|get\|set\|unset\|export\|import\|path` | Keys | `--note`, `-P`, `--stdin`, `--fish` | `echo sk-… \| dispatch env set OPENAI_API_KEY --stdin --note "for summaries"` |
| `zcode-plugin install\|status\|remove` | The ZCode plugin (injects prime and the skills) | | `dispatch zcode-plugin install` |

## Several Agents

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `agent list\|start\|ask\|read\|wait\|keys\|close` | Delegate through Herdr | `--host`, `--cwd`, `--label`, `--name`, `--model`, `--task`, `-p`, `--no-wait`, `--timeout`, `--lines`, `--extra`, `--auto`, `--focus` | `dispatch agent start codex --cwd ~/Projects/x --task task-abc -p "fix the tests"` |
| `discuss [task]` | Several Agents each say their piece once | `--topic`, `-P`, `--with`, `--leader`, `--rounds`, `-q`, `--conclude`, `--image`, `--everyone`, `--fresh`, `--tui` | `dispatch discuss --topic "should we switch frameworks" --with claude:opus,codex` |
| `discuss-judge`, `discuss-conclude`, `discuss-doc`, `discuss-live` | Judge dry run, write the conclusion, wrap up the document, live state | | `dispatch discuss-doc task-abc` |
| `discuss-aside <task> [question]` | By the way: ask the "classmate" about something you did not follow in a discussion. The answer is kept beside the discussion, never written into the task, and the members cannot see it | `--stdin`, `--quote`, `--clear` | `dispatch discuss-aside task-abc "What is CKShare"` |
| `split <id>` | Create subtasks from a discussion and hand them out | `--to kind:"title\|description"` | `dispatch split task-abc --to codex:"the endpoint\|…"` |

## Machines, phone, system

| Command | What it does | Common arguments | Example |
|:--|:--|:--|:--|
| `hosts [rename …]` | This Mac and the others, and their remote desktop capabilities | `--local`, `--refresh` | `dispatch hosts rename local study` |
| `serve [run\|url\|qr\|host]` | The phone web version | `--svg` | `dispatch serve qr` |
| `screen [status\|setup]` | One-step setup for viewing the screen from a phone | | `dispatch screen setup` |
| `notify <title> [body]` | Push to the phone or to the Mac's notifications | `--url`, `--level normal\|high`, `--key` | `dispatch notify "It is done" "ready to look at"` |
| `notify-watch` | Run one phone push check by hand | `--json` | `dispatch notify-watch --json` |
| `quota` | Each Agent's quota | `--local` | `dispatch quota` |
| `stats` | Tokens, the heatmap, tools, skills | `--agent`, `--days`, `--local`, `--cached` | `dispatch stats --days 30` |
| `settings [key] [value]` | The shared settings | | `dispatch settings session_archive_days 60` |
| `summarize providers\|set-key\|uses` | The summary model and its uses | | `dispatch summarize uses` |
| `update [check\|apply]` | Check for or install a new version | `--no-relaunch` | `dispatch update apply` |
| `init [wizard\|status\|run\|…]` | The first-run setup wizard | `run deps\|cli\|board\|agents\|rules\|review\|reverse-ssh`, `rename-self`, `rename-peer`, `remove-host`, `skip`, `finish`, `reset`, `peers` | `dispatch init status --json` |
| `prime` | The injection at session start | `--hook-json`, `--cwd`, `--limit` | `dispatch prime` |

# Knowledge base

> What this page is for: what the shared experience base looks like, how to record the four kinds of entry, and how Agents end up using them.

![Knowledge base](../../assets/shot-wiki.png)

## What it is

The knowledge base lives in the task board's memory (Beads memory), is shared by every Agent, and syncs across both Macs. At session start, `dispatch prime` injects only the current project's entries and the general ones; for the rest, Agents look things up on demand with `dispatch wiki search <keyword>`, or with `--semantic` to search by meaning. When a task is wrapped up, `dispatch done --retro` generates a retro entry automatically.

## The four kinds of entry

| Type | Body | Extra fields | Where it comes from |
|:--|:--|:--|:--|
| Pitfall (pit) | Symptom + cause | Fix | An Agent runs `dispatch wiki add --kind pit "symptom" --fix "fix" -P project`, or you use "＋ Pitfall" in the interface |
| Win (win) | Which approach proved right | Why it is right | `--kind win --why` |
| Retro (retro) | What this task did | Technique, what went right, what went wrong | Generated automatically by `dispatch done --retro "【technique】…【right】…【wrong】…"` |
| How-to (howto) | A reusable set of steps or commands | | `--kind howto`, or "＋ How-to" |

Each entry can carry a project and a linked task; the key is generated from the body automatically, or you can write your own.

## The page

- Search box: keyword, project, task ID.
- Filters: **Common** (pitfalls, wins and how-tos, excluding automatic retros; the default), All, Pitfall, Win, Retro, How-to, Other memories (plain memories with no type).
- Each entry: the type chip, the key, the project, the task, the body and its fields; "Edit" and "Delete" (click twice to confirm). Right-click: edit, copy contents, copy key, open the task, show only this project's entries, delete.
- Right-click empty space: record a pitfall, record a win, record a how-to, reload the knowledge base.
- After recording, it says "Recorded. Agents on this project will see it when their next session starts".

Memories whose key starts with `dispatch-` are Dispatch's own records (project star and archive states and the like). They never appear here and are never injected into an Agent.

## Where else it shows up

- The project page's "Knowledge base" tab: only this project's entries.
- "Related pitfalls" in the right column of the task details: pitfalls found by the meaning of the task.
- The retro created when a task is finished lands here.

## Command line

```sh
dispatch wiki search "keyword" [--semantic] [--limit 5]
dispatch wiki list [-k pit|win|retro|howto|all] [-P project]
dispatch wiki show <key>
dispatch wiki add --kind pit "symptom" --fix "fix" -P project [--task task-xxx]
dispatch wiki add --kind win "approach" --why "why it is right" -P project
dispatch wiki related <task-id>      # the pitfalls closest in meaning to this task
dispatch pit add|list|show           # = wiki --kind pit
```

Semantic search needs an OpenAI or Zhipu key (`OPENAI_API_KEY` / `ZHIPU_API_KEY`) and builds its index with sqlite-vec.

# Change impact matrix

The matrix routes findings; it does not invent fixed file names. Find the project's existing architecture, integration, operations, decision and release docs first, then bring each audience's doc up to date (in phase 2, for the findings the person picked).

## Noise to remove first

| Anti-pattern | Default handling |
|---|---|
| "X went live on some date, see Y" at the top of the main rules | merge the current constraint in place; pure history goes to git, the changelog or incident docs |
| The main rules copy the whole architecture, a scoring formula or a data flow | keep the boundaries and a pointer to the authoritative doc; the details go back to docs |
| Several versions each claim to be "current" | decide by the code switches, the runtime and the fallback chain; mark old versions explicitly as fallback or retired |
| Finished to-dos still listed as open | after checking, delete them or turn them into a current constraint; no "done" logbook |
| A one-off incident written at length into memory | extract the reusable lesson; mechanism into docs, the story into incident docs or git |
| The same rule copied into several places | keep one authoritative source; the others become short pointers or go |
| "Kept for history" with no real reader or use | delete; history needs a use, an authoritative place and a way to find it |
| Agent session leftovers: one-off plans, debug scripts, `xxx_old` / `xxx_backup` copies | merge what is still valid into the real docs; the files are deletion candidates, removed only after the person confirms |

## Code or runtime changes → knowledge surfaces

| Change | Audiences to check |
|---|---|
| API / routes / protocol | external integration contract, architecture routes, authentication, examples, consumer docs, smoke tests |
| Environment variables / provider / model | example env, runbook, the authoritative default, downstream config, cost and fallback notes |
| Schema / stored fields | data model, migration and rollback, derived data and caches, read/write boundaries, tests |
| User flow / permissions / navigation | README or product notes, architecture permissions, operations handbook, visual acceptance |
| Scoring / filtering / clustering / prompts | current algorithm doc, thresholds and switches, backtest evidence, fallback chain, effect on what is shown |
| Services / deployment / CDN / edge | runbook, service names, markers, cache, rollback, live acceptance |
| Background jobs / alerts | job docs, scheduling, failure handling, alert routing, decision surfaces |
| Retirement / rename / shutdown | non-historical references to the old symbol, consumers, rules, skills and memory; keep clearly marked historical evidence |
| Release process / multi-agent lifecycle | SOP, merge and deploy scripts, knowledge receipts, cleanup gates, workspace audit |

## Audience duties

When a capability is added or changed, decide whether each of four duties exists; this does not mean creating four fixed files:

1. **How to use it**: README, API or integration guide, examples.
2. **How it works**: architecture, schema, state machines, design boundaries.
3. **How to run it**: runbook, environment variables, smoke tests, rollback, alerts.
4. **Current state and history**: product changelog, release notes, incidents or git; write a changelog only when the project rules or the person ask for one.

When one doc serves several duties, update it in place; do not split files for form's sake.

## Memory routing

| Kind of memory | Handling |
|---|---|
| The person's preferences / repeated corrections | keep short, actionable entries where the platform allows it and the person agrees |
| System mechanisms | graduate into the authoritative docs; memory keeps only a pointer |
| Decisions | keep the final conclusion and the reason that still holds; the process belongs to git or the changelog |
| Finished open items | after checking, delete them so they stop posing as a plan |
| Relative times | current state gets absolute dates; natural wording in historical narrative is not replaced mechanically |
| Duplicates or conflicts | decide by the current code or runtime; when undecidable, keep the conflict and mark it pending |
| Machine-generated indexes | never edit directly; write the prescribed input or candidate and leave it to the generator |
| Long unreferenced | judge by authority and reuse value; being unreferenced alone is no reason to delete |

## Rule violations → proposed action

| Finding | Proposed action |
|---|---|
| The local rules require one source, but the symlink or import is missing | add it within the authorization and verify realpath or loading |
| Two independent rule files differ | merge when the local declaration decides it unambiguously; otherwise pending |
| Runnable code but no project rule file | propose a minimal rule file (the five essentials, short); use the workspace's template when there is one |
| The ignore file misses a safety red line | add it within the request's scope and authorization, and check for tracked secrets |
| Naming violations, loose files in the root | report the impact; moving, renaming or deleting usually waits for the person |
| Rules reference a retired path or command | remove it when this machine confirms it without doubt and there is no cross-device question; otherwise report |
| The same violation keeps coming back | fix it at the root with a check, hook or test; whether to build it follows the local authorization |

## Checks across projects

When any of these is true, search for the real consumers instead of changing only the current project:

- a shared API, SDK, domain, authentication, schema or environment variable changed;
- the deployment or edge layer changed behaviour visible downstream;
- a shared skill, script or template is used by several projects;
- the current project's docs explicitly list who depends on it.

Finding a consumer while reading does not mean you may edit it. State the dependency evidence and the impact first, then act according to the task and the workspace's rules.

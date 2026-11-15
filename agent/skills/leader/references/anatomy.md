# The task brief · its structure

In Dispatch: `PROGRESS.md` is the task's log (`dispatch log <task> "…"`; whoever takes over reads it first with `bd show` and `bd comments`), and `BLOCKED.md` is the list of decisions waiting for the leader (one `dispatch need-you "…" --task <task>` each, which lands in Waiting for you). When a project does not use Dispatch's task board, write those two files as named.

Six sections in a fixed order: "Decided for the leader" comes first (the leader scans it before sending and can change a call), "Done when" comes last (two hard measures that gather everything). The whole is at most 4000 characters; a single task's brief is usually 1500 to 2000. This specification comes without a sample on purpose: write each brief yourself, worded for the task at hand, without borrowing stock sentences.

## Opening (no heading, five things, one sentence each)

- You are the doer, and this document is your only source for the task; nobody can be asked on the way; what you are unsure of goes into `BLOCKED.md` (the list of open decisions), you skip it and go on with the rest, and it is handed in with the delivery
- After a break or in a new session: read `PROGRESS.md` (the progress record) first and go on from there without redoing work; update it as soon as each item is done
- Why this work: one sentence of intent, why it is done and what the world looks like afterwards; the doer decides cases the brief does not cover by it
- When two requirements conflict, which gives way (such as "correct > complete > fast")
- Where law ends and advice begins: breaking "only" or "never" fails the work; "suggested" may be replaced by a better way, with one line in `PROGRESS.md` saying why

## Decided for the leader

One line per decision not asked: the question → the default (marked "guessed") | what a wrong guess costs. The leader may change them before sending; the doer goes with the defaults without stopping to wait.
Goals that cannot be judged by a machine command (style, experience) are recorded here too: turned into spot checks plus the leader's own check, saying this work can only be half delegated.

## Boundaries

- The allow-list: exactly which paths may change, plus new files; everything else is read only. Use an allow-list, not a block-list, which can never be complete
- The grading criteria (tests, acceptance scripts, CI configuration) may not be touched at all; without git, give each file's sha256 fingerprint (a digest of its content that must be exactly the same at delivery)
- Name the most tempting side jobs (the bug fixable in one line, a refactor on the way, installing a tool on the way) and say they go into `BLOCKED.md` for a decision; for what cannot be undone (deleting data, changing permissions), stop, write `BLOCKED.md` and do something else

## Current state and task 0

- Measured numbers one by one with source and date; what could not be measured is marked "guessed, not checked"; key conclusions that can be proven in advance (such as "changing only the implementation makes everything pass") are written here, taking away the excuses up front
- Task 0: run the given commands to check the numbers above; commands that do not exist and checks that check nothing are recorded in `BLOCKED.md` at once; when the numbers disagree, stop, put the evidence at the top of `BLOCKED.md`, and do only the parts not affected; once everything matches, write "the goal as understood / the order / the biggest risk" in at most 10 lines in `PROGRESS.md`, then start

## Task N

Each task has: a one-sentence goal with numbers; one sentence on where to start (with several tasks, in dependency order, saying why this one comes first); the rules written as "do A, otherwise B" with concrete consequences; acceptance = a command + a judgement a machine can make (with a guard against missing things, such as "0 skipped"); a reverse check = cause one failure on purpose, paste the red output, restore and paste all green; every check where "nobody would know if it broke" needs this step.

## Rules

- Name the cheating moves exactly: skipping tests (skip/todo), loosening checks, replacing what is under test with a fake (mock), deleting tests, changing thresholds or acceptance scripts, `|| true` (counting failure as success): each one fails the work; test count / coverage may only be ≥ the baseline; for tasks that add tests, add "`git diff` of the implementation folder is empty (not one line of business code changed)"
- No new processes, permissions or dependencies; what must be added goes into `BLOCKED.md`
- After 3 failures of the same acceptance check, move to the next item; when the result is worse than at the start, roll back and report honestly: "not done, but clearly explained" passes, "done, but worse" fails
- The project's own discipline (branch and PR rules, checks before committing) goes here

## Done when

- Two hard measures: one measures the result the leader wants (not the amount of work), one guards a constraint (fingerprints unchanged, 0 rollbacks and the like)
- One sentence: "for every item, paste the real command output in the conversation (including the red → green evidence of the reverse checks); only saying it is done does not count", because the small model judging completion runs no commands and reads no files, only what is pasted in the conversation
- `BLOCKED.md` is handed in with the delivery; when empty it says "none"
- Stop-loss: "or N rounds have been run: then stop and report honestly where it is stuck and what is missing"

## Exploring work: change four places, keep the rest

When the leader wants the answer itself (research, picking an option, "should we do X"), hard measures only buy padded answers:

1. Replace the done conditions with learning goals: a cap on the number of conclusions, each with source and date or steps to reproduce it; better 2 solid ones than 10 padded ones
2. Replace the budget with an affordable loss: at most how much time / how many sources; when it is used up, hand in "the best so far + what has not been ruled out yet"
3. Cheat-proofing guards mainly against invention: padded conclusions, citations of things that do not exist and "measurements" never run are cheating; each conclusion must survive the leader picking one at random and reproducing it within 10 minutes
4. A dead end is a valid delivery: proving with evidence that a direction is dead (why it died + the raw output) counts as done

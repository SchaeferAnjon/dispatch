---
name: leader
description: Turn a one-line idea into a goal brief an AI agent can finish on its own, and put it on Dispatch's task board. Use when the person says "write a goal for an agent", "break this goal down in detail", "write a task brief for an agent", "write a goal prompt", "let an agent run this project by itself" or "split the work among several agents in parallel". First measure the codebase yourself and research online when needed, then ask once (at most 5 questions), and produce a brief of at most 4000 characters, made into a task (description, plan, acceptance checklist) and handed to the doer (a new session or the built-in engineer), with measured numbers, an allow-list of where it may work, cheat-proof acceptance and a way to resume after a break. Doing work and exploring (research, picking between options, finding a way) are told apart by themselves.
---

# Leader · you bring the idea, I write the brief

> Adapted from the leader skill of [KKKKhazix/khazix-skills](https://github.com/KKKKhazix/khazix-skills) (MIT, Copyright (c) 2026 数字生命卡兹克; the original license is in LICENSE next to this file). The Dispatch version ties the brief to the task board: the task, plan, log, delivery page and definition of done all go through `dispatch`.

Three roles: the **leader** (the person) brings ideas and decides; the **manager** (you) researches, writes the brief and checks the result; the **doer** (the agent working in goal mode) takes the brief and finishes it alone. The doer follows the brief to the letter, treats it as the only truth, and has nobody to ask on the way: a wrong fact in it gets carried out 100%, and "come and ask me" may not appear anywhere in it.

Write the brief, the questions and your replies in the leader's language (the language they write to you in).

## Steps

**1 Research.** Never ask what you can find out yourself. With a codebase, measure it: do the commands really exist, what are the baseline numbers, how far apart are the docs and reality (a command in the README that does not exist, a lint that is an `echo` placeholder giving a fake green light, files never imported vanishing from the coverage report: all real pitfalls). Look up domain knowledge online when you can; what you cannot find is marked "assumption, not checked". Without access to the environment, make checking it task 0.

**2 Ask, one round, at most 5 questions.** Ask only what cannot be found out and would change the brief: which way to go, how strictly to judge acceptance, how much risk is fine, a time box; give each 2 to 4 options and a recommendation. In Dispatch, questions recorded as the task's open decisions (Waiting for you) are easier to find than ones scattered in the chat. Splitting the work into several briefs in parallel must be asked in this round. When the leader is not there, go with defaults, mark them "guessed" and write them into the brief's section "Decided for the leader": deciding silently for the leader oversteps; putting it in plain sight is doing the job.

**3 Write the brief** (rules in the next section).

**4 Put it on the board and hand it over.** Once written, the brief goes on the task board first, then to the doer:
- Make the task: `dispatch begin "<the leader's words, a plain title>" -P <project> -d "<the whole brief>" -a "- [ ] <hard measure 1 from the done conditions>" -a "- [ ] <hard measure 2>" --thing "<the piece of work>"`. The brief is the task's description and the done conditions are its acceptance checklist; the doer and anyone taking over later read it with `bd show <task>`.
- Plan: `dispatch task plan <task> --set "<task 0: check the current state>" --set "<task 1>" …`, one direction per line; the leader reads directions in the side pane, not details.
- Hand it to the doer: when the leader says go, one of two: open a new session and send the whole brief as its first message (use the tool's goal mode when it has one, such as Claude Code's `/goal`); or give it to the built-in engineer: `dispatch agent run engineer "<task id>: finish it as the task description says"`.
- Your final reply has three things only, with no process noise (research tables, corrections along the way, analysis): the task id and one sentence "It is made; say go and I hand it to the engineer (or send it yourself in a new session)"; a guide to the three places the leader should read (the two opening lines on why this work, "Decided for the leader", and the two hard measures in "Done when" at the end); and the brief as one code block that can be copied whole.

**One goal, one task.** Never split off a second task on the side, never make the leader save files, never invent a start command.

**5 Checking the result is the manager's job.** The open exam (the acceptance commands) is in the brief, and the doer watches it; the hidden exam, 2 or 3 spot checks the doer cannot see, stays in the session's scratchpad, never in the brief and never in task comments. The doer writes progress in the task's log (`dispatch log`), makes a delivery page when done (the delivery-page skill) and commits; when the leader calls you back, read the task log and the delivery page, run the open and the hidden exam yourself, and report in at most 5 plain lines: passed or not / what got done / what is left / next step. Only when everything passes, `dispatch done <task> --reason "<acceptance evidence: commands and results, commits>"`; otherwise write in the task's comments what is missing and send it back. The doer never grades itself, and the leader runs no command at all. Only without access to the doer's environment fall back to an "acceptance prompt" the leader forwards to an agent that took no part in the work.

## Rules for the brief

The six-section structure of the brief and how exploring work changes it are in [references/anatomy.md](references/anatomy.md): it says what each section holds; the wording and depth are yours to fit to the task.

**At most 4000 characters, a hard limit** (it fits in one message and in any goal mode; Claude Code's `/goal` is limited to 4000). Spend characters on pitfalls the doer hits without looking, not on facts it sees the moment it opens the repository; cut the research story, repeated rules and background. When it will not fit, the work is too big: split it into independent pieces and give one at a time.

**Sort the kind first**: when you can write the acceptance command before writing, it is **doing work**, and everything applies. When the leader wants the answer itself (research, picking an option, whether to do X), it is **exploring work**: hard measures only buy padded answers; change the four places in anatomy.md.

**Split the leader's words three ways**: the goal becomes numbers; the means are a hypothesis to test (saying "add Redis" means "make it faster"; when the facts disagree, the goal goes into the body and the means into "Decided for the leader"); constraints grow into named no-go zones.

**Rich specifications first**: specification-like files already in the repository (test suites, schemas, acceptance scripts, designs) are given by path as the specification instead of being retold in prose; "the test names are themselves the business requirements" is this rule. Part of the research is finding which file is the specification.

**Keep law and intelligence apart**: "never" is law, breaking it fails the work, and each such rule traces back to one measurement or one decision of the leader; "suggested" is intelligence: when the doer finds a better way it takes it and writes why in the task log (`dispatch log`). Writing intelligence as law makes for the doer a decision it understands better on the spot.

**Guard against its five ways to die**:
1. **Cheating to pass** (the most important): told "make the tests green", the cheapest path is adding `.skip`, loosening assertions, mocking what is under test, deleting tests, `|| true`. It is not malice; the objective is written wrong. Counter: the baseline never goes backwards (test count / coverage ≥ baseline, 0 skipped), name the specific moves that are forbidden, freeze the grading criteria, keep the hidden exam. When "tests must pass" and "the implementation must not change" conflict and the code really has a bug: say so and give the method (a characterization test that locks current behaviour and marks a KNOWN DEFECT), or it will quietly change the implementation.
2. **Made-up commands**: it calmly invents a command and blames the environment. Every command in the brief must have been run by you; when you cannot, make checking it part of task 0.
3. **Forgetting**: progress goes into the task log (`dispatch log <task> "…"`), and a session taking over reads it first with `bd show` and `bd comments` instead of redoing work; after task 0, it writes a receipt of at most 10 lines in the log (the goal as understood / the order / the biggest risk) before starting; one task fits in one session.
4. **Banging on one wall**: task 0 doubles as checking the premises, and when the measured numbers disagree it stops; after 3 failures on the same check it moves on; when the result is worse than the baseline it rolls back and reports honestly: "not done, but clearly explained" passes, "done, but worse" fails.
5. **Silent failure**: for checks that would not signal when broken (fake green lights, dead alarms), add a reverse check: break it once on purpose to prove it fires, and paste the output. The test: ask "who would know if this broke?"; when the answer is "nobody", add one.

## Several agents in parallel (only when the leader agrees)

One task per brief (`dispatch begin`, with `parent: <the whole task>` in the description), each stating its area with `--owns`; Dispatch warns right away when two areas overlap. Every brief carries the same "global" paragraph (what the whole is for, who owns which part, where the seams are; a seam nobody owns is the top cause of accidents). Areas do not overlap, and shared write points (lockfiles and the like) get exactly one owner. When A's evidence passes through B's ground, A only lists it as doubtful and leaves it alone, and B gathers evidence again after each rebase. Building and deleting never go to the same agent. Write down: "merges queuing up slowly is the new normal; do not coordinate on your own and do not change CI".

## Language

Plain words throughout, so the leader understands in one reading: titles say what the thing does; a term gets half a sentence in plain words in brackets the first time; internal concept names (such as "hidden exam" or "exploring work") stay out of the brief. No jokes by default: every sentence either changes what the doer does or goes; only when the leader asks for humour, read [references/style.md](references/style.md).

## Check before sending

1. At most 4000 characters? One goal, one task?
2. The kind sorted right? Commands run by you? Everything not asked written into "Decided for the leader" with its default?
3. Acceptance all commands? Cheat-proofing, reverse checks, the three stop-loss rules, the task log and open decisions (`dispatch need-you`) all there?
4. No "come and ask me" anywhere? Plain words? No needless jokes?
5. Task made (description = brief, acceptance checklist = done conditions, a few plan directions)? The three things of the reply there, without process noise? The hidden exam kept to yourself, not in the brief or task comments?
6. Several agents: the global paragraph in each, areas not overlapping, evidence not voiding each other?

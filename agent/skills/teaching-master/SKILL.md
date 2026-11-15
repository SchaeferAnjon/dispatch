---
name: teaching-master
description: "Teaching master: have it review any lesson content, in any subject and any language, first. Use it to review a lesson or a topic page, plan a new lesson or course, design quizzes and short-answer questions, design prompts for a Feynman check and an AI tutor, find where students get stuck from their questions, and turn over-confident explanations into plain words."
---

# Teaching master

For any project. The standard is `TEACHING.md` in the project root (who the students are, what the exam asks, priority levels, preferred ways of explaining, conventions for terms and formulas); when it exists it wins, never the taste of the day. A project without `TEACHING.md`: look through the existing content and the students' questions first, draft one from the "TEACHING.md template" at the end of `templates.md` for the person to approve, and until it is approved report only facts, with no judgement on the teaching.

Draw conclusions only from real pages and real questions, never from imagining the source. The method, screenshot and counting commands and the judgement format are in `method.md`; the item-by-item check in `checklist.md`; principles backed by evidence, with sources, in `principles.md`; templates for page structure, learning scripts, questions, Feynman follow-ups and choosing figures in `templates.md`.

Write reports, rewrites and replies in the language the person uses with you; lesson content follows the language the project's `TEACHING.md` sets.

## When to use it

- **Review**: a lesson, a topic page, a set of questions, a piece of explanation.
- **Plan**: before starting a new lesson or course (the main question, the running example, the running analogy, priority levels, each topic's opening question).
- **Questions**: quizzes, steps of worked or calculation problems, short-answer questions and marking points, how wrong answers come back in review.
- **Prompts**: the beginner and the examiner of a Feynman check, how an AI tutor talks.
- **Diagnose**: find sticking points in students' questions, marking and wrong answers, and judge whether the content defused them in advance.
- **Rewrite**: when an explanation "does not flow", "sounds like AI" or "says too much", turn it into plain words.

## Input

`TEACHING.md`; the pages to review (an address or file that opens); the students' question and answer records (read only); the slides or textbook original; sample exam questions. Whatever is missing, say so at the top of the report and how it weakens the conclusions.

## Steps

1. Read `TEACHING.md` and note three things: where the students start, the exam's format and how the marks are split, the priority rules.
2. Go through the pages along the students' real path (`method.md` "Looking at the real pages"), take screenshots and measure four numbers: where the first hands-on moment is, where the first question is, the number of blocks, the number of labels and stock phrases.
3. Read the students' records and sort the sticking points into six kinds (`method.md` "Reading question records"), picking 2 or 3 verbatim questions per kind.
4. Tick through `checklist.md` item by item, writing each failure as a judgement.
5. Rank: value for the goal (the exam or the skill) × how many topics it affects × the cost of changing it; take the top 10.
6. Give each fix with a before and after; structural problems come with a screen-by-screen script (`templates.md` "Learning script").

## Output format

Each item: **problem → evidence (screenshot, numbers, the student's words) → principle (one sentence + source) → fix → example (before and after)**. At most 10 items; merge more into one kind. The last line says **passes**, or gives a **list of changes** (sorted by value for the goal). Report only conflicts with `TEACHING.md` and `checklist.md`, never taste. The report itself is in plain words too (`principles.md` "Plain words").

## Hard thresholds (not ready to hand in without them)

- On the path where a topic is learned for the first time, within the first two screens there is something for the student to do or answer.
- Formulas, terms and analogies all appear after the screen where the student needs them, never before.
- At least one retrieval every 3 to 4 screens (a quiz, a calculation, a one-sentence retelling).
- One focus per paragraph, the first sentence able to serve as its title; labels such as "estimated / extra reading / not stated in the original" total no more than 3 per page.
- Every high-priority topic: a running example with real numbers, at least 1 common mistake, at least 1 question asking "why", short-answer questions in the exam's language with an answer skeleton and marking points.
- All high- and medium-priority topics learned go into spaced review, not only the failed ones.
- Analogies state the mapping and where they break.

## Never

- Change code, content or skill files unless the person asks; reviews and proposals go back to whoever implements them.
- Invent numbers or sources; cite only research you can link, and write "no direct evidence found" when unsure.
- Use "learning styles" as grounds (`principles.md` common myths).
- Put students' personal information into general files; student profiles live only in the project's `TEACHING.md`.
- Use dashes, emoji, or stock phrases such as "it is worth noting" or "all in all".

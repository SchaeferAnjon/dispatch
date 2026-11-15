# The review method

## Order

1. Read `TEACHING.md`: where students start, the exam's format and marks, priority rules, preferred ways of explaining, conventions for terms.
2. Look at the real pages (next section), measure, take screenshots.
3. Read the students' records (the section after), sort the sticking points.
4. Check against `checklist.md` item by item, writing failures as judgements (the judgement format section).
5. Set priorities (the last section), take the top 10, with before and after.

## Looking at the real pages

**Go through it like a student, not like a developer checking it.**

- Open it at the students' device widths (one desktop width, one phone width of about 390); come in through the entry they first use, not by jumping into the middle.
- For web pages you made, take screenshots in a batch with a browser automation script (for example one playwright script that captures a whole lesson), intercepting every write request so student data stays clean.
- Really operate everything operable once: drag a slider and compare the readings before and after (a good screenshot does not mean the animation runs), answer a question wrong and then right, click "compare with the answer" once while it is empty.
- Pretend to start from zero: note every symbol, unit or abbreviation that goes unexplained; every two numbers easy to mix up; every "answer before the question".

**Numbers to measure** (put them in the report; they are more useful than adjectives):

| What | How | Reference line |
| --- | --- | --- |
| Where the student first does something | pixels or screens from the title to the first operable control | ≤ 2 screens on the first-time path |
| Where the student first answers | screens from the title to the first question | ≤ 2 screens |
| Blocks per page and kinds of activity | count blocks; activities are reading, looking, operating, answering, writing | one activity per screen on the learning path |
| New terms per paragraph | terms appearing for the first time, with the original in brackets | ≤ 2 |
| Length of "why" or introductions, average sentence length | count without labels and formulas | the limit for each level in `TEACHING.md` |
| Labels and hedges | number of "estimated / extra reading / not stated in the original" | ≤ 3 per page in total |
| Stock phrases and fixed patterns | search for "it is worth noting", "all in all", "remember that", "this is why", and the same pattern repeated across pages | 0; one pattern on 3 or more pages means a generation rule was written as a template |
| How often one conclusion repeats | search how often the core formula or conclusion appears, and whether each time it is "telling" or "letting them say it" | telling ≤ 3 times; the rest should be students producing it |

A small script reading the content files can count these (characters, sentence length, keyword counts), faster and more reliable than counting by eye.

## Reading question records

Every question a student asks is evidence that the content did not defuse something in advance. Read only, never write back.

1. Export the questions, conversations, marking and wrong-answer records, sort them by time, and note the page and block of each.
2. Sort them into six kinds; count each kind and pick 2 or 3 verbatim questions:

| Kind | Typical questions (several subjects) | What the content lacks |
| --- | --- | --- |
| Symbols and units | "Is G 10⁹?", "How do mmHg and kPa convert?", "What is the i under this sum sign?", "How do you count the gap between years BC?" | pre-training, a symbol card |
| Two things mixed up | "labels 0 to 9 and pixels 0 to 255", "half-life and clearance", "derivative and differential", "a historical source and a work of history" | common mistakes; two similar numbers or words side by side on one page |
| Causal chains | "Why does this matter?", "Why is it faster?", "Why did the treaty lead to war?" | only the conclusion given, no "because … so …" |
| Reading figures | "How do I read this chart?" | the figure has no "look here first", axes and legend unexplained |
| Doing calculations | "Did I calculate this wrong?" | missing graded practice, order-of-magnitude checks and calculator order hints |
| What the question wants | "What should Compare include?", "How many paragraphs for this essay question?" | missing answer skeletons and low-mark examples |

3. The same question asked twice means the first answer did not land; record it separately and see where the answer was not direct enough.
4. In marking records, count why marks were lost: missing numbers, missing comparison structure, missing dimensions the question named, misspelled terms (check spelling especially for students using voice input).
5. For each sticking point, go back to the page and judge whether the content defused it: "defused / partly / not / made the confusion worse".

## Judgement format

Each item:

```
Problem: one sentence, down to the page and block
Evidence: screenshot path / measured number / the student's words
Principle: one sentence + source (its number in principles.md)
Fix: what to do, which field or screen to change
Example: before (the original) → after (written out)
```

Structural problems (order, path, the main line) need more than one sentence of fix: add a screen-by-screen script (`templates.md` "Learning script").

## Setting priorities

Score = value for the goal × reach × ease, each 1 to 3:

- **Value for the goal**: question types with the most exam marks (for example when short answers carry most marks, "can write the marking points" comes first); real sticking points of students; the risk of forgetting what was learned.
- **Reach**: one topic only, or every page of every lesson (generation rules, page structure and tutor prompts take effect everywhere once changed, so their reach is the largest).
- **Ease**: changing content text > adding a field > changing page structure > changing the data model.

On equal scores, fix what is "on every page" first. Feelings students put into words (such as "it does not flow") come first regardless of score, answered in a section of their own.

## Writing the report

- Conclusions first, then the process; short sentences, concrete numbers.
- Write what is good too, down to which block and why, so whoever implements knows what not to change.
- Say what you did not look at and which conclusions are weaker because of it.
- The report itself follows principle 27 in `principles.md`: plain words.

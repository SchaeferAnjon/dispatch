/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Explain terms, the word list and the matching without the window (learning while the agent works,
 *  the third part, user 2026-11-15, task-39x97, kanban design/learn-scene frame 4; the person: "终端生成的文件我从来不
 *  看，黑箱子让人不安心"). The common developer words an agent's reply and the Now tab use, each with one sentence for
 *  someone who does not program. In a reply only a word's first time is marked (a faint dotted line under it); hovering
 *  or focusing it says the sentence and offers Ask more. The marks are drawn by
 *  browser/widget/chatContentParts/dispatchTermMarks.ts. ide/tests/learn-terms.test.mjs tests this file. No imports:
 *  Node runs it as it is.
 *--------------------------------------------------------------------------------------------*/

/** Settings › Learning › Explain terms: on unless switched off. */
export const EXPLAIN_TERMS_SETTING = 'dispatch.learning.explainTerms';

export function explainTermsOn(value: unknown): boolean {
	return value !== false;
}

export interface IDispatchTerm {
	/** The word as the hover names it. */
	readonly term: string;
	/** The forms it is found by; plurals are added (commit → commits, dependency → dependencies). */
	readonly words: readonly string[];
	/** An acronym: found only in capitals (API, not "api" in a path). */
	readonly exact?: boolean;
	/** One sentence for a person who does not program. */
	readonly plain: string;
}

/** At most 30: the words a person new to programming meets first in an agent's reply. */
export const DISPATCH_TERMS: readonly IDispatchTerm[] = [
	{ term: 'Worktree', words: ['worktree', 'work tree'], plain: 'A second copy of the project in its own folder, so the agent can change files without touching the copy you work in.' },
	{ term: 'Commit', words: ['commit', 'committed'], plain: 'A saved snapshot of the project with a short note on what changed. You can always go back to it.' },
	{ term: 'Branch', words: ['branch'], plain: 'A separate line of work in the project. Its changes stay apart from the main version until they are merged.' },
	{ term: 'Diff', words: ['diff'], plain: 'The lines that were added, changed or removed between two versions of a file.' },
	{ term: 'Merge', words: ['merge', 'merged'], plain: 'Bringing the changes of one branch into another, so both lines of work end up in one version.' },
	{ term: 'Conflict', words: ['merge conflict', 'conflict'], plain: 'Two changes touched the same lines and git cannot tell which to keep, so someone has to choose.' },
	{ term: 'Repository', words: ['repository', 'repo'], plain: 'The project folder together with its whole history of saved changes.' },
	{ term: 'Pull request', words: ['pull request', 'PR'], plain: 'A request to merge a branch into the main version, so others can look at the changes first.' },
	{ term: 'Push', words: ['push', 'pushed'], plain: 'Sending your saved commits from this Mac to the shared copy online.' },
	{ term: 'Dependency', words: ['dependency'], plain: 'Code someone else wrote that this project needs in order to run, installed from the internet.' },
	{ term: 'Package', words: ['package'], plain: 'A ready-made bundle of someone else\'s code, installed so the project can use it.' },
	{ term: 'Library', words: ['library'], plain: 'Reusable code someone else wrote that the project calls on for a common job.' },
	{ term: 'Framework', words: ['framework'], plain: 'A ready-made base for building an app; the project\'s own code fills in what is special about it.' },
	{ term: 'Build', words: ['build'], plain: 'Turning the project\'s source files into the program that actually runs.' },
	{ term: 'Compile', words: ['compile', 'compiler', 'compiled'], plain: 'Translating code into a form the computer can run; an error here stops the build.' },
	{ term: 'Test', words: ['test', 'unit test'], plain: 'A small program that checks the code does what it should. It passes or fails.' },
	{ term: 'Lint', words: ['lint', 'linter'], plain: 'A tool that reads the code for likely mistakes and style problems without running it.' },
	{ term: 'Refactor', words: ['refactor', 'refactored'], plain: 'Reorganizing code without changing what it does, so it is easier to read or change later.' },
	{ term: 'API', words: ['API'], exact: true, plain: 'The requests one program accepts from another, like a menu of things you can ask it to do.' },
	{ term: 'Terminal', words: ['terminal'], plain: 'The text window where you type commands for the computer instead of clicking.' },
	{ term: 'CLI', words: ['CLI'], exact: true, plain: 'A program you use by typing commands in the terminal instead of clicking buttons.' },
	{ term: 'Script', words: ['script'], plain: 'A small program, often just a list of commands, that does a task for you.' },
	{ term: 'Hook', words: ['hook'], plain: 'A small script that runs by itself when something happens, for example before every commit.' },
	{ term: 'Environment variable', words: ['environment variable', 'env var'], plain: 'A named setting a program gets when it starts, often used for keys and folders.' },
	{ term: 'Component', words: ['component'], plain: 'One self-contained piece of the screen, like a button or a settings row, made once and reused.' },
	{ term: 'Server', words: ['server'], plain: 'A program, often on another computer, that waits for requests and answers them, like the one behind a website.' },
	{ term: 'Database', words: ['database'], plain: 'Where a program keeps its data in order, so it can find and change it quickly.' },
	{ term: 'Deploy', words: ['deploy', 'deployed'], plain: 'Putting a new version where its real users get it, like a website going live.' },
	{ term: 'JSON', words: ['JSON'], exact: true, plain: 'A plain-text way to write down structured data: names and values in curly brackets.' },
];

/** commit → commits, dependency → dependencies, branch → branches; a phrase gets its last word's plural. */
export function pluralOf(word: string): string {
	if (/[^aeiou]y$/i.test(word)) {
		return `${word.slice(0, -1)}ies`;
	}
	if (/(s|x|z|ch|sh)$/i.test(word)) {
		return `${word}es`;
	}
	return `${word}s`;
}

/** Every form a term is found by, the longest first (so "merge conflict" wins over "merge"). */
export function formsOf(t: IDispatchTerm): string[] {
	const out = new Set<string>();
	for (const w of t.words) {
		out.add(w);
		// a past tense has no plural ("committed", not "committeds")
		if (!/ed$/i.test(w)) {
			out.add(pluralOf(w));
		}
	}
	return [...out].sort((a, b) => b.length - a.length);
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

/**
 * Before a word: not a letter, digit or anything that makes it part of a name or a path (`pre-commit`, `src/build`,
 * `#test`, `@package`). After it: not a letter, digit, `_`, `-` or `/`, and a `.` only as the end of a sentence
 * (`build.ts` is a file, `the build.` is a word).
 */
const BEFORE = '(?<![\\p{Script=Latin}\\p{N}_./\\\\@#$~-])';
const AFTER = '(?![\\p{Script=Latin}\\p{N}_/\\\\-]|\\.[\\p{Script=Latin}\\p{N}_])';

/** A form in capitals (API, PR): found only in capitals, "pr" and "api" are not it. */
function isAcronym(form: string): boolean {
	return /^[A-Z]{2,}s?$/.test(form);
}

const matchers = new Map<IDispatchTerm, RegExp[]>();
function matchersOf(t: IDispatchTerm): RegExp[] {
	let res = matchers.get(t);
	if (!res) {
		const forms = formsOf(t);
		const exact = forms.filter(f => t.exact || isAcronym(f));
		const loose = forms.filter(f => !exact.includes(f));
		const re = (fs: string[], flags: string) => new RegExp(`${BEFORE}(?:${fs.map(escape).join('|')})${AFTER}`, flags);
		res = [...(loose.length ? [re(loose, 'giu')] : []), ...(exact.length ? [re(exact, 'gu')] : [])];
		matchers.set(t, res);
	}
	return res;
}

/** The first place `t` is in `text`: [start, end), or undefined. */
function firstOf(t: IDispatchTerm, text: string): { start: number; end: number } | undefined {
	let best: { start: number; end: number } | undefined;
	for (const re of matchersOf(t)) {
		re.lastIndex = 0;
		const m = re.exec(text);
		if (m && (!best || m.index < best.start || (m.index === best.start && m[0].length > best.end - best.start))) {
			best = { start: m.index, end: m.index + m[0].length };
		}
	}
	return best;
}

export interface ITermMatch {
	readonly term: IDispatchTerm;
	/** Where it is in the text: [start, end). */
	readonly start: number;
	readonly end: number;
}

/**
 * The terms in `text` that are not in `claimed` yet, each at its first place, in the order they appear; they do not
 * overlap (the earlier, then the longer, wins). The terms found are added to `claimed`: the next piece of the same
 * reply marks none of them again.
 */
export function findTerms(text: string, claimed: Set<string>, terms: readonly IDispatchTerm[] = DISPATCH_TERMS): ITermMatch[] {
	const found: ITermMatch[] = [];
	for (const t of terms) {
		if (claimed.has(t.term)) {
			continue;
		}
		const at = firstOf(t, text);
		if (at) {
			found.push({ term: t, ...at });
		}
	}
	found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
	const out: ITermMatch[] = [];
	let after = 0;
	for (const f of found) {
		if (f.start >= after) {
			out.push(f);
			after = f.end;
			claimed.add(f.term.term);
		}
	}
	return out;
}

export function termByName(name: string, terms: readonly IDispatchTerm[] = DISPATCH_TERMS): IDispatchTerm | undefined {
	return terms.find(t => t.term === name);
}

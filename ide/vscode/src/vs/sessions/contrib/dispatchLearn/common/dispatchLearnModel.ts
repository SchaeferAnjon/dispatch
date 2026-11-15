/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: learning while the agent works (direction B「Talk while new」, user 2026-11-15, task-q9x2r, kanban
 *  design/learn-scene), the sums without the window. What the agent did this turn that a person new to it would want
 *  a word about (a new file, an install, a deletion), the small card's words for it, Quiet or Talk, and the card's
 *  clock. The words come from what the agent already said (the file's own first comment, the command, the sentence it
 *  wrote before the call); no model is asked for a card. ide/tests/learn.test.mjs tests this file. No imports: Node
 *  runs it as it is.
 *--------------------------------------------------------------------------------------------*/

// ---- Quiet or Talk ------------------------------------------------------------------------------------------------

/** Talk: a small card when the agent adds a file, installs or deletes something. Quiet: nothing comes by itself. */
export type LearnMode = 'talk' | 'quiet';

/** The one setting, switched from the side chat card's ⋯ and from Settings › Learning. */
export const LEARN_MODE_SETTING = 'dispatch.learning.whileWorking';

export function learnMode(value: unknown): LearnMode {
	return value === 'quiet' ? 'quiet' : 'talk';
}

// ---- what happened ------------------------------------------------------------------------------------------------

export type LearnKind = 'create' | 'install' | 'delete';

/** One thing the agent did in this turn that gets a word. */
export interface ILearnEvent {
	readonly kind: LearnKind;
	/** create, delete: the file's path; install: the package (or `npm dependencies` for a bare install). */
	readonly subject: string;
	/** A file's path from the project's folder, when it is inside it. */
	readonly rel?: string;
	/** The command it came from (an install, a deletion by a shell). */
	readonly command?: string;
	/** What the agent said about it: the new file's first comment, or its sentence before the call. */
	readonly why?: string;
	/** The tool call it came from. */
	readonly call: string;
}

/**
 * Words you know (the prototype's frame 7): a thing the person has learned gets no card. Only the seam this time
 * (task-q9x2r): nothing is known yet, so every card shows.
 */
export interface ILearnKnownWords {
	has(key: string): boolean;
}

export const NO_KNOWN_WORDS: ILearnKnownWords = { has: () => false };

/** The word an event teaches: `install:date-fns`, `create:reminder.ts`. */
export function learnKey(e: Pick<ILearnEvent, 'kind' | 'subject'>): string {
	return `${e.kind}:${e.kind === 'install' ? e.subject : fileName(e.subject)}`;
}

/** Whether this event gets a card. */
export function shouldTalk(mode: LearnMode, e: Pick<ILearnEvent, 'kind' | 'subject'>, known: ILearnKnownWords = NO_KNOWN_WORDS): boolean {
	return mode === 'talk' && !known.has(learnKey(e));
}

export function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// ---- reading a shell command --------------------------------------------------------------------------------------

/** The command's simple commands, each as its words (quotes taken off), split at `&&`, `||`, `;`, `|` and new lines. */
export function shellCommands(command: string): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = '';
	let has = false;
	let quote: '"' | '\'' | undefined;
	const endWord = () => {
		if (has) {
			words.push(word);
		}
		word = '';
		has = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) {
			out.push(words);
		}
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) {
				quote = undefined;
			} else if (c === '\\' && quote === '"' && i + 1 < command.length) {
				word += command[++i];
			} else {
				word += c;
			}
			continue;
		}
		if (c === '"' || c === '\'') {
			quote = c;
			has = true;
		} else if (c === '\\' && command[i + 1] === '\n') {
			i++;
		} else if (c === '\\' && i + 1 < command.length) {
			word += command[++i];
			has = true;
		} else if (c === '\n' || c === ';' || c === '|' || c === '&') {
			endCommand();
			if ((c === '&' || c === '|') && command[i + 1] === c) {
				i++;
			}
		} else if (/\s/.test(c)) {
			endWord();
		} else {
			word += c;
			has = true;
		}
	}
	endCommand();
	return out;
}

/** The words with what only runs it taken off the front: `FOO=1`, `sudo`, `command`, `time`, `env`, `exec`. */
function bare(words: readonly string[]): string[] {
	let i = 0;
	while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ['sudo', 'command', 'time', 'env', 'exec', 'nohup'].includes(words[i]))) {
		i++;
	}
	return words.slice(i).map((w, j) => j === 0 ? fileName(w) : w);
}

/** Flags that take the next word as their value, so it is not a package. */
const VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '--registry', '--prefix', '-C', '--cwd', '--dir', '--filter', '-t', '--target', '--python', '-p', '--version', '--tag', '--cask-path', '--manifest-path', '--git', '--path', '--branch', '--rev', '--features', '-F']);

/** The words after `from` that are not flags or their values. */
function args(words: readonly string[], from: number): string[] {
	const out: string[] = [];
	for (let i = from; i < words.length; i++) {
		const w = words[i];
		if (w.startsWith('-')) {
			if (VALUE_FLAGS.has(w)) {
				i++;
			}
			continue;
		}
		if (w === '>' || w === '2>' || w === '<' || /^\d?>/.test(w)) {
			break;
		}
		out.push(w);
	}
	return out;
}

export interface IInstall {
	/** The tool that installs: npm, pip, brew. */
	readonly tool: string;
	/** What it installs; empty for `npm install` (a project's own list). */
	readonly packages: readonly string[];
	/** The simple command, as words joined again. */
	readonly command: string;
}

/** Where the subcommand that installs is, by tool: the words that may come there. */
const INSTALLERS: Record<string, readonly string[]> = {
	npm: ['install', 'i', 'add', 'ci', 'in', 'isntall'],
	cnpm: ['install', 'i', 'add'],
	pnpm: ['add', 'install', 'i'],
	yarn: ['add', 'install'],
	bun: ['add', 'install', 'i'],
	deno: ['add', 'install'],
	pip: ['install'],
	pip3: ['install'],
	pipx: ['install'],
	conda: ['install'],
	mamba: ['install'],
	gem: ['install'],
	brew: ['install'],
	port: ['install'],
	apt: ['install'],
	'apt-get': ['install'],
	dnf: ['install'],
	yum: ['install'],
	cargo: ['add', 'install'],
	go: ['get', 'install'],
	poetry: ['add'],
	composer: ['require'],
};

/** The installs in a shell command: `npm install date-fns`, `pip install requests`, `brew install jq`, … */
export function installsIn(command: string): IInstall[] {
	const out: IInstall[] = [];
	for (const raw of shellCommands(command)) {
		let w = bare(raw);
		if (!w.length) {
			continue;
		}
		// python -m pip install …, uv pip install …, uv add …
		if (/^python(\d(\.\d+)?)?$/.test(w[0]) && w[1] === '-m' && w[2] === 'pip') {
			w = ['pip', ...w.slice(3)];
		} else if (w[0] === 'uv' && w[1] === 'pip') {
			w = ['pip', ...w.slice(2)];
		} else if (w[0] === 'uv' && w[1] === 'add') {
			out.push({ tool: 'uv', packages: args(w, 2), command: raw.join(' ') });
			continue;
		}
		const tool = w[0];
		const subs = INSTALLERS[tool];
		if (!subs) {
			continue;
		}
		// the first word that is not a flag is the subcommand (`yarn` alone installs the project's list)
		let at = 1;
		while (at < w.length && w[at].startsWith('-')) {
			at += VALUE_FLAGS.has(w[at]) ? 2 : 1;
		}
		const sub = w[at];
		if (sub === undefined && tool === 'yarn') {
			out.push({ tool, packages: [], command: raw.join(' ') });
			continue;
		}
		if (!sub || !subs.includes(sub)) {
			continue;
		}
		out.push({ tool, packages: args(w, at + 1), command: raw.join(' ') });
	}
	return out;
}

/** The paths a shell command deletes: `rm`, `rmdir`, `unlink`, `trash`, `git rm`. */
export function deletesIn(command: string): string[] {
	const out: string[] = [];
	for (const raw of shellCommands(command)) {
		const w = bare(raw);
		if (w[0] === 'rm' || w[0] === 'rmdir' || w[0] === 'unlink' || w[0] === 'trash') {
			out.push(...args(w, 1));
		} else if (w[0] === 'git' && w[1] === 'rm') {
			out.push(...args(w, 2));
		}
	}
	return out;
}

/**
 * The files a shell command writes: what `>` and `>>` send output to (not stderr, `/dev/null` or another stream),
 * `touch` and `tee`. Whether one is new is for the disk to say (createdInTurn).
 */
export function writesIn(command: string): string[] {
	const out: string[] = [];
	for (const raw of shellCommands(command)) {
		const w = bare(raw);
		if (w[0] === 'touch' || w[0] === 'tee') {
			out.push(...args(w, 1));
		}
		for (let i = 0; i < raw.length; i++) {
			const m = /^(\d?)(>>?)(.*)$/.exec(raw[i]);
			if (!m || m[1] === '2') {
				continue;
			}
			const target = m[3] || raw[i + 1];
			if (target && !target.startsWith('&') && target !== '/dev/null' && !/^\d?>/.test(target)) {
				out.push(target);
			}
		}
	}
	return [...new Set(out)];
}

// ---- what the agent already said ----------------------------------------------------------------------------------

/** Lines a header comment has that say nothing about the file. */
const NOT_ABOUT = /^(copyright|\(c\)|license|licensed|spdx|@ts-|eslint|prettier|tslint|jshint|global |use strict|#!|-\*-|vim:|@flow|@jsx|@format|noqa|type: ?ignore|pylint|generated|auto-generated|do not edit)/i;

/** The first sentence of `text`, one line, at most `max` characters (cut with …). */
export function firstSentence(text: string, max = 160): string {
	const one = text.replace(/\s+/g, ' ').trim();
	const m = /^(.+?(?:[.!?](?=\s|$)|[。！？]))/.exec(one);
	const s = (m ? m[1] : one).trim();
	return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * What a new file says about itself: its first comment (`// …`, `/* … *\/`, `# …`, `"""…"""`, `<!-- … -->`, `-- …`),
 * or a Markdown file's first heading. Licence lines, tool directives and the shebang are passed over.
 */
export function headerComment(content: string): string | undefined {
	const lines = content.replace(/\r\n?/g, '\n').split('\n').slice(0, 40);
	let i = 0;
	const skip = () => {
		while (i < lines.length && (!lines[i].trim() || lines[i].startsWith('#!') || /^\s*(['"]use (strict|client|server)['"];?|<\?php|<!doctype html>|<html.*>)\s*$/i.test(lines[i]))) {
			i++;
		}
	};
	for (let tries = 0; tries < 6; tries++) {
		skip();
		if (i >= lines.length) {
			return undefined;
		}
		const line = lines[i].trim();
		let words: string[] = [];
		if (line.startsWith('/*') || line.startsWith('<!--') || line.startsWith('"""') || line.startsWith('\'\'\'')) {
			const end = line.startsWith('/*') ? '*/' : line.startsWith('<!--') ? '-->' : line.slice(0, 3);
			let body = line.replace(/^(\/\*+!?|<!--|"""|''')/, '');
			let j = i;
			while (!body.includes(end) && j + 1 < lines.length) {
				j++;
				body += '\n' + lines[j];
			}
			i = j + 1;
			words = body.split(end)[0].split('\n').map(l => l.replace(/^\s*\*+\s?/, '').trim());
		} else if (/^(\/\/+|#+(?!!)|--|;+)\s?/.test(line) && !/^#(include|import|define|if|pragma)\b/.test(line)) {
			const markdownHeading = /^#+\s/.test(line);
			let j = i;
			const prefix = /^(\/\/+|#+|--|;+)/.exec(line)![1][0];
			while (j < lines.length && lines[j].trim().startsWith(prefix) && !(markdownHeading && j > i)) {
				words.push(lines[j].trim().replace(/^(\/\/+!?|#+|--|;+)\s?/, '').trim());
				j++;
			}
			i = j;
		} else {
			return undefined;
		}
		// tags and the file's own name on the first line say nothing (`@file reminder.ts`, `reminder.ts`)
		const said = words.filter(w => w && !NOT_ABOUT.test(w) && !/^@(file|module|fileoverview|author|license|copyright|since|version)\b\s*\S*$/i.test(w) && !/^[\w.-]+\.\w+$/.test(w) && !/^[-=*_#\s]+$/.test(w))
			.map(w => w.replace(/^@(fileoverview|file|description|module)\s+/i, ''));
		if (said.length) {
			return firstSentence(said.join(' '));
		}
	}
	return undefined;
}

/** The last sentence of what the agent wrote, one line (Markdown marks taken off), or undefined. */
export function lastSentence(text: string): string | undefined {
	const plain = text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!plain) {
		return undefined;
	}
	const parts = plain.split(/(?<=[.!?])\s+|(?<=[。！？])/);
	const last = parts.map(s => s.trim()).filter(s => s.replace(/[.!?。！？:：]/g, '').trim().length > 1).pop();
	return last ? firstSentence(last.replace(/[:：]$/, '.')) : undefined;
}

/** Words that say what something is for, in English and Chinese. */
const PURPOSE = /\b(so|so that|to|for|because|allows?|needs?|handles?|keeps?|holds?|stores?|schedules?|shows?|makes?)\b|让|为了|用来|用于|需要|得|因为|以便|负责|管/i;

/**
 * The sentence the agent wrote before a call, when it says something about `names` (a file, a package) or what it is
 * for; a bare "Let me install it." says neither and is left out.
 */
export function why(sentence: string | undefined, names: readonly string[]): string | undefined {
	if (!sentence) {
		return undefined;
	}
	const lower = sentence.toLowerCase();
	const named = names.some(n => {
		const base = fileName(n).toLowerCase();
		const stem = base.replace(/\.[^.]+$/, '');
		return !!base && (lower.includes(base) || (stem.length > 2 && lower.includes(stem)));
	});
	return named || PURPOSE.test(sentence) ? sentence : undefined;
}

/**
 * The files a tool call's message names: Markdown links (`Edit [a.ts](file:///p/a.ts)`, the targets as written) and
 * Codex's own lines (`add: /p/a.ts`, `delete: /p/b.ts`), with what was done when the message says it.
 */
export function filesInMessage(message: string): { readonly target: string; readonly op?: 'create' | 'delete' | 'edit' }[] {
	const out: { target: string; op?: 'create' | 'delete' | 'edit' }[] = [];
	for (const m of message.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
		out.push({ target: m[1] });
	}
	for (const line of message.split('\n')) {
		const m = /^\s*(add|delete|update|rename from \S+):\s+(.+?)\s*$/.exec(line);
		if (m) {
			out.push({ target: m[2], op: m[1] === 'add' ? 'create' : m[1] === 'delete' ? 'delete' : 'edit' });
		}
	}
	return out;
}

/** Tools that write a file whole or change one (the agents' names for them). */
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit', 'multiedit', 'apply_patch', 'patch', 'file_edit', 'create_file', 'str_replace_editor', 'str_replace_based_edit_tool']);

/** A file written in a turn is new when it was made after the turn began (a little room for the clocks). */
export function createdInTurn(birth: number | undefined, turnStart: number): boolean {
	return birth !== undefined && birth > 0 && birth >= turnStart - 2000;
}

// ---- the small card -----------------------------------------------------------------------------------------------

export interface ILearnCard {
	readonly kind: LearnKind;
	/** The codicon: a new file, a package, the bin. */
	readonly icon: 'new-file' | 'package' | 'trash';
	/** Line one, 13/500: the file or the package, or how many. */
	readonly title: string;
	/** After it, 11px: New file, Created, Installed, Deleted. */
	readonly tag: string;
	/** Line two, at most two lines: what the agent said, else the action itself. */
	readonly text: string;
	/** The whole thing as one sentence, for a screen reader. */
	readonly sentence: string;
	readonly events: readonly ILearnEvent[];
}

const ICONS: Record<LearnKind, ILearnCard['icon']> = { create: 'new-file', install: 'package', delete: 'trash' };

/** Names in a line: three, then "and 2 more". */
function names(list: readonly string[]): string {
	return list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}

function sentence(s: string): string {
	const t = s.trim();
	return /[.!?。！？…]$/.test(t) ? t : `${t}.`;
}

/** Events of one kind in one turn, the same thing once (the last word about it wins). */
export function mergeEvents(all: readonly ILearnEvent[], more: readonly ILearnEvent[]): ILearnEvent[] {
	const out = [...all];
	for (const e of more) {
		const at = out.findIndex(x => x.kind === e.kind && x.subject === e.subject);
		if (at < 0) {
			out.push(e);
		} else if (!out[at].why && e.why) {
			out[at] = { ...out[at], why: e.why };
		}
	}
	return out;
}

/** The card of one kind of thing in one turn: one event says itself, several are counted and named. */
export function cardFor(kind: LearnKind, events: readonly ILearnEvent[]): ILearnCard {
	const icon = ICONS[kind];
	const one = events.length === 1 ? events[0] : undefined;
	const files = events.map(e => fileName(e.subject));
	if (kind === 'create') {
		if (one) {
			const text = sentence(one.why ?? `Created ${one.rel ?? one.subject}`);
			return { kind, icon, title: files[0], tag: 'New file', text, sentence: `Created ${files[0]}. ${text}`, events };
		}
		const text = sentence(names(files));
		return { kind, icon, title: `${events.length} new files`, tag: 'Created', text, sentence: `Created ${events.length} files: ${text}`, events };
	}
	if (kind === 'delete') {
		if (one) {
			const text = sentence(one.why ?? `Deleted ${one.rel ?? one.subject}`);
			return { kind, icon, title: files[0], tag: 'Deleted', text, sentence: `Deleted ${files[0]}. ${text}`, events };
		}
		const text = sentence(names(files));
		return { kind, icon, title: `${events.length} files`, tag: 'Deleted', text, sentence: `Deleted ${events.length} files: ${text}`, events };
	}
	const packages = events.map(e => e.subject);
	const commands = [...new Set(events.map(e => e.command).filter((c): c is string => !!c))];
	const title = packages.length <= 3 ? packages.join(', ') : `${packages.length} packages`;
	const said = events.find(e => e.why)?.why;
	// the card says the command without its flags; the side chat's quote has it whole (askText)
	const text = sentence(said && commands.length <= 1 ? said : commands.length ? `Ran ${[...new Set(commands.map(withoutFlags))].join(' and ')}` : `Installed ${names(packages)}`);
	return { kind, icon, title, tag: 'Installed', text, sentence: `Installed ${names(packages)}. ${text}`, events };
}

/** A simple command without its flags and their values: `npm install --dry-run --no-fund left-pad` → `npm install
 *  left-pad`; what it sends its output to is left out too (`2>&1`, `> log.txt`, task-fktjx's learn-talk run). */
export function withoutFlags(command: string): string {
	const words = shellCommands(command)[0] ?? [];
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (/^\d?[<>]/.test(words[i])) {
			break;
		}
		if (words[i].startsWith('-')) {
			if (VALUE_FLAGS.has(words[i])) {
				i++;
			}
			continue;
		}
		out.push(words[i]);
	}
	return out.join(' ') || command;
}

/** What an install says it installs: its packages, or the tool's own list (`npm install` with nothing after it). */
export function installSubjects(install: IInstall): string[] {
	return install.packages.length ? [...install.packages] : [`${install.tool} dependencies`];
}

/** The text a side chat about the card is asked on (the agent reads it; the card's quote shows its first line). */
export function askText(card: ILearnCard): { readonly text: string; readonly where: string } {
	if (card.kind === 'install') {
		const commands = [...new Set(card.events.map(e => e.command).filter((c): c is string => !!c))];
		return { text: commands.join('\n') || card.title, where: commands.length > 1 ? `${commands.length} commands · Installed` : 'Command · Installed' };
	}
	const paths = card.events.map(e => e.rel ?? e.subject);
	return { text: paths.join('\n'), where: card.events.length === 1 ? `${fileName(card.events[0].subject)} · ${card.tag}` : `${card.title}` };
}

// ---- the card's clock and place -----------------------------------------------------------------------------------

/** A card fades after 7 seconds; the pointer on it stops the clock. */
export const TALK_CARD_MS = 7000;

/** How long a card has left, and since when it runs (undefined: stopped, the pointer is on it). */
export interface ITalkClock {
	readonly left: number;
	readonly since?: number;
}

export function startClock(now: number, ms = TALK_CARD_MS): ITalkClock {
	return { left: ms, since: now };
}

export function pauseClock(c: ITalkClock, now: number): ITalkClock {
	return c.since === undefined ? c : { left: Math.max(0, c.left - (now - c.since)) };
}

export function resumeClock(c: ITalkClock, now: number): ITalkClock {
	return c.since === undefined ? { left: c.left, since: now } : c;
}

export function clockLeft(c: ITalkClock, now: number): number {
	return c.since === undefined ? c.left : Math.max(0, c.left - (now - c.since));
}

/** At most this many cards at once; an older one goes when a fourth comes. */
export const MAX_TALK_CARDS = 3;

/** The card's width: 340, the side pane's width less 16 each side when that is less; in a window 1200 wide or less
 *  the pane's width less 12 each side (as the side chat card). */
export function talkCardWidth(paneWidth: number, windowWidth: number): number {
	return Math.max(0, windowWidth <= 1200 ? paneWidth - 24 : Math.min(340, paneWidth - 32));
}

/**
 * Where each card's bottom is, from the pane's bottom: the newest nearest the corner, 8 between them, above the pills
 * that show there (32 high: the side chat's, Walk me through's; a number says how many, task-fktjx).
 */
export function talkCardBottoms(heights: readonly number[], corner: number, pill: boolean | number): number[] {
	let bottom = corner + (typeof pill === 'number' ? pill : pill ? 1 : 0) * (32 + 8);
	const out: number[] = [];
	for (let i = heights.length - 1; i >= 0; i--) {
		out[i] = bottom;
		bottom += heights[i] + 8;
	}
	return out;
}

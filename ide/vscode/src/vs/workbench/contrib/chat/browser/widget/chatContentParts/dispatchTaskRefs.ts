/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: task mentions in a chat reply (patches/330-task-links.patch).
 *
 *  Agents mention a task by its title with the id after it in brackets: 「仓库拆分修 Bug（task-2vcx）」,
 *  "Fix the login (task-2vcx)". The reply shows the title as one link and hides the id. What counts
 *  as the title: a quoted phrase just before the bracket (「…」 “…” "…"), else the words since the
 *  last clause break (。！？；;，,、：: or a new line). A bracket with nothing before it in the same
 *  text is `labelStart === start` (the element before it, e.g. **bold**, is the title). A bare id
 *  with no bracket is `bare`: the link shows the task's title, looked up from the board; when that title is
 *  already written right before it ("(Add dark mode, task-fsn)"), those words become the link and the id
 *  goes, so the title shows once (titleWrittenBefore, task-lj06.30).
 *--------------------------------------------------------------------------------------------*/

export interface IDispatchTaskRef {
	readonly id: string;
	/** The range to drop: the bracket with the id, and a space before it. For a bare id, the id. */
	readonly start: number;
	readonly end: number;
	/** The words that become the link (empty when labelStart === labelEnd). */
	readonly labelStart: number;
	readonly labelEnd: number;
	/** No words to link: the link shows the task's title from the board (a bare id, or a bracket after a long sentence). */
	readonly bare: boolean;
}

const REF = /(\s?[（(]\s*(task-[a-z0-9]{2,8})\s*[）)])|\b(task-[a-z0-9]{2,8})\b/g;
const BREAK = /[。！？!?；;，,、：:\n]/;
const QUOTES: Record<string, string> = { '」': '「', '”': '“', '"': '"', '』': '『', '»': '«' };
const MAX_LABEL = 60;

export function findTaskRefs(text: string): IDispatchTaskRef[] {
	const out: IDispatchTaskRef[] = [];
	let floor = 0;
	REF.lastIndex = 0;
	for (let m = REF.exec(text); m; m = REF.exec(text)) {
		const start = m.index;
		const end = start + m[0].length;
		if (m[2]) {
			const [labelStart, labelEnd] = labelBefore(text, floor, start);
			// no words of its own before the bracket: the link shows the task's title
			out.push({ id: m[2], start, end, labelStart, labelEnd, bare: labelStart === labelEnd && text.slice(floor, start).trim() !== '' });
		} else if (m[3]) {
			out.push({ id: m[3], start, end, labelStart: start, labelEnd: start, bare: true });
		}
		floor = end;
	}
	return out;
}

function labelBefore(text: string, floor: number, at: number): [number, number] {
	let end = at;
	while (end > floor && /\s/.test(text[end - 1])) {
		end--;
	}
	if (end === floor) {
		return [at, at];
	}
	// a quoted phrase: the words inside the quotes
	const open = QUOTES[text[end - 1]];
	if (open) {
		const from = text.lastIndexOf(open, end - 2);
		if (from >= floor && end - 1 - (from + 1) > 0 && end - 1 - (from + 1) <= MAX_LABEL) {
			return [from + 1, end - 1];
		}
	}
	// the words since the last clause break
	let start = end;
	while (start > floor && !BREAK.test(text[start - 1])) {
		start--;
		if (end - start > MAX_LABEL) {
			return [at, at];
		}
	}
	while (start < end && /[\s*_`「“"『«-]/.test(text[start])) {
		start++;
	}
	return start < end ? [start, end] : [at, at];
}

/**
 * For a bare id: when `before` (the text up to it) ends with the board's `title` and some separators
 * ("Add dark mode, " "Add dark mode: " "Add dark mode "), how many characters at its end are the title
 * and the separators: those become the title once, as the link. -1 when the title is not there.
 */
export function titleWrittenBefore(before: string, title: string): number {
	const t = title.trim();
	const sep = /[\s,，、;；:：–—-]*$/.exec(before)?.[0].length ?? 0;
	const head = before.slice(0, before.length - sep);
	if (!t || !head.toLowerCase().endsWith(t.toLowerCase())) {
		return -1;
	}
	const from = head.length - t.length;
	// a whole title, not the end of a longer word ("Bad dark mode" is not "dark mode")
	return from > 0 && /[\p{L}\p{N}]/u.test(head[from - 1]) && /[\p{L}\p{N}]/u.test(t[0]) && !/[\u3400-\u9fff]/.test(t[0]) ? -1 : t.length + sep;
}

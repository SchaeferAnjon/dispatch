/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the words under Tidy up after work (no DOM: tests/tidy.test.mjs loads it as it is).
 *--------------------------------------------------------------------------------------------*/

export interface ITidyLast {
	readonly project?: string;
	readonly at?: number;
	readonly line?: string;
	readonly status?: string;
}

/** "Last check: site, 2 hours ago. 3 docs disagree with the code" — or nothing before the first check. */
export function tidyLastLine(last: ITidyLast | undefined, nowMs: number): string {
	if (!last || !last.at) {
		return '';
	}
	const mins = Math.max(0, Math.round((nowMs / 1000 - last.at) / 60));
	const ago = last.status === 'running' ? 'running now'
		: mins < 1 ? 'just now'
			: mins < 60 ? `${mins} min ago`
				: mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
					: `${Math.round(mins / 60 / 24)} d ago`;
	const line = (last.line ?? '').trim();
	const said = last.status === 'running' ? '' : last.status === 'failed' ? `It did not finish: ${line}` : line;
	return `Last check: ${last.project ?? ''}, ${ago}.` + (said ? ` ${said.length > 160 ? said.slice(0, 157) + '…' : said}` : '');
}

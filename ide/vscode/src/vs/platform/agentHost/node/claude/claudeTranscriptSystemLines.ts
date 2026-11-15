/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the SDK's `getSessionMessages` returns a transcript's system lines without what they
 *  say (`message` is undefined: the line keeps `subtype` and `content` at its top level). So a restored
 *  chat lost what `/context`, `/usage` or `/recap` printed (`local_command`) and its "Conversation
 *  compacted" line (`compact_boundary`). This reads those lines from the transcript file itself and
 *  puts them back where the replay mapper looks (`message.subtype`, `message.text`).
 *--------------------------------------------------------------------------------------------*/

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/** The transcript file Claude Code keeps for a session: `<config>/projects/<cwd, every other character a dash>/<id>.jsonl`. */
export function claudeTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
	return `${configDir.replace(/\/+$/, '')}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`;
}

/** Fills in the content of system lines `getSessionMessages` returned empty; unchanged when there are none. */
export async function withTranscriptSystemLines(messages: readonly SessionMessage[], readTranscript: () => Promise<string | undefined>): Promise<readonly SessionMessage[]> {
	if (!messages.some(m => m.type === 'system' && m.message === undefined)) {
		return messages;
	}
	let raw: string | undefined;
	try {
		raw = await readTranscript();
	} catch {
		raw = undefined;
	}
	if (!raw) {
		return messages;
	}
	const lines = new Map<string, { readonly subtype: string; readonly content: string }>();
	for (const line of raw.split('\n')) {
		if (!line.includes('"system"')) {
			continue;
		}
		try {
			const entry = JSON.parse(line) as { type?: unknown; uuid?: unknown; subtype?: unknown; content?: unknown };
			if (entry.type === 'system' && typeof entry.uuid === 'string' && typeof entry.subtype === 'string') {
				lines.set(entry.uuid, { subtype: entry.subtype, content: typeof entry.content === 'string' ? entry.content : '' });
			}
		} catch {
			// a partly written last line
		}
	}
	return messages.map(m => {
		if (m.type !== 'system' || m.message !== undefined) {
			return m;
		}
		const line = lines.get(m.uuid);
		return line ? { ...m, message: { subtype: line.subtype, text: line.content } } : m;
	});
}

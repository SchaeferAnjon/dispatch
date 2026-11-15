/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what an OpenCode sub-agent does, step by step (patches/235-opencode-subagent-steps.patch,
 *  task-4bkhf). OpenCode runs a `task` in a child session; the ACP stream only carries the task's call and its
 *  answer, but OpenCode's own server (the one the question tool already listens to) streams every part of every
 *  session on /global/event and keeps the child session's messages. These helpers read both in OpenCode's own shapes
 *  and turn them into the ACP updates the rest of the harness already shows (opencodeTools.ts, opencodeReplay.ts):
 *  a sub-agent's thinking, words and tool calls, live under its row and again after Dispatch reopens. Pure functions.
 *--------------------------------------------------------------------------------------------*/

import type { IAcpSessionUpdate } from './opencodeAcpClient.js';

/** A part as OpenCode's server gives it (`message.part.updated`, GET /session/<id>/message). */
export interface IOpenCodePart {
	readonly id?: string;
	readonly sessionID?: string;
	readonly messageID?: string;
	readonly type: string;
	readonly text?: string;
	readonly synthetic?: boolean;
	readonly tool?: string;
	readonly callID?: string;
	readonly state?: {
		readonly status?: string;
		readonly title?: string;
		readonly input?: unknown;
		readonly output?: unknown;
		readonly error?: unknown;
		readonly metadata?: Record<string, unknown>;
	};
	readonly time?: { readonly start?: number; readonly end?: number };
}

export interface IOpenCodeMessage {
	readonly info: { readonly id?: string; readonly role?: string; readonly sessionID?: string };
	readonly parts: readonly IOpenCodePart[];
}

export type OpenCodeStreamEvent =
	| { readonly kind: 'part'; readonly sessionID: string; readonly part: IOpenCodePart }
	| { readonly kind: 'message'; readonly sessionID: string; readonly messageID: string; readonly role: string };

/** A part or message event in one line of /global/event (`data: {directory, payload: {type, properties}}`). */
export function parseStreamEvent(line: string): OpenCodeStreamEvent | undefined {
	if (!line.startsWith('data:') || !line.includes('"message.')) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(line.slice(5));
	} catch {
		return undefined;
	}
	const event = value as { payload?: { type?: unknown; properties?: unknown }; type?: unknown; properties?: unknown } | null;
	const payload = event?.payload && typeof event.payload === 'object' ? event.payload : event;
	const props = payload?.properties as Record<string, unknown> | undefined;
	if (!props || typeof props !== 'object') {
		return undefined;
	}
	if (payload?.type === 'message.part.updated') {
		const part = props['part'] as IOpenCodePart | undefined;
		const sessionID = typeof props['sessionID'] === 'string' ? props['sessionID'] : part?.sessionID;
		return part && typeof part === 'object' && typeof part.type === 'string' && typeof sessionID === 'string' ? { kind: 'part', sessionID, part } : undefined;
	}
	if (payload?.type === 'message.updated') {
		const info = props['info'] as { id?: unknown; role?: unknown; sessionID?: unknown } | undefined;
		return info && typeof info.id === 'string' && typeof info.role === 'string' && typeof info.sessionID === 'string'
			? { kind: 'message', sessionID: info.sessionID, messageID: info.id, role: info.role }
			: undefined;
	}
	return undefined;
}

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/**
 * The child session a `task` tool part runs in: its metadata says so while it runs (`sessionId`), its output after
 * (`<task id="ses_…">`, older versions `session_id: ses_…` inside `<task_metadata>`).
 */
export function childSessionOf(part: { readonly state?: IOpenCodePart['state'] } | undefined, outputText?: string): string | undefined {
	const meta = part?.state?.metadata?.['sessionId'];
	if (typeof meta === 'string' && SESSION_ID.test(meta)) {
		return meta;
	}
	const output = outputText ?? (typeof part?.state?.output === 'string' ? part.state.output : '');
	const m = /<task\s+id="(ses_[A-Za-z0-9]+)"/.exec(output) ?? /session_id:\s*(ses_[A-Za-z0-9]+)/.exec(output);
	return m?.[1];
}

/** The child session of a task as an ACP update reports it (`rawOutput.metadata.sessionId`, or its output). */
export function childSessionOfUpdate(update: IAcpSessionUpdate, outputText: string): string | undefined {
	const raw = update.rawOutput && typeof update.rawOutput === 'object' ? update.rawOutput as Record<string, unknown> : undefined;
	const metadata = raw?.['metadata'] && typeof raw['metadata'] === 'object' ? raw['metadata'] as Record<string, unknown> : undefined;
	return childSessionOf({ state: { metadata, output: raw?.['output'] } }, outputText);
}

function acpStatus(status: string | undefined): string | undefined {
	switch (status) {
		case 'completed': return 'completed';
		case 'error': return 'failed';
		case 'running': return 'in_progress';
		case 'pending': return 'pending';
		default: return undefined;
	}
}

/**
 * A tool part as the ACP update the harness reads: the first time (`first`) as `tool_call` titled with the tool's id
 * (how opencodeTools.ts learns which tool it is), then as `tool_call_update` with OpenCode's title, the input, the
 * status and, once done, the output (or the error).
 */
export function toolPartUpdate(part: IOpenCodePart, first: boolean): IAcpSessionUpdate | undefined {
	if (part.type !== 'tool' || !part.callID || !part.tool) {
		return undefined;
	}
	const st = part.state ?? {};
	const done = st.status === 'completed' || st.status === 'error';
	const output = st.status === 'error' ? st.error : st.output;
	return {
		sessionUpdate: first ? 'tool_call' : 'tool_call_update',
		toolCallId: part.callID,
		title: first ? part.tool : (st.title || part.tool),
		...(st.input && typeof st.input === 'object' ? { rawInput: st.input } : {}),
		...(acpStatus(st.status) ? { status: acpStatus(st.status) } : {}),
		...(done ? { rawOutput: { output: typeof output === 'string' ? output : (output === undefined ? '' : JSON.stringify(output)), ...(st.metadata ? { metadata: st.metadata } : {}) } } : {}),
		...(part.messageID ? { messageId: part.messageID } : {}),
	};
}

/** A text or reasoning part as the ACP chunk the harness reads, or undefined for any other part. */
export function textPartUpdate(part: IOpenCodePart, role: string | undefined): IAcpSessionUpdate | undefined {
	if ((part.type !== 'text' && part.type !== 'reasoning') || !part.text || part.synthetic) {
		return undefined;
	}
	const sessionUpdate = role === 'user' ? 'user_message_chunk' : part.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk';
	return { sessionUpdate, content: { type: 'text', text: part.text }, ...(part.messageID ? { messageId: part.messageID } : {}) };
}

/** A child session's messages (GET /session/<id>/message) as the updates `mapReplayToTurns` folds into turns. */
export function messagesToUpdates(messages: readonly IOpenCodeMessage[]): IAcpSessionUpdate[] {
	const out: IAcpSessionUpdate[] = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		for (const part of m?.parts ?? []) {
			const text = textPartUpdate(part, m.info?.role);
			if (text) {
				out.push(text);
				continue;
			}
			const call = toolPartUpdate(part, true);
			if (call) {
				out.push(call);
				const update = toolPartUpdate(part, false);
				if (update) {
					out.push(update);
				}
			}
		}
	}
	return out;
}

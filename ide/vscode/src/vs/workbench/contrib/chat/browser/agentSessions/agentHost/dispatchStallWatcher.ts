/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a running turn never spins in silence (260-session-liveness.patch). When nothing new has
 *  come from the agent for a while, a row at the end of the reply says how long it has been and what the last
 *  step was. agentHostSessionHandler.ts calls watchDispatchStall for each turn it observes.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../../../base/common/async.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { ResponsePartKind, ToolCallStatus, type ResponsePart, type StringOrMarkdown, type ToolCallState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { stringOrMarkdownToString } from './stateToProgressAdapter.js';

/** "45 s" under a minute, then "4 min" (the MCP row counts the same way). */
function formatStallTime(seconds: number): string {
	return seconds < 60 ? localize('dispatch.waited.seconds', "{0} s", seconds) : localize('dispatch.waited.minutes', "{0} min", Math.floor(seconds / 60));
}

/** the last thing the agent did in this turn, in a few words, for the stall row. */
function describeLastStep(parts: readonly unknown[], connectionAuthority: string): string {
	const last = parts[parts.length - 1] as { kind?: ResponsePartKind; toolCall?: ToolCallState } | undefined;
	if (!last) {
		return localize('dispatch.stall.startedStep', "the agent started");
	}
	if (last.kind === ResponsePartKind.ToolCall && last.toolCall) {
		const tc = last.toolCall as ToolCallState & { invocationMessage?: StringOrMarkdown; displayName?: string };
		const message = tc.invocationMessage ? stringOrMarkdownToString(tc.invocationMessage, connectionAuthority) : undefined;
		const text = (typeof message === 'string' ? message : message?.value ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
		const name = text || tc.displayName || tc.toolName;
		const done = tc.status === ToolCallStatus.Completed || tc.status === ToolCallStatus.Cancelled;
		return done
			? localize('dispatch.stall.toolDoneStep', "the last step ({0}, finished)", name.slice(0, 120))
			: localize('dispatch.stall.toolRunningStep', "the last step ({0})", name.slice(0, 120));
	}
	if (last.kind === ResponsePartKind.Reasoning) {
		return localize('dispatch.stall.thinkingStep', "the agent started thinking");
	}
	if (last.kind === ResponsePartKind.Markdown) {
		return localize('dispatch.stall.writingSince', "the last words of the reply");
	}
	return localize('dispatch.stall.otherStep', "the agent's last step");
}

/**
 * When nothing new has come from the agent for STALL_MS (no text, no tool update, no MCP progress), the row at the
 * end says how long it has been and what the last step was; the stop button ends the turn and the next message goes
 * on in the same session. Not while the turn waits for the person (a question or an approval): that row says so
 * itself. Not while a tool call runs either.
 */
export function watchDispatchStall(store: DisposableStore, responseParts$: IObservable<readonly ResponsePart[]>, mcpStarting$: IObservable<readonly unknown[]>, connectionAuthority: string, sink: (parts: IChatProgress[]) => void): void {
	const STALL_MS = 45_000;
	const TICK_MS = 5_000;
	let episode = 0;
	// What counts as news: a part added, text or reasoning growing, a tool call changing status
	// or getting output, MCP servers changing. Not heartbeats (modifiedAt, elapsed counters).
	const progress$ = derived(reader => {
		const parts = responseParts$.read(reader);
		const starting = mcpStarting$.read(reader).length;
		return starting + ';' + parts.map(p => {
			if (p.kind === ResponsePartKind.Markdown || p.kind === ResponsePartKind.Reasoning) {
				return p.kind + p.content.length;
			}
			if (p.kind === ResponsePartKind.ToolCall) {
				// output a command prints counts; a terminal's bookkeeping does not
				const content = (p.toolCall as { content?: { type?: string; text?: string }[] }).content;
				const printed = content?.reduce((n, c) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0) ?? 0;
				return p.kind + p.toolCall.status + printed;
			}
			if (p.kind === ResponsePartKind.InputRequest) {
				return p.kind + (p.response ?? '');
			}
			return String(p.kind);
		}).join(',');
	});
	store.add(autorun(reader => {
		progress$.read(reader);
		const parts = responseParts$.get();
		episode++;
		const waitingForPerson = parts.some(p => (p.kind === ResponsePartKind.InputRequest && p.response === undefined)
			|| (p.kind === ResponsePartKind.ToolCall && (p.toolCall.status === ToolCallStatus.PendingConfirmation || p.toolCall.status === ToolCallStatus.PendingResultConfirmation || p.toolCall.status === ToolCallStatus.AuthRequired)));
		if (waitingForPerson) {
			return;
		}
		// a command or tool that is still running is not a stall: its own row shows it working, and a test
		// suite or a build is quiet for minutes
		if (parts.some(p => p.kind === ResponsePartKind.ToolCall && p.toolCall.status === ToolCallStatus.Running)) {
			return;
		}
		// the MCP row already says what the turn waits on: one row at a time
		if (mcpStarting$.get().length > 0 && !parts.some(p => p.kind !== ResponsePartKind.SystemNotification)) {
			return;
		}
		const since = Date.now();
		const id = `dispatch.stall.${episode}`;
		const last = describeLastStep(parts, connectionAuthority);
		const show = () => {
			const seconds = Math.round((Date.now() - since) / 1000);
			sink([{
				kind: 'progressMessage',
				id,
				content: new MarkdownString().appendText(localize('dispatch.stallSince', "Nothing new for {0} since {1}. Stop ends only this turn, not the session.", formatStallTime(seconds), last)),
				shimmer: true,
			}]);
		};
		reader.store.add(disposableTimeout(() => {
			show();
			const handle = setInterval(show, TICK_MS);
			reader.store.add(toDisposable(() => clearInterval(handle)));
		}, STALL_MS));
	}));
}

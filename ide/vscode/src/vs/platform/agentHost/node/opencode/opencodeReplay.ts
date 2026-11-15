/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: an OpenCode session's history as turns. `session/load` replays the conversation as
 *  the same `session/update` notifications a live turn sends (user_message_chunk, agent thoughts and
 *  text, tool calls and their updates), oldest first; this folds them into the protocol's `Turn[]`
 *  the way claudeReplayMapper does for Claude transcripts: a user message starts a turn, text and
 *  thoughts become parts, a tool call is cancelled until an update completes it. Pure function.
 *--------------------------------------------------------------------------------------------*/

import {
	MessageKind,
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
	ToolCallStatus,
	ToolResultContentType,
	TurnState,
	type Message,
	type ResponsePart,
	type ToolCallResponsePart,
	type ToolResultSubagentContent,
	type Turn,
} from '../../common/state/protocol/state.js';
import { localize } from '../../../../nls.js';
import { withMessageSystemInitiatedLabel } from '../../common/state/sessionState.js';
import type { IAcpSessionUpdate } from './opencodeAcpClient.js';
import { openCodeUserText } from './opencodeSkillTurn.js';
import { subagentTask, toolDisplayName, toolInputString, toolInvocationMessage, toolMeta, toolOutputText, toolPastTenseMessage, toolView, type IOpenCodeToolView } from './opencodeTools.js';

interface IReplayTurn {
	id: string;
	userMessageId: string | undefined;
	text: string;
	parts: ResponsePart[];
	/** the message the last text / thought part came from, to keep appending to it */
	lastPart: { kind: 'text' | 'thought'; messageId: string | undefined; index: number } | undefined;
	tools: Map<string, { view: IOpenCodeToolView; index: number }>;
}

/**
 * A message OpenCode sent itself: a plugin going on with its to-do list (oh-my-openagent's
 * "[SYSTEM DIRECTIVE: …]" with its OMO_INTERNAL_INITIATOR marker). OpenCode stores it as a user message.
 */
export function isOpenCodeOwnPrompt(text: string): boolean {
	return /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/.test(text) || /^\s*\[SYSTEM DIRECTIVE:/.test(text);
}

/** The message of a turn OpenCode ran by itself: a system notification line, not the person's bubble. */
export function openCodeOwnTurnMessage(text: string): Message {
	return withMessageSystemInitiatedLabel(
		{ text: text || localize('opencode.ownTurn', "OpenCode went on by itself."), origin: { kind: MessageKind.SystemNotification } },
		localize('opencode.ownTurn', "OpenCode went on by itself."),
	);
}

function textOf(update: IAcpSessionUpdate): string {
	const content = update.content;
	if (content && typeof content === 'object' && !Array.isArray(content)) {
		const text = (content as { text?: unknown }).text;
		return typeof text === 'string' ? text : '';
	}
	return '';
}

/**
 * `subagentChat`: Dispatch IDE, the chat a subagent task ran (`buildSubagentChatUri`); with it a task carries it as its
 * Subagent content, so the host lists the sub-agent under the session again after a restart and reads its steps.
 */
export function mapReplayToTurns(updates: readonly IAcpSessionUpdate[], idPrefix: string, subagentChat?: (toolCallId: string) => string): Turn[] {
	const turns: Turn[] = [];
	let active: IReplayTurn | undefined;
	let counter = 0;
	const close = () => {
		if (!active) {
			return;
		}
		const pending = [...active.tools.values()].some(t => (active!.parts[t.index] as ToolCallResponsePart).toolCall.status !== ToolCallStatus.Completed);
		turns.push({
			id: active.id,
			message: isOpenCodeOwnPrompt(active.text) ? openCodeOwnTurnMessage(active.text) : { text: openCodeUserText(active.text), origin: { kind: MessageKind.User } },
			responseParts: active.parts,
			usage: undefined,
			state: pending ? TurnState.Cancelled : TurnState.Complete,
		});
		active = undefined;
	};
	const open = (messageId: string | undefined): IReplayTurn => {
		close();
		active = { id: messageId ?? `${idPrefix}-${++counter}`, userMessageId: messageId, text: '', parts: [], lastPart: undefined, tools: new Map() };
		return active;
	};
	for (const update of updates) {
		switch (update.sessionUpdate) {
			case 'user_message_chunk': {
				const turn = active && active.userMessageId !== undefined && active.userMessageId === update.messageId && !active.parts.length ? active : open(update.messageId);
				turn.text += textOf(update);
				break;
			}
			case 'agent_message_chunk':
			case 'agent_thought_chunk': {
				const text = textOf(update);
				if (!text) {
					break;
				}
				const turn = active ?? open(undefined);
				const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought';
				const last = turn.lastPart;
				if (last && last.kind === kind && last.messageId === update.messageId && last.index === turn.parts.length - 1) {
					const part = turn.parts[last.index] as { content: string };
					part.content += text;
				} else {
					turn.parts.push(kind === 'text'
						? { kind: ResponsePartKind.Markdown, id: `${turn.id}#md-${turn.parts.length}`, content: text }
						: { kind: ResponsePartKind.Reasoning, id: `${turn.id}#rs-${turn.parts.length}`, content: text });
					turn.lastPart = { kind, messageId: update.messageId, index: turn.parts.length - 1 };
				}
				break;
			}
			case 'tool_call':
			case 'tool_call_update': {
				const id = update.toolCallId;
				if (!id) {
					break;
				}
				const turn = active ?? open(undefined);
				let entry = turn.tools.get(id);
				const view = toolView(update, entry?.view);
				if (!entry) {
					const meta = toolMeta(view);
					const part: ToolCallResponsePart = {
						kind: ResponsePartKind.ToolCall,
						toolCall: {
							status: ToolCallStatus.Cancelled,
							toolCallId: id,
							toolName: view.name,
							displayName: toolDisplayName(view),
							invocationMessage: toolInvocationMessage(view),
							toolInput: toolInputString(view),
							reason: ToolCallCancellationReason.Skipped,
							...(meta ? { _meta: meta } : {}),
						},
					};
					turn.parts.push(part);
					entry = { view, index: turn.parts.length - 1 };
					turn.tools.set(id, entry);
					turn.lastPart = undefined;
				} else {
					entry.view = view;
				}
				if (update.status === 'completed' || update.status === 'failed') {
					const part = turn.parts[entry.index] as ToolCallResponsePart;
					const success = update.status === 'completed';
					const output = toolOutputText(update);
					const meta = toolMeta(entry.view);
					const sub = subagentChat ? subagentTask(entry.view) : undefined;
					const task: ToolResultSubagentContent | undefined = sub && subagentChat ? {
						type: ToolResultContentType.Subagent,
						resource: subagentChat(id),
						title: sub.description || sub.agentDisplayName,
						agentName: sub.agentName,
						...(sub.description ? { description: sub.description } : {}),
					} : undefined;
					part.toolCall = {
						status: ToolCallStatus.Completed,
						toolCallId: id,
						toolName: entry.view.name,
						displayName: toolDisplayName(entry.view),
						invocationMessage: toolInvocationMessage(entry.view),
						toolInput: toolInputString(entry.view),
						confirmed: ToolCallConfirmationReason.NotNeeded,
						success,
						pastTenseMessage: toolPastTenseMessage(entry.view, success, output),
						...(output || task ? { content: [...(output ? [{ type: ToolResultContentType.Text as const, text: output }] : []), ...(task ? [task] : [])] } : {}),
						...(meta ? { _meta: meta } : {}),
					};
				}
				break;
			}
			default:
				break; // plan, usage_update, available_commands_update, config_option_update: not part of the history
		}
	}
	close();
	return turns;
}

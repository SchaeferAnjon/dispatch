/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: an OpenCode sub-agent's steps, live, in its own chat under the session (patches/
 *  235-opencode-subagent-steps.patch, task-4bkhf). OpenCode's server streams every part of every
 *  session; when a `task` of a chat of ours names its child session, the child's thinking, words and tool calls are
 *  told to the Agent Host as actions of that sub-agent (`parentToolCallId`: the host puts them in the sub-agent's
 *  chat, as it does for Claude's and Codex's sub-agents). Its first message is the task's prompt, which the chat
 *  already starts with, so it is left out.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType } from '../../common/state/sessionState.js';
import { childSessionOf, toolPartUpdate, type IOpenCodePart, type OpenCodeStreamEvent } from './opencodeSubagentSteps.js';
import { toolDisplayName, toolHasInput, toolInputString, toolInvocationMessage, toolMeta, toolOutputText, toolPastTenseMessage, toolView, type IOpenCodeToolView } from './opencodeTools.js';

/** The chat of ours a session of OpenCode's belongs to, and the turn running in it now. */
export interface IOpenCodeParentChat {
	readonly chat: URI;
	readonly turnId: string | undefined;
}

interface IChild {
	/** the OpenCode session of the chat that ran the task */
	readonly parentSession: string;
	readonly chat: URI;
	readonly toolCallId: string;
	readonly tools: Map<string, { view: IOpenCodeToolView; ready: boolean; done: boolean }>;
	readonly texts: Map<string, string>;
	/** it said something of its own: its answer is in its chat already */
	spoke: boolean;
}

/** Parts kept for a session nobody has claimed yet (a child's first parts can come before its task names it). */
const EARLY_SESSIONS = 20;
const EARLY_PARTS = 200;
const ROLES = 1000;

export class OpenCodeSubagentMirror {

	private readonly _children = new Map<string /* child session */, IChild>();
	private readonly _byTool = new Map<string /* task tool call */, string /* child session */>();
	private readonly _roles = new Map<string /* message */, string>();
	private readonly _early = new Map<string /* session */, IOpenCodePart[]>();

	constructor(
		private readonly _parentOf: (sessionId: string) => IOpenCodeParentChat | undefined,
		private readonly _fire: (chat: URI, parentToolCallId: string, action: ChatAction) => void,
	) { }

	/** The child session a task ran in, as far as it is known (live, or read back from a history). */
	childOf(toolCallId: string): string | undefined {
		return this._byTool.get(toolCallId);
	}

	remember(toolCallId: string, childSession: string): void {
		this._byTool.set(toolCallId, childSession);
		if (this._byTool.size > 500) {
			this._byTool.delete(this._byTool.keys().next().value!);
		}
	}

	/** The sub-agent said something of its own: its final answer need not be added again. */
	spoke(toolCallId: string): boolean {
		const child = this._byTool.get(toolCallId);
		return !!(child && this._children.get(child)?.spoke);
	}

	/** The task is back: nothing more comes for it. */
	done(toolCallId: string): void {
		const child = this._byTool.get(toolCallId);
		if (child) {
			this._children.delete(child);
		}
	}

	onEvent(e: OpenCodeStreamEvent): void {
		if (e.kind === 'message') {
			this._roles.set(e.messageID, e.role);
			if (this._roles.size > ROLES) {
				this._roles.delete(this._roles.keys().next().value!);
			}
			return;
		}
		const part = e.part;
		// a task of a chat of ours: its child session is now known
		if (part.type === 'tool' && part.tool === 'task' && part.callID && !this._children.has(e.sessionID)) {
			const parent = this._parentOf(e.sessionID);
			const child = childSessionOf(part);
			if (parent && child && !this._children.has(child)) {
				this.remember(part.callID, child);
				this._children.set(child, { parentSession: e.sessionID, chat: parent.chat, toolCallId: part.callID, tools: new Map(), texts: new Map(), spoke: false });
				const early = this._early.get(child);
				this._early.delete(child);
				for (const p of early ?? []) {
					this._mirror(child, p);
				}
			}
		}
		if (this._children.has(e.sessionID)) {
			this._mirror(e.sessionID, part);
		} else if (!this._parentOf(e.sessionID)) {
			this._keepEarly(e.sessionID, part);
		}
	}

	private _keepEarly(session: string, part: IOpenCodePart): void {
		let list = this._early.get(session);
		if (!list) {
			if (this._early.size >= EARLY_SESSIONS) {
				this._early.delete(this._early.keys().next().value!);
			}
			list = [];
			this._early.set(session, list);
		}
		if (list.length < EARLY_PARTS) {
			list.push(part);
		}
	}

	private _mirror(session: string, part: IOpenCodePart): void {
		const child = this._children.get(session)!;
		const turnId = this._parentOf(child.parentSession)?.turnId ?? '';
		const fire = (action: ChatAction) => this._fire(child.chat, child.toolCallId, action);
		if (part.type === 'text' || part.type === 'reasoning') {
			if (!part.text || part.synthetic || !part.id || this._roles.get(part.messageID ?? '') === 'user') {
				return; // the task's prompt: the sub-agent's chat starts with it already
			}
			const before = child.texts.get(part.id);
			const kind = part.type === 'text' ? ResponsePartKind.Markdown : ResponsePartKind.Reasoning;
			const partId = `opencode-sub-${part.id}`;
			if (before === undefined) {
				fire({ type: ActionType.ChatResponsePart, turnId, part: { kind, id: partId, content: part.text } });
			} else if (part.text.length > before.length && part.text.startsWith(before)) {
				const more = part.text.slice(before.length);
				fire(kind === ResponsePartKind.Markdown
					? { type: ActionType.ChatDelta, turnId, partId, content: more }
					: { type: ActionType.ChatReasoning, turnId, partId, content: more });
			} else {
				return;
			}
			child.texts.set(part.id, part.text);
			if (part.type === 'text') {
				child.spoke = true;
			}
			return;
		}
		const callId = part.callID;
		const existing = callId ? child.tools.get(callId) : undefined;
		const update = toolPartUpdate(part, !existing);
		if (!update || !callId || existing?.done) {
			return;
		}
		let tool = existing;
		if (!tool) {
			const view = toolView(update);
			tool = { view, ready: false, done: false };
			child.tools.set(callId, tool);
			const meta = toolMeta(view);
			fire({ type: ActionType.ChatToolCallStart, turnId, toolCallId: callId, toolName: view.name, displayName: toolDisplayName(view), ...(meta ? { _meta: meta } : {}) });
			// the same part again as an update: its input and status
			const again = toolPartUpdate(part, false);
			if (again) {
				tool.view = toolView(again, tool.view);
			}
		} else {
			tool.view = toolView(update, tool.view);
		}
		const status = update.status;
		const finished = status === 'completed' || status === 'failed';
		if (!tool.ready && (toolHasInput(tool.view) || finished)) {
			tool.ready = true;
			fire({ type: ActionType.ChatToolCallReady, turnId, toolCallId: callId, invocationMessage: toolInvocationMessage(tool.view), toolInput: toolInputString(tool.view), confirmed: ToolCallConfirmationReason.NotNeeded });
		}
		if (finished) {
			tool.done = true;
			const finalUpdate = toolPartUpdate(part, false) ?? update;
			const output = toolOutputText(finalUpdate);
			const success = status === 'completed';
			fire({
				type: ActionType.ChatToolCallComplete, turnId, toolCallId: callId,
				result: { success, pastTenseMessage: toolPastTenseMessage(tool.view, success, output), content: output ? [{ type: ToolResultContentType.Text, text: output }] : [] },
			});
		}
	}
}

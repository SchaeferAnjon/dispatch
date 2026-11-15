/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: `/clear` the way Claude Code's terminal does it: the model's context goes, the
 *  screen stays. For Claude Code, Codex and OpenCode sessions the agent starts a fresh backing
 *  conversation (IAgent.clearChatContext), so the next message reaches the model as the first of a
 *  new conversation; this turn draws a "Context cleared" line, and every turn above it (this one
 *  included) is kept by the host as a local turn, so the transcript survives a restore unchanged.
 *  Sessions of other agents keep their own `/clear`.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { dispatchHandoffBoundaries } from '../../../../sessions/contrib/dispatchLife/node/dispatchLife.js';
import { parseLeadingSlashCommand } from '../../common/agentHostSlashCommand.js';
import { AgentSystemNotificationKind, toAgentSystemNotificationMeta } from '../../common/meta/agentSystemNotificationMeta.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { isAhpChatChannel, parseRequiredSessionUriFromChatUri, ResponsePartKind } from '../../common/state/sessionState.js';
import { ILocalChatCommand, ILocalChatCommandContext, ILocalChatCommandHandling, ILocalChatCommandRequest, LocalChatCommandRegistry } from './localChatCommand.js';

export const CLEAR_SLASH_COMMAND = 'clear';

/** Whether `prompt` is `/clear` (Claude Code's optional name after it is ignored). */
export function isClearCommand(prompt: string): boolean {
	return parseLeadingSlashCommand(prompt)?.command === CLEAR_SLASH_COMMAND;
}

export class ClearLocalCommand extends Disposable implements ILocalChatCommand {

	readonly name = CLEAR_SLASH_COMMAND;
	/** The whole transcript is kept as local turns: the agent forgets it. */
	readonly recordsLocalTurn = 'transcript' as const;

	constructor(private readonly _context: ILocalChatCommandContext) {
		super();
	}

	tryHandle(request: ILocalChatCommandRequest): ILocalChatCommandHandling | undefined {
		if (!isClearCommand(request.text)) {
			return undefined;
		}
		const session = isAhpChatChannel(request.turnChannel) ? parseRequiredSessionUriFromChatUri(request.turnChannel) : request.turnChannel;
		if (!this._context.canClearContext(session)) {
			return undefined; // an agent without Dispatch's /clear gets the message as it is
		}
		return { run: () => this._run(request) };
	}

	private async _run(request: ILocalChatCommandRequest): Promise<void> {
		const handoff = dispatchHandoffBoundaries.get(request.turnChannel);
		if (await this._context.clearContext(request.turnChannel)) {
			if (handoff) { handoff.cleared = true; }
			this._context.dispatch(request.turnChannel, {
				type: ActionType.ChatResponsePart,
				turnId: request.turnId,
				part: {
					kind: ResponsePartKind.SystemNotification,
					content: handoff ? { markdown: `[Context handed off](${URI.file(handoff.path).toString()})` } : localize('agentHostClear.cleared', "Context cleared"),
					_meta: { ...toAgentSystemNotificationMeta({ kind: AgentSystemNotificationKind.ContextCleared }), ...(handoff ? { handoffId: handoff.id, handoffPath: handoff.path, afterMessage: handoff.after_message } : {}) },
				},
			});
		}
	}
}

LocalChatCommandRegistry.register(ClearLocalCommand);

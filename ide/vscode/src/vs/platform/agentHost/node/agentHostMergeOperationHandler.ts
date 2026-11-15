/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { basename, isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { AGENT_HOST_MERGE_CHANGESET_OPERATION_ID, IChangesetOperationHandler } from '../common/agentHostChangesetOperationService.js';
import { IAgentHostGitService, tryResolvePrimaryWorktreeRoot } from '../common/agentHostGitService.js';
import { parseChangesetUri } from '../common/changesetUri.js';
import type { InvokeChangesetOperationParams, InvokeChangesetOperationResult } from '../common/state/protocol/channels-changeset/commands.js';
import { AHP_SESSION_NOT_FOUND, JsonRpcErrorCodes, ProtocolError } from '../common/state/sessionProtocol.js';
import { hasSessionPullRequestForBranch, readSessionGitHubState, readSessionGitState, type SessionState } from '../common/state/sessionState.js';

export class AgentHostMergeOperationHandler implements IChangesetOperationHandler {

	static readonly OPERATION_MERGE = AGENT_HOST_MERGE_CHANGESET_OPERATION_ID;

	constructor(
		private readonly _getSessionState: (sessionKey: string) => SessionState | undefined,
		private readonly _resolveBaseBranchName: (sessionKey: string) => Promise<string | undefined>,
		private readonly _onGitStateChanged: (sessionKey: string) => Promise<void>,
		private readonly _onMerged: (sessionKey: string, commit: string) => Promise<void>,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(params: InvokeChangesetOperationParams, token: CancellationToken): Promise<InvokeChangesetOperationResult> {
		const parsed = parseChangesetUri(params.channel);
		if (!parsed) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, `Not a changeset URI: ${params.channel}`);
		}
		this._throwIfCancelled(token);

		const sessionUri = parsed.sessionUri;
		const sessionState = this._getSessionState(sessionUri);
		if (!sessionState) {
			throw new ProtocolError(AHP_SESSION_NOT_FOUND, `Session not found: ${sessionUri}`);
		}

		const workingDirectoryValue = sessionState.workingDirectories?.[0];
		if (!workingDirectoryValue) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, `Session has no working directory: ${sessionUri}`);
		}
		const workingDirectory = URI.parse(workingDirectoryValue);
		const worktreeRoot = await this._gitService.getRepositoryRoot(workingDirectory);
		const repositoryRoot = worktreeRoot ? await tryResolvePrimaryWorktreeRoot(this._gitService, worktreeRoot) : undefined;
		if (!worktreeRoot || !repositoryRoot || isEqual(worktreeRoot, repositoryRoot)) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.parentMissing', "Could not find the project this session's separate copy was made from."));
		}
		this._throwIfCancelled(token);

		const storedGitState = readSessionGitState(sessionState._meta);
		const targetBranch = await this._resolveBaseBranchName(sessionUri);
		if (!targetBranch) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.targetBranchMissing', "Could not tell which branch of your project the changes go into."));
		}
		const gitState = await this._gitService.getSessionGitState(worktreeRoot, targetBranch) ?? storedGitState;
		const sourceBranch = gitState?.branchName ?? await this._gitService.getCurrentBranch(worktreeRoot);
		if (!sourceBranch) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.sourceBranchMissing', "Could not tell which branch this session's separate copy is on."));
		}
		if (sourceBranch === targetBranch) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, localize('agentHost.changeset.merge.sameBranch', "This session's copy is on '{0}' itself, the branch its changes would go into.", targetBranch));
		}

		const checkedOutTargetBranch = this._gitService.getCurrentBranchName
			? await this._gitService.getCurrentBranchName(repositoryRoot)
			: await this._gitService.getCurrentBranch(repositoryRoot);
		if (checkedOutTargetBranch !== targetBranch) {
			throw new ProtocolError(
				JsonRpcErrorCodes.InvalidParams,
				checkedOutTargetBranch
					? localize('agentHost.changeset.merge.wrongTargetBranch', "Your project folder is on the branch '{0}' now. Switch it back to '{1}', then try again.", checkedOutTargetBranch, targetBranch)
					: localize('agentHost.changeset.merge.detachedTarget', "Switch your project folder to the branch '{0}', then try again.", targetBranch)
			);
		}
		if (!await this._gitService.branchExists(repositoryRoot, sourceBranch)) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.sourceBranchMissingInParent', "Your project folder does not know the branch '{0}' of this session's copy.", sourceBranch));
		}
		if (await this._gitService.hasUncommittedChanges(repositoryRoot)) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, localize('agentHost.changeset.merge.targetDirty', "Your project folder has changes that are not committed. Commit them or put them aside, then bring these changes into '{0}'.", targetBranch));
		}
		this._throwIfCancelled(token);

		let didCommit = false;
		let shouldRefresh = false;
		try {
			const hasUncommittedChanges = await this._gitService.hasUncommittedChanges(worktreeRoot);
			this._throwIfPullRequestExists(sessionUri, sourceBranch);
			if (hasUncommittedChanges) {
				// Dispatch IDE: the commit message the default agent wrote (contrib/dispatchFixit)
				const dispatchMessage = typeof params._meta?.['dispatch.commitMessage'] === 'string' ? (params._meta['dispatch.commitMessage'] as string).trim() : '';
				try {
					await this._gitService.commitAll(worktreeRoot, dispatchMessage || localize('agentHost.changeset.merge.commitMessage', "Agent Host changes for {0}", sourceBranch));
				} catch (error) {
					const stderr = (error as { stderr?: unknown })?.stderr;
					throw new ProtocolError(JsonRpcErrorCodes.InternalError, `Failed to commit changes: ${typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : String(error)}`);
				}
				didCommit = true;
				shouldRefresh = true;
			}
			this._throwIfCancelled(token);
			this._throwIfPullRequestExists(sessionUri, sourceBranch);

			this._logService.info(`[AgentHostMergeOperationHandler] Merging ${sourceBranch} into ${targetBranch} for session ${sessionUri}`);
			try {
				await this._gitService.mergeBranch(repositoryRoot, sourceBranch);
			} catch (error) {
				this._throwIfCancelled(token);
				const stderr = (error as { stderr?: unknown })?.stderr; // Dispatch IDE: git's whole output
				const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : String(error);
				throw new ProtocolError(
					JsonRpcErrorCodes.InternalError,
					didCommit
						? localize('agentHost.changeset.merge.failedAfterCommit', "This session's changes were committed in its copy, but they could not be brought into '{0}'. Open your project folder and merge them by hand. Git said: {1}", targetBranch, detail)
						: localize('agentHost.changeset.merge.failed', "The changes could not be brought into '{0}'. Open your project folder and merge them by hand. Git said: {1}", targetBranch, detail)
				);
			}
			shouldRefresh = true;
			let mergeCommit: string | undefined;
			try {
				mergeCommit = await this._gitService.revParse(repositoryRoot, 'HEAD');
			} catch (error) {
				throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.commitLookupFailed', "Changes were merged into '{0}', but the resulting commit could not be recorded: {1}", targetBranch, error instanceof Error ? error.message : String(error)));
			}
			if (!mergeCommit) {
				throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.commitMissing', "Changes were merged into '{0}', but the resulting commit could not be recorded.", targetBranch));
			}
			await this._onMerged(sessionUri, mergeCommit);
		} finally {
			if (shouldRefresh) {
				try {
					await this._onGitStateChanged(sessionUri);
				} catch (error) {
					this._logService.warn(`[AgentHostMergeOperationHandler] Post-merge refresh failed for session ${sessionUri}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}

		return { message: { markdown: localize('agentHost.changeset.merge.mergedPlain', "This session's changes are in {0} now (branch '{1}').", basename(repositoryRoot), targetBranch) } };
	}

	private _throwIfPullRequestExists(sessionUri: string, branchName: string): void {
		const gitHubState = readSessionGitHubState(this._getSessionState(sessionUri)?._meta);
		if (hasSessionPullRequestForBranch(gitHubState, branchName)) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, localize('agentHost.changeset.merge.pullRequestExists', "Merge Changes is no longer available because a pull request exists for branch '{0}'.", branchName));
		}
	}

	private _throwIfCancelled(token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, localize('agentHost.changeset.merge.cancelled', "Merge operation was cancelled."));
		}
	}
}

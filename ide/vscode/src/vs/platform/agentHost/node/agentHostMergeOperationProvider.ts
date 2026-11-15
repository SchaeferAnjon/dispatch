/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { basename, isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import type { IChangesetOperationContribution, IChangesetOperationContext, IChangesetOperationRegistry } from '../common/agentHostChangesetOperationService.js';
import { IAgentHostGitStateService } from '../common/agentHostGitStateService.js';
import { resolveDiffBaseBranchName } from '../common/agentHostGitService.js';
import { ChangesetKind } from '../common/changesetUri.js';
import { SessionConfigKey } from '../common/sessionConfigKeys.js';
import { ChangesetOperationScope, ChangesetOperationStatus, hasSessionPullRequestForBranch, SessionLifecycle, type ChangesetOperation, type SessionState } from '../common/state/sessionState.js';
import { AgentHostMergeOperationHandler } from './agentHostMergeOperationHandler.js';
import { AgentHostStateManager, IAgentHostStateManager } from './agentHostStateManager.js';

export class AgentHostMergeOperationContribution extends Disposable implements IChangesetOperationContribution {

	private _registry: IChangesetOperationRegistry | undefined;

	constructor(
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostGitStateService private readonly _gitStateService: IAgentHostGitStateService,
	) {
		super();
	}

	registerHandlers(registry: IChangesetOperationRegistry): IDisposable {
		this._registry = registry;
		const store = new DisposableStore();
		const handler = this._instantiationService.createInstance(
			AgentHostMergeOperationHandler,
			(sessionKey: string) => this._stateManager.getSessionState(sessionKey),
			(sessionKey: string) => this._gitStateService.resolveSessionBaseBranchName(sessionKey),
			(sessionKey: string) => this._onGitStateChanged(sessionKey),
			(sessionKey: string, commit: string) => this._gitStateService.recordSessionMerge(sessionKey, commit),
		);
		store.add(registry.registerChangesetOperationHandler(AgentHostMergeOperationHandler.OPERATION_MERGE, handler));
		store.add({ dispose: () => { this._registry = undefined; } });
		return store;
	}

	getOperations({ sessionKey, changesetKind, gitState, gitHubState }: IChangesetOperationContext): ChangesetOperation[] | undefined {
		const state = this._stateManager.getSessionState(sessionKey);
		if (changesetKind !== ChangesetKind.Branch
			|| state?.lifecycle !== SessionLifecycle.Ready
			|| !this._isWorktreeSession(state)) {
			return undefined;
		}

		const branchName = gitState?.branchName;
		const configuredBaseBranch = state.config?.values[SessionConfigKey.Isolation] === 'worktree'
			? state.config.values[SessionConfigKey.Branch]
			: undefined;
		const baseBranchName = typeof configuredBaseBranch === 'string' && configuredBaseBranch.trim()
			? resolveDiffBaseBranchName(configuredBaseBranch.trim(), undefined)
			: resolveDiffBaseBranchName(undefined, gitState?.baseBranchName);
		if (!branchName || !baseBranchName || branchName === baseBranchName || hasSessionPullRequestForBranch(gitHubState, branchName)) {
			return undefined;
		}

		const hasBranchChanges = gitState?.hasBaseBranchChanges ?? (gitState?.outgoingChanges ?? 0) > 0;
		const uncommittedChanges = gitState?.uncommittedChanges ?? 0;
		if (!hasBranchChanges && uncommittedChanges === 0) {
			return undefined;
		}

		// Dispatch IDE (plain-words): the project's name and what happens, not worktree / parent repository / branch names (kanban task-lj06.27)
		const project = projectName(state) || localize('agentHost.changeset.merge.yourProject', "your project");
		return [{
			id: AgentHostMergeOperationHandler.OPERATION_MERGE,
			label: localize('agentHost.changeset.merge', "Merge Changes"),
			description: localize('agentHost.changeset.merge.descriptionPlain', "Bring this session's changes into {0}, your project folder. What the agent has not committed yet is committed first.", project),
			confirmation: localize('agentHost.changeset.merge.confirmationPlain', "Bring this session's changes into {0}? The agent worked on a separate copy of your project, so your project folder does not have them yet. What it has not committed yet is committed first.", project),
			icon: 'git-merge',
			group: 'merge',
			scopes: [ChangesetOperationScope.Changeset],
			status: ChangesetOperationStatus.Idle,
		} satisfies ChangesetOperation];
	}

	private _isWorktreeSession(state: SessionState | undefined): boolean {
		if (!state) {
			return false;
		}
		if (state.config?.values[SessionConfigKey.Isolation] === 'worktree') {
			return true;
		}
		const workingDirectory = state.workingDirectories?.[0];
		const project = state.project?.uri;
		return !!workingDirectory && !!project && !isEqual(URI.parse(workingDirectory), URI.parse(project));
	}

	private async _onGitStateChanged(sessionKey: string): Promise<void> {
		this._registry?.onDidChangeOperations(sessionKey);
		await this._registry?.refreshSessionGitState(sessionKey);
	}
}

/**
 * Dispatch IDE (plain-words, kanban task-lj06.27): the project a separate copy belongs to, by the name a person knows:
 * the project's display name, else its folder's name, else the folder the copy sits beside
 * (`<parent>/<project>.worktrees/<copy>`, as vs/sessions/common/dispatchSeparateCopy.ts reads it).
 */
function projectName(state: SessionState): string | undefined {
	if (state.project?.displayName) {
		return state.project.displayName;
	}
	if (state.project?.uri) {
		const name = basename(URI.parse(state.project.uri));
		if (name) {
			return name;
		}
	}
	const workingDirectory = state.workingDirectories?.[0];
	const copy = workingDirectory ? /([^/]+)\.worktrees\/[^/]+\/?$/.exec(URI.parse(workingDirectory).path) : null;
	return copy?.[1];
}

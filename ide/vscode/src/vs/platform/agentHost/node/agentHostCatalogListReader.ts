/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentSession, type IAgentSessionMetadata } from '../common/agent.js';
import { SessionStatus, withSessionExternal, withSessionStatusFlag } from '../common/state/sessionState.js';
import { AGENT_HOST_CATALOG_PAYLOAD_VERSION, decodeAgentHostCatalogPayload, reviveAgentHostCatalogData, type AgentHostCatalogRevivedData } from './agentHostCatalogProjection.js';
import type { IAgentHostDatabase, IAgentHostDatabaseSessionV2 } from './agentHostDatabase.js';
import type { IRegisteredSession } from './agentSessionRegistry.js';

export type AgentHostCatalogListResult =
	/** The central row is authoritative for this session's listing. */
	| { readonly eligible: true; readonly metadata: IAgentSessionMetadata; readonly data: AgentHostCatalogRevivedData }
	/**
	 * The central row marks the session as a chat backing. It is deliberately
	 * hidden and must never fall back into the top-level list.
	 */
	| { readonly eligible: false; readonly chatBacking: true }
	/** The central row is missing, stale or unusable; the caller falls back and schedules a repair. */
	| { readonly eligible: false; readonly chatBacking: false; readonly detail: string; readonly error?: Error };

/**
 * Eligibility boundary between the `sessions_v2` catalog and the session list:
 * it checks that a stored row still describes the registered session, then
 * hands the payload's own decoded data to the caller without re-parsing it.
 */
export class AgentHostCatalogListReader {

	constructor(private readonly _catalogDatabase: IAgentHostDatabase) { }

	async read(registered: IRegisteredSession): Promise<AgentHostCatalogListResult> {
		let catalog: IAgentHostDatabaseSessionV2 | undefined;
		try {
			catalog = await this._catalogDatabase.getSessionV2(registered.session.toString());
		} catch (error) {
			return readFailed(error);
		}
		return this._fromRow(registered, catalog);
	}

	/**
	 * Dispatch IDE: the whole catalog in one query, for a listing: the answer for each registered session, the
	 * same as {@link read} gives. One `getSessionV2` per session took about 1.1 s for 763 sessions (kanban task-mpidn).
	 */
	async readAll(): Promise<(registered: IRegisteredSession) => AgentHostCatalogListResult> {
		let rows: Map<string, IAgentHostDatabaseSessionV2>;
		try {
			rows = new Map((await this._catalogDatabase.listSessionsV2()).map(row => [row.session, row]));
		} catch (error) {
			const failed = readFailed(error);
			return () => failed;
		}
		return registered => this._fromRow(registered, rows.get(registered.session.toString()));
	}

	private _fromRow(registered: IRegisteredSession, catalog: IAgentHostDatabaseSessionV2 | undefined): AgentHostCatalogListResult {
		const session = registered.session.toString();
		try {
			if (!catalog) {
				return ineligible('no central row');
			}
			if (catalog.session !== session) {
				return ineligible(`central row identity ${catalog.session} does not match`);
			}
			if (catalog.isChatBacking) {
				return { eligible: false, chatBacking: true };
			}
			if (AgentSession.provider(registered.session) !== registered.provider || catalog.provider !== registered.provider) {
				return ineligible(`central row provider ${catalog.provider} does not match ${registered.provider}`);
			}
			if (catalog.payloadVersion !== AGENT_HOST_CATALOG_PAYLOAD_VERSION) {
				return ineligible(`central row payload version ${catalog.payloadVersion} is outdated`);
			}
			const decoded = decodeAgentHostCatalogPayload(catalog.payload);
			if (!decoded.ok) {
				return ineligible(`central payload is ${decoded.reason}: ${decoded.error}`);
			}
			// A payload can only become chat-backing through a write that also
			// updates the row marker, but an inconsistent row must still hide
			// the session rather than surface a backing as a top-level entry.
			if (decoded.value.data.isChatBacking) {
				return { eligible: false, chatBacking: true };
			}
			const data = reviveAgentHostCatalogData(decoded.value.data);
			return { eligible: true, metadata: this._toSessionMetadata(registered, data), data };
		} catch (error) {
			return readFailed(error);
		}
	}

	private _toSessionMetadata(registered: IRegisteredSession, data: AgentHostCatalogRevivedData): IAgentSessionMetadata {
		let status = withSessionStatusFlag(SessionStatus.Idle, SessionStatus.IsRead, data.isRead);
		status = withSessionStatusFlag(status, SessionStatus.IsArchived, data.isArchived);
		const meta = withSessionExternal(data._meta, registered.external);
		return {
			session: registered.session,
			startTime: registered.startTime,
			// The registry owns durable recency: a live advance can outrun the
			// payload's own timestamp until the next reconciliation writes it back.
			modifiedTime: Math.max(data.modifiedTime, registered.modifiedTime),
			summary: data.summary,
			status,
			project: data.project,
			workingDirectories: [...data.workingDirectories],
			changes: data.changes,
			...(meta !== undefined ? { _meta: meta } : {}),
		};
	}
}

function readFailed(error: unknown): AgentHostCatalogListResult {
	return {
		eligible: false,
		chatBacking: false,
		detail: 'central row read failed',
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

function ineligible(detail: string): AgentHostCatalogListResult {
	return { eligible: false, chatBacking: false, detail };
}

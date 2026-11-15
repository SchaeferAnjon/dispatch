/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dispatch: login identities ("profiles") of the integrated browser (kanban task-jj19). The default
 * identity is the shared persistent session every page used before (`persist:vscode-browser`); each
 * other identity is a persistent session of its own, so it keeps its own cookies, local storage,
 * cache, history and site permissions. A person adds them from the identity button in the address bar
 * (to sign in to a second account, or as a test user) and an agent opens a page "as" one of them.
 * The list and names live in the workbench (`browserProfilesFeature.ts`); the main process only needs
 * the id.
 */

/** Ids are made by the workbench: lowercase letters, digits and dashes, so they are safe in a partition name. */
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isBrowserProfileId(id: unknown): id is string {
	return typeof id === 'string' && PROFILE_ID.test(id);
}

/** The Electron partition of an identity other than the default one. */
export function browserProfilePartition(id: string): string {
	return `persist:dispatch-browser-${id}`;
}

/** `BrowserSession.id` of an identity other than the default one (the default one stays `global`). */
export function browserProfileSessionId(id: string): string {
	return `global:${id}`;
}

/** The identity of a `BrowserSession.id`, undefined for the default one and for other scopes. */
export function browserProfileOfSessionId(sessionId: string): string | undefined {
	return sessionId.startsWith('global:') ? sessionId.slice('global:'.length) : undefined;
}

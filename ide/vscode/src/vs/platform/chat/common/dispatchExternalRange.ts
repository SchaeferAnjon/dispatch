/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const DAY = 24 * 60 * 60 * 1000;

/** The same date boundary in the Agent Host and the external-session banner. */
export function externalSessionCutoff(mode: string, now: number): number {
	if (mode === 'allTime') { return Number.NEGATIVE_INFINITY; }
	const days = mode === 'last24Hours' ? 1 : mode === 'last7Days' ? 7 : mode === 'last90Days' ? 90 : 30;
	return now - days * DAY;
}

/** Keep enough catalog history for the chosen range; smaller views still retain 30 days. */
export function externalCatalogCutoff(mode: string, now: number): number {
	return externalSessionCutoff(mode === 'last90Days' || mode === 'allTime' ? mode : 'last30Days', now);
}

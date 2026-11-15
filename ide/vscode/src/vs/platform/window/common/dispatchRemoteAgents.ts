/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The on-disk workspace identity remains distinct for every remote and the local window. */
export function remoteAgentsWorkspacePath(base: string, authority: string): string {
 return `${base}.remote-${encodeURIComponent(authority)}.code-workspace`;
}
export function belongsToMachine(uri: { scheme: string; authority: string }, authority: string | undefined): boolean {
 return authority ? uri.scheme === 'vscode-remote' && uri.authority === authority : uri.scheme === 'file';
}

/** Application storage is shared by all windows, so remote machine resources need a namespace. */
export function machineStorageKey(key: string, authority: string | undefined): string {
 return authority ? `${key}.remote.${encodeURIComponent(authority)}` : key;
}

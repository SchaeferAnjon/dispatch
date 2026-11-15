/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "Run on", the pure part (kanban task-qb6j). Which computers the new session page offers, what
 *  the chip says, and which folders on another Mac come first. dispatchRunOn.ts draws and connects.
 *--------------------------------------------------------------------------------------------*/

/** A Mac as `dispatch machines --json` gives it (the fields this needs). */
export interface IRunOnMachine {
	readonly id: string;
	readonly name: string;
	readonly local: boolean;
	readonly online: boolean;
	readonly ssh?: string;
	readonly recent?: readonly { readonly dir?: string; readonly label?: string; readonly name?: string }[];
}

export interface IRunOnChoice {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly checked: boolean;
	readonly local: boolean;
}

export const THIS_MAC = 'local';

/** "This Mac" first, then the other Macs that can be reached over SSH, each with whether it is online now. */
export function runOnChoices(machines: readonly IRunOnMachine[] | undefined, current: string | undefined): IRunOnChoice[] {
	const list = machines ?? [];
	const here = list.find(m => m.local);
	const out: IRunOnChoice[] = [{ id: THIS_MAC, label: 'This Mac', description: here?.name ?? '', checked: !current || current === THIS_MAC, local: true }];
	for (const m of list) {
		if (m.local || !m.ssh) {
			continue;
		}
		out.push({ id: m.id, label: m.name || m.id, description: m.online ? 'Online' : 'Not reachable right now', checked: current === m.id, local: false });
	}
	return out;
}

/** What the menu lists for these Macs, as one string: an open menu is drawn again only when it changes. */
export function choicesKey(machines: readonly IRunOnMachine[] | undefined): string {
	return JSON.stringify(runOnChoices(machines, undefined).map(c => [c.id, c.label, c.description]));
}

/** What the chip says: the machine the session will run on. */
export function runOnLabel(current: string | undefined, machines: readonly IRunOnMachine[] | undefined, connectedName?: string): string {
	if (!current || current === THIS_MAC) {
		return 'This Mac';
	}
	return machines?.find(m => m.id === current)?.name || connectedName || current;
}

/** The machine id a remote session's host name belongs to (the provider is named after the Mac when it connects). */
export function machineIdForName(name: string | undefined, machines: readonly IRunOnMachine[] | undefined): string | undefined {
	if (!name) {
		return undefined;
	}
	return machines?.find(m => !m.local && (m.name === name || m.id === name))?.id ?? name;
}

/** That Mac's recent project folders, newest first, absolute paths only, no repeats. */
export function recentFolders(m: IRunOnMachine | undefined): { dir: string; label: string }[] {
	const seen = new Set<string>();
	const out: { dir: string; label: string }[] = [];
	for (const r of m?.recent ?? []) {
		const dir = typeof r.dir === 'string' ? r.dir.trim() : '';
		if (!dir.startsWith('/') || dir.split('/').includes('..') || seen.has(dir)) {
			continue;
		}
		seen.add(dir);
		out.push({ dir, label: r.label || r.name || dir.split('/').filter(Boolean).pop() || dir });
	}
	return out;
}

/** A failed connection in plain words: what to check, not the SSH error. */
export function connectFailure(machine: string, detail: string): string {
	const d = detail.toLowerCase();
	if (/timed out|timeout|etimedout|ehostunreach|enetunreach|econnrefused|no route/.test(d)) {
		return `${machine} did not answer. Check that it is on, awake and on the same network or Tailscale.`;
	}
	if (/authentication|permission denied|all configured authentication methods failed/.test(d)) {
		return `${machine} did not let this Mac in. Add it again in Settings › Macs so this Mac's key is set up there.`;
	}
	if (/not set up on this computer/.test(d)) {
		return `Dispatch is not set up on ${machine} for this version yet. Try again; it is copied over first.`;
	}
	return `Could not start a session on ${machine}: ${detail.split('\n')[0]}`;
}

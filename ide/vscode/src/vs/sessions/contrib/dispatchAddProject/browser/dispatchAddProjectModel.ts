/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Add project, the parts that are plain functions (dispatchAddProject.ts is the dialog).
 *  The three ways of adding a project and what they ask for. The work is the CLI's (`dispatch
 *  projects-view new | clone | add`, through dispatch-bridge's `dispatch.projects`); this only checks
 *  what is typed, so the person sees what is wrong before anything is sent.
 *--------------------------------------------------------------------------------------------*/

export type AddProjectWay = 'folder' | 'new' | 'copy';

/** What the CLI answers for a project that was added (or why it was not). */
export interface IAddProjectAnswer {
	readonly ok?: boolean;
	readonly name?: string;
	readonly label?: string;
	readonly dir?: string;
	readonly message?: string;
	readonly retry?: boolean;
	readonly code?: string;
}

export interface IAddProjectDefaults {
	readonly home: string;
	readonly parent: string;
	readonly git?: { readonly ok?: boolean; readonly message?: string };
}

export interface IClonePhase {
	readonly state?: 'running' | 'done' | 'failed';
	readonly phase?: string;
	readonly percent?: number;
	readonly detail?: string;
}

/** `/Users/me/Projects/x` as `~/Projects/x`. */
export function tildePath(path: string, home: string): string {
	const h = home.replace(/\/+$/, '');
	return h && (path === h || path.startsWith(h + '/')) ? '~' + path.slice(h.length) : path;
}

/** The folder name a web address suggests: its last part without .git (https://github.com/octocat/Hello-World.git is Hello-World). */
export function addressName(address: string): string {
	const a = address.trim().split(/[?#]/)[0].replace(/\/+$/, '');
	const last = a ? a.split(/[/:]/).pop() ?? '' : '';
	return last.endsWith('.git') ? last.slice(0, -4) : last;
}

/** A web address worth sending: https://, ssh://, git@host:owner/name, github.com/owner/name, or a folder on this Mac. */
export function looksLikeAddress(text: string): boolean {
	const a = text.trim();
	if (!a || a.startsWith('-') || /\s/.test(a) || a.includes('::')) {
		return false;
	}
	return /^(https?|ssh|git|file):\/\/\S+$/i.test(a)
		|| /^[\w.-]+@[\w.-]+:\S+$/.test(a)
		|| /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/\S+$/i.test(a)
		|| a.startsWith('/');
}

/** Why a project name cannot be used, or undefined when it can. An empty name is not an error yet: nothing is wrong with a form nobody has typed in. */
export function nameProblem(name: string): string | undefined {
	const n = name.trim();
	if (!n) {
		return undefined;
	}
	if (n.length > 100) {
		return 'That name is too long. Use 100 characters or fewer.';
	}
	if (/[\\/:\u0000-\u001f]/.test(n)) {
		return 'A project name cannot contain slashes or colons.';
	}
	if (n.startsWith('.')) {
		return 'A project name cannot start with a dot.';
	}
	if (n.startsWith('-')) {
		return 'A project name cannot start with a dash.';
	}
	return undefined;
}

/** Where the project will end up, written the way the person reads it: `~/Projects/my-app`. */
export function destination(parent: string, folderName: string, home: string): string {
	const p = tildePath(parent.replace(/\/+$/, ''), home);
	return folderName.trim() ? `${p}/${folderName.trim()}` : p + '/';
}

/** The words for a progress step the CLI reports while a copy runs. */
export function progressLine(p: IClonePhase | undefined): string {
	if (!p) {
		return 'Connecting';
	}
	const phase = p.phase || 'Connecting';
	return p.detail ? `${phase}, ${p.detail}` : phase;
}

/** What a failed answer says, always in words (the CLI writes them; this covers an answer that did not come). */
export function failureMessage(answer: IAddProjectAnswer | undefined): string {
	return answer?.message || 'Dispatch did not answer. Try again.';
}

/**
 * Whether git knows the person's name for commits, as far as the dialog can tell: `checking` until the CLI answers,
 * `known`, or `ask` (the form asks for both, task-pog4t).
 */
export type IdentityState = 'checking' | 'known' | 'ask';

const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

/**
 * Why Create project cannot be pressed yet, in words next to it; undefined when it can. An empty name says nothing
 * (nothing is wrong with a form nobody has typed in), everything after it does: the button used to stay grey with
 * no reason while the email was missing, and could be pressed before Dispatch knew whether git has a name at all
 * (task-lj06.20).
 */
export function createBlocker(name: string, identity: IdentityState, who?: { readonly name: string; readonly email: string }): string | undefined {
	if (!name.trim() || nameProblem(name)) {
		return undefined;
	}
	if (identity === 'checking') {
		return 'Checking your name for commits...';
	}
	if (identity === 'ask') {
		if (!who?.name.trim()) {
			return 'Type your name for commits to create the project.';
		}
		if (!who.email.trim()) {
			return 'Type your email for commits to create the project.';
		}
		if (who.name.trim().length > 100 || /[<>]/.test(who.name)) {
			return 'Keep the name under 100 characters, without < or >.';
		}
		if (!EMAIL.test(who.email.trim())) {
			return 'That email does not look like an email address.';
		}
	}
	return undefined;
}

/** What the dialog says when the CLI refused for want of a name and email (its own words point at Settings). */
export const NO_IDENTITY_MESSAGE = 'Git needs your name and email before the project\'s history can start. Fill them in above, then create the project.';

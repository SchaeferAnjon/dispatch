/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the name and email on commits, asked of the person once instead of made up (kanban task-pog4t).
 *  On a new Mac git has neither; the first agent that committed set `opencode <opencode@localhost>` itself, and a
 *  new project's first commit was signed `Dispatch <dispatch@localhost>`. The setup wizard, Settings › Agents ›
 *  Commits and Add Project ask with what this Mac already knows the person by as the suggestion; the CLI keeps it in
 *  git's own settings (kanban app/cli/git_identity.py through dispatch-bridge's `dispatch.firstRun`).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

/** `dispatch git-identity --json`. */
export interface IDispatchGitIdentity {
	readonly ok?: boolean;
	readonly message?: string;
	readonly name: string;
	readonly email: string;
	/** git can sign a commit: both are set */
	readonly known: boolean;
	/** what to offer: git's own half, else the Claude or ChatGPT account, the Mac's name for the person, GitHub */
	readonly suggest?: { readonly name: string; readonly email: string; readonly from: string };
}

const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

export function gitIdentityProblem(name: string, email: string): string | undefined {
	if (!name.trim()) {
		return localize('dispatchGitIdentity.noName', "Type the name your commits should carry.");
	}
	if (name.trim().length > 100 || /[<>]/.test(name)) {
		return localize('dispatchGitIdentity.badName', "Keep the name under 100 characters, without < or >.");
	}
	if (!EMAIL.test(email.trim())) {
		return localize('dispatchGitIdentity.badEmail', "That does not look like an email address.");
	}
	return undefined;
}

/** What git has and what to offer; undefined when the CLI cannot be asked. */
export async function readGitIdentity(commandService: ICommandService): Promise<IDispatchGitIdentity | undefined> {
	try {
		const g = await commandService.executeCommand<IDispatchGitIdentity>('dispatch.firstRun', 'git-identity');
		return g && g.ok !== false ? g : undefined;
	} catch {
		return undefined;
	}
}

/** The name, then the email, in the command palette's input; undefined when the person backs out. */
export async function askGitIdentity(quickInputService: IQuickInputService, start: { readonly name: string; readonly email: string }): Promise<{ name: string; email: string } | undefined> {
	const name = await quickInputService.input({
		title: localize('dispatchGitIdentity.nameTitle', "Your name on commits"),
		prompt: localize('dispatchGitIdentity.namePrompt', "Git puts it on every commit made on this Mac, yours and your agents'."),
		value: start.name,
		placeHolder: localize('dispatchGitIdentity.namePlaceholder', "Your name"),
		validateInput: async v => !v.trim() ? localize('dispatchGitIdentity.noName', "Type the name your commits should carry.") : v.trim().length > 100 || /[<>]/.test(v) ? localize('dispatchGitIdentity.badName', "Keep the name under 100 characters, without < or >.") : undefined,
	});
	if (name === undefined) {
		return undefined;
	}
	const email = await quickInputService.input({
		title: localize('dispatchGitIdentity.emailTitle', "Your email on commits"),
		prompt: localize('dispatchGitIdentity.emailPrompt', "It goes next to your name. Sites like GitHub use it to show the commits as yours."),
		value: start.email,
		placeHolder: localize('dispatchGitIdentity.emailPlaceholder', "you@example.com"),
		validateInput: async v => EMAIL.test(v.trim()) ? undefined : localize('dispatchGitIdentity.badEmail', "That does not look like an email address."),
	});
	if (email === undefined) {
		return undefined;
	}
	return { name: name.trim().replace(/\s+/g, ' '), email: email.trim() };
}

/** Saves both in git's settings for this Mac; the answer says what git has now, or why not. */
export async function saveGitIdentity(commandService: ICommandService, v: { readonly name: string; readonly email: string }): Promise<IDispatchGitIdentity> {
	try {
		const g = await commandService.executeCommand<IDispatchGitIdentity>('dispatch.firstRun', 'git-identity-set', v);
		return g ?? { ok: false, name: '', email: '', known: false, message: localize('dispatchGitIdentity.noAnswer', "Dispatch did not answer. Try again.") };
	} catch (e) {
		return { ok: false, name: '', email: '', known: false, message: String((e as Error)?.message ?? e) };
	}
}

/** "Ada Lovelace · ada@example.com" */
export function gitIdentityLine(v: { readonly name: string; readonly email: string }): string {
	return [v.name, v.email].filter(Boolean).join(' · ');
}

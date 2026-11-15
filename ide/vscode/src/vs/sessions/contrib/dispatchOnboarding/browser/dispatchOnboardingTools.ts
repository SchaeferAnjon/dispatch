/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a Mac without Apple's command line tools, which is every new Mac. The dispatch CLI runs on their
 *  python3 and projects are git folders; without them the first window used to show the wizard's "Looking at this
 *  Mac" for a moment, then nothing, while macOS asked from behind it whether to install "the command line developer
 *  tools" for "the python3 command" (the new-user run on the 0.9.1 release, kanban task-7mmi3). This page comes first
 *  instead, in the wizard's look: what they are and why, Install (macOS's own installer, `xcode-select --install`),
 *  and once they are in, the window starts again and the wizard takes over.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';

const $ = DOM.$;
export const DISPATCH_TOOLS_VIEW_ID = 'dispatch.onboarding.tools';
const POLL_MS = 4000;

export interface IToolsAnswer { readonly ok: boolean }

export class DispatchToolsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchTools.viewTitle', "Set up Dispatch"));
	override readonly maxWidth = 680;
	private root: HTMLElement | undefined;
	private install: Button | undefined;

	constructor(@ICommandService private readonly commandService: ICommandService) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-onboarding-host');
		const root = this.root = DOM.append(container, $('.dispatch-onboarding.dispatch-tools'));
		DOM.append(root, $('h2.dob-title', undefined, localize('dispatchTools.title', "First, Apple's command line tools")));
		DOM.append(root, $('p.dob-sub', undefined, localize('dispatchTools.sub', "Dispatch and the coding agents use git and Python. On a Mac they come with Apple's free Command Line Tools, and this Mac does not have them yet.")));
		const body = DOM.append(root, $('.dob-body'));
		const well = DOM.append(body, $('.dob-well'));
		const steps: [string, string][] = [
			[localize('dispatchTools.s1', "Click Install"), localize('dispatchTools.s1d', "macOS asks once more: click Install there too, then Agree.")],
			[localize('dispatchTools.s2', "Wait a few minutes"), localize('dispatchTools.s2d', "macOS downloads them from Apple (about 1 GB) and shows its own progress.")],
			[localize('dispatchTools.s3', "Dispatch goes on by itself"), localize('dispatchTools.s3d', "Once they are in, this window starts again with Dispatch's setup.")],
		];
		for (const [title, detail] of steps) {
			const row = DOM.append(well, $('.dob-row.with-why'));
			const main = DOM.append(row, $('.dob-main'));
			DOM.append(DOM.append(main, $('.dob-line')), $('span.dob-n', undefined, title));
			DOM.append(main, $('.dob-why', undefined, detail));
		}
		const state = DOM.append(body, $('p.dob-note', { role: 'status' }));
		const foot = DOM.append(root, $('.dob-foot'));
		DOM.append(foot, $('span.dob-sp'));
		const install = this.install = this._register(new Button(foot, { ...defaultButtonStyles, ariaLabel: localize('dispatchTools.install', "Install") }));
		install.label = localize('dispatchTools.install', "Install");
		install.element.classList.add('dob-btn', 'fill');
		this._register(install.onDidClick(async () => {
			await this.commandService.executeCommand('dispatch.onboarding', 'tools-install');
			state.textContent = localize('dispatchTools.asked', "macOS's installer is open. If you do not see it, look in the Dock for Install Command Line Developer Tools.");
		}));

		// they arrive however they were installed (here, macOS's own question, a Terminal): the window starts again
		const timer = DOM.getWindow(root).setInterval(async () => {
			const answer = await this.commandService.executeCommand<IToolsAnswer>('dispatch.onboarding', 'tools').catch(() => undefined);
			if (answer?.ok) {
				DOM.getWindow(root).clearInterval(timer);
				state.textContent = localize('dispatchTools.done', "The command line tools are in. Dispatch starts again to set itself up...");
				install.enabled = false;
				await this.commandService.executeCommand('workbench.action.reloadWindow');
			}
		}, POLL_MS);
		this._register({ dispose: () => DOM.getWindow(root).clearInterval(timer) });
	}

	layout(_width: number, height: number): void {
		if (this.root) {
			this.root.style.height = `${Math.max(320, height - 20)}px`;
		}
	}

	override focus(): void {
		this.install?.focus();
	}
}

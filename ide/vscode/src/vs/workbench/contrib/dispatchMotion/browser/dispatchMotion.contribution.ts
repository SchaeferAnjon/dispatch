/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Motion "Less" (patches/055-motion-setting.patch, kanban design/settings direction B,
 *  task-wl9fo). Between all motion and none: the motion that tells you something keeps moving (a working block
 *  breathing, a spinner, the Assistant thinking, a waiting block knocking, a build filling up, the dot of a running
 *  app), and what is only decoration stops (steam over the cup, the sleeping z's, rings and bars growing in, the
 *  bottom bar's blocks sliding in, the empty page's fish). A tip's ring and What's new's flash point at something, so
 *  they stay. DESIGN.md's rule stays:
 *  wherever a person waits, something moves.
 *
 *  `dispatch.motion` (full | less) next to VS Code's `workbench.reduceMotion`; Less puts `dispatch-motion-less` on the
 *  window, and media/dispatchMotion.css stops the decoration under it. Both windows, so the editor window's
 *  settings.json knows the setting.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchMotion.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { trackDispatchWindowIdle } from './dispatchIdle.js';
import { DISPATCH_MOTION_SETTING } from './dispatchMotionModel.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'dispatchMotion',
	order: 100,
	title: localize('dispatchMotion.title', "Dispatch"),
	type: 'object',
	properties: {
		[DISPATCH_MOTION_SETTING]: {
			type: 'string',
			enum: ['full', 'less'],
			enumDescriptions: [
				localize('dispatchMotion.full', "All of Dispatch's motion."),
				localize('dispatchMotion.less', "Only the motion that tells you something, like a working block or a spinner; the decoration stops."),
			],
			default: 'full',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('dispatchMotion.description', "How much Dispatch moves. `#workbench.reduceMotion#` set to on stops all of it."),
		},
	},
});

const LESS_CLASS = 'dispatch-motion-less';

class DispatchMotion extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchMotion';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super();
		const body = layoutService.mainContainer.ownerDocument.body;
		const apply = () => body.classList.toggle(LESS_CLASS, configurationService.getValue<string>(DISPATCH_MOTION_SETTING) === 'less');
		apply();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DISPATCH_MOTION_SETTING)) {
				apply();
			}
		}));
		this._register(toDisposable(() => body.classList.remove(LESS_CLASS)));
		// a window nobody looks at stops what only decorates (task-yocgz)
		this._register(trackDispatchWindowIdle(mainWindow));
	}
}

registerWorkbenchContribution2(DispatchMotion.ID, DispatchMotion, WorkbenchPhase.BlockStartup);

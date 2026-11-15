/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: light or dark. Dispatch has one theme, 暖石 (Dispatch Light / Dispatch Dark), in three modes:
 *  System (follows the Mac through window.autoDetectColorScheme), Light and Dark. The Agents window's
 *  Settings > Appearance is where people choose it (sessions/contrib/dispatchSettings); these are the commands
 *  it uses, and one in the command palette that steps to the next mode. The Agents window's title bar has a button too,
 *  left of the devices (user 2026-10-21, preference「标题栏切换深浅」, after task-tjor had kept it in Settings only): a
 *  click goes to the other of light and dark from what shows now, System included.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

export type DispatchThemeMode = 'system' | 'light' | 'dark';
const LIGHT = 'Dispatch Light';
const DARK = 'Dispatch Dark';
const MODES: DispatchThemeMode[] = ['system', 'light', 'dark'];

export function readDispatchTheme(config: IConfigurationService): { mode: DispatchThemeMode } {
	if (config.getValue<boolean>('window.autoDetectColorScheme')) {
		return { mode: 'system' };
	}
	return { mode: config.getValue<string>('workbench.colorTheme') === LIGHT ? 'light' : 'dark' };
}

export async function writeDispatchTheme(config: IConfigurationService, mode: DispatchThemeMode): Promise<void> {
	await config.updateValue('workbench.preferredLightColorTheme', LIGHT, ConfigurationTarget.USER);
	await config.updateValue('workbench.preferredDarkColorTheme', DARK, ConfigurationTarget.USER);
	if (mode === 'system') {
		await config.updateValue('window.autoDetectColorScheme', true, ConfigurationTarget.USER);
	} else {
		await config.updateValue('workbench.colorTheme', mode === 'light' ? LIGHT : DARK, ConfigurationTarget.USER);
		await config.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.cycleThemeMode',
			title: localize2('dispatch.theme.cycle', "Theme: System, Light, Dark"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const config = accessor.get(IConfigurationService);
		const { mode } = readDispatchTheme(config);
		await writeDispatchTheme(config, MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
	}
});

// the same choices for other places (Settings > Appearance, end-to-end scenarios): read and write by command
CommandsRegistry.registerCommand('_dispatch.theme.get', accessor => readDispatchTheme(accessor.get(IConfigurationService)));
CommandsRegistry.registerCommand('_dispatch.theme.set', (accessor, mode: DispatchThemeMode) => writeDispatchTheme(accessor.get(IConfigurationService), MODES.includes(mode) ? mode : 'system'));

/** The title bar's light or dark: the other of the two from what the window shows now (System included). */
const TOGGLE_LIGHT_DARK = 'dispatch.toggleLightDark';
registerAction2(class extends Action2 {
	constructor() {
		super({ id: TOGGLE_LIGHT_DARK, title: localize2('dispatch.theme.toggle', "Switch Light or Dark"), icon: Codicon.colorMode, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const dark = isDark(accessor.get(IThemeService).getColorTheme().type);
		await writeDispatchTheme(accessor.get(IConfigurationService), dark ? 'light' : 'dark');
	}
});

// the Agents window: left of the devices (Macs -120, phone -110, bell -105)
MenuRegistry.appendMenuItem(MenuId.for('SessionsTitleBarSessionMenu'), {
	command: { id: TOGGLE_LIGHT_DARK, title: localize('dispatch.theme.toggleTitle', "Switch light or dark"), icon: Codicon.colorMode },
	group: 'navigation',
	order: -130,
	when: ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated()),
});

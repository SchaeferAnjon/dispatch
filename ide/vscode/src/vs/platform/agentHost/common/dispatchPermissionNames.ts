/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the one name each permission level has everywhere (kanban task-o2r5g). The same Full auto was
 *  called Full auto, Never asks, can do anything, Runs every tool without asking, Allow all, Bypass Approvals and
 *  Default permissions in different corners. These are the names Settings › Agents and the setup wizard give the
 *  three answers to "how much may agents do on their own" (kanban app/cli/autonomy.py), used by every picker, chip,
 *  menu and warning: VS Code's own permission levels (Default, Assisted, Allow all) and each agent's own modes
 *  (Claude Code's permissionMode, Codex's permissions preset) map onto them.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

export const dispatchAlwaysAsk = () => localize('dispatchPermissionName.alwaysAsk', "Always ask");
export const dispatchAskRisky = () => localize('dispatchPermissionName.askRisky', "Ask for risky actions");
export const dispatchFullAuto = () => localize('dispatchPermissionName.fullAuto', "Full auto");

export const dispatchAlwaysAskDetail = () => localize('dispatchPermissionName.alwaysAskDetail', "Waits for your OK before it changes a file or runs a command");
export const dispatchAskRiskyDetail = () => localize('dispatchPermissionName.askRiskyDetail', "Edits files on its own and asks before running commands");
export const dispatchFullAutoDetail = () => localize('dispatchPermissionName.fullAutoDetail', "Changes files and runs commands without asking, so it can also delete or overwrite things");

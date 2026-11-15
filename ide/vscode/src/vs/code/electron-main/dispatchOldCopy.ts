/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: started from an old copy (a build folder, a backup) while /Applications holds a newer one, ask once
 *  whether to open the installed version instead (task-7ve7v; 10-09 a fresh install of 0.9.2 opened a backup from
 *  10-01 because LaunchServices knew both). Test instances (their own --user-data-dir) are never asked, unless
 *  DISPATCH_OLD_COPY_CHECK=1; for that check DISPATCH_INSTALLED_APP names another "installed" copy and
 *  DISPATCH_OLD_COPY_ANSWER=open|keep answers in place of a person (the dialog runs before any window, and a locked
 *  screen or a hidden test Mac has nobody to click it).
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { app, dialog } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { isMacintosh } from '../../base/common/platform.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { IStateService } from '../../platform/state/node/state.js';
import { StateService } from '../../platform/state/node/stateService.js';
import { dispatchBuiltOn, dispatchBundleOf, dispatchShouldOfferInstalled } from './dispatchOldCopyCheck.js';

const ASKED_KEY = 'dispatch.oldCopyAsked';

/** True when the person chose the installed version: it opens once this copy has quit, which it does now. */
export async function dispatchOfferInstalledCopy(env: IEnvironmentMainService, product: IProductService, state: IStateService, log: ILogService): Promise<boolean> {
	const forced = process.env['DISPATCH_OLD_COPY_CHECK'] === '1';
	if (!isMacintosh || !env.isBuilt || (env.args['user-data-dir'] && !forced)) {
		return false;
	}
	const installed = process.env['DISPATCH_INSTALLED_APP'] || `/Applications/${product.nameLong}.app`;
	const bundle = dispatchBundleOf(env.appRoot);
	let installedDate: string | undefined;
	try {
		installedDate = JSON.parse(await fs.readFile(join(installed, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')).date;
	} catch {
		return false; // nothing installed (or unreadable): this copy is the one there is
	}
	const asked = state.getItem<string[]>(ASKED_KEY, []);
	if (!dispatchShouldOfferInstalled({ bundle, installed, ownDate: product.date, installedDate, asked })) {
		return false;
	}
	state.setItem(ASKED_KEY, [...asked, bundle!].slice(-50));
	const message = `You opened an old copy at ${bundle}. Open the installed version?`;
	log.info(`dispatch: ${message}`);
	const answer = forced ? process.env['DISPATCH_OLD_COPY_ANSWER'] : undefined;
	const response = answer === 'open' ? 0 : answer === 'keep' ? 1 : (await dialog.showMessageBox({
		type: 'question',
		message,
		detail: `The one in Applications was built ${dispatchBuiltOn(installedDate)}; this copy was built ${dispatchBuiltOn(product.date)}.`,
		buttons: ['Open Installed Version', 'Keep Using This Copy'],
		defaultId: 0,
		cancelId: 1,
		noLink: true,
	})).response;
	if (response !== 0) {
		log.info(`dispatch: kept the old copy at ${bundle}`);
		return false;
	}
	log.info(`dispatch: opening ${installed} instead of ${bundle}`);
	if (state instanceof StateService) {
		await state.close(); // "asked once" is on disk before this copy quits
	}
	// open it once this process is gone: while it runs, LaunchServices would only bring this copy to the front
	spawn('/bin/sh', ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$1"', String(process.pid), installed], { detached: true, stdio: 'ignore' }).unref();
	app.exit(0);
	return true;
}

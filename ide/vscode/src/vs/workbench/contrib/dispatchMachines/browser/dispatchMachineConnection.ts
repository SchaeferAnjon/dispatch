/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Connection UI is visible before the remote extension host is ready. */
import './media/dispatchMachineConnection.css';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { connectionState, dispatchMachines, thisWindowMachine, rememberedName, clockTime } from './dispatchMachines.js';
import { parsePreparation, preparationKey, connectionStep, connectionHistory } from '../../../services/remote/common/dispatchMachineState.js';

class DispatchMachineConnection extends Disposable implements IWorkbenchContribution {
 static readonly ID = 'dispatch.contrib.machineConnection';
 constructor(
  @IWorkbenchEnvironmentService environment: IWorkbenchEnvironmentService,
  @IWorkbenchLayoutService layout: IWorkbenchLayoutService,
  @IStorageService storage: IStorageService,
  @ICommandService commands: ICommandService,
 ) {
  super();
  const authority = environment.remoteAuthority;
  if (!authority?.startsWith('ssh-remote+')) { return; }
  const key = preparationKey(authority);
  const root = layout.mainContainer;
  const overlay = DOM.append(root, DOM.$('div.dispatch-machine-connecting'));
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  const icon = DOM.append(overlay, DOM.$('span.codicon.codicon-vm'));
  icon.setAttribute('aria-hidden', 'true');
  const title = DOM.append(overlay, DOM.$('h2'));
  const step = DOM.append(overlay, DOM.$('p.dispatch-machine-step'));
  const actions = DOM.append(overlay, DOM.$('div.dispatch-machine-actions'));
  const cancel = DOM.append(actions, DOM.$('button', undefined, 'Cancel'));
  const retryInitial = DOM.append(actions, DOM.$('button', undefined, 'Try again'));
  const banner = DOM.append(root, DOM.$('div.dispatch-remote-lost'));
  banner.setAttribute('role', 'status');
  const lostText = DOM.append(banner, DOM.$('span'));
  const retry = DOM.append(banner, DOM.$('button', undefined, 'Try again'));
  let history = { everConnected: false, lostAt: undefined as number | undefined };
  const prep = () => parsePreparation(storage.get(key, StorageScope.APPLICATION_SHARED));
  const place = () => {
   const parts = environment.isSessionsWindow ? [Parts.CUSTOM_VIEW_GRID_PART, Parts.SESSIONS_PART, Parts.EDITOR_PART] : [Parts.EDITOR_PART];
  const target = parts.map(part => layout.getContainer(mainWindow, part)).find(el => el && el.offsetWidth > 0 && el.offsetHeight > 0);
   if (!target) { return; }
   const box = target.getBoundingClientRect();
   const parent = root.getBoundingClientRect();
   for (const el of [overlay, banner]) {
    el.style.left = `${box.left - parent.left}px`;
    el.style.top = `${box.top - parent.top}px`;
    el.style.width = `${box.width}px`;
   }
   overlay.style.height = `${box.height}px`;
  };
  const render = () => {
   const state = connectionState.get();
   const record = prep();
   const name = thisWindowMachine(dispatchMachines.get())?.name || record?.name || rememberedName(authority) || 'Remote machine';
   const updated = connectionHistory(state, history, Date.now() / 1000);
   history = { everConnected: updated.everConnected, lostAt: updated.lostAt };
   const lost = history.everConnected && state !== 'connected';
   const initial = !history.everConnected && state !== 'connected';
   const failed = state === 'disconnected' || record?.stage === 'failed' || record?.stage === 'cancelled';
   overlay.style.display = initial ? 'flex' : 'none';
   banner.style.display = lost ? 'flex' : 'none';
   root.classList.toggle('dispatch-machine-unavailable', lost || initial);
   title.textContent = failed ? `${name} is not reachable` : `Connecting to ${name}...`;
   step.textContent = failed ? record?.error || 'Check that the machine is online, then try again.' : connectionStep(record?.stage);
   retryInitial.hidden = !failed;
   lostText.textContent = `${name} is not reachable since ${clockTime(history.lostAt)}`;
   place();
  };
  this._register(autorun(reader => { connectionState.read(reader); dispatchMachines.read(reader); render(); }));
  this._register(storage.onDidChangeValue(StorageScope.APPLICATION_SHARED, key, this._store)(render));
  this._register(layout.onDidLayoutMainContainer(place));
  this._register(DOM.addDisposableListener(cancel, 'click', async () => {
   const rec = prep();
   if (rec) { storage.store(key, JSON.stringify({ ...rec, stage: 'cancelled', retry: false, at: Date.now() }), StorageScope.APPLICATION_SHARED, StorageTarget.MACHINE); }
   await commands.executeCommand('workbench.action.closeWindow');
  }));
  const tryAgain = async () => {
   const rec = prep();
   if (rec && rec.stage === 'failed') {
    storage.store(key, JSON.stringify({ ...rec, stage: 'finding', retry: true, at: Date.now() }), StorageScope.APPLICATION_SHARED, StorageTarget.MACHINE);
   }
   await commands.executeCommand('workbench.action.reloadWindow');
  };
  this._register(DOM.addDisposableListener(retry, 'click', tryAgain));
  this._register(DOM.addDisposableListener(retryInitial, 'click', tryAgain));
  this._register(toDisposable(() => { overlay.remove(); banner.remove(); root.classList.remove('dispatch-machine-unavailable'); }));
 }
}
registerWorkbenchContribution2(DispatchMachineConnection.ID, DispatchMachineConnection, WorkbenchPhase.BlockRestore);

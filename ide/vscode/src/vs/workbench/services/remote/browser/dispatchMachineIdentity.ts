/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { observableValue, IObservable } from '../../../../base/common/observable.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { MachineConnectionState, MACHINE_NAMES_KEY } from '../common/dispatchMachineState.js';

export interface IDispatchAttention {
	readonly approve?: number;
	readonly decide?: number;
	readonly unread?: number;
	readonly only_you?: number;
	readonly total?: number;
	readonly as_of?: number | null;
}
export interface IDispatchRecent {
	readonly name: string;
	readonly label?: string;
	readonly dir?: string;
	readonly last_at?: number;
	readonly last_title?: string;
}
export interface IDispatchMachine {
	readonly id: string;
	readonly name: string;
	readonly local: boolean;
	readonly online: boolean;
	readonly last_seen?: number | null;
	readonly ssh?: string;
	readonly address?: string;
	readonly user?: string;
	readonly running?: number;
	readonly working?: number;
	readonly sessions?: number;
	readonly attention?: IDispatchAttention | null;
	readonly recent?: readonly IDispatchRecent[];
	readonly authority?: string;
	readonly hosts_file?: string;
	readonly dispatch_version?: string | null;
}


export const machinesValue = observableValue<readonly IDispatchMachine[] | undefined>('dispatchMachines', undefined);
export const dispatchMachines: IObservable<readonly IDispatchMachine[] | undefined> = machinesValue;
export const connectionState = observableValue<MachineConnectionState>('dispatchMachinesConnection', 'connected');
let storage: IStorageService | undefined;
export function setMachineStorage(value: IStorageService): void { storage = value; }
export function thisWindowMachine(list: readonly IDispatchMachine[] | undefined): IDispatchMachine | undefined {
 return list?.find(m => m.local);
}
export function rememberedName(authority: string | undefined): string {
 if (!authority) { return ''; }
 try { return JSON.parse(storage?.get(MACHINE_NAMES_KEY, StorageScope.APPLICATION_SHARED) || mainWindow.localStorage.getItem(MACHINE_NAMES_KEY) || '{}')[authority] ?? ''; }
 catch { return ''; }
}
export function rememberMachineNames(list: readonly IDispatchMachine[]): void {
 try {
  const names = JSON.parse(storage?.get(MACHINE_NAMES_KEY, StorageScope.APPLICATION_SHARED) || mainWindow.localStorage.getItem(MACHINE_NAMES_KEY) || '{}');
  for (const m of list) { if (m.authority && m.name) { names[m.authority] = m.name; } }
  mainWindow.localStorage.setItem(MACHINE_NAMES_KEY, JSON.stringify(names));
  storage?.store(MACHINE_NAMES_KEY, JSON.stringify(names), StorageScope.APPLICATION_SHARED, StorageTarget.MACHINE);
 } catch { /* first live answer provides the name when storage is unavailable */ }
}

let initialMachineFolder: URI | undefined;
export function setInitialMachineFolder(folder: URI | undefined): void { initialMachineFolder = folder; }
export function getInitialMachineFolder(): URI | undefined { return initialMachineFolder; }

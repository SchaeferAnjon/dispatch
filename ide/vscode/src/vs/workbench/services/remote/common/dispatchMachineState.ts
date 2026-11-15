/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Dispatch machine identity and preparation, shared by both window modes and their resolver. */
export const DISPATCH_MACHINES_BUTTON = 'dispatch.machines.button';
export type MachineConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
export type PreparationStage = 'finding' | 'connecting' | 'starting-server' | 'ready' | 'failed' | 'cancelled';
export interface MachinePreparation {
 readonly name: string;
 readonly host: string;
 readonly stage: PreparationStage;
 readonly at: number;
 readonly owner?: number;
 readonly land?: 'waiting';
 readonly error?: string;
 readonly retry?: boolean;
}
export const MACHINE_NAMES_KEY = 'dispatch.machines.names';
export const preparationKey = (authority: string) => `dispatch.machines.preparation.${authority}`;
export function parsePreparation(raw: string | undefined, now = Date.now()): MachinePreparation | undefined {
 try {
  const r = JSON.parse(raw || 'null');
  return r && typeof r.name === 'string' && typeof r.host === 'string'
   && ['finding', 'connecting', 'starting-server', 'ready', 'failed', 'cancelled'].includes(r.stage)
   && typeof r.at === 'number' && now - r.at < 300_000 && r.at <= now + 10_000 ? r : undefined;
 } catch { return undefined; }
}
export function machineWindowTitle(agents: boolean, name: string): string {
 return `${agents ? 'Dispatch Agent' : 'Dispatch IDE'}${name ? ` · ${name}` : ''}`;
}
export function machineIndicator(name: string, state: MachineConnectionState): string {
 if (state === 'connecting') { return `$(vm) Connecting to ${name}...`; }
 if (state === 'reconnecting') { return `$(vm) Reconnecting to ${name}...`; }
 if (state === 'disconnected') { return `$(vm) ${name} · offline`; }
 return `$(vm) ${name}`;
}
export function connectionStep(stage: PreparationStage | undefined): string {
 return stage === 'finding' ? 'Finding machine' : stage === 'starting-server' ? 'Starting server' : 'Connecting';
}

export interface ConnectionHistory { readonly everConnected: boolean; readonly lostAt?: number }
export function connectionHistory(state: MachineConnectionState, previous: ConnectionHistory, now: number): ConnectionHistory {
 if (state === 'connected') { return { everConnected: true }; }
 return previous.everConnected ? { everConnected: true, lostAt: previous.lostAt ?? now } : previous;
}

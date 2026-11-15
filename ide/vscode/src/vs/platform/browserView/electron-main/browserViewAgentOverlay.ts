/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IBrowserViewAgentOverlayCue, IBrowserViewAgentOverlayEvent, IBrowserViewAgentOverlayState } from '../common/browserView.js';

/**
 * Dispatch: the main-process half of the agent overlay of one browser view (the preload draws it,
 * `preload-browserView.ts` `AgentOverlay`). It keeps the last state, sends it again whenever the
 * main frame's preload reports ready (every navigation starts a new document without the overlay),
 * relays cues, and turns the page's messages (the user clicked or typed, Stop, Resume) into
 * {@link onDidEvent}.
 */
export class BrowserViewAgentOverlay extends Disposable {

	private _state: IBrowserViewAgentOverlayState | undefined;
	private _captureWaiter: (() => void) | undefined;

	private readonly _onDidEvent = this._register(new Emitter<IBrowserViewAgentOverlayEvent>());
	readonly onDidEvent: Event<IBrowserViewAgentOverlayEvent> = this._onDidEvent.event;

	constructor(private readonly webContents: Electron.WebContents) {
		super();

		const onIpcMessage = (event: Electron.Event, channel: string, ...args: unknown[]) => {
			const senderFrame = (event as { senderFrame?: Electron.WebFrameMain }).senderFrame;
			if (!senderFrame || senderFrame !== this.webContents.mainFrame) {
				return; // the overlay lives in the top frame only
			}
			switch (channel) {
				case 'vscode:browserView:preloadReady':
					if (this._state?.active) {
						this._post('vscode:browserView:agentOverlay', this._state);
					}
					break;
				case 'vscode:browserView:agentOverlayEvent': {
					const type = (args[0] as { type?: string } | undefined)?.type;
					if (type === 'userInput' || type === 'stop' || type === 'resume') {
						this._onDidEvent.fire({ type });
					}
					break;
				}
				case 'vscode:browserView:agentOverlayHidden':
					this._captureWaiter?.();
					break;
			}
		};
		this.webContents.on('ipc-message', onIpcMessage);
		this._register({ dispose: () => this.webContents.removeListener('ipc-message', onIpcMessage) });
	}

	get isActive(): boolean {
		return !!this._state?.active;
	}

	setState(state: IBrowserViewAgentOverlayState): void {
		this._state = state.active ? state : undefined;
		this._post('vscode:browserView:agentOverlay', state);
	}

	cue(cue: IBrowserViewAgentOverlayCue): void {
		if (this._state?.active) {
			this._post('vscode:browserView:agentOverlayCue', cue);
		}
	}

	/**
	 * Hide the overlay for a screenshot and resolve once the page has painted without it (or after
	 * a short timeout, so a page that is busy cannot hold the screenshot up).
	 */
	async hideForCapture(): Promise<void> {
		if (!this._state?.active) {
			return;
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(done, 250);
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this._captureWaiter = () => {
				this._captureWaiter = undefined;
				done();
			};
			this._post('vscode:browserView:agentOverlayCapture', { hidden: true });
		});
	}

	/** Show the overlay again after {@link hideForCapture}, with the viewfinder flash. */
	showAfterCapture(): void {
		this._captureWaiter = undefined;
		if (this._state?.active) {
			this._post('vscode:browserView:agentOverlayCapture', { hidden: false, flash: true });
		}
	}

	private _post(channel: string, data: unknown): void {
		try {
			this.webContents.mainFrame.postMessage(channel, data);
		} catch {
			// The frame is gone (navigating, closing): the next preloadReady replays the state.
		}
	}
}

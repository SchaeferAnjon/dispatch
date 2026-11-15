/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import type { IToolImpl, IToolInvocation, IToolResult } from '../../../chat/common/tools/languageModelToolsService.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { IBrowserAgentPresenceService } from './browserAgentPresence.js';
import { IBrowserProfilesService } from '../browserProfilesService.js';
import { ClickBrowserTool } from './clickBrowserTool.js';
import { NavigateBrowserTool } from './navigateBrowserTool.js';
import { OpenBrowserTool } from './openBrowserTool.js';
import { ReadBrowserTool } from './readBrowserTool.js';
import { ScreenshotBrowserTool } from './screenshotBrowserTool.js';
import { TypeBrowserTool } from './typeBrowserTool.js';

/**
 * Dispatch: `_dispatch.browser` drives the integrated browser for a session running in a terminal
 * (`dispatch browser --ide …`, kanban app/cli/browser_ide.py, through dispatch-bridge's request
 * channel). It runs the same tool implementations the Agents window's sessions use, so a terminal
 * Claude Code gets the same overlay (cursor, outlines, the bar with Stop) and the same logins.
 *
 * Arguments: `{ action, url?, page?, ref?, selector?, element?, text?, key?, submit?, engine?, profile?, name? }`
 * with `action` one of `status`, `open`, `go`, `read`, `click`, `type`, `press`, `shot`, `profiles`,
 * `profile-add`. Returns `{ ok, page?, title?, url?, text?, image?, mime?, pages?, profiles?, error? }`;
 * never throws. `open` with `profile` opens the page with that login identity (browserProfilesService.ts).
 */
export interface IDispatchBrowserArgs {
	readonly action: 'status' | 'open' | 'go' | 'read' | 'click' | 'type' | 'press' | 'shot' | 'profiles' | 'profile-add' | 'size';
	/** `size`: lay the page out at this width and height, like a desktop browser window (sites that show a phone page in a narrow pane), scaled to fit the pane; no width: back to the pane's own size. */
	readonly width?: number;
	readonly height?: number;
	/** `open`: a login identity by name; `profile-add`: see `name`. */
	readonly profile?: string;
	/** `profile-add`: the new identity's name. */
	readonly name?: string;
	readonly url?: string;
	readonly page?: string;
	readonly ref?: string;
	readonly selector?: string;
	readonly element?: string;
	readonly text?: string;
	readonly key?: string;
	readonly submit?: boolean;
	/** `claude`, `codex`, or anything else: which icon and name the overlay shows. */
	readonly engine?: string;
}

export interface IDispatchBrowserResult {
	readonly ok: boolean;
	readonly error?: string;
	readonly page?: string;
	readonly title?: string;
	readonly url?: string;
	readonly text?: string;
	/** `shot`: the image, base64. */
	readonly image?: string;
	readonly mime?: string;
	readonly pages?: readonly { id: string; title: string; url: string; active: boolean; shared: boolean; agent: 'idle' | 'working' | 'paused'; profile: string }[];
	/** `profiles` and `profile-add`: every login identity, `current` is the one new pages use. */
	readonly profiles?: readonly { id: string; name: string; current: boolean }[];
	/** The login identity of the page acted on, by name. */
	readonly profile?: string;
	/** `open`: the page is open but had not finished loading when the wait ran out. */
	readonly loading?: boolean;
}

/** The page the last `open` made, so the next commands act on it without naming it. */
let lastPage: string | undefined;

CommandsRegistry.registerCommand('_dispatch.browser', async (accessor, args: IDispatchBrowserArgs): Promise<IDispatchBrowserResult> => {
	const instantiationService = accessor.get(IInstantiationService);
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const editorService = accessor.get(IEditorService);
	const editorGroups = accessor.get(IEditorGroupsService);
	const presence = accessor.get(IBrowserAgentPresenceService);
	const profiles = accessor.get(IBrowserProfilesService);
	try {
		return await run(args ?? { action: 'status' });
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}

	async function run(a: IDispatchBrowserArgs): Promise<IDispatchBrowserResult> {
		const engine = a.engine || 'agent';
		const call = async (tool: IToolImpl, parameters: Record<string, unknown>): Promise<IToolResult> => {
			const invocation: IToolInvocation = {
				callId: generateUuid(),
				toolId: 'dispatch-cli',
				parameters: { ...parameters, dispatchEngine: engine },
				context: undefined,
			};
			return tool.invoke(invocation, async () => 0, { report: () => { } }, CancellationToken.None);
		};
		const failed = (r: IToolResult) => typeof r.toolResultError === 'string' ? r.toolResultError : r.toolResultError ? 'the browser action failed' : undefined;
		const text = (r: IToolResult) => r.content.map(c => c.kind === 'text' ? c.value : '').filter(Boolean).join('\n');

		if (a.action === 'status') {
			return { ok: true, page: pickPage(undefined), pages: [...browserViews.getKnownBrowserViews().values()].map(e => describe(e)) };
		}

		const listProfiles = () => profiles.getProfiles().map(p => ({ id: p.id, name: p.name, current: p.id === profiles.current }));
		if (a.action === 'profiles') {
			return { ok: true, profiles: listProfiles() };
		}
		if (a.action === 'profile-add') {
			const created = profiles.add(a.name ?? '');
			return { ok: true, profile: created.name, profiles: listProfiles() };
		}

		if (a.action === 'open') {
			if (!a.url) {
				return { ok: false, error: 'open needs a URL' };
			}
			const r = await call(instantiationService.createInstance(OpenBrowserTool), { url: a.url, forceNew: true, ...(a.profile ? { profile: a.profile } : {}) });
			const error = failed(r);
			// A heavy page (one that keeps loading video, like Higgsfield) runs past the tool's wait but is
			// open: the next commands act on it, and the agent hears that it is still loading.
			const loading = /Page ID: [\w-]+/.test(text(r)) ? undefined : /\(ID: ([\w-]+)\) is open/.exec(error ?? text(r))?.[1];
			if (loading) {
				lastPage = loading;
				await reveal(loading);
				return { ok: true, loading: true, ...info(loading), text: 'The page is open but still loading. Read it in a moment (dispatch browser --ide read).' };
			}
			if (error) {
				return { ok: false, error };
			}
			const page = /Page ID: ([\w-]+)/.exec(text(r))?.[1];
			if (page) {
				lastPage = page;
				await reveal(page);
			}
			return { ok: true, ...(page ? info(page) : {}), text: text(r).replace(/^Page ID: [\w-]+\s*\n\s*Summary:\s*\n?/, '') };
		}

		const page = pickPage(a.page);
		if (!page) {
			return { ok: false, error: 'no page is open in the built-in browser (dispatch browser --ide open <url>)' };
		}
		// The page has to be the shown tab: a page behind another tab is not rendered, and Playwright
		// then waits for it to become visible until it times out.
		await reveal(page);
		// A page the user opened is shared with the agent on first use (the overlay shows it).
		const input = browserViews.getKnownBrowserViews().get(page);
		const model = input && await input.resolve();
		if (model && model.sharingState !== BrowserViewSharingState.Shared) {
			await presence.shareWithAgent(page);
		}

		const target = a.ref ? { ref: a.ref } : a.selector ? { selector: a.selector } : {};
		let r: IToolResult;
		switch (a.action) {
			case 'go':
				r = await call(instantiationService.createInstance(NavigateBrowserTool), { pageId: page, type: 'url', url: a.url });
				break;
			case 'read':
				r = await call(instantiationService.createInstance(ReadBrowserTool), { pageId: page });
				break;
			case 'click':
				r = await call(instantiationService.createInstance(ClickBrowserTool), { pageId: page, element: a.element ?? a.selector ?? a.ref, ...target });
				break;
			case 'type':
				r = await call(instantiationService.createInstance(TypeBrowserTool), { pageId: page, element: a.element, text: a.text ?? '', submit: !!a.submit, ...target });
				break;
			case 'press':
				r = await call(instantiationService.createInstance(TypeBrowserTool), { pageId: page, key: a.key, element: a.element, ...target });
				break;
			case 'size': {
				// the browser's own device emulation (the same one as its device toolbar): the page is laid out at
				// this size and scaled down to fit the pane, so the person still sees all of it
				const view = await browserViews.getKnownBrowserViews().get(page)?.resolve();
				if (!view) {
					return { ok: false, error: 'that page is gone', ...info(page) };
				}
				if (a.width === undefined) {
					await view.setDevice(undefined);
					return { ok: true, ...info(page), text: 'The page is back to the size of the pane.' };
				}
				const w = Math.round(Number(a.width)), h = Math.round(Number(a.height));
				if (!(w >= 320 && w <= 3840 && h >= 320 && h <= 2400)) {
					return { ok: false, error: 'size needs a width and height between 320x320 and 3840x2400', ...info(page) };
				}
				await view.setDevice({ width: w, height: h });
				return { ok: true, ...info(page), text: `The page is laid out at ${w}x${h} and scaled to fit the pane.` };
			}
			case 'shot': {
				r = await call(instantiationService.createInstance(ScreenshotBrowserTool), { pageId: page });
				const error = failed(r);
				if (error) {
					return { ok: false, error, ...info(page) };
				}
				const data = r.content.find(c => c.kind === 'data');
				if (!data || data.kind !== 'data') {
					return { ok: false, error: 'no image came back', ...info(page) };
				}
				return { ok: true, ...info(page), image: encodeBase64(data.value.data as VSBuffer), mime: data.value.mimeType };
			}
			default:
				return { ok: false, error: `unknown action ${String((a as { action?: string }).action)}` };
		}
		const error = failed(r);
		return error ? { ok: false, error, text: text(r), ...info(page) } : { ok: true, text: text(r), ...info(page) };
	}

	async function reveal(page: string): Promise<void> {
		const input = browserViews.getKnownBrowserViews().get(page);
		if (!input || editorService.visibleEditors.includes(input)) {
			return;
		}
		// in the group that already has its tab (the Agents window's side pane), not a new one
		const group = editorGroups.groups.find(g => g.contains(input));
		await (group ? group.openEditor(input, { preserveFocus: true, pinned: true }) : editorService.openEditor(input, { preserveFocus: true, pinned: true })).catch(() => undefined);
	}

	function pickPage(given: string | undefined): string | undefined {
		const known = browserViews.getKnownBrowserViews();
		if (given && known.has(given)) {
			return given;
		}
		if (lastPage && known.has(lastPage)) {
			return lastPage;
		}
		const active = editorService.activeEditor;
		if (active instanceof BrowserEditorInput && known.has(active.id)) {
			return active.id;
		}
		const visible = editorService.visibleEditors.find(e => e instanceof BrowserEditorInput && known.has(e.id));
		if (visible instanceof BrowserEditorInput) {
			return visible.id;
		}
		return [...known.keys()].at(-1);
	}

	function info(page: string): { page: string; title?: string; url?: string; profile: string } {
		const e = browserViews.getKnownBrowserViews().get(page);
		return { page, title: e?.title, url: e?.url, profile: profiles.nameOf(e?.profile) };
	}

	function describe(e: BrowserEditorInput) {
		return {
			id: e.id,
			title: e.title ?? '',
			url: e.url ?? '',
			active: editorService.activeEditor === e,
			shared: e.model?.sharingState === BrowserViewSharingState.Shared,
			agent: presence.getMode(e.id),
			profile: profiles.nameOf(e.profile),
		};
	}
});

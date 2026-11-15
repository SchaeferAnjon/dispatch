/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Now tab, first in a session's side pane (patches/410-now.patch).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext, IsTopRightEditorGroupContext } from '../../../../workbench/common/contextkeys.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { SessionsCategories } from '../../../common/categories.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { DispatchNowEditor, DispatchNowEditorInput, DispatchNowEditorSerializer } from './dispatchNowEditor.js';
import './dispatchEmptySidePane.js';

export const DISPATCH_NOW_TAB_COMMAND_ID = 'workbench.action.agentSessions.dispatchNowTab';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DispatchNowEditor, DispatchNowEditor.ID, localize('dispatchNow.editor', "Now")),
	[new SyncDescriptor(DispatchNowEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DispatchNowEditorInput.ID, DispatchNowEditorSerializer);

const nowTabWhen = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated());
const DispatchNowTabMissingContext = new RawContextKey<boolean>('dispatchNowTabMissing', true, localize('dispatchNowTabMissing', "Whether the session's editor group has no Now tab"));

/** The Now tab, first in the strip. `background`: join without taking the front. */
async function openNowTab(accessor: ServicesAccessor, background = false): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const group = groups.mainPart.activeGroup;
	const existing = group.editors.find(e => e instanceof DispatchNowEditorInput);
	if (existing) {
		if (group.getIndexOfEditor(existing) !== 0) {
			group.moveEditor(existing, group, { index: 0, inactive: true, preserveFocus: true });
		}
		if (!background) {
			await editorService.openEditor(existing, { pinned: true }, group);
		}
		return;
	}
	await editorService.openEditor(instantiationService.createInstance(DispatchNowEditorInput), {
		pinned: true,
		index: 0,
		inactive: background,
		preserveFocus: true,
	}, group);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_NOW_TAB_COMMAND_ID,
			title: localize2('dispatchNow.tab', "Now"),
			category: SessionsCategories.Sessions,
			icon: Codicon.pulse,
			f1: true,
			precondition: nowTabWhen,
			menu: {
				id: Menus.SessionsEditorTabsBarAddTab,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(nowTabWhen, IsTopRightEditorGroupContext, DispatchNowTabMissingContext),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return openNowTab(accessor);
	}
});

/**
 * The Now tab is there by default and comes first: when a session that has started becomes the active one
 * and the side pane has tabs (a chat without a folder: always), Now joins them at the front and is the one shown (once per session; after that
 * the person's own pick stays). A new session (no message yet, so no task and no plan) has nothing to say yet: no
 * Now tab until its first message (user 2026-10-10, "if Now has nothing, don't show it for now"); it joins in the
 * background, so a closed side pane stays closed and an open one keeps its size.
 */
class DispatchNowTabByDefault extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchNowTabByDefault';

	constructor(
		@IAgentWorkbenchLayoutService layoutService: IAgentWorkbenchLayoutService,
		@ISessionsService sessionsService: ISessionsService,
		@IEditorGroupsService groups: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService logService: ILogService,
	) {
		super();
		const missing = DispatchNowTabMissingContext.bindTo(contextKeyService);
		const updateMissing = () => missing.set(!groups.mainPart.activeGroup.editors.some(e => e instanceof DispatchNowEditorInput));
		this._register(Event.any(editorService.onDidEditorsChange, groups.onDidChangeActiveGroup)(updateMissing));
		updateMissing();
		if (!layoutService.isSinglePaneLayoutEnabled) {
			return;
		}
		// The session's own tabs are put back when it is shown, which can drop a tab added a moment too early (and
		// takes a while on a busy Mac): a started session's strip always gets Now back at the front. Like Changes
		// and Files the strip's tabs have no close button.
		const fronted = new Set<string>();
		// a Now being added: the strip changing meanwhile is that very add, not the tab going away
		const adding = new Set<string>();
		let current = '';
		// something that keeps closing the tab must not turn this into a loop: a few tries a session in a short while
		const tries = new Map<string, number[]>();
		const ensure = () => {
			const session = sessionsService.activeSession.get();
			const group = groups.mainPart.activeGroup;
			const key = current;
			// a chat without a folder (Chats) never gets a Changes or Files tab: its empty strip gets Now, or its open
			// side pane is a blank block with only a close button (0.9.2, task-qx5ln). A project's session waits for its
			// own tabs, which are put back a moment after it is shown. A new session, a chat's too, has nothing to say
			// yet: its side pane shows the empty state of the file list (dispatchDockedDetailFit.ts) until it starts.
			const chat = !!session && (!!session.isQuickChat?.get() || !session.workspace.get());
			const untitled = session?.status.get() === SessionStatus.Untitled;
			if (!key || !session || untitled || (group.count === 0 && !chat)) {
				logService.info(`[dispatch now] not yet: ${!key || !session ? 'no session' : untitled ? 'new session' : 'no tabs'}`);
				return;
			}
			const now = group.editors.find(e => e instanceof DispatchNowEditorInput);
			if ((now && group.getIndexOfEditor(now) === 0 && fronted.has(key)) || adding.has(key)) {
				return;
			}
			const now10 = Date.now();
			const recent = (tries.get(key) ?? []).filter(t => now10 - t < 10_000);
			if (recent.length >= 4) {
				if (recent.length === 4) {
					logService.warn('[dispatch now] the tab keeps going away; not adding it again for a while');
					recent.push(now10);
					tries.set(key, recent);
				}
				return;
			}
			recent.push(now10);
			tries.set(key, recent);
			// the first time a session comes up, Now is the tab shown; later it only keeps its place at the front
			const first = !fronted.has(key);
			logService.info(`[dispatch now] ${now ? 'to the front' : 'adding'}${first ? ', shown' : ''} (${group.count} tabs)`);
			// a default tab joining the strip never reveals a closed side pane
			const suppression = layoutService.suppressEditorPartAutoVisibility();
			adding.add(key);
			instantiationService.invokeFunction(openNowTab, !first).catch(e => logService.error('[dispatch now] could not add the Now tab', e)).finally(() => {
				adding.delete(key);
				suppression.dispose();
				if (group.activeEditor instanceof DispatchNowEditorInput || !first) {
					fronted.add(key);
				}
			});
		};
		this._register(editorService.onDidEditorsChange(() => ensure()));
		// the side pane shown (its toggle, a restore): whatever it opens on has Now in it
		this._register(layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.EDITOR_PART && e.visible) {
				ensure();
			}
		}));
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			const workspace = session?.workspace.read(reader);
			session?.status.read(reader); // a new session's first message: the started session is shown again
			current = session ? `${session.resource.toString()}|${workspace?.uri.toString()}` : '';
			for (const ms of [600, 1800, 3500]) {
				setTimeout(ensure, ms);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchNowTabByDefault.ID, DispatchNowTabByDefault, WorkbenchPhase.AfterRestored);

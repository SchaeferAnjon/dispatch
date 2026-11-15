/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Knowledge in the Agents window's Customizations, for every harness: what every
 *  agent knows about the person and their work (kanban design/knowledge/redesign, direction B).
 *  The page opens on "What Dispatch knows about you" (the preferences agents follow most, the ones
 *  remembered since the last visit, what is coming up in About me), then five entries: Preferences
 *  (`dispatch prefs`), About me (PROFILE.md), Facts (FACTS.md), Wiki, Engine memory. Facts and About me
 *  entries are edited in their file, which the page asks this side to open at the entry's line.
 *
 *  The page is dispatch-bridge's (kanban app/src/knowledge, built into the bridge's media/knowledge):
 *  this file reads its script and stylesheet, inlines them into a webview and passes the page's calls
 *  to the bridge command `dispatch.knowledge` (ide-ext/src/knowledge.ts). What the page asks the window:
 *  open a Markdown file at a line; open a preference's evidence in the right panel, the way a task's
 *  deliverable opens (`_dispatch.openPath`: a page in the integrated browser, an image in the preview),
 *  Customizations closing first; open the session its words were said in, at that message; show a
 *  folder in Finder.
 *
 *  `_dispatch.openKnowledge({view, id, edit})` opens Knowledge at a preference (Edit in a session's
 *  "Preference remembered" toast, a short name in a reply). `_dispatch.knowledgeChanged` (the bridge
 *  watches ~/.dispatch/preferences.jsonl) makes an open page read its preferences again and the
 *  sessions' "Remembered" lines too.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchKnowledge.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extname, joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { aiCustomizationManagementSectionRegistry } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementEditor } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditor.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { fireDispatchPrefsChanged } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchPrefs.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { isRequestVM } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorsOrder } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const BRIDGE_ID = 'dispatch.dispatch-bridge';
const COMMAND = 'dispatch.knowledge';
const OPEN_PATH = '_dispatch.openPath';
/** Settings' own close (dispatchSettingsState.ts DISPATCH_SETTINGS_CLOSE): Knowledge is one of its pages. */
const DISPATCH_SETTINGS_CLOSE_ID = 'dispatch.settings.close';

type Navigation = { view: 'home' | 'prefs' | 'pref'; id?: string; edit?: boolean };
interface IPageCall { kind: 'call'; id: number; op: string; payload?: unknown }
interface IPageOpen { kind: 'open'; href: string }
interface IPageOpenFile { kind: 'openFile'; path: string; line: number }
interface IPageEvidence { kind: 'openEvidence'; target: string }
interface IPageSession { kind: 'openSession'; session: string; at?: string; engine?: string }
interface IPageReveal { kind: 'reveal'; path: string }
interface IPageReady { kind: 'ready' }
type PageMessage = IPageCall | IPageOpen | IPageOpenFile | IPageEvidence | IPageSession | IPageReveal | IPageReady;

/** What the page may open from its lists: Markdown files (FACTS.md, PROFILE.md, where a preference came from). */
const OPENABLE = /\.md$/i;
/** Evidence the right panel shows: pages, images, Markdown. */
const EVIDENCE = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.md', '.pdf']);

class KnowledgeWidget extends Disposable {
	static readonly live = new Set<KnowledgeWidget>();
	/** Where the next page that says it is ready should go (Edit in a toast before Knowledge was open). */
	static pending: Navigation | undefined;

	private readonly container: HTMLElement;
	private readonly webview: IWebviewElement;
	private ready = false;

	constructor(
		parent: HTMLElement,
		@IWebviewService webviewService: IWebviewService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IEditorService private readonly editorService: IEditorService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();
		this.container = DOM.append(parent, DOM.$('.dispatch-knowledge'));
		this.webview = this._register(webviewService.createWebviewElement({
			title: localize('dispatchKnowledge.title', "Knowledge"),
			options: { disableServiceWorker: true, enableFindWidget: true },
			contentOptions: { allowScripts: true },
			extension: undefined,
		}));
		this.webview.mountTo(this.container, DOM.getWindow(parent));
		this._register(this.webview.onMessage(e => this.onMessage(e.message)));
		KnowledgeWidget.live.add(this);
		this._register({ dispose: () => KnowledgeWidget.live.delete(this) });
		void this.load();
	}

	focus(): void { this.webview.focus(); }

	post(message: unknown): void {
		if (this.ready) {
			void this.webview.postMessage(message);
		}
	}

	navigate(to: Navigation): void {
		if (this.ready) {
			void this.webview.postMessage({ kind: 'navigate', ...to });
		} else {
			KnowledgeWidget.pending = to;
		}
	}

	private async load(): Promise<void> {
		const bridge = await this.extensionService.getExtension(BRIDGE_ID);
		if (!bridge) {
			this.webview.setHtml(this.page('', '', localize('dispatchKnowledge.noBridge', "Knowledge needs the Dispatch bridge extension, which is not installed.")));
			return;
		}
		try {
			const dir = joinPath(bridge.extensionLocation, 'media', 'knowledge');
			const [js, css] = await Promise.all([
				this.fileService.readFile(joinPath(dir, 'knowledge.js')),
				this.fileService.readFile(joinPath(dir, 'knowledge.css')),
			]);
			this.webview.setHtml(this.page(js.value.toString(), css.value.toString()));
		} catch (error) {
			this.webview.setHtml(this.page('', '', localize('dispatchKnowledge.noPage', "Could not load the Knowledge page from the Dispatch bridge: {0}", String(error))));
		}
	}

	/** The page with its script and stylesheet inline, allowed by a nonce and nothing else. */
	private page(js: string, css: string, message?: string): string {
		const nonce = generateUuid().replace(/-/g, '');
		const esc = (s: string) => s.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
		return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">
<style>${css.replace(/<\/style/gi, '<\\/style')}</style>
</head><body>
${message ? `<p style="padding:24px;color:var(--vscode-descriptionForeground)">${esc(message)}</p>` : '<div id="root"></div>'}
${js ? `<script type="module" nonce="${nonce}">${js.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
</body></html>`;
	}

	private async onMessage(message: unknown): Promise<void> {
		const m = message as PageMessage | undefined;
		switch (m?.kind) {
			case 'ready': {
				this.ready = true;
				const to = KnowledgeWidget.pending;
				KnowledgeWidget.pending = undefined;
				if (to) {
					void this.webview.postMessage({ kind: 'navigate', ...to });
				}
				return;
			}
			case 'openFile': {
				const path = String(m.path ?? '');
				if (OPENABLE.test(path)) {
					// the text editor, not the Markdown preview: the line is where the cursor lands
					const line = Math.max(1, Number(m.line) || 1);
					await this.editorService.openEditor({ resource: URI.file(path), options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id, selection: { startLineNumber: line, startColumn: 1 }, revealIfOpened: true } });
				}
				return;
			}
			case 'open': {
				const uri = URI.parse(String(m.href ?? ''));
				if (uri.scheme === 'https' || uri.scheme === 'http') {
					await this.openerService.open(uri, { openExternal: true });
				}
				return;
			}
			case 'openEvidence':
				await this.openEvidence(String(m.target ?? ''));
				return;
			case 'openSession':
				await this.openSession(String(m.session ?? ''), String(m.at ?? ''));
				return;
			case 'reveal': {
				const path = String(m.path ?? '');
				if (path.startsWith('/') && await this.fileService.exists(URI.file(path))) {
					await this.commandService.executeCommand('revealFileInOS', URI.file(path));
				}
				return;
			}
			case 'call':
				break;
			default:
				return;
		}
		if (typeof m.id !== 'number') {
			return;
		}
		let answer: { ok: boolean; result?: unknown; error?: string };
		try {
			answer = await this.run(m.op, m.payload);
		} catch (error) {
			answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		await this.webview.postMessage({ kind: 'reply', id: m.id, ...answer });
	}

	/** Customizations is a modal over the Agents window: close it so the right panel shows what opens. */
	private async closeCustomizations(): Promise<void> {
		const open = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(e => e.editor instanceof AICustomizationManagementEditorInput);
		if (open.length) {
			await this.editorService.closeEditors(open);
		}
		// Knowledge is a page of Settings now (Abilities › Knowledge): Settings steps aside too, so the file or
		// the session it opens is in view (dispatchSettings.contribution.ts; not there in an editor-only build)
		if (CommandsRegistry.getCommand(DISPATCH_SETTINGS_CLOSE_ID)) {
			await this.commandService.executeCommand(DISPATCH_SETTINGS_CLOSE_ID).catch(() => undefined);
		}
	}

	/** A page or image in the right panel, like a task's deliverable; a web link in the integrated browser. */
	private async openEvidence(target: string): Promise<void> {
		let arg: string;
		if (/^https?:\/\//i.test(target)) {
			arg = target;
		} else {
			const [path, fragment] = target.split('#', 2);
			const file = URI.file(path);
			if (!path.startsWith('/') || !EVIDENCE.has(extname(file).toLowerCase()) || !await this.fileService.exists(file)) {
				return;
			}
			arg = fragment ? file.with({ fragment }).toString() : path;
		}
		await this.closeCustomizations();
		await this.commandService.executeCommand(OPEN_PATH, arg);
	}

	/** The session the words were said in (its id is the agent's own session id), at that message. */
	private async openSession(id: string, at: string): Promise<void> {
		if (!/^[A-Za-z0-9_-]{8,120}$/.test(id)) {
			return;
		}
		const session = this.sessionsManagementService.getSessions().find(s => {
			const last = decodeURIComponent(s.resource.path).split('/').filter(Boolean).pop();
			return last === id;
		});
		if (!session) {
			return;
		}
		await this.closeCustomizations();
		await this.sessionsService.openSession(session.resource);
		const when = Date.parse(at);
		if (Number.isNaN(when)) {
			return;
		}
		// the request the words came with: the last one sent before the preference was remembered
		for (let attempt = 0; attempt < 10; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 300));
			const widget = this.chatWidgetService.getWidgetBySessionResource(session.mainChat.get().resource);
			const requests = widget?.viewModel?.getItems().filter(isRequestVM) ?? [];
			if (!widget || !requests.length) {
				continue;
			}
			const item = [...requests].reverse().find(r => r.timestamp <= when + 5000) ?? requests[0];
			widget.reveal(item);
			widget.focus(item);
			return;
		}
	}

	/** The bridge command; right after the window opens the bridge may still be activating. */
	private async run(op: string, payload: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		for (let attempt = 0; ; attempt++) {
			try {
				const answer = await this.commandService.executeCommand<{ ok: boolean; result?: unknown; error?: string }>(COMMAND, op, payload);
				return answer ?? { ok: false, error: localize('dispatchKnowledge.noAnswer', "The Dispatch bridge did not answer.") };
			} catch (error) {
				if (attempt >= 10 || !/not found/i.test(String(error))) {
					throw error;
				}
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}
	}
}

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.Knowledge,
	label: localize('dispatchKnowledge.navigationLabel', "Knowledge"),
	icon: Codicon.library,
	description: localize('dispatchKnowledge.navigationDescription', "What agents know about you and your work."),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(KnowledgeWidget, container),
});

/** Knowledge, at a preference (edit: its form open) or the Preferences list. */
CommandsRegistry.registerCommand('_dispatch.openKnowledge', async (accessor: ServicesAccessor, to?: Navigation) => {
	const editorService = accessor.get(IEditorService);
	const nav: Navigation = to && (to.view === 'pref' || to.view === 'prefs' || to.view === 'home') ? { view: to.view, id: typeof to.id === 'string' ? to.id : undefined, edit: !!to.edit } : { view: 'home' };
	const before = new Set(KnowledgeWidget.live);
	// a page made by opening the section takes it when it says it is ready
	KnowledgeWidget.pending = nav;
	const pane = await editorService.openEditor(AICustomizationManagementEditorInput.getOrCreate(), { pinned: true });
	if (pane instanceof AICustomizationManagementEditor) {
		pane.selectSectionById(AICustomizationManagementSection.Knowledge);
	}
	const same = [...KnowledgeWidget.live].filter(w => before.has(w));
	if (same.length) {
		KnowledgeWidget.pending = undefined;
		for (const w of same) {
			w.navigate(nav);
		}
	}
});

/** Knowledge's home in the pages already open (Settings' side bar row for Knowledge, clicked on a preference). */
CommandsRegistry.registerCommand('_dispatch.knowledgeHome', () => {
	for (const w of KnowledgeWidget.live) {
		w.navigate({ view: 'home' });
	}
});

/** The preferences file changed (the bridge watches it): open pages and the sessions' lines read it again. */
CommandsRegistry.registerCommand('_dispatch.knowledgeChanged', () => {
	for (const w of KnowledgeWidget.live) {
		w.post({ kind: 'changed', what: 'prefs' });
	}
	fireDispatchPrefsChanged();
});

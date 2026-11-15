/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Draw and ask in the side pane (kanban design/annotations/redesign 第 4 节「右栏
 *  里的图」, DECISIONS.md 「标注图四个触点」; patches/320-draw-and-ask.patch).
 *
 *  Any picture or document in the side pane shows a small bar at its top right while the pointer is
 *  on it (fades in 200 ms): Draw and ask, and Enlarge. A picture in the image preview is a webview that
 *  never tells the window where the pointer is, so there the bar stays at the picture's top right for as
 *  long as the picture is the pane's active editor. Draw and ask opens the draw tool right there,
 *  over what you were looking at, 1:1 (scroll to look around): a picture as it is, a document in the
 *  Docs tab as a picture of all of it (scrolled through and put together first, so the trackpad and
 *  the wheel go on through the document while you draw and the boxes stay on what they mark), any
 *  other page as a capture of what is on screen. Add to message puts the picture with its boxes
 *  burned in into the session's chat input with the lines (a whole document: the part with the
 *  boxes, at least a screen of it), nothing is sent: you read it over, add a word and send (the same
 *  as Ask Question on selected text).
 *
 *  Pictures that already carry an agent's red boxes (a Where to look viewport) start with green.
 *  Pages in the integrated browser come in through {@link DispatchPaneDraw.open} with the page's
 *  elements to snap to (dispatchDrawBrowser.ts).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { DispatchMarksMetadataKey, IDispatchMarksMetadata, IDispatchMarksMetaElement } from '../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { INewSessionComposer, INewSessionComposerService } from '../../chat/browser/newSessionComposerService.js';
import { DispatchMarkColor, dispatchPictureSize, dispatchWherePictureOf } from '../../dispatchCommon/browser/dispatchWhere.js';
import { dispatchBlobUrl, rememberDispatchOriginal } from './dispatchDrawInput.js';
import { burnDispatchMarks, DispatchDrawTool, IDispatchDrawMark, IDispatchSnapTarget } from './dispatchDrawTool.js';

const $ = dom.$;

/** A picture to draw on in the side pane. */
export interface IDispatchPaneDrawRequest {
	/** What the tool covers (a picture, an editor, the page of a browser). */
	readonly anchor: HTMLElement;
	readonly bytes: Uint8Array;
	readonly mime: string;
	/** Picture pixels per screen point (a capture: the device pixel ratio). */
	readonly scale?: number;
	/** The attachment's name. */
	readonly name: string;
	/** The Source line: where the picture came from. */
	readonly source?: string;
	readonly color?: DispatchMarkColor;
	readonly snap?: readonly IDispatchSnapTarget[];
	readonly page?: { readonly url: string; readonly viewport: readonly [number, number] };
	/** The page elements behind the boxes (asked when adding to the message). */
	readonly elements?: (marks: readonly IDispatchDrawMark[]) => Promise<IDispatchMarksMetaElement[]>;
	/** Called once the tool is closed either way. */
	readonly onDidClose?: () => void;
	/** Picture pixels to show in the middle at first. */
	readonly center?: readonly [number, number];
	/**
	 * The tool covers a native view (the integrated browser's page, which paints above the DOM): mark
	 * the tool as an overlay the browser knows, so the page steps back while the tool is open.
	 */
	readonly overNativeView?: boolean;
	/**
	 * The picture is a whole document, `viewport` points of it were on screen: the message gets the part
	 * with the boxes (at least that tall), not all of it.
	 */
	readonly wholeDocument?: { readonly viewport: number };
}

/** The Docs tab's command (dispatchDocsEditor.ts); by id, so this file does not import that one. */
const DOCS_SCROLL_COMMAND = '_dispatch.docsScroll';
interface IDocScroll {
	readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly top: number;
	readonly height: number;
}
/** A longer document: its part around what is on screen (points). */
const WHOLE_DOC_MAX_POINTS = 30000;
/** Canvas limits: 32767 pixels a side, and memory. */
const WHOLE_DOC_MAX_SIDE = 32000;
const WHOLE_DOC_MAX_AREA = 120_000_000;

/**
 * Put an annotated picture into the active session's chat input (not sent). Without a started
 * session, into the new-session page's input (the same annotated tile there).
 */
export async function addDispatchPictureToChat(
	services: { chatWidgetService: IChatWidgetService; sessionsService: ISessionsService; notificationService: INotificationService; newSessionComposerService: INewSessionComposerService },
	entry: IChatRequestVariableEntry,
): Promise<boolean> {
	const session = services.sessionsService.activeSession.get();
	if (session?.isCreated.get()) {
		const widget = await whenChatWidgetForSession(services.chatWidgetService, session.resource, 3000) ?? services.chatWidgetService.lastFocusedWidget;
		if (widget) {
			widget.attachmentModel.addContext(entry);
			widget.focusInput();
			return true;
		}
	}
	// the new-session page (NewChatInputWidget has these beyond INewSessionComposer)
	const composer = services.newSessionComposerService.activeComposer.get() as (INewSessionComposer & { addAttachments?(...entries: IChatRequestVariableEntry[]): void; focus?(): void }) | undefined;
	if (composer?.addAttachments) {
		composer.addAttachments(entry);
		composer.focus?.();
		return true;
	}
	services.notificationService.info(localize('dispatchDraw.noSession', "Open a session first: the picture goes into its message box."));
	return false;
}

let currentPaneDraw: DispatchPaneDraw | undefined;

/** Open the side pane's draw tool on a picture (the integrated browser's page). */
export function openDispatchPaneDraw(req: IDispatchPaneDrawRequest): Promise<void> {
	return currentPaneDraw ? currentPaneDraw.open(req) : Promise.resolve();
}


/** Draw the active Docs document with the existing scrollable whole-page tool. */
export function drawDispatchDocument(): Promise<void> {
	return currentPaneDraw ? currentPaneDraw.drawDocument() : Promise.resolve();
}

export function setDispatchPaneDraw(value: DispatchPaneDraw): IDisposable {
	currentPaneDraw = value;
	return toDisposable(() => {
		if (currentPaneDraw === value) {
			currentPaneDraw = undefined;
		}
	});
}

/**
 * The side pane's Draw and ask: the hover bar and the tool over the pane. One tool at a time.
 */
export class DispatchPaneDraw extends Disposable {

	private readonly bar: HTMLElement;
	private readonly barDrawButton: HTMLButtonElement;
	private barTarget: { anchor: HTMLElement; kind: 'img' | 'editor'; img?: HTMLImageElement } | undefined;
	private hideTimer: ReturnType<typeof setTimeout> | undefined;
	/** The active side pane editor is a picture in the image preview: the bar stays on it. */
	private pinned = false;
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	/** Taking the picture (a whole document is scrolled through first): the bar stays away meanwhile. */
	private capturing = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IHostService private readonly hostService: IHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@INotificationService private readonly notificationService: INotificationService,
		@INewSessionComposerService private readonly newSessionComposerService: INewSessionComposerService,
		@ILogService private readonly logService: ILogService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		const doc = mainWindow.document;
		this.bar = $('.dispatch-draw-bar', { role: 'toolbar', 'aria-label': localize('dispatchDraw.barAria', "Picture actions") });
		// the pen alone, its name in the hover; enlarging is the pane's own button in its tab bar
		const drawTitle = localize('dispatchDraw.drawAndAsk', "Draw and ask");
		this.barDrawButton = dom.append(this.bar, $('button.fbtn.i', { type: 'button', 'aria-label': drawTitle })) as HTMLButtonElement;
		dom.append(this.barDrawButton, $('span.codicon.codicon-edit'));
		this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.barDrawButton, drawTitle));
		// inside the workbench element: the theme's colours are defined there, and it stacks above the webviews in it
		this.layoutService.mainContainer.appendChild(this.bar);
		this._register(toDisposable(() => this.bar.remove()));

		this._register(dom.addDisposableListener(this.barDrawButton, dom.EventType.CLICK, e => {
			e.preventDefault();
			const target = this.barTarget;
			this.hideBar(true);
			if (target) {
				void this.drawOn(target);
			}
		}));
		this._register(dom.addDisposableListener(doc, dom.EventType.MOUSE_OVER, (e: MouseEvent) => this.onPointer(e), true));
		this._register(dom.addDisposableListener(doc, dom.EventType.MOUSE_LEAVE, () => this.scheduleHide()));
		// the image preview is a webview: no pointer event reaches this window from it, so its bar is pinned
		const repin = () => mainWindow.requestAnimationFrame(() => this.pinForPicture());
		this._register(this.editorService.onDidActiveEditorChange(repin));
		this._register(this.editorService.onDidVisibleEditorsChange(repin));
		this._register(dom.addDisposableListener(mainWindow, 'resize', repin));
		const part = this.editorPart();
		if (part) {
			const ro = this._register(new dom.DisposableResizeObserver('dispatchDrawPin', repin, mainWindow));
			this._register(ro.observe(part));
		}
	}

	/** Pin the bar to the side pane's picture when it is an image preview; unpin otherwise. */
	private pinForPicture(): void {
		const docPane = this.current.value ? undefined : this.documentPane();
		const r = docPane?.container.getBoundingClientRect();
		if (docPane?.picture && r && r.width > 0 && r.height > 0) {
			this.pinned = true;
			this.showBar({ anchor: docPane.container, kind: 'editor' });
		} else if (this.pinned) {
			this.pinned = false;
			this.hideBar(true);
		}
	}

	// ---- the bar

	private editorPart(): HTMLElement | undefined {
		try {
			const part = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
			if (part) {
				return part;
			}
		} catch {
			// not a part this layout knows by id
		}
		return mainWindow.document.querySelector<HTMLElement>('.part.editor') ?? undefined;
	}

	/** The side pane's active editor, when it is a picture or a document. */
	private documentPane(): { container: HTMLElement; resource: URI | undefined; picture: boolean } | undefined {
		const pane = this.editorService.activeEditorPane;
		const container = pane instanceof EditorPane ? pane.getContainer() : undefined;
		const part = this.editorPart();
		if (!pane || !container || !part?.contains(container)) {
			return undefined;
		}
		const id = pane.getId();
		const input = pane.input as { resource?: URI; viewType?: string } | undefined;
		if (id === 'WebviewEditor') {
			return { container, resource: input?.resource, picture: input?.viewType === 'imagePreview.previewEditor' };
		}
		if (id === 'workbench.editor.dispatch.docs' || id === 'workbench.editor.dispatch.doc') {
			return { container, resource: undefined, picture: false };
		}
		return undefined;
	}

	async drawDocument(): Promise<void> {
		const pane = this.documentPane();
		if (pane) {
			this.hideBar(true);
			await this.drawOn({ anchor: pane.container, kind: 'editor' });
		}
	}

	private onPointer(e: MouseEvent): void {
		// Docs owns a fixed toolbar. No image or webview hover may place a bar over its header.
		const paneId = this.editorService.activeEditorPane?.getId();
		if (paneId === 'workbench.editor.dispatch.docs' || paneId === 'workbench.editor.dispatch.doc') {
			this.pinned = false;
			this.hideBar(true);
			return;
		}
		if (this.current.value || this.capturing) {
			return;
		}
		const t = e.target as HTMLElement | null;
		if (!t || this.bar.contains(t)) {
			this.cancelHide();
			return;
		}
		const part = this.editorPart();
		if (!part) {
			return;
		}
		// a picture in the pane's own DOM (a Where to look viewport, a picture in a document)
		const img = t instanceof HTMLImageElement ? t : undefined;
		if (img && part.contains(img)) {
			const r = img.getBoundingClientRect();
			if (r.width >= 96 && r.height >= 64) {
				const anchor = img.closest<HTMLElement>('.vp') ?? img;
				this.showBar({ anchor, kind: 'img', img });
				return;
			}
		}
		// a document or picture editor: its webview is not inside the pane's DOM, so go by position
		const docPane = this.documentPane();
		if (docPane) {
			const r = docPane.container.getBoundingClientRect();
			const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
			if (inside && (part.contains(t) || t.tagName === 'IFRAME' || t.classList.contains('webview'))) {
				this.showBar({ anchor: docPane.container, kind: 'editor' });
				return;
			}
		}
		this.scheduleHide();
	}

	private showBar(target: { anchor: HTMLElement; kind: 'img' | 'editor'; img?: HTMLImageElement }): void {
		this.cancelHide();
		this.barTarget = target;
		const r = target.anchor.getBoundingClientRect();
		// a document editor keeps its own buttons at its top right (the Markdown editor's read / edit switch): the pen
		// goes to its bottom right, clear of them and of the scroll bar
		this.bar.style.left = `${Math.round(r.right - (target.kind === 'editor' ? 24 : 8))}px`;
		this.bar.style.top = `${Math.round(target.kind === 'editor' ? r.bottom - 44 : r.top + 8)}px`;
		this.bar.classList.add('visible');
	}

	private scheduleHide(): void {
		if (!this.bar.classList.contains('visible') || this.hideTimer) {
			return;
		}
		this.hideTimer = setTimeout(() => this.hideBar(), 200);
	}

	private cancelHide(): void {
		if (this.hideTimer) {
			clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
	}

	private hideBar(now = false): void {
		this.cancelHide();
		if (this.pinned && !now) {
			// back to the pinned picture (the pointer left a picture in the pane's own DOM)
			this.pinForPicture();
			if (this.pinned) {
				return;
			}
		}
		this.bar.classList.remove('visible');
		if (now) {
			this.bar.classList.add('instant');
			mainWindow.requestAnimationFrame(() => this.bar.classList.remove('instant'));
		}
		this.barTarget = undefined;
	}

	// ---- capturing what is under the bar

	private async drawOn(target: { anchor: HTMLElement; kind: 'img' | 'editor'; img?: HTMLImageElement }): Promise<void> {
		if (this.capturing) {
			return;
		}
		this.capturing = true;
		try {
			await this.captureAndDraw(target);
		} finally {
			this.capturing = false;
		}
	}

	private async captureAndDraw(target: { anchor: HTMLElement; kind: 'img' | 'editor'; img?: HTMLImageElement }): Promise<void> {
		try {
			if (target.kind === 'img' && target.img) {
				let bytes = await this.bytesOfImg(target.img);
				if (!bytes) {
					return;
				}
				// a Where to look viewer draws its boxes over a raw screenshot: burn them in first, so
				// what you add sits next to them in one picture
				const shown = dispatchWherePictureOf(target.img);
				if (shown && !shown.drawn && shown.marks.length) {
					const raw = dispatchBlobUrl(bytes.bytes, bytes.mime);
					try {
						const size = await dispatchPictureSize(raw.url);
						if (size) {
							bytes = { bytes: await burnDispatchMarks({ url: raw.url, size, scale: shown.scale }, shown.marks), mime: 'image/png' };
						}
					} finally {
						raw.dispose();
					}
				}
				const hasBoxes = !!shown?.marks.length || !!target.img.closest('.dispatch-docs-where, .where');
				const title = this.editorService.activeEditorPane?.input?.getName();
				// open where the picture was being looked at (a Where to look viewport shows one spot of it)
				const ir = target.img.getBoundingClientRect(), ar = target.anchor.getBoundingClientRect();
				const center: [number, number] | undefined = ir.width && ir.height
					? [((ar.left + ar.width / 2 - ir.left) / ir.width) * target.img.naturalWidth, ((ar.top + ar.height / 2 - ir.top) / ir.height) * target.img.naturalHeight]
					: undefined;
				await this.open({
					center,
					anchor: target.anchor,
					bytes: bytes.bytes,
					mime: bytes.mime,
					name: target.img.alt || (hasBoxes ? 'where.png' : 'picture.png'),
					source: [hasBoxes ? localize('dispatchDraw.sourceWhere', "Where to look") : undefined, title].filter(Boolean).join(', ') || undefined,
					color: hasBoxes ? 'green' : 'red',
				});
				return;
			}
			const docPane = this.documentPane();
			if (!docPane) {
				return;
			}
			if (docPane.picture && docPane.resource) {
				const content = await this.fileService.readFile(docPane.resource);
				const bytes = content.value.buffer;
				await this.open({
					anchor: docPane.container,
					bytes,
					mime: 'image/png',
					name: basename(docPane.resource),
					source: docPane.resource.scheme === 'file' ? docPane.resource.fsPath : docPane.resource.toString(),
				});
				return;
			}
			const title = this.editorService.activeEditorPane?.input?.getName() ?? '';
			const resource = this.editorService.activeEditorPane?.input?.resource;
			const source = [localize('dispatchDraw.sourceScreen', "a capture of the side pane"), title, resource?.scheme === 'file' ? resource.fsPath : undefined].filter(Boolean).join(', ');
			// a document in the Docs tab longer than the pane: all of it, so drawing can go on down the page
			const whole = await this.captureWholeDocument();
			if (whole) {
				await this.open({
					anchor: docPane.container,
					bytes: whole.bytes,
					mime: 'image/jpeg',
					scale: whole.scale,
					center: whole.center,
					name: `${title || 'document'}.jpg`,
					source,
					wholeDocument: { viewport: whole.viewport },
				});
				return;
			}
			const capture = await this.capture(docPane.container);
			if (!capture) {
				return;
			}
			await this.open({
				anchor: docPane.container,
				bytes: capture.bytes,
				mime: 'image/jpeg',
				scale: capture.scale,
				name: `${title || 'document'}.jpg`,
				source,
			});
		} catch (e) {
			this.logService.error('[dispatch] Draw and ask: could not take the picture', e);
			this.notificationService.error(localize('dispatchDraw.captureFailed', "Could not take the picture: {0}", String(e)));
		}
	}

	private async bytesOfImg(img: HTMLImageElement): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
		try {
			const res = await fetch(img.currentSrc || img.src);
			const blob = await res.blob();
			return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/png' };
		} catch {
			// not fetchable (another scheme): draw what is shown
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				return undefined;
			}
			ctx.drawImage(img, 0, 0);
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
			return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' } : undefined;
		}
	}

	/** What `element` shows on screen, captured from the window (documents in webviews included). */
	private async capture(element: HTMLElement): Promise<{ bytes: Uint8Array; scale: number } | undefined> {
		const r = element.getBoundingClientRect();
		const zoom = getZoomFactor(mainWindow);
		const buf = await this.hostService.getScreenshot({ x: Math.round(r.left * zoom), y: Math.round(r.top * zoom), width: Math.round(r.width * zoom), height: Math.round(r.height * zoom) });
		if (!buf) {
			return undefined;
		}
		return { bytes: buf.buffer, scale: mainWindow.devicePixelRatio || 1 };
	}

	/**
	 * The document in the Docs tab, all of it (or its {@link WHOLE_DOC_MAX_POINTS} around what is on screen):
	 * scrolled through a screen at a time and put together, then back where it was. Undefined when the tab
	 * shows no document, it fits on screen, or it did not answer (the caller captures what is on screen).
	 */
	private async captureWholeDocument(): Promise<{ bytes: Uint8Array; scale: number; center: [number, number]; viewport: number } | undefined> {
		const ask = (op: 'metrics' | 'scroll', y?: number, hideFixed?: boolean) =>
			this.commandService.executeCommand<IDocScroll | undefined>(DOCS_SCROLL_COMMAND, op, y, hideFixed).catch(() => undefined);
		const first = await ask('metrics');
		if (!first || first.rect.width < 16 || first.rect.height < 16 || first.height <= first.rect.height + 4) {
			return undefined;
		}
		const vw = first.rect.width;
		const vh = first.rect.height;
		const span = Math.min(first.height, WHOLE_DOC_MAX_POINTS);
		const from = Math.max(0, Math.min(first.top - vh, first.height - span));
		const dpr = mainWindow.devicePixelRatio || 1;
		const scale = Math.max(0.5, Math.min(dpr, WHOLE_DOC_MAX_SIDE / span, Math.sqrt(WHOLE_DOC_MAX_AREA / (vw * span))));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(vw * scale);
		canvas.height = Math.round(span * scale);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return undefined;
		}
		const zoom = getZoomFactor(mainWindow);
		let complete = false;
		try {
			for (let y = from; ; y += vh) {
				const at = Math.min(y, from + span - vh);
				// below the first screen a bar that stays on screen steps out, so it is in the picture once
				const v = await ask('scroll', at, at > from);
				if (!v) {
					return undefined;
				}
				const r = v.rect;
				const shot = await this.hostService.getScreenshot({ x: Math.round(r.x * zoom), y: Math.round(r.y * zoom), width: Math.round(r.width * zoom), height: Math.round(r.height * zoom) });
				if (!shot) {
					return undefined;
				}
				const piece = dispatchBlobUrl(shot.buffer);
				try {
					const img = await loadPicture(piece.url);
					ctx.drawImage(img, 0, (v.top - from) * scale, vw * scale, r.height * scale);
				} finally {
					piece.dispose();
				}
				if (at >= from + span - vh) {
					break;
				}
			}
			complete = true;
		} finally {
			await ask('scroll', first.top, false);
		}
		if (!complete) {
			return undefined;
		}
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
		if (!blob) {
			return undefined;
		}
		return {
			bytes: new Uint8Array(await blob.arrayBuffer()),
			scale,
			// the left edge in view, where it was down the page
			center: [0, (first.top - from + vh / 2) * scale],
			viewport: vh,
		};
	}

	// ---- the tool over the pane

	/** Open the draw tool over `req.anchor`. Resolves when it is closed. */
	async open(req: IDispatchPaneDrawRequest): Promise<void> {
		this.current.clear();
		const store = new DisposableStore();
		this.current.value = store;
		// the bar would sit over the tool's own row (the pointer went on moving while the picture was taken)
		this.hideBar(true);
		const blob = dispatchBlobUrl(req.bytes, req.mime);
		store.add(blob);
		const size = await dispatchPictureSize(blob.url);
		if (!size || this.current.value !== store) {
			return;
		}
		const scale = req.scale ?? (size[0] > 1600 ? 2 : 1);
		const overlay = $('.dispatch-draw-overlay');
		// `editor-widget` is one of the classes the integrated browser's overlay manager watches for
		overlay.classList.toggle('editor-widget', !!req.overNativeView);
		this.layoutService.mainContainer.appendChild(overlay);
		store.add(toDisposable(() => overlay.remove()));
		const place = () => {
			const r = req.anchor.getBoundingClientRect();
			overlay.style.left = `${Math.round(r.left)}px`;
			overlay.style.top = `${Math.round(r.top)}px`;
			overlay.style.width = `${Math.round(r.width)}px`;
			overlay.style.height = `${Math.round(r.height)}px`;
		};
		place();
		store.add(dom.addDisposableListener(mainWindow, 'resize', place));
		const ro = store.add(new dom.DisposableResizeObserver('dispatchDrawPane', place, mainWindow));
		store.add(ro.observe(req.anchor));

		const tool = store.add(new DispatchDrawTool({ url: blob.url, size, scale }, {
			fit: 'points',
			color: req.color,
			accept: localize('dispatchDraw.addToMessage', "Add to message"),
			snap: req.snap,
			center: req.center,
		}));
		overlay.appendChild(tool.element);
		tool.layout();
		mainWindow.requestAnimationFrame(() => {
			overlay.classList.add('open');
			tool.focus();
		});

		await new Promise<void>(resolve => {
			store.add(tool.onDidCancel(() => resolve()));
			store.add(tool.onDidAccept(async marks => {
				if (marks.length) {
					overlay.classList.add('busy');
					try {
						await this.addToMessage(req, size, scale, blob.url, marks);
					} catch (e) {
						this.logService.error('[dispatch] Draw and ask: could not add the picture', e);
					}
				}
				resolve();
			}));
		});
		if (this.current.value === store) {
			this.current.clear();
		}
		req.onDidClose?.();
		this.pinForPicture();
	}

	private async addToMessage(req: IDispatchPaneDrawRequest, size: [number, number], scale: number, url: string, marks: IDispatchDrawMark[]): Promise<void> {
		// a whole document: the part with the boxes
		const part = req.wholeDocument ? await cropToMarks(url, size, scale, marks, req.wholeDocument.viewport) : undefined;
		try {
			if (part) {
				// the page's elements are looked up by the boxes on the whole page, not on the cut-out part
				const elements = req.elements;
				await this.addPictureToMessage({ ...req, bytes: part.bytes, mime: 'image/jpeg', elements: elements ? () => elements(marks) : undefined }, part.size, scale, part.url, part.marks);
			} else {
				await this.addPictureToMessage(req, size, scale, url, marks);
			}
		} finally {
			part?.dispose();
		}
	}

	private async addPictureToMessage(req: IDispatchPaneDrawRequest, size: [number, number], scale: number, url: string, marks: IDispatchDrawMark[]): Promise<void> {
		const bytes = await burnDispatchMarks({ url, size, scale }, marks);
		if (this.customViewService.activeCustomView.get()) {
			// a page is in the middle (the document was opened beside it): the session's message box comes
			// back so the picture lands where it is seen; the title bar's ← goes back to the page
			this.customViewService.hideCustomView();
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 300));
		}
		let elements: IDispatchMarksMetaElement[] | undefined;
		if (req.elements) {
			try {
				elements = await req.elements(marks);
			} catch (e) {
				this.logService.warn('[dispatch] Draw and ask: page elements not read', e);
			}
		}
		const meta: IDispatchMarksMetadata = {
			v: 1,
			size,
			scale,
			marks: marks.map(m => ({ n: m.n, box: m.box, color: m.color ?? 'red', note: (m.note ?? '').trim() || undefined })),
			source: req.source,
			page: req.page,
			elements: elements?.length ? elements : undefined,
		};
		const id = `dispatch-draw-${generateUuid()}#dispatch-marked-0`;
		rememberDispatchOriginal(id, { bytes: req.bytes, mime: req.mime, size, scale });
		const entry = {
			id,
			kind: 'image',
			name: req.name,
			value: bytes,
			mimeType: 'image/png',
			isPasted: true,
			_meta: { [DispatchMarksMetadataKey]: meta },
		} as IChatRequestVariableEntry;
		await addDispatchPictureToChat({ chatWidgetService: this.chatWidgetService, sessionsService: this.sessionsService, notificationService: this.notificationService, newSessionComposerService: this.newSessionComposerService }, entry);
	}
}

function loadPicture(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('picture did not load'));
		img.src = url;
	});
}

/**
 * The band of a whole-document picture that holds the boxes: a quarter screen above the first and below
 * the last, at least `viewport` points tall, the full width. The boxes move with it. Undefined when that
 * is the whole picture anyway.
 */
async function cropToMarks(url: string, size: [number, number], scale: number, marks: readonly IDispatchDrawMark[], viewport: number): Promise<{ bytes: Uint8Array; url: string; size: [number, number]; marks: IDispatchDrawMark[]; dispose(): void } | undefined> {
	if (!marks.length) {
		return undefined;
	}
	const screen = viewport * scale;
	let top = Math.min(...marks.map(m => m.box[1])) - screen / 4;
	let bottom = Math.max(...marks.map(m => m.box[1] + m.box[3])) + screen / 4;
	if (bottom - top < screen) {
		const middle = (top + bottom) / 2;
		top = middle - screen / 2;
		bottom = middle + screen / 2;
	}
	if (top < 0) {
		bottom -= top;
		top = 0;
	}
	top = Math.round(top);
	bottom = Math.min(size[1], Math.round(bottom));
	if (top <= 0 && bottom >= size[1]) {
		return undefined;
	}
	const img = await loadPicture(url);
	const canvas = document.createElement('canvas');
	canvas.width = size[0];
	canvas.height = bottom - top;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return undefined;
	}
	ctx.drawImage(img, 0, top, size[0], bottom - top, 0, 0, size[0], bottom - top);
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
	if (!blob) {
		return undefined;
	}
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const piece = dispatchBlobUrl(bytes, 'image/jpeg');
	return {
		bytes,
		url: piece.url,
		size: [size[0], bottom - top],
		marks: marks.map(m => ({ ...m, box: [m.box[0], m.box[1] - top, m.box[2], m.box[3]] as [number, number, number, number] })),
		dispose: () => piece.dispose(),
	};
}

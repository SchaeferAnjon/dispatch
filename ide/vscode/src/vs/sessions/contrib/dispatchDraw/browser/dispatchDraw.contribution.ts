/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: 「截图上画框当输入」 in the Agents window (kanban design/annotations/redesign 第 4 节;
 *  patches/320-draw-and-ask.patch). Wires the pieces:
 *
 *  - the chat's picture hooks: the input's picture tile and pen (dispatchDrawInput.ts), a sent
 *    picture with boxes as a 144×96 crop above the bubble and its lines inside the bubble, a click
 *    on it opening the Where to look viewer under the message;
 *  - sending while drawing sends the boxes (a submit handler commits the open drawing first);
 *  - the side pane's Draw and ask (dispatchDrawPane.ts).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDispatchMarksMetadata, readDispatchMarksMeta } from '../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatSubmitRequestHandlerService } from '../../../../workbench/contrib/chat/browser/chatSubmitRequestHandlerService.js';
import { IDispatchChatImageAttachmentContext, IDispatchChatRequestContext, setDispatchChatPictureHooks } from '../../../../workbench/contrib/chat/browser/attachments/dispatchChatPictureHooks.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { DispatchThumbSize, DispatchWhereViewer, IDispatchMark, renderDispatchWhereLegend, renderDispatchWhereThumb } from '../../dispatchCommon/browser/dispatchWhere.js';
import { dispatchAttachmentBytes, dispatchBlobUrl, DispatchDrawInputController, IDispatchDrawInputHost, renderDispatchImageTile, setDispatchDrawInputController } from './dispatchDrawInput.js';
import { DispatchPaneDraw, setDispatchPaneDraw } from './dispatchDrawPane.js';

/** Point and talk's keyframes carry boxes too (for the agent) but draw themselves (contrib/dispatchPointTalk). */
const POINT_TALK_FRAME_META = 'dispatch.pointTalk';

const $ = dom.$;

let inputController: DispatchDrawInputController | undefined;

function marksOf(meta: IDispatchMarksMetadata): IDispatchMark[] {
	return meta.marks.map(m => ({ n: m.n, box: m.box, color: m.color, note: m.note ?? '' }));
}

class DispatchDrawContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchDraw';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatSubmitRequestHandlerService submitHandlers: IChatSubmitRequestHandlerService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		const controller = this._register(instantiationService.createInstance(DispatchDrawInputController));
		inputController = controller;
		this._register(setDispatchDrawInputController(controller));
		this._register(setDispatchPaneDraw(this._register(instantiationService.createInstance(DispatchPaneDraw))));
		this._register(toDisposable(() => inputController = undefined));

		this._register(setDispatchChatPictureHooks({
			decorateImageAttachment: ctx => this.decorateImage(ctx),
			decorateRequest: ctx => this.decorateRequest(ctx),
		}));

		// sending while the draw tool is open sends the boxes
		this._register(submitHandlers.register({
			id: 'dispatch.draw.flushBeforeSend',
			tryHandle: async request => {
				const widget = this.chatWidgetService.getWidgetBySessionResource(request.sessionResource);
				const box = widget?.domNode.querySelector<HTMLElement>('.chat-input-container.dispatch-drawing');
				if (box) {
					await controller.flush(box);
				}
				return false;
			},
		}));
	}

	private widgetOf(element: HTMLElement): IChatWidget | undefined {
		return this.chatWidgetService.getAllWidgets().find(w => w.domNode.contains(element));
	}

	private hostFor(element: HTMLElement): IDispatchDrawInputHost | undefined {
		const widget = this.widgetOf(element);
		const box = element.closest<HTMLElement>('.chat-input-container');
		if (!widget || !box) {
			return undefined;
		}
		return {
			box,
			row: box.querySelector<HTMLElement>('.chat-attachments-container') ?? undefined,
			entries: () => widget.attachmentModel.attachments,
			replace: (oldId, entry) => widget.attachmentModel.updateContext([oldId], [entry]),
			focus: () => widget.focusInput(),
		};
	}

	private decorateImage(ctx: IDispatchChatImageAttachmentContext): IDisposable | undefined {
		if (ctx.attachment._meta?.[POINT_TALK_FRAME_META]) {
			return undefined; // a Point and talk keyframe: contrib/dispatchPointTalk draws it
		}
		const store = new DisposableStore();
		const render = (bytes: Uint8Array) => {
			if (ctx.isCurrentInput) {
				store.add(renderDispatchImageTile(ctx.element, ctx.attachment, bytes, {
					draw: () => {
						const host = this.hostFor(ctx.element);
						if (host) {
							void inputController?.openFor(host, ctx.attachment.id);
						}
					},
				}));
				return;
			}
			const meta = readDispatchMarksMeta(ctx.attachment);
			if (!meta) {
				return;
			}
			// a sent picture with boxes: 144×96 cropped to them; a click opens the viewer under the message
			const blob = dispatchBlobUrl(bytes);
			store.add(blob);
			ctx.element.classList.add('dispatch-draw-sent');
			ctx.element.dataset.dispatchMarks = ctx.attachment.id;
			// the boxes are burned into a sent picture (the agent got exactly this)
			const thumb = renderDispatchWhereThumb(blob.url, { size: meta.size, marks: marksOf(meta), drawn: true }, { size: DispatchThumbSize.message, fit: 'marks', zoom: true, title: localize('dispatchDraw.showBoxes', "Show where the boxes are") });
			ctx.element.prepend(thumb);
			store.add(toDisposable(() => {
				thumb.remove();
				ctx.element.classList.remove('dispatch-draw-sent');
				delete ctx.element.dataset.dispatchMarks;
			}));
		};
		if (ctx.imageData) {
			render(ctx.imageData);
		} else {
			void dispatchAttachmentBytes(this.fileService, ctx.attachment).then(bytes => {
				if (bytes && !store.isDisposed) {
					render(bytes);
				}
			});
		}
		return store;
	}

	private decorateRequest(ctx: IDispatchChatRequestContext): IDisposable | undefined {
		const pictures = ctx.variables
			.map(v => ({ entry: v, meta: v.kind === 'image' && !v._meta?.[POINT_TALK_FRAME_META] ? readDispatchMarksMeta(v) : undefined }))
			.filter((p): p is { entry: IChatRequestVariableEntry; meta: IDispatchMarksMetadata } => !!p.meta);
		if (!pictures.length) {
			return undefined;
		}
		const store = new DisposableStore();
		// the lines go into the bubble after the text (the request's .rendered-markdown is the bubble);
		// a bubble of their own, styled the same, when the message has no text
		const parts = ctx.container.querySelectorAll<HTMLElement>('.rendered-markdown');
		let bubble = parts.length ? parts[parts.length - 1] : undefined;
		let own: HTMLElement | undefined;
		if (!bubble) {
			own = dom.append(ctx.container, $('.rendered-markdown.dispatch-draw-bubble'));
			bubble = own;
		}
		const lines = dom.append(bubble, $('.dispatch-draw-bubble-lines'));
		pictures.forEach((p, i) => {
			if (pictures.length > 1) {
				dom.append(lines, $('.cap', undefined, localize('dispatchDraw.pictureN', "Picture {0}", i + 1)));
			}
			renderDispatchWhereLegend(lines, marksOf(p.meta));
		});
		store.add(toDisposable(() => {
			lines.remove();
			own?.remove();
		}));

		// a click on a sent picture's thumbnail opens its viewer under the message, again closes it
		const viewer = store.add(new MutableDisposable<DisposableStore>());
		const openFor = async (id: string) => {
			if (viewer.value && (viewer.value as DisposableStore & { dispatchId?: string }).dispatchId === id) {
				viewer.clear();
				return;
			}
			const p = pictures.find(x => x.entry.id === id);
			if (!p) {
				return;
			}
			const bytes = await dispatchAttachmentBytes(this.fileService, p.entry);
			if (!bytes) {
				return;
			}
			const vs = new DisposableStore() as DisposableStore & { dispatchId?: string };
			vs.dispatchId = id;
			const blob = dispatchBlobUrl(bytes);
			vs.add(blob);
			const holder = dom.append(ctx.container, $('.dispatch-draw-sent-viewer'));
			vs.add(toDisposable(() => holder.remove()));
			const where = vs.add(new DispatchWhereViewer(holder, { image: '', size: p.meta.size, scale: p.meta.scale, drawn: true, marks: marksOf(p.meta) }, blob.url, { side: 'auto' }));
			where.layout(true);
			viewer.value = vs;
			// once the row has grown: its bottom (the viewer) at the bottom of the chat
			const win = dom.getWindow(holder);
			win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
				if (viewer.value === vs) {
					ctx.reveal?.(1);
				}
			}));
		};
		store.add(dom.addDisposableListener(ctx.container, dom.EventType.CLICK, e => {
			const el = (e.target as HTMLElement).closest<HTMLElement>('.dispatch-draw-sent');
			const id = el?.dataset.dispatchMarks;
			if (id) {
				e.preventDefault();
				e.stopPropagation();
				void openFor(id);
			}
		}, true));
		return store;
	}
}

registerWorkbenchContribution2(DispatchDrawContribution.ID, DispatchDrawContribution, WorkbenchPhase.BlockRestore);

/** `_dispatch.draw.flush`: commit any open drawing (tests, and the composer before it sends). */
CommandsRegistry.registerCommand('_dispatch.draw.flush', async (_accessor: ServicesAccessor) => {
	await inputController?.flush();
});

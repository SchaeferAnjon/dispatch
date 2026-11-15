/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the quote card (kanban design/quote/redesign 方向 B, 实现清单 3 to 6; patches/
 *  315-quote.patch). One card in two places, the same family as the picture thumbnails of
 *  Draw and ask:
 *
 *  - in the chat input, in the attachment row above the text: 48 high, 280 at most, the quote's first
 *    line and under it where it came from (Claude · 4:20 AM, NOTES.md:9); × at the top right on hover;
 *  - above a sent bubble, right-aligned like the thumbnails, 360 at most, no ×.
 *
 *  On hover the words it came from light up in the conversation, and after the hover delay the whole
 *  quote shows in the shared hover card. A click goes back to where it came from.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchQuote.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event as BaseEvent } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IDispatchQuoteMeta, readDispatchQuoteMeta } from '../../../../platform/agentHost/common/meta/dispatchQuoteAttachmentMeta.js';
import { setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatAttachmentWidgetInstance } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentWidgetRegistry.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { DISPATCH_REVEAL_QUOTE_COMMAND, firstLine } from './dispatchQuote.js';
import { showQuoteSource } from './dispatchQuoteSource.js';

const $ = dom.$;

export class DispatchQuoteAttachmentWidget extends Disposable implements IChatAttachmentWidgetInstance {

	readonly element: HTMLElement;

	private readonly _onDidDelete = this._register(new Emitter<Event>());
	readonly onDidDelete = this._onDidDelete.event;

	private readonly _onDidOpen = this._register(new Emitter<void>());
	readonly onDidOpen = this._onDidOpen.event;

	private readonly _lit = this._register(new MutableDisposable());

	constructor(
		attachment: IChatRequestVariableEntry,
		options: { shouldFocusClearButton: boolean; supportsDeletion: boolean },
		container: HTMLElement,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly _commandService: ICommandService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
	) {
		super();
		const meta: IDispatchQuoteMeta = readDispatchQuoteMeta(attachment) ?? {
			v: 1,
			text: typeof attachment.value === 'string' ? attachment.value : attachment.name,
			source: { from: 'reply', label: '' },
		};
		const sent = !options.supportsDeletion;
		this.element = dom.append(container, $('.chat-attached-context-attachment.dispatch-quote'));
		this.element.classList.toggle('sent', sent);
		this.element.tabIndex = 0;
		this.element.role = 'button';

		const body = dom.append(this.element, $('.dispatch-quote-body'));
		dom.append(body, $('.dispatch-quote-text', undefined, firstLine(meta.text)));
		const src = dom.append(body, $('.dispatch-quote-src'));
		const icon = meta.source.icon ? ThemeIcon.fromId(meta.source.icon) : (meta.source.from === 'diff' ? Codicon.diffSingle : meta.source.from === 'file' ? Codicon.file : undefined);
		if (icon) {
			dom.append(src, $(ThemeIcon.asCSSSelector(icon)));
		}
		dom.append(src, $('span', undefined, meta.source.label));

		const aria = meta.source.label
			? localize('dispatchQuote.aria', "Quote from {0}: {1}", meta.source.label, meta.text)
			: localize('dispatchQuote.ariaNoSource', "Quote: {0}", meta.text);
		this.element.ariaLabel = options.supportsDeletion ? localize('dispatchQuote.ariaDelete', "{0} (Delete)", aria) : aria;

		if (options.supportsDeletion) {
			const clear = this._register(new Button(this.element, { supportIcons: true, title: localize('dispatchQuote.remove', "Remove quote") }));
			clear.element.tabIndex = -1;
			clear.element.classList.add('dispatch-quote-rm');
			clear.icon = Codicon.closeCompact;
			this._register(BaseEvent.once(clear.onDidClick)(e => this._onDidDelete.fire(e)));
			this._register(dom.addStandardDisposableListener(this.element, dom.EventType.KEY_DOWN, e => {
				if (e.keyCode === KeyCode.Backspace || e.keyCode === KeyCode.Delete) {
					e.preventDefault();
					e.stopPropagation();
					this._onDidDelete.fire(e.browserEvent);
				}
			}));
		}

		// the whole quote in the shared hover card, above the card
		this._register(setupDispatchTextHover(hoverService, this.element, () => ({ text: meta.text, notes: meta.source.label ? [meta.source.label] : [] }), {
			when: () => true,
			position: HoverPosition.ABOVE,
		}));

		// the words it came from light up while the pointer is on the card
		if (meta.source.from === 'reply' && meta.source.chat) {
			const chat = URI.parse(meta.source.chat);
			this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_ENTER, () => {
				const widget = this._chatWidgetService.getWidgetBySessionResource(chat);
				this._lit.value = widget ? showQuoteSource(widget, meta.source.responseId, meta.text) : undefined;
			}));
			this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_LEAVE, () => this._lit.clear()));
		}

		const open = () => {
			this._lit.clear();
			void this._commandService.executeCommand(DISPATCH_REVEAL_QUOTE_COMMAND, meta);
			this._onDidOpen.fire();
		};
		this._register(dom.addDisposableListener(this.element, dom.EventType.CLICK, e => {
			if ((e.target as HTMLElement | null)?.closest('.dispatch-quote-rm')) {
				return;
			}
			e.preventDefault();
			open();
		}));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, e => {
			const ev = new StandardKeyboardEvent(e);
			if (ev.equals(KeyCode.Enter) || ev.equals(KeyCode.Space)) {
				ev.preventDefault();
				open();
			}
		}));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the two message boxes Point and talk records into (task-3w0lf), seen as one: a session's chat input
 *  (a chat widget, the camera is in its ChatExecute menu) and the new-session composer (NewChatInputWidget, a
 *  hand-built tool row with no ChatExecute menu, so the camera is a toolbar of its own menu here). The controller in
 *  ../electron-browser records, reviews and sends through this interface only, so both boxes behave the same.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IChatWidget } from '../../../../workbench/contrib/chat/browser/chat.js';
import type { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';

/** The review key of the new-session composer: it has no session yet, and there is one such box in sight. */
export const POINT_TALK_NEW_SESSION = 'dispatch:new-session';

/** The new-session composer's tool row: the camera (the same action as in ChatExecute, the same tooltip and ⌃⇧S). */
export const DispatchPointTalkNewSessionMenu = new MenuId('DispatchPointTalkNewSession');

export interface IPointTalkBox {
	readonly isPointTalkBox: true;
	/** Which review it shows: the session's resource, or {@link POINT_TALK_NEW_SESSION}. */
	key(): string | undefined;
	/** The box: the slot goes in first, it gets the recording and review classes. */
	box(): HTMLElement | undefined;
	/** The row of attachments (the draw tool opens over it). */
	attachRow(): HTMLElement | undefined;
	/** Where the card for what is missing goes (first child, right above the box). */
	cardHost(): HTMLElement;
	/** In the window and on screen. */
	shown(): boolean;
	getInput(): string;
	setInput(text: string): void;
	readonly attachments: readonly IChatRequestVariableEntry[];
	addAttachments(entries: IChatRequestVariableEntry[]): void;
	deleteAttachments(ids: string[]): void;
	replaceAttachment(oldId: string, entry: IChatRequestVariableEntry): void;
	readonly onDidChangeAttachments: Event<void>;
	/** The box shows another session (a chat widget's view model changed). */
	readonly onDidChangeKey: Event<void>;
	/** What is in the box was sent. */
	readonly onDidSend: Event<void>;
	send(): void;
	focusInput(): void;
}

export function isPointTalkBox(x: unknown): x is IPointTalkBox {
	return !!x && typeof x === 'object' && (x as Partial<IPointTalkBox>).isPointTalkBox === true;
}

function onScreen(e: HTMLElement | undefined): boolean {
	return !!e?.isConnected && e.getClientRects().length > 0;
}

// ---------------------------------------------------------------- a session's chat input

const chatBoxes = new WeakMap<IChatWidget, IPointTalkBox>();

/** The same object for the same widget (the controller compares boxes). */
export function pointTalkChatBox(widget: IChatWidget): IPointTalkBox {
	let b = chatBoxes.get(widget);
	if (!b) {
		const box = () => widget.input.element.querySelector<HTMLElement>('.chat-input-container') ?? undefined;
		b = {
			isPointTalkBox: true,
			key: () => widget.viewModel?.sessionResource.toString(),
			box,
			attachRow: () => box()?.querySelector<HTMLElement>('.chat-attachments-container') ?? undefined,
			cardHost: () => widget.input.element,
			shown: () => !!widget.input?.element?.isConnected,
			getInput: () => widget.getInput(),
			setInput: text => widget.setInput(text),
			get attachments() { return widget.attachmentModel.attachments; },
			addAttachments: entries => widget.attachmentModel.addContext(...entries),
			deleteAttachments: ids => widget.attachmentModel.delete(...ids),
			replaceAttachment: (oldId, entry) => widget.attachmentModel.updateContext([oldId], [entry]),
			onDidChangeAttachments: Event.map(widget.attachmentModel.onDidChange, () => undefined),
			onDidChangeKey: Event.map(widget.onDidChangeViewModel, () => undefined),
			onDidSend: Event.map(widget.onDidAcceptInput, () => undefined),
			send: () => void widget.acceptInput(),
			focusInput: () => widget.focusInput?.(),
		};
		chatBoxes.set(widget, b);
	}
	return b;
}

/** Whether the widget's box is on screen (the keyboard's ⌃⇧S goes to a box in sight). */
export function chatBoxOnScreen(widget: IChatWidget): boolean {
	return onScreen(pointTalkChatBox(widget).box());
}

// ---------------------------------------------------------------- the new-session composer

/** What NewChatInputWidget hands over (newChatInput.ts, the one hook in its tool row). */
export interface IDispatchPointTalkComposer {
	/** `.new-chat-input-area`, the box. */
	readonly area: HTMLElement;
	readonly attachments: {
		readonly attachments: readonly IChatRequestVariableEntry[];
		readonly onDidChangeContext: Event<void>;
		setAttachments(entries: readonly IChatRequestVariableEntry[]): void;
		addAttachments(...entries: IChatRequestVariableEntry[]): void;
	};
	getText(): string;
	setText(text: string): void;
	submit(): Promise<boolean>;
	focus(): void;
}

/** The composer's side of the hook: it says when a message went. */
export interface IDispatchPointTalkComposerHandle extends IDisposable {
	sent(): void;
}

class NewSessionBox implements IPointTalkBox {

	readonly isPointTalkBox = true;
	readonly onDidSend: Event<void> = Event.map(Event.filter(onDidSendComposer.event, b => b === this), () => undefined);
	readonly onDidChangeKey = Event.None;
	readonly onDidChangeAttachments: Event<void>;

	constructor(private readonly composer: IDispatchPointTalkComposer) {
		this.onDidChangeAttachments = composer.attachments.onDidChangeContext;
	}

	key(): string { return POINT_TALK_NEW_SESSION; }
	box(): HTMLElement { return this.composer.area; }
	attachRow(): HTMLElement | undefined { return this.composer.area.querySelector<HTMLElement>('.sessions-chat-attach-row') ?? undefined; }
	/** The stack round the box (its notices, its tip): the card goes on top of it, as above a session's input part. */
	cardHost(): HTMLElement { return this.composer.area.closest<HTMLElement>('.new-chat-input-container') ?? this.composer.area.parentElement!; }
	shown(): boolean { return onScreen(this.composer.area); }
	getInput(): string { return this.composer.getText(); }
	setInput(text: string): void { this.composer.setText(text); }
	get attachments(): readonly IChatRequestVariableEntry[] { return this.composer.attachments.attachments; }
	addAttachments(entries: IChatRequestVariableEntry[]): void { this.composer.attachments.addAttachments(...entries); }
	deleteAttachments(ids: string[]): void {
		const gone = new Set(ids);
		this.composer.attachments.setAttachments(this.attachments.filter(a => !gone.has(a.id)));
	}
	replaceAttachment(oldId: string, entry: IChatRequestVariableEntry): void {
		this.composer.attachments.setAttachments(this.attachments.map(a => a.id === oldId ? entry : a));
	}
	send(): void { void this.composer.submit(); }
	focusInput(): void { this.composer.focus(); }
}

const composers: NewSessionBox[] = [];
const onDidAddComposer = new Emitter<IPointTalkBox>();
const onDidRemoveComposer = new Emitter<IPointTalkBox>();
/** Fired by the composer after a send went, even when sending took the composer down already (the page moved on). */
const onDidSendComposer = new Emitter<IPointTalkBox>();
/** A new-session composer was drawn / taken down / sent what it had. */
export const onDidAddPointTalkComposer = onDidAddComposer.event;
export const onDidRemovePointTalkComposer = onDidRemoveComposer.event;
export const onDidSendPointTalkComposer = onDidSendComposer.event;

/** The new-session composers drawn now, newest last. */
export function pointTalkComposers(): readonly IPointTalkBox[] {
	return composers;
}

/**
 * The hook in NewChatInputWidget's tool row: the camera right before the send button, and the box registered for the
 * controller. `instantiationService` is the composer's (its context keys).
 */
export function renderDispatchPointTalkComposer(instantiationService: IInstantiationService, toolbar: HTMLElement, composer: IDispatchPointTalkComposer): IDispatchPointTalkComposerHandle {
	const box = new NewSessionBox(composer);
	const container = toolbar.ownerDocument.createElement('div');
	container.className = 'dispatch-pt-camera';
	toolbar.appendChild(container);
	const menu = instantiationService.createInstance(MenuWorkbenchToolBar, container, DispatchPointTalkNewSessionMenu, {
		hiddenItemStrategy: HiddenItemStrategy.NoHide,
		menuOptions: { arg: box, shouldForwardArgs: false },
	});
	composers.push(box);
	onDidAddComposer.fire(box);
	let gone = false;
	return {
		sent: () => onDidSendComposer.fire(box),
		dispose: () => {
			if (gone) {
				return;
			}
			gone = true;
			menu.dispose();
			container.remove();
			composers.splice(composers.indexOf(box), 1);
			onDidRemoveComposer.fire(box);
		},
	};
}

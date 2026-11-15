/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the same terminal session read as a chat (kanban design/terminal-merge, direction A, A4).
 *
 *  "Chat / Terminal" at the top of a terminal session switches between the terminal and this view; the agent
 *  keeps running, nothing restarts. The chat is read from the agent's own record of the conversation on disk
 *  (Claude Code: ~/.claude/projects/<folder>/<id>.jsonl, with the id Dispatch gave it), not guessed from the
 *  screen, and refreshes while it is shown. The box at the bottom types what is written into the terminal and
 *  presses Enter for it. Agents whose record Dispatch cannot read yet keep "Chat" greyed, with the reason.
 *
 *  A sub-agent the session sent out (opened from its row under the session in the list, direction A, A3) is read
 *  here too, from its own record, read only: what it does is told to the session that sent it.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { claudeTranscriptPath, IChatLine, parseClaudeTranscript } from './dispatchTerminalModel.js';
import { DispatchTerminalSession } from './dispatchTerminalSessionsProvider.js';

const REFRESH_MS = 1500;

/** Why "Chat" is not offered for this terminal, or undefined when it is. */
export function chatUnavailableReason(session: DispatchTerminalSession): string | undefined {
	if (!session.agent) {
		return 'A plain terminal has no conversation to show as a chat.';
	}
	if (session.agent.id !== 'claude') {
		return `Dispatch can show the conversation as a chat for Claude Code for now. ${session.agent.name} stays in the terminal.`;
	}
	if (!session.controller.info.agentSession) {
		return 'This Claude Code was not started by Dispatch, so Dispatch does not know which conversation it is.';
	}
	return undefined;
}

export class DispatchTerminalChat extends Disposable {
	readonly element: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _input: HTMLTextAreaElement;
	private readonly _rendered = this._register(new DisposableStore());
	private _timer: number | undefined;
	private _lastSize = -1;
	private _visible = false;
	private readonly _head: HTMLElement;
	private readonly _headStore = this._register(new DisposableStore());
	private readonly _composer: HTMLElement;
	/** A sub-agent's record shown instead of the session's conversation (read only). */
	private _record: { readonly file: string; readonly title: string; readonly detail: string } | undefined;
	private readonly _onDidRequestBack = this._register(new Emitter<void>());
	/** "Back to the session" over a sub-agent's record. */
	readonly onDidRequestBack = this._onDidRequestBack.event;

	constructor(
		private readonly _session: DispatchTerminalSession,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
	) {
		super();
		this.element = DOM.$('.dispatch-terminal-chat');
		this._head = DOM.append(this.element, DOM.$('.dtc-record-head'));
		this._head.style.display = 'none';
		this._list = DOM.append(this.element, DOM.$('.dtc-list'));
		const composer = this._composer = DOM.append(this.element, DOM.$('.dtc-composer'));
		this._input = DOM.append(composer, DOM.$<HTMLTextAreaElement>('textarea.dtc-input'));
		this._input.placeholder = 'Reply. Dispatch types it into the terminal.';
		this._input.rows = 2;
		DOM.append(composer, DOM.$('.dtc-where')).textContent = `Running in a terminal · ${_session.agent?.name ?? 'Terminal'}`;
		this._register(DOM.addDisposableListener(this._input, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this._send();
			}
		}));
		this._register({ dispose: () => this._stop() });
	}

	private _send(): void {
		const text = this._input.value.trim();
		if (!text) {
			return;
		}
		this._input.value = '';
		this._session.controller.paste(text);
		// Enter a moment later, so the agent has taken the pasted text in as one block
		mainWindow.setTimeout(() => this._session.controller.write('\r'), 120);
		mainWindow.setTimeout(() => void this._refresh(), 800);
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		this.element.style.display = visible ? '' : 'none';
		if (visible) {
			void this._refresh();
			this._timer ??= mainWindow.setInterval(() => void this._refresh(), REFRESH_MS);
			if (!this._record) {
				this._input.focus();
			}
		} else {
			this._stop();
		}
	}

	private _stop(): void {
		if (this._timer !== undefined) {
			mainWindow.clearInterval(this._timer);
			this._timer = undefined;
		}
	}

	/** Shows a sub-agent's own record, read only, or the session's conversation again (undefined). */
	showRecord(record: { readonly file: string; readonly title: string; readonly detail: string } | undefined): void {
		if (record?.file === this._record?.file && record?.detail === this._record?.detail) {
			return;
		}
		this._record = record;
		this._lastSize = -1;
		this._composer.style.display = record ? 'none' : '';
		this._head.style.display = record ? '' : 'none';
		DOM.clearNode(this._head);
		this._headStore.clear();
		if (record) {
			const text = DOM.append(this._head, DOM.$('.dtc-record-text'));
			DOM.append(text, DOM.$('span.dtc-record-title')).textContent = record.title;
			DOM.append(text, DOM.$('span.dtc-record-detail')).textContent = record.detail;
			const back = DOM.append(this._head, DOM.$<HTMLButtonElement>('button.dtc-record-back', { type: 'button' }));
			back.textContent = 'Back to the session';
			this._headStore.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => this._onDidRequestBack.fire()));
		}
		void this._refresh();
	}

	private _file(): URI | undefined {
		if (this._record) {
			return URI.file(this._record.file);
		}
		const id = this._session.controller.info.agentSession;
		if (!id) {
			return undefined;
		}
		const home = this._paths.userHome({ preferLocal: true }).fsPath;
		return URI.file(claudeTranscriptPath(home, this._session.folder.fsPath, id));
	}

	private async _refresh(): Promise<void> {
		const file = this._file();
		if (!file || !this._visible) {
			return;
		}
		let lines: IChatLine[] = [];
		try {
			const stat = await this._files.stat(file);
			if (stat.size === this._lastSize) {
				return;
			}
			this._lastSize = stat.size ?? -1;
			lines = parseClaudeTranscript((await this._files.readFile(file)).value.toString(), { sidechain: !!this._record });
		} catch {
			this._lastSize = -1;
			this._draw([], this._record ? 'Its record shows here once Claude Code has written it.' : 'The conversation shows here once Claude Code has written its first message.');
			return;
		}
		this._draw(lines);
	}

	private _draw(lines: readonly IChatLine[], empty?: string): void {
		const atBottom = this._list.scrollHeight - this._list.scrollTop - this._list.clientHeight < 40;
		this._rendered.clear();
		DOM.clearNode(this._list);
		if (!lines.length) {
			DOM.append(this._list, DOM.$('.dtc-empty')).textContent = empty ?? 'No messages yet.';
			return;
		}
		for (const line of lines) {
			const row = DOM.append(this._list, DOM.$(`.dtc-line.${line.role}`));
			if (line.role === 'tool') {
				row.textContent = line.text;
				continue;
			}
			const md = this._rendered.add(renderMarkdown(new MarkdownString(line.text, { supportThemeIcons: false })));
			row.appendChild(md.element);
		}
		if (atBottom) {
			this._list.scrollTop = this._list.scrollHeight;
		}
	}
}

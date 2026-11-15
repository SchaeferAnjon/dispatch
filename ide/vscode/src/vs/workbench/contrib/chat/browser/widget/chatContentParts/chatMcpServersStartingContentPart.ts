/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { IRenderedMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { createPixelSpinner, IPixelSpinner } from '../../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IChatMcpServersStartingSlow, IChatMcpStartingServer } from '../../../common/chatService/chatService.js';
import { ChatTreeItem } from '../../chat.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { IChatContentPart } from './chatContentParts.js';
import './media/chatMcpServersInteractionContent.css';
import './media/dispatchSessionLiveness.css';

/** Dispatch: the agent host gives a server this long (MCP_TIMEOUT for Claude, startup_timeout_sec for Codex). */
const GIVE_UP_AFTER_SECONDS = 20;
const OPEN_CUSTOMIZATIONS_COMMAND = 'aiCustomization.openManagementEditor';

/** "[Turn it off in MCP Servers](command:…)", opening Customizations on its MCP Servers page. */
function mcpServersLink(): string {
	const args = encodeURIComponent(JSON.stringify('mcpServers'));
	return `[${localize('dispatch.mcp.serversPage', "MCP Servers")}](command:${OPEN_CUSTOMIZATIONS_COMMAND}?${args})`;
}

/** "playwright", "playwright and harbor", "a, b and c": names as plain text. */
function serverNames(servers: readonly IChatMcpStartingServer[]): string {
	const names = servers.map(server => escapeMarkdownSyntaxTokens(server.name));
	return names.length > 1 ? localize('dispatch.mcp.andList', "{0} and {1}", names.slice(0, -1).join(', '), names[names.length - 1]) : names[0] ?? '';
}

/** "12 s" under a minute, then "4 min". */
export function formatWaited(seconds: number): string {
	return seconds < 60 ? localize('dispatch.waited.seconds', "{0} s", seconds) : localize('dispatch.waited.minutes', "{0} min", Math.floor(seconds / 60));
}

/**
 * Renders a lightweight "Starting MCP servers …" progress hint for agent-host
 * sessions. The set of servers still starting is driven by the observable on
 * {@link IChatMcpServersStartingSlow.servers}; when it empties (all servers
 * started, content began arriving, or the turn ended) the part hides itself.
 * There is no interactive affordance — this is a progress indicator only.
 */
export class ChatMcpServersStartingContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private readonly rendered = this._register(new MutableDisposable<IRenderedMarkdown>());
	private readonly spinner = this._register(new MutableDisposable<IPixelSpinner>());
	private hadStartingServers = false;
	private didNotifyFinished = false;

	/** Dispatch: servers seen starting in this turn, so a later failure of one of them is told. */
	private readonly seenStarting = new Map<string, string>();
	private readonly ticker = this._register(new MutableDisposable());
	private startedAt: number;

	constructor(
		private readonly data: IChatMcpServersStartingSlow,
		private readonly options: {
			readonly createSpinner?: typeof createPixelSpinner;
			readonly showSpinner?: boolean;
			readonly onDidFinishStarting?: () => void;
		} | undefined,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
	) {
		super();
		this.domNode = dom.$('.chat-mcp-servers-interaction');
		this.startedAt = this.data.startedAt ?? Date.now();
		this._register(autorun(reader => {
			this.data.newlyFailed?.read(reader);
			this.render(this.data.servers.read(reader), this.data.failed?.read(reader) ?? []);
		}));
	}

	private render(allServers: readonly IChatMcpStartingServer[], failed: readonly IChatMcpStartingServer[]): void {
		// Dispatch: a declared server only assumed to be starting (the agent has not said) is not
		// what holds the turn once the agent would have given up on it anyway
		const elapsed = (Date.now() - this.startedAt) / 1000;
		const servers = elapsed > GIVE_UP_AFTER_SECONDS + 5 ? allServers.filter(s => !s.assumed) : allServers;
		dom.clearNode(this.domNode);
		this.rendered.clear();
		this.spinner.clear();

		if (!servers.length) {
			this.ticker.clear();
			// Dispatch: one that was starting here and then gave up stays as a line with a way out.
			const newly = this.data.newlyFailed?.get() ?? [];
			const gaveUp = failed.filter(f => this.seenStarting.has(f.id) || [...this.seenStarting.values()].includes(f.name) || newly.some(n => n.id === f.id));
			if (gaveUp.length) {
				this.domNode.style.display = '';
				this._renderMessage(gaveUp.length > 1
					? localize('dispatch.mcp.gaveUpMany', "MCP servers {0} did not start; this session goes on without them. Turn them off in {1}", serverNames(gaveUp), mcpServersLink())
					: localize('dispatch.mcp.gaveUp', "MCP server {0} did not start; this session goes on without it. Turn it off in {1}", serverNames(gaveUp), mcpServersLink()), false);
			} else {
				this.domNode.style.display = 'none';
			}
			if (this.hadStartingServers && !this.didNotifyFinished) {
				this.didNotifyFinished = true;
				this.options?.onDidFinishStarting?.();
			}
			return;
		}
		this.hadStartingServers = true;
		this.domNode.style.display = '';
		for (const server of servers) {
			this.seenStarting.set(server.id, server.name);
		}

		// Dispatch: say how long it has been waiting, and after the time the agent gives a server, where to turn it off.
		const seconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
		const many = servers.length > 1;
		const message = seconds >= GIVE_UP_AFTER_SECONDS
			? (many
				? localize('dispatch.mcp.stillStartingMany', "MCP servers {0} are still starting · {1}. Turn them off in {2}", serverNames(servers), formatWaited(seconds), mcpServersLink())
				: localize('dispatch.mcp.stillStarting', "MCP server {0} is still starting · {1}. Turn it off in {2}", serverNames(servers), formatWaited(seconds), mcpServersLink()))
			: (many
				? localize('dispatch.mcp.startingMany', "Starting MCP servers {0} · {1}", serverNames(servers), formatWaited(seconds))
				: localize('dispatch.mcp.startingOne', "Starting MCP server {0} · {1}", serverNames(servers), formatWaited(seconds)));
		this._renderMessage(message);
		if (!this.ticker.value) {
			const handle = setInterval(() => this.render(this.data.servers.get(), this.data.failed?.get() ?? []), 1000);
			this.ticker.value = { dispose: () => clearInterval(handle) };
		}
	}

	private _renderMessage(content: string, spinner = true): void {
		const container = dom.$('.chat-mcp-servers-interaction-hint');
		const messageContainer = dom.$('.chat-mcp-servers-message');
		if (spinner && this.options?.showSpinner !== false) {
			const iconElement = dom.$('.chat-mcp-servers-icon');
			this.spinner.value = (this.options?.createSpinner ?? createPixelSpinner)(iconElement);
			messageContainer.appendChild(iconElement);
		}

		const rendered = this.rendered.value = this.markdownRendererService.render(new MarkdownString(content, { isTrusted: { enabledCommands: [OPEN_CUSTOMIZATIONS_COMMAND] } }));
		messageContainer.appendChild(rendered.element);
		container.appendChild(messageContainer);
		this.domNode.appendChild(container);
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		return other.kind === 'mcpServersStartingSlow';
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}

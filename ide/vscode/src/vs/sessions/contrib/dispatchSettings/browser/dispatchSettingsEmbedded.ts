/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the abilities (what was Customizations: Skills, MCP servers, Plugins, Hooks, Instructions,
 *  Sub-agents, Knowledge, What Dispatch changed) and each agent's own page, inside the Settings page. They are
 *  the customizations editor itself, created here with an input of its own instead of in a modal editor, its
 *  list of sections hidden: the Settings contents in the side bar are the one list.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagement.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AICustomizationManagementEditor } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditor.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { abilitySection, AGENT_PAGES, AbilityId, backToPageStart, harnessForAgent, isAgentPage, pageForSection, SettingsPageId } from './dispatchSettingsModel.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export class EmbeddedCustomizations extends Disposable {

	readonly element: HTMLElement;
	private pane: AICustomizationManagementEditor | undefined;
	private readonly input: AICustomizationManagementEditorInput;
	private size: DOM.Dimension | undefined;
	private harnessMoved = false;

	/** The editor went to another section by itself (a card on its overview, a link inside a page). */
	private readonly _onDidMove = this._register(new Emitter<SettingsPageId>());
	readonly onDidMove: Event<SettingsPageId> = this._onDidMove.event;
	private showing: SettingsPageId | undefined;

	constructor(
		parent: HTMLElement,
		private readonly close: () => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.element = DOM.append(parent, DOM.$('.dset-embed'));
		this.element.hidden = true;
		this.input = this._register(new AICustomizationManagementEditorInput());
		const keys = new Set([CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION.key]);
		this._register(contextKeyService.onDidChangeContext(e => {
			if (!this.pane || this.element.hidden || this.showing === undefined || !e.affectsSome(keys)) {
				return;
			}
			const section = this.pane.dispatchSelectedSection;
			// the What Dispatch changed page has no section of its own: staying there is not a move
			if (!section && (this.showing === 'changes' || this.showing === 'findskills')) {
				return;
			}
			const page = section ? pageForSection(section, this.harnessService.activeHarness.get()) : 'findskills';
			if (page !== this.showing) {
				this.showing = page;
				this._onDidMove.fire(page);
			}
		}));
	}

	private making: Promise<AICustomizationManagementEditor> | undefined;

	/** The editor, made once (a page shown while it is being made ahead waits for the same one). */
	private ensure(): Promise<AICustomizationManagementEditor> {
		return this.making ??= this.make();
	}

	private async make(): Promise<AICustomizationManagementEditor> {
		// The editor asks its group to close it (an AI-guided "New", the overview's close): here that closes Settings.
		const group = {
			id: -1,
			windowId: mainWindow.vscodeWindowId,
			closeEditor: async () => { this.close(); return true; },
		} as unknown as IEditorGroup;
		const pane = this.pane = this.instantiationService.createInstance(AICustomizationManagementEditor, group);
		pane.create(this.element);
		pane.setSectionListHidden(true);
		pane.setVisible(true);
		await pane.setInput(this.input, undefined, {}, CancellationToken.None);
		this.relayout();
		return pane;
	}

	/** Made ahead, hidden, once Settings is open and the window is idle: the first ability clicked then only switches
	 *  section, and its list was already read (Skills drew "Loading customizations..." on its first visit,
	 *  design/settings-fast). */
	prepare(): void {
		void this.ensure();
	}

	/** Shows an ability or an agent's page. */
	async show(page: SettingsPageId): Promise<void> {
		this.element.hidden = false;
		// the side bar's row for the page already on screen: back to that page's start (Knowledge's home)
		const restart = backToPageStart(this.showing, page);
		this.showing = undefined;
		if (isAgentPage(page)) {
			const engine = AGENT_PAGES.find(a => a.id === page)?.engine ?? 'claude';
			this.harnessService.setActiveSession(this.harnessService.getSessionResourceForHarness(harnessForAgent(engine)));
			this.harnessMoved = true;
		} else {
			this.restoreHarness();
		}
		const pane = await this.ensure();
		if (this._store.isDisposed) {
			return;
		}
		if (isAgentPage(page)) {
			pane.selectSectionById(AICustomizationManagementSection.HarnessSettings);
		} else if (page === 'findskills') {
			pane.showWelcomePage();
		} else if (page === 'changes') {
			pane.showCustomizationMigrationDashboard();
		} else {
			const section = abilitySection(page as AbilityId);
			if (section) {
				pane.selectSectionById(section as AICustomizationManagementSection);
			}
			if (restart && page === 'knowledge') {
				void this.commandService.executeCommand('_dispatch.knowledgeHome');
			}
		}
		this.showing = page;
		this.relayout();
		// once the section drew its rows
		DOM.getWindow(this.element).requestAnimationFrame(() => this.relayout());
	}

	hide(): void {
		this.element.hidden = true;
		this.showing = undefined;
		this.restoreHarness();
	}

	layout(width: number, height: number): void {
		this.size = new DOM.Dimension(Math.max(0, width - 4), Math.max(0, height - 8));
		this.relayout();
	}

	focus(): void {
		this.pane?.focus();
	}

	private relayout(): void {
		if (this.pane && this.size && !this.element.hidden) {
			this.element.style.height = `${this.size.height}px`;
			this.pane.layout(this.size);
		}
	}

	/** An agent's page switched the editor to that agent: back to the agent of the session in use. */
	private restoreHarness(): void {
		if (!this.harnessMoved) {
			return;
		}
		this.harnessMoved = false;
		const session = this.sessionsService.activeSession.get();
		if (session) {
			this.harnessService.setActiveSession(session.resource);
		}
	}

	override dispose(): void {
		this.restoreHarness();
		if (this.pane) {
			this.pane.clearInput();
			this.pane.dispose();
			this.pane = undefined;
		}
		this.element.remove();
		super.dispose();
	}
}

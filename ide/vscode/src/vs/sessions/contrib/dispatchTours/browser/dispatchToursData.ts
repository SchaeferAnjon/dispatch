/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the tips and the Getting started checklist, as data. Plain words (kanban design/orca-study
 *  「说人话的规则」): what it is and what it does for you, in one or two sentences, no jargon.
 *
 *  A tour is for the first time a person reaches a place, so the text answers the question they have right
 *  then: what is this and what do I do with it. Anchors are CSS selectors on the Agents window; a step
 *  whose element is not there (a tab the person closed) is left out.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IDispatchTour, IDispatchTourStep } from './dispatchToursModel.js';

export const CHECKLIST_ENTRY = '.dispatch-checklist-entry';

export const DISPATCH_TOURS: readonly IDispatchTour[] = [
	{
		// the first-run setup ends on a new chat's page, with the first suggestions as cards (dispatchFirstPrompts.ts)
		id: 'first-prompt',
		order: 0,
		place: { selector: '.new-session-prompt-option', text: 'Check my projects' },
		steps: [
			{
				id: 'first-prompt-card',
				anchor: { selector: '.new-session-prompt-option', text: 'Check my projects' },
				placement: 'top',
				advanceOnClick: true,
				title: localize('dispatchTours.firstPrompt.title', "Start here"),
				body: localize('dispatchTours.firstPrompt.body', "Ask what is unfinished in your projects. Click this card and the question is written for you."),
			},
		],
	},
	{
		// after the first-run setup: where the things that are easy to miss are
		id: 'welcome',
		order: 1,
		place: { selector: '.dispatch-waiting-section' },
		steps: [
			{
				id: 'waiting-row',
				anchor: { selector: '.dispatch-waiting-section' },
				placement: 'right',
				advanceOnClick: true,
				title: localize('dispatchTours.waitingRow.title', "Waiting for you"),
				body: localize('dispatchTours.waitingRow.body', "When an agent stops to ask you something, it shows up right under here, so you never have to watch a session. Click one to answer it."),
			},
			{
				id: 'checklist',
				anchor: { selector: CHECKLIST_ENTRY },
				placement: 'top', // the entry is in the status bar at the window's foot
				title: localize('dispatchTours.checklist.title', "Getting started"),
				body: localize('dispatchTours.checklist.body', "A short list of things worth trying. Each one ticks itself when you do it, and you can hide the list any time."),
			},
		],
	},
	{
		id: 'new-session',
		order: 2,
		place: { selector: '.new-chat-input-area' },
		steps: [
			{
				id: 'new-workspace',
				anchor: { selector: '.new-session-workspace-picker-container' },
				placement: 'right',
				title: localize('dispatchTours.newWorkspace.title', "Pick the folder to work in"),
				body: localize('dispatchTours.newWorkspace.body', "The agent works on the files in this folder. Choose a project you added, or any folder on your Mac."),
			},
			{
				id: 'new-input',
				anchor: { selector: '.new-chat-input-area' },
				placement: 'top',
				title: localize('dispatchTours.newInput.title', "Say what you want"),
				body: localize('dispatchTours.newInput.body', "Write it the way you would tell a colleague. Press Enter to send. You can paste a screenshot or drag in a file."),
			},
			{
				id: 'new-control',
				anchor: { selector: '.new-chat-bottom-container' },
				placement: 'top',
				title: localize('dispatchTours.newControl.title', "Stay in control"),
				body: localize('dispatchTours.newControl.body', "The switch on the left decides how much the agent may do without asking you. What is on the right depends on the page: in a project, a separate copy keeps your own files as they are; in a new chat, Turbo splits one message into parts that run at the same time."),
			},
			{
				id: 'new-side-panel',
				anchor: { selector: '.titlebar-session-actions-container .action-label', aria: 'Toggle Side Panel' },
				placement: 'bottom',
				advanceOnClick: true,
				title: localize('dispatchTours.newSidePanel.title', "Watch it work"),
				body: localize('dispatchTours.newSidePanel.body', "Open the side panel to see what the agent changes, plans and delivers while it works."),
			},
		],
	},
	{
		id: 'side-pane',
		order: 3,
		place: { selector: '.tabs-container .tab' },
		steps: [
			{
				id: 'changes-tab',
				anchor: { selector: '.tabs-container .tab', aria: 'Changes' },
				placement: 'bottom',
				advanceOnClick: true,
				title: localize('dispatchTours.changesTab.title', "Changes"),
				body: localize('dispatchTours.changesTab.body', "Every file the agent edits shows up here. Click one to see exactly what changed."),
			},
			{
				id: 'tasks-tab',
				anchor: { selector: '.tabs-container .tab', aria: 'Tasks' },
				placement: 'bottom',
				advanceOnClick: true,
				title: localize('dispatchTours.tasksTab.title', "Tasks"),
				body: localize('dispatchTours.tasksTab.body', "The plan the agent made, how far it got, and what it handed in."),
			},
			{
				id: 'docs-tab',
				anchor: { selector: '.tabs-container .tab', aria: 'Docs' },
				placement: 'bottom',
				advanceOnClick: true,
				title: localize('dispatchTours.docsTab.title', "Docs"),
				body: localize('dispatchTours.docsTab.body', "Pages the agent made for you to read: reports, designs, prototypes. They open right here."),
			},
			{
				id: 'add-tab',
				anchor: { selector: '.tabs-bar-add-tab' },
				placement: 'bottom',
				title: localize('dispatchTours.addTab.title', "More tabs"),
				body: localize('dispatchTours.addTab.body', "Add a file browser, a web page or a search next to these."),
			},
		],
	},
	{
		id: 'changes',
		order: 4,
		place: { selector: '.changes-view-body .chat-editing-session-container, .changes-view-body .changes-welcome' },
		steps: [
			{
				id: 'changes-list',
				anchor: { selector: '.changes-view-body .chat-editing-session-container, .changes-view-body .changes-welcome' },
				placement: 'left',
				title: localize('dispatchTours.changesList.title', "Everything the agent changed"),
				body: localize('dispatchTours.changesList.body', "Click a file to see the old and the new version side by side, line by line."),
			},
		],
	},
	{
		id: 'tasks',
		order: 5,
		place: { selector: '.dispatch-tasks-scope' },
		steps: [
			{
				id: 'tasks-scope',
				anchor: { selector: '.dispatch-tasks-scope' },
				placement: 'left',
				title: localize('dispatchTours.tasksScope.title', "This session or the whole project"),
				body: localize('dispatchTours.tasksScope.body', "\"This session\" is the plan the agent made in this conversation. \"Project\" lists every task in the project, so you can see what is done and what is next."),
			},
			{
				id: 'tasks-graph',
				anchor: { selector: '.dispatch-tasks-graph' },
				placement: 'left',
				title: localize('dispatchTours.tasksGraph.title', "Graph"),
				body: localize('dispatchTours.tasksGraph.body', "Draws the tasks as a map, so you can see which one leads to which."),
			},
		],
	},
	{
		id: 'waiting',
		order: 6,
		place: { selector: '.dispatch-waiting-page' },
		steps: [
			{
				id: 'waiting-summary',
				anchor: { selector: '.dispatch-waiting-intro' },
				placement: 'bottom',
				title: localize('dispatchTours.waitingSummary.title', "Everything that needs you"),
				body: localize('dispatchTours.waitingSummary.body', "Approvals, questions and things only you can do, from every project, the newest first. What you have not touched for a week waits under Older."),
			},
			{
				id: 'waiting-keys',
				anchor: { selector: '.dispatch-waiting-keys' },
				placement: 'top',
				title: localize('dispatchTours.waitingKeys.title', "Quick keys"),
				body: localize('dispatchTours.waitingKeys.body', "Move with J and K, press A to allow, D to deny, O to open the session."),
			},
		],
	},
	{
		id: 'docs',
		order: 7,
		place: { selector: '.dispatch-docs-list' },
		steps: [
			{
				id: 'docs-list',
				anchor: { selector: '.dispatch-docs-scope' },
				placement: 'bottom',
				title: localize('dispatchTours.docsList.title', "Pages your agent delivered"),
				body: localize('dispatchTours.docsList.body', "Reports, designs and prototypes land here when a task is done. Click one to read it. \"This session\" and \"Project\" change how many you see."),
			},
			{
				id: 'docs-search',
				anchor: { selector: '.dispatch-docs-search-box' },
				placement: 'bottom',
				title: localize('dispatchTours.docsSearch.title', "Find a page fast"),
				body: localize('dispatchTours.docsSearch.body', "Press ⌘K to search every page in the project."),
			},
		],
	},
	{
		id: 'delivery',
		order: 8,
		place: { selector: '.dispatch-docs-reader-head' },
		steps: [
			{
				id: 'delivery-task',
				anchor: { selector: '.dispatch-docs-context' },
				placement: 'bottom',
				title: localize('dispatchTours.deliveryTask.title', "What it was for"),
				body: localize('dispatchTours.deliveryTask.body', "This line says which task the page was delivered for. Click the task name to jump to it."),
			},
			{
				id: 'delivery-draw',
				anchor: { selector: '.dispatch-docs-actions .dispatch-docs-icon', aria: 'Draw and ask' },
				placement: 'bottom',
				title: localize('dispatchTours.deliveryDraw.title', "Draw and ask"),
				body: localize('dispatchTours.deliveryDraw.body', "Circle something on the page and write a question. The agent gets your drawing and your words."),
			},
			{
				id: 'delivery-back',
				anchor: { selector: '.dispatch-docs-back' },
				placement: 'bottom',
				title: localize('dispatchTours.deliveryBack.title', "Back to the list"),
				body: localize('dispatchTours.deliveryBack.body', "Click here, or press Esc."),
			},
		],
	},
];

// ---------------------------------------------------------------- the Getting started checklist

export interface IDispatchChecklistItem {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	/** It ticks itself when one of these is true. */
	readonly doneWhen: {
		/** The place is on screen (the person opened it). */
		readonly onScreen?: IDispatchTourStep['anchor'];
		/** One of these commands ran. */
		readonly commands?: readonly string[];
		/** A message was sent to an agent. */
		readonly request?: boolean;
		/** A message was sent from a chat's page (no folder: Chats). */
		readonly chatRequest?: boolean;
		/** Asked of Dispatch now and then. */
		readonly check?: 'agents' | 'phone' | 'sessions';
	};
	/** Show me: take the person there. */
	readonly show: { readonly command: string; readonly args?: readonly unknown[] } | { readonly spot: IDispatchTourStep };
}

export const DISPATCH_CHECKLIST: readonly IDispatchChecklistItem[] = [
	{
		// the id it has been saved under since it was the Assistant's (a tick stays a tick)
		id: 'assistant',
		title: localize('dispatchChecklist.ask.title', "Ask what is unfinished"),
		description: localize('dispatchChecklist.ask.desc', "Start a chat and ask. It looks across all your projects and tells you what is not done yet."),
		// or the first suggestions on a chat's page were used or closed (dispatchFirstPrompts.ts)
		doneWhen: { chatRequest: true, commands: ['dispatch.firstPrompts.done'] },
		show: { command: 'sessionsView.newQuickChat' },
	},
	{
		id: 'agents',
		title: localize('dispatchChecklist.agents.title', "Choose your agents"),
		description: localize('dispatchChecklist.agents.desc', "Pick which coding agents Dispatch uses, and which one starts new sessions."),
		doneWhen: { check: 'agents' },
		show: {
			spot: {
				id: 'agents-link',
				// Dispatch IDE: Customizations moved into Settings; its Agents page is behind the bottom bar's Settings
				anchor: { selector: '.dispatch-status-item[data-part="settings"]', text: 'Settings' },
				placement: 'top',
				title: localize('dispatchChecklist.agents.spotTitle', "Agents"),
				body: localize('dispatchChecklist.agents.spotBody', "Turn on the agents you use and pick the one new sessions start with."),
				action: { label: localize('dispatchChecklist.agents.spotAction', "Open Agents"), command: 'dispatch.settings.open', args: ['agents'] },
			},
		},
	},
	{
		id: 'session',
		title: localize('dispatchChecklist.session.title', "Start your first session"),
		description: localize('dispatchChecklist.session.desc', "Describe what you want in plain words and send it."),
		doneWhen: { request: true, check: 'sessions' },
		show: { command: 'workbench.action.sessions.newChat' },
	},
	{
		id: 'waiting',
		title: localize('dispatchChecklist.waiting.title', "Open Waiting for you"),
		description: localize('dispatchChecklist.waiting.desc', "See what needs your approval or your answer, from every project."),
		doneWhen: { onScreen: { selector: '.dispatch-waiting-page' } },
		show: { command: 'dispatch.waiting.show' },
	},
	{
		id: 'board',
		title: localize('dispatchChecklist.board.title', "Look at the task board"),
		description: localize('dispatchChecklist.board.desc', "Open the Tasks tab to see the plan the agent made."),
		doneWhen: { onScreen: { selector: '.dispatch-tasks-scope' } },
		show: { command: 'workbench.action.agentSessions.dispatchTasksTab' },
	},
	{
		id: 'changes',
		title: localize('dispatchChecklist.changes.title', "Check what the agent changed"),
		description: localize('dispatchChecklist.changes.desc', "Open the Changes tab and click a file."),
		doneWhen: { onScreen: { selector: '.changes-view-body .chat-editing-session-container' } },
		show: { command: 'workbench.action.agentSessions.openChangesView' },
	},
	{
		id: 'delivery',
		title: localize('dispatchChecklist.delivery.title', "Open a delivery"),
		description: localize('dispatchChecklist.delivery.desc', "Read a page your agent delivered, in the Docs tab."),
		// the reader (a document), or a delivery page in front in its own tab (pages open in the browser; the tab carries
		// the delivery symbol, a source file from Files does not)
		doneWhen: { onScreen: { selector: '.dispatch-docs-reader-head, .tabs-container .tab.active.dispatch-tab-doc .tab-label.codicon-dispatch-delivery' } },
		show: { command: 'workbench.action.agentSessions.dispatchDocsTab' },
	},
	{
		id: 'phone',
		title: localize('dispatchChecklist.phone.title', "Pair your phone"),
		description: localize('dispatchChecklist.phone.desc', "Scan a code to see your sessions and answer questions from your iPhone."),
		doneWhen: { check: 'phone' },
		show: {
			spot: {
				id: 'phone-button',
				anchor: { selector: '.dispatch-mobile-button' },
				placement: 'bottom',
				title: localize('dispatchChecklist.phone.spotTitle', "Pair your phone"),
				body: localize('dispatchChecklist.phone.spotBody', "Click here and scan the code with your iPhone."),
				action: { label: localize('dispatchChecklist.phone.spotAction', "Show the code") },
			},
		},
	},
];

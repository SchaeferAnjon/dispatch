/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Customizations › Agents lists Dispatch's own sub-agent definitions for every
 *  harness, Claude and Codex alike: ~/.dispatch/agents/*.md (User) and <project>/.dispatch/agents/*.md
 *  (Workspace). Claude Code reads the same files through ~/.claude/agents (a link to ~/.dispatch/agents)
 *  and <project>/.claude/agents; Codex has no sub-agents, so Dispatch runs one as its own session
 *  (`dispatch agent run <name> "…"`: Run as a Session... in the row's menu, through dispatch-bridge's dispatch.agentRun).
 *
 *  It wraps the harness's own item provider: every other kind of customization comes from there
 *  unchanged; for agents, the harness's copies of the same files are dropped, and New Agent creates
 *  the file in ~/.dispatch/agents or <project>/.dispatch/agents. Open, edit and Delete are the list's
 *  own (a plain file).
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { AICustomizationSources, IAICustomizationWorkspaceService } from '../../../common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService, ICustomizationItem, ICustomizationItemProvider, ICustomizationSourceFolder } from '../../../common/customizationHarnessService.js';
import { AI_CUSTOMIZATION_ITEM_TYPE_KEY, AI_CUSTOMIZATION_ITEM_URI_KEY, AICustomizationManagementItemMenuId } from '../../aiCustomization/aiCustomizationManagement.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { ICustomAgent } from '../../../common/promptSyntax/service/promptsService.js';

/** `key: value` lines of a Markdown file's frontmatter. */
export function parseAgentFrontmatter(text: string): Record<string, string> {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const out: Record<string, string> = {};
	if (!m) {
		return out;
	}
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (kv) {
			out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
		}
	}
	return out;
}

/** A harness item that is one of Dispatch's definitions seen through Claude's folders (or ours). */
export function isDispatchAgentCopy(path: string): boolean {
	return /\/\.(claude|dispatch)\/agents\/[^/]+\.md$/.test(path);
}

export class DispatchAgentsItemProvider extends Disposable implements ICustomizationItemProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void>;
	private readonly userFolder: URI;
	private watchedProject: string | undefined;

	readonly provideCustomAgents?: (sessionResource: URI, token: CancellationToken) => Promise<readonly ICustomAgent[]>;

	constructor(
		private readonly inner: ICustomizationItemProvider,
		@IFileService private readonly fileService: IFileService,
		@IPathService pathService: IPathService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.onDidChange = Event.any(inner.onDidChange, this._onDidChange.event);
		this.userFolder = joinPath(pathService.userHome({ preferLocal: true }), '.dispatch', 'agents');
		this._register(this.fileService.watch(this.userFolder));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.affects(this.userFolder) || (this.watchedProject && e.affects(URI.file(this.watchedProject)))) {
				this._onDidChange.fire();
			}
		}));
		if (inner.provideCustomAgents) {
			this.provideCustomAgents = (session, token) => inner.provideCustomAgents!(session, token);
		}
	}

	private projectFolder(): URI | undefined {
		const root = this.instantiationService.invokeFunction(accessor => accessor.get(IAICustomizationWorkspaceService).getActiveProjectRoot());
		if (!root || root.scheme !== 'file') {
			return undefined;
		}
		const folder = joinPath(root, '.dispatch', 'agents');
		if (this.watchedProject !== folder.fsPath) {
			this.watchedProject = folder.fsPath;
			this._register(this.fileService.watch(folder));
		}
		return folder;
	}

	async provideChatSessionCustomizations(sessionResource: URI, token: CancellationToken): Promise<ICustomizationItem[] | undefined> {
		const [items, project, user] = await Promise.all([
			this.inner.provideChatSessionCustomizations(sessionResource, token),
			this.read(this.projectFolder(), AICustomizationSources.local),
			this.read(this.userFolder, AICustomizationSources.user),
		]);
		const own = [...project, ...user];
		const names = new Set(own.map(i => i.name));
		const rest = (items ?? []).filter(i => !(i.type === PromptsType.agent && (isDispatchAgentCopy(i.uri.path) || names.has(i.name))));
		return [...rest, ...own];
	}

	async provideSourceFolders(sessionResource: URI, type: PromptsType, token: CancellationToken): Promise<readonly ICustomizationSourceFolder[] | undefined> {
		if (type !== PromptsType.agent) {
			return this.inner.provideSourceFolders?.(sessionResource, type, token);
		}
		const project = this.projectFolder();
		return [
			...(project ? [{ uri: project, label: localize('dispatchAgents.workspaceFolder', "Project (.dispatch/agents)"), source: AICustomizationSources.local }] : []),
			{ uri: this.userFolder, label: localize('dispatchAgents.userFolder', "Dispatch (~/.dispatch/agents)"), source: AICustomizationSources.user },
		];
	}

	private async read(folder: URI | undefined, source: typeof AICustomizationSources.user): Promise<ICustomizationItem[]> {
		if (!folder) {
			return [];
		}
		let children;
		try {
			children = (await this.fileService.resolve(folder)).children ?? [];
		} catch {
			return [];
		}
		const files = children.filter(c => !c.isDirectory && c.name.endsWith('.md') && !c.name.startsWith('.'));
		const items = await Promise.all(files.map(async (file): Promise<ICustomizationItem | undefined> => {
			let fm: Record<string, string> = {};
			try {
				fm = parseAgentFrontmatter((await this.fileService.readFile(file.resource, { length: 8192 })).value.toString());
			} catch {
				return undefined;
			}
			const name = fm['name'] || basename(file.resource).replace(/\.md$/, '');
			const meta = [fm['engine'] === 'codex' ? 'Codex' : undefined, fm['model'], fm['effort']].filter(Boolean);
			return {
				itemKey: `dispatch-agent:${file.resource.toString()}`,
				uri: file.resource,
				type: PromptsType.agent,
				name,
				description: [...meta, fm['description']].filter(Boolean).join(' · ') || undefined,
				source,
				extensionId: undefined,
				pluginUri: undefined,
				userInvocable: true,
			};
		}));
		return items.filter((i): i is ICustomizationItem => !!i).sort((a, b) => a.name.localeCompare(b.name));
	}
}

/** Run as a Session... in a Dispatch definition's menu (the list's own … and right-click menu). */
const RUN_AGENT_DEFINITION = '_dispatch.runAgentDefinition';
CommandsRegistry.registerCommand(RUN_AGENT_DEFINITION, async (accessor, context?: { uri?: string; name?: string }) => {
	const uri = context?.uri ? URI.parse(context.uri) : undefined;
	if (!uri || !isDispatchAgentCopy(uri.path)) {
		return;
	}
	const harness = accessor.get(ICustomizationHarnessService).activeHarness.get();
	const commandService = accessor.get(ICommandService);
	const name = context?.name || basename(uri).replace(/\.md$/, '');
	const project = /\/\.dispatch\/agents\/[^/]+\.md$/.test(uri.path) && !uri.path.startsWith(`${accessor.get(IPathService).userHome({ preferLocal: true }).path}/.dispatch/`)
		? uri.path.replace(/\/\.dispatch\/agents\/[^/]+\.md$/, '')
		: undefined;
	await commandService.executeCommand('dispatch.agentRun', name, /codex/i.test(harness) ? 'codex' : 'claude', project);
});
MenuRegistry.appendMenuItem(AICustomizationManagementItemMenuId, {
	command: { id: RUN_AGENT_DEFINITION, title: localize('dispatchAgents.run', "Run as a Session...") },
	when: ContextKeyExpr.and(ContextKeyExpr.equals(AI_CUSTOMIZATION_ITEM_TYPE_KEY, PromptsType.agent), ContextKeyExpr.regex(AI_CUSTOMIZATION_ITEM_URI_KEY, /\/\.dispatch\/agents\/[^/]+\.md$/)),
	group: '2_run',
	order: 5,
});

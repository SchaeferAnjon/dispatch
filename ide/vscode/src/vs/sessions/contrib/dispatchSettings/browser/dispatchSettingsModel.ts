/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Agents window's own Settings page (kanban design/settings, direction B), the plain part:
 *  which pages there are, the contents in the side bar, and the search over every setting by the words
 *  people use ("sleep" finds Keep awake, "dark" finds Appearance).
 *--------------------------------------------------------------------------------------------*/

/** The abilities (what used to be Customizations), each a section of the customizations editor. */
export type AbilityId = 'skills' | 'tools' | 'plugins' | 'hooks' | 'instructions' | 'subagents' | 'knowledge' | 'changes' | 'editor' | 'findskills';

export type SettingsPageId =
	| 'overview' | 'account' | 'usage' | 'agents' | 'soul' | 'keys' | 'appearance' | 'learning' | 'notifications' | 'awake' | 'network' | 'phone' | 'macs' | 'projects'
	| 'abilities' | AbilityId
	| 'agent:claude' | 'agent:codex' | 'agent:opencode';

export interface ISettingsNavItem {
	readonly id: SettingsPageId;
	readonly label: string;
	/** A codicon id. */
	readonly icon: string;
}

/** The side bar's contents, in order. Abilities has its seven under it, always open. */
export const SETTINGS_NAV: readonly ISettingsNavItem[] = [
	{ id: 'account', label: 'Account and usage', icon: 'account' },
	{ id: 'agents', label: 'Agents', icon: 'hubot' },
	{ id: 'soul', label: 'Soul', icon: 'heart' },
	{ id: 'keys', label: 'Keys', icon: 'key' },
	{ id: 'appearance', label: 'Appearance', icon: 'color-mode' },
	{ id: 'learning', label: 'Learning', icon: 'mortar-board' },
	{ id: 'notifications', label: 'Notifications', icon: 'bell' },
	{ id: 'awake', label: 'Keep awake', icon: 'coffee' },
	{ id: 'network', label: 'Network', icon: 'globe' },
	{ id: 'phone', label: 'Phone', icon: 'device-mobile' },
	{ id: 'macs', label: 'Macs', icon: 'vm' },
	{ id: 'projects', label: 'Projects', icon: 'folder' },
];

export const ABILITIES: readonly ISettingsNavItem[] = [
	{ id: 'skills', label: 'Skills', icon: 'lightbulb' },
	{ id: 'tools', label: 'MCP servers', icon: 'plug' },
	{ id: 'plugins', label: 'Plugins', icon: 'extensions' },
	{ id: 'hooks', label: 'Hooks', icon: 'zap' },
	{ id: 'instructions', label: 'Instructions', icon: 'book' },
	{ id: 'subagents', label: 'Sub-agents', icon: 'organization' },
	{ id: 'knowledge', label: 'Knowledge', icon: 'library' },
];

export const AGENT_PAGES: readonly { readonly id: 'agent:claude' | 'agent:codex' | 'agent:opencode'; readonly engine: string; readonly label: string }[] = [
	{ id: 'agent:claude', engine: 'claude', label: 'Claude Code' },
	{ id: 'agent:codex', engine: 'codex', label: 'Codex' },
	{ id: 'agent:opencode', engine: 'opencode', label: 'OpenCode' },
];

export function isAbility(page: SettingsPageId): page is AbilityId {
	return page === 'changes' || page === 'editor' || page === 'findskills' || ABILITIES.some(a => a.id === page);
}

export function isAgentPage(page: SettingsPageId): page is 'agent:claude' | 'agent:codex' | 'agent:opencode' {
	return page.startsWith('agent:');
}

/** Pages shown by the customizations editor inside the Settings page. */
export function isEmbeddedPage(page: SettingsPageId): boolean {
	return isAbility(page) || isAgentPage(page);
}

/** The page a side bar row stands for: an agent's page is under Agents, every ability under Abilities. */
export function navOwner(page: SettingsPageId): SettingsPageId {
	if (isAgentPage(page)) {
		return 'agents';
	}
	if (page === 'usage') {
		return 'account';
	}
	return page;
}

const TITLES: Record<string, string> = {
	overview: 'Settings',
	abilities: 'Abilities',
	changes: 'What Dispatch changed on this Mac',
	editor: 'Editor window',
	findskills: 'Find skills',
	usage: 'Usage',
};

export function pageTitle(page: SettingsPageId): string {
	return TITLES[page]
		?? SETTINGS_NAV.find(n => n.id === page)?.label
		?? ABILITIES.find(n => n.id === page)?.label
		?? AGENT_PAGES.find(n => n.id === page)?.label
		?? 'Settings';
}

/** The page's parent for the way back ("Settings › Agents › Claude Code"). */
export function pageParent(page: SettingsPageId): SettingsPageId | undefined {
	if (page === 'overview') {
		return undefined;
	}
	if (isAgentPage(page)) {
		return 'agents';
	}
	if (isAbility(page)) {
		return 'abilities';
	}
	if (page === 'usage') {
		return 'account';
	}
	return 'overview';
}

/** The customizations editor's section for an ability page (`AICustomizationManagementSection`). */
export function abilitySection(page: AbilityId): string | undefined {
	switch (page) {
		case 'skills': return 'skills';
		case 'tools': return 'mcpServers';
		case 'plugins': return 'plugins';
		case 'hooks': return 'hooks';
		case 'instructions': return 'instructions';
		case 'subagents': return 'agents';
		case 'knowledge': return 'knowledge';
		case 'editor': return 'editorSettings';
		default: return undefined;
	}
}

/** Pages that go deeper inside themselves (Knowledge: Preferences, then one preference). Its row in the side bar
 *  takes such a page back to its start when it is the page on screen, as any other page's row does. */
const PAGES_WITH_DEPTH: readonly SettingsPageId[] = ['knowledge'];

export function backToPageStart(showing: SettingsPageId | undefined, page: SettingsPageId): boolean {
	return showing === page && PAGES_WITH_DEPTH.includes(page);
}

/** The other way: the Settings page for a section someone asked the customizations editor for. */
export function pageForSection(section: string | undefined, harness: string | undefined): SettingsPageId {
	switch (section) {
		case 'skills': return 'skills';
		case 'mcpServers': return 'tools';
		case 'plugins': return 'plugins';
		case 'hooks': return 'hooks';
		case 'instructions': return 'instructions';
		case 'agents': return 'subagents';
		case 'knowledge': return 'knowledge';
		case 'editorSettings': return 'editor';
		case 'harnessSettings': {
			const engine = agentForHarness(harness);
			return engine ? `agent:${engine}` as SettingsPageId : 'agents';
		}
		default: return 'abilities';
	}
}

/** `agent-host-claude` → `claude`; undefined for a harness Settings has no page for. */
export function agentForHarness(harness: string | undefined): string | undefined {
	const m = /^agent-host-(claude|codex|opencode)$/.exec(harness ?? '');
	return m ? m[1] : undefined;
}

export function harnessForAgent(engine: string): string {
	return `agent-host-${engine}`;
}

// ---- search ---------------------------------------------------------------------------------------------

export interface ISettingsEntry {
	/** What the row is called on its page. */
	readonly label: string;
	readonly page: SettingsPageId;
	/** One line under it in the results. */
	readonly detail: string;
	/** Words people use for it. */
	readonly words: readonly string[];
	/** The row on the page to flash (its data-setting), when the page has one. */
	readonly key?: string;
}

export const SETTINGS_INDEX: readonly ISettingsEntry[] = [
	{ label: 'Accounts', page: 'account', key: 'accounts', detail: 'The Claude and ChatGPT accounts on this Mac, and switching between them.', words: ['account', 'login', 'sign in', 'sign out', 'switch account', 'claude', 'chatgpt', 'codex', 'subscription', 'plan'] },
	{ label: 'Allowance used', page: 'account', key: 'accounts', detail: 'How much of the 5-hour and weekly allowance is used.', words: ['usage', 'limit', 'quota', 'allowance', 'rate limit', '5-hour', 'weekly'] },
	{ label: 'Usage over time', page: 'usage', detail: 'Sessions and allowance by day.', words: ['usage', 'history', 'chart', 'statistics', 'stats'] },
	{ label: 'Agents you use', page: 'agents', key: 'agents', detail: 'Turn Claude Code, Codex and OpenCode on or off.', words: ['agent', 'engine', 'claude code', 'codex', 'opencode', 'turn off', 'disable', 'harness'] },
	{ label: 'Default agent', page: 'agents', key: 'agents', detail: 'The agent a new session starts with.', words: ['default', 'new session', 'start with'] },
	{ label: 'What agents may do on their own', page: 'agents', key: 'autonomy', detail: 'Always ask, ask for risky actions, or full auto.', words: ['permission', 'permissions', 'approve', 'approval', 'ask', 'yolo', 'auto', 'full auto', 'autonomy', 'risky', 'trust'] },
	{ label: 'Use other apps without asking', page: 'agents', key: 'computer-all', detail: 'Agents use Notes, Finder and other apps without asking each time.', words: ['computer use', 'other apps', 'allow', 'always allow', 'ask', 'permission', 'notes', 'finder', 'simulator', 'control'] },
	{ label: 'Sign commits as co-authored by the AI', page: 'agents', key: 'co-author', detail: 'Whether agents end commit messages with a Co-authored-by line naming themselves.', words: ['commit', 'co-author', 'coauthor', 'co-authored-by', 'signature', 'trailer', 'git', 'attribution', 'credit'] },
	{ label: 'Work at once', page: 'agents', key: 'nextup-limit', detail: 'How many sessions may work at the same time before the next thing in line waits.', words: ['next up', 'queue', 'line', 'at once', 'parallel', 'concurrent', 'how many', 'limit'] },
	{ label: 'Next up starts with', page: 'agents', key: 'nextup-engine', detail: 'The agent a thing noted from a chat starts with.', words: ['next up', 'queue', 'line', 'start with', 'engine', 'agent'] },
	{ label: 'Start next up by itself', page: 'agents', key: 'nextup-auto', detail: 'Off is the same as Pause.', words: ['next up', 'pause', 'resume', 'auto start', 'automatic', 'queue'] },
	{ label: 'Agents opened in the terminal', page: 'agents', key: 'terminal-agents', detail: 'Other agents on this Mac, run in the terminal.', words: ['gemini', 'kimi', 'grok', 'pi', 'hermes', 'terminal', 'tui', 'cli'] },
	{ label: 'Claude Code settings', page: 'agent:claude', detail: 'Default model, permission mode and allowed tools.', words: ['model', 'permission', 'allowed tools', 'fable', 'opus', 'sonnet', 'haiku', 'settings.json', 'sub-agent effort'] },
	{ label: 'Codex settings', page: 'agent:codex', detail: 'Codex\'s defaults.', words: ['codex', 'model', 'reasoning', 'approval', 'sandbox', 'config.toml'] },
	{ label: 'OpenCode settings', page: 'agent:opencode', detail: 'Default model and the AI services OpenCode uses.', words: ['provider', 'deepseek', 'zhipu', 'glm', 'api key', 'opencode'] },
	{ label: 'Soul', page: 'soul', key: 'soul', detail: 'How every agent talks and works, and everything else Dispatch gives every agent.', words: ['built-in', 'builtin', 'built in', 'soul', 'voice', 'tone', 'style', 'personality', 'character', 'talk', 'reply', 'answer', 'concise', 'short', 'direct', 'verbose', 'wordy', 'hedge', 'apologize', 'plain'] },
	{ label: 'Soul text', page: 'soul', key: 'soul-text', detail: 'Change what every agent reads, or reset it to the default.', words: ['soul.md', 'edit soul', 'reset', 'default'] },
	{ label: 'Dispatch\'s rules', page: 'soul', key: 'builtin-rules', detail: 'dispatch.md: how agents work with Dispatch. Read-only, replaced when Dispatch updates.', words: ['dispatch.md', 'rules', 'built-in rules', 'instructions', 'workflow', 'conventions'] },
	{ label: 'Session brief', page: 'soul', key: 'builtin-brief', detail: 'Tasks, preferences and nearby sessions every new session starts with (dispatch prime).', words: ['brief', 'session brief', 'prime', 'dispatch prime', 'sessionstart', 'context', 'handoff'] },
	{ label: 'Dispatch\'s tools', page: 'soul', key: 'builtin-tools', detail: 'The task board\'s tools every agent can call (MCP). On or off.', words: ['mcp', 'dispatch mcp', 'tools', 'task board tools', 'task_begin'] },
	{ label: 'Dispatch\'s hooks', page: 'soul', key: 'builtin-hooks', detail: 'Session brief, activity, task plans and file ownership, on or off per agent.', words: ['hook', 'hooks', 'dispatch-hook', 'session activity', 'task plans', 'file ownership', 'edit guard', 'presence'] },
	{ label: 'Built-in skills', page: 'soul', key: 'builtin-skills', detail: 'The skills that come with Dispatch, read-only.', words: ['skill', 'skills', 'built-in skills', 'task-board', 'delivery page', 'built-in browser', 'computer use', 'designer', 'neat-freak', 'leader'] },
	{ label: 'Built-in sub-agents', page: 'soul', key: 'builtin-agents', detail: 'Engineer, tester, researcher and the other helpers that come with Dispatch, each on or off.', words: ['sub-agent', 'subagent', 'helper', 'engineer', 'tester', 'researcher', 'designer', 'teaching-master', 'animation-director'] },
	{ label: 'API keys', page: 'keys', key: 'keys', detail: 'API keys and other secrets your agents use by name: add, show, copy, change or delete one.', words: ['key', 'keys', 'api key', 'api', 'secret', 'secrets', 'token', 'password', 'credential', 'env', 'environment variable', 'dispatch env', 'deepseek', 'openai', 'anthropic'] },
	{ label: 'Add a key', page: 'keys', key: 'keys', detail: 'Save an API key once; every agent can use it by its name.', words: ['add key', 'new key', 'save key', 'paste key', 'store key'] },
	{ label: 'Light or dark', page: 'appearance', key: 'theme', detail: 'System, Light or Dark.', words: ['theme', 'dark', 'dark mode', 'light', 'light mode', 'color', 'colour', 'appearance', 'night'] },
	{ label: 'Motion', page: 'appearance', key: 'motion', detail: 'Animations in the window.', words: ['animation', 'motion', 'reduce motion', 'movement'] },
	{ label: 'Banners on this Mac', page: 'notifications', key: 'mac-kinds', detail: 'Which show a banner: an agent finished, needs you, or stopped without finishing.', words: ['notification', 'notify', 'banner', 'alert', 'mac', 'desktop', 'finished', 'done', 'stopped', 'error', 'needs you', 'turn off', 'mute'] },
	{ label: 'Notification sound', page: 'notifications', key: 'mac-sound', detail: 'The sound a banner plays: the Mac\'s alert sound, none, or another.', words: ['sound', 'chime', 'ding', 'beep', 'tone', 'mute', 'silent', 'quiet', 'audio'] },
	{ label: 'Banners for agents outside this window', page: 'notifications', key: 'mac-notify', detail: 'Agents another agent started, ones from your phone, ones in a terminal.', words: ['notification', 'banner', 'background', 'terminal', 'phone', 'closed'] },
	{ label: 'Tell my phone', page: 'notifications', key: 'phone-notify', detail: 'Replies, approvals, finished tasks and things only you can do.', words: ['notification', 'notify', 'push', 'alert', 'banner', 'reply', 'approval'] },
	{ label: 'While the agent works', page: 'learning', key: 'learn-mode', detail: 'Quiet, or Talk: a small card when the agent adds a file, installs or deletes something.', words: ['learn', 'learning', 'teach', 'explain', 'talk', 'quiet', 'tips', 'cards', 'toast', 'new file', 'install', 'side chat', 'ask question', 'what is this'] },
	{ label: 'Keep this Mac awake', page: 'awake', key: 'awake', detail: 'While an agent works or your phone is connected, the Mac does not sleep.', words: ['sleep', 'awake', 'caffeinate', 'lid', 'energy', 'screen', 'display', 'power'] },
	{ label: 'Proxy', page: 'network', key: 'netProxy', detail: 'The proxy the agents go out through: this Mac\'s, none, or one you type.', words: ['proxy', 'network', 'vpn', 'clash', 'pac', 'socks', 'http proxy', 'firewall', 'china', 'connection', 'reconnect', 'offline'] },
	{ label: 'Downloads from mirrors in China', page: 'network', key: 'netMirror', detail: 'Installs and updates from the official servers or from mirrors in China.', words: ['mirror', 'npm', 'pypi', 'homebrew', 'download', 'install', 'update', 'npmmirror', 'tsinghua', 'china'] },
	{ label: 'Chinese models', page: 'network', key: 'net-models', detail: 'DeepSeek, Zhipu GLM, Kimi and Qwen in OpenCode: what account or key each needs.', words: ['deepseek', 'glm', 'zhipu', 'kimi', 'moonshot', 'qwen', 'tongyi', 'china', 'chinese', 'api key', 'opencode'] },
	{ label: 'Pair a phone', page: 'phone', key: 'pair', detail: 'Scan a code with Dispatch on your iPhone.', words: ['phone', 'iphone', 'mobile', 'pair', 'qr', 'scan', 'ios'] },
	{ label: 'Paired phones', page: 'phone', key: 'phones', detail: 'The phones that can reach this Mac.', words: ['phone', 'iphone', 'remove phone', 'revoke'] },
	{ label: 'Macs', page: 'macs', key: 'macs', detail: 'This Mac and your others: rename, address, add one.', words: ['mac', 'machine', 'computer', 'tailscale', 'ssh', 'remote', 'mini', 'add a mac'] },
	{ label: 'Projects', page: 'projects', key: 'projects', detail: 'The folders Dispatch knows, and their names.', words: ['project', 'folder', 'rename', 'repository', 'repo'] },
	{ label: 'Skills', page: 'skills', detail: 'Your skills: know-how agents load when a task needs it.', words: ['skill', 'skills', 'skill.md', 'my skills'] },
	{ label: 'Find skills', page: 'findskills', detail: 'Search your skill pool, then skills.sh.', words: ['find skills', 'skills.sh', 'install skill', 'add skill'] },
	{ label: 'MCP servers', page: 'tools', detail: 'The tool servers agents can call, such as a browser: see them, add one, copy one to another agent.', words: ['mcp', 'mcp server', 'mcp servers', 'add mcp', 'server', 'servers', 'tool', 'tools', 'external tools', 'playwright', 'browser', 'connector']  },
	{ label: 'Plugins', page: 'plugins', detail: 'Claude Code plugins on this Mac.', words: ['plugin', 'plugins', 'marketplace'] },
	{ label: 'Hooks', page: 'hooks', detail: 'Your own hooks: what runs when a session starts, stops or edits.', words: ['hook', 'hooks', 'my hooks', 'settings.json'] },
	{ label: 'Instructions', page: 'instructions', detail: 'Your rules every agent reads (GLOBAL.md).', words: ['rule', 'rules', 'instruction', 'claude.md', 'agents.md', 'global.md', 'sync', 'my rules'] },
	{ label: 'Sub-agents', page: 'subagents', detail: 'Your helpers an agent can hand part of a task to.', words: ['sub-agent', 'subagent', 'agents', 'persona', 'my sub-agents'] },
	{ label: 'Knowledge', page: 'knowledge', detail: 'What agents know about you and your work.', words: ['knowledge', 'wiki', 'preference', 'preferences', 'facts', 'memory', 'about me'] },
	{ label: 'What Dispatch changed on this Mac', page: 'changes', detail: 'Everything Dispatch set up or imported, each with Undo.', words: ['migration', 'migrations', 'import', 'imported', 'undo', 'changed'] },
	{ label: 'Tab completion and ⌘K', page: 'editor', detail: 'Suggestions while typing in the editor window.', words: ['tab', 'completion', 'autocomplete', 'cmd k', '⌘k', 'rewrite', 'editor'] },
];

export interface ISettingsHit {
	readonly entry: ISettingsEntry;
	readonly score: number;
}

/** Every entry the words match, best first: the name, then the words people use, then the line under it. */
export function searchSettings(query: string, index: readonly ISettingsEntry[] = SETTINGS_INDEX): ISettingsHit[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return [];
	}
	const hits: ISettingsHit[] = [];
	for (const entry of index) {
		const label = entry.label.toLowerCase();
		let score = 0;
		if (label.startsWith(q)) {
			score = 4;
		} else if (label.split(/[\s-]+/).some(w => w.startsWith(q))) {
			score = 3.5;
		} else if (entry.words.some(w => w.startsWith(q) || w === q)) {
			score = 3;
		} else if (label.includes(q) || entry.words.some(w => w.includes(q))) {
			score = 2;
		} else if (entry.detail.toLowerCase().includes(q) || pageTitle(entry.page).toLowerCase().includes(q)) {
			score = 1;
		}
		if (score) {
			hits.push({ entry, score });
		}
	}
	return hits.sort((a, b) => b.score - a.score);
}

/** The side bar rows a search lights up: the pages its hits are on, and the page above an agent's or an ability's. */
export function pagesOf(hits: readonly ISettingsHit[]): Set<SettingsPageId> {
	const pages = new Set<SettingsPageId>();
	for (const h of hits) {
		pages.add(h.entry.page);
		pages.add(navOwner(h.entry.page));
		if (isAbility(h.entry.page)) {
			pages.add('abilities');
		}
	}
	return pages;
}

/** The parts of a text a query matches, for <mark>: [before, match, after] or undefined. */
export function matchParts(text: string, query: string): [string, string, string] | undefined {
	const q = query.trim().toLowerCase();
	if (!q) {
		return undefined;
	}
	const i = text.toLowerCase().indexOf(q);
	return i < 0 ? undefined : [text.slice(0, i), text.slice(i, i + q.length), text.slice(i + q.length)];
}

// ---- small numbers -----------------------------------------------------------------------------------------

/** 0 to 100, whole. */
export function percent(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** How long ago something was read, as the line next to it says it: "just now", "3 min ago", "2 h ago", "yesterday". */
export function agoText(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) {
		return 'just now';
	}
	const m = Math.floor(s / 60);
	if (m < 60) {
		return `${m} min ago`;
	}
	const h = Math.floor(m / 60);
	if (h < 24) {
		return `${h} h ago`;
	}
	const d = Math.floor(h / 24);
	return d === 1 ? 'yesterday' : `${d} days ago`;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchTerminal/browser/dispatchTerminalModel.ts'));

const agent = (id, enabled, extra = {}) => ({ id, name: id.toUpperCase(), about: `about ${id}`, command: `/bin/${id}`, runnable: ['claude', 'codex', 'opencode'].includes(id), enabled, is_default: false, ...extra });

test('a terminal session says it is a terminal and what runs in it', () => {
	assert.equal(model.terminalSessionTitle(undefined), 'Terminal');
	assert.equal(model.terminalSessionTitle({ name: 'Claude Code' }), 'Claude Code (terminal)');
});

const preview = {
	found: true,
	summary: { font: 'JetBrains Mono', size: 14, theme: 'Catppuccin Mocha', cursor: 'bar' },
	settings: { 'terminal.integrated.fontFamily': 'JetBrains Mono', 'terminal.integrated.fontSize': 14, 'terminal.integrated.cursorStyle': 'line' },
	colors: { 'terminal.background': '#1e1e2e' },
	colors_by_scheme: null,
};

test('the question names what would come over, in plain words', () => {
	const text = model.ghosttyOfferDetail(preview);
	assert.match(text, /the font \(JetBrains Mono, 14\), the colors \(Catppuccin Mocha\) and the cursor \(bar\)/);
	assert.match(text, /Your Ghostty settings stay as they are/);
	assert.doesNotMatch(text, /\b(CLI|PATH|config|JSON)\b/);
	assert.match(model.ghosttyOfferDetail({ found: true, settings: { 'terminal.integrated.fontSize': 12 } }), /copy the font \(12\) into its terminal/);
});

test('the terminal colors are set inside the person\'s own color settings, which keep their other colors', () => {
	const changes = model.ghosttyChanges(preview, { 'editor.background': '#000000', 'terminal.background': '#ffffff' });
	assert.deepEqual(changes.colorCustomizations, { 'editor.background': '#000000', 'terminal.background': '#1e1e2e' });
	assert.equal(changes.settings['terminal.integrated.fontSize'], 14);
	assert.equal(model.ghosttyChanges({ found: true, settings: { 'terminal.integrated.fontSize': 12 } }, undefined).colorCustomizations, undefined);
});

test('a light and dark pair goes under the matching Dispatch theme', () => {
	const changes = model.ghosttyChanges({ found: true, colors: {}, colors_by_scheme: { light: { 'terminal.background': '#fff' }, dark: { 'terminal.background': '#000' } } },
		{ '[Dispatch Dark]': { 'terminal.foreground': '#eee' }, 'editor.background': '#111' });
	assert.deepEqual(changes.colorCustomizations, {
		'[Dispatch Dark]': { 'terminal.foreground': '#eee', 'terminal.background': '#000' },
		'[Dispatch Light]': { 'terminal.background': '#fff' },
		'editor.background': '#111',
	});
});

// ---- the terminal that keeps running (kanban app/termd) ----------------------------------------

test('claude starts with a conversation id of ours and goes on with it after a restart', () => {
	const claude = agent('claude', true, { start: '/bin/claude --session-id {session}', resume: '/bin/claude --resume {session}', fork: '/bin/claude --resume {session} --fork-session --session-id {new}' });
	const launch = model.launchFor(claude, () => 'u-1');
	assert.equal(launch.command, '/bin/claude --session-id u-1');
	assert.equal(launch.agentSession, 'u-1');
	assert.equal(launch.restoreCommand, '/bin/claude --resume u-1');
	assert.equal(model.fillRecipe(claude.fork, 'u-1', 'u-2'), '/bin/claude --resume u-1 --fork-session --session-id u-2');
	assert.equal(model.fillRecipe(claude.fork, undefined, 'u-2'), '', 'no copy without the conversation it copies');
});

test('an agent without a way to go on starts bare and has no restart line', () => {
	const launch = model.launchFor(agent('aider', true), () => 'x');
	assert.deepEqual(launch, { command: '/bin/aider', agentSession: undefined, restoreCommand: undefined });
	const codex = model.launchFor(agent('codex', true, { resume: '/bin/codex resume --last' }), () => 'x');
	assert.equal(codex.command, '/bin/codex');
	assert.equal(codex.restoreCommand, '/bin/codex resume --last');
});

test('keys xterm has no mapping for send what iTerm2 and Ghostty send', () => {
	const k = (key, mods = {}) => model.resolveTerminalKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
	assert.deepEqual(k('Enter', { shiftKey: true }), { type: 'send', data: '\x1b\r' });
	assert.deepEqual(k('Backspace', { metaKey: true }), { type: 'send', data: '\x15' });
	assert.deepEqual(k('ArrowLeft', { metaKey: true }), { type: 'send', data: '\x01' });
	assert.deepEqual(k('ArrowRight', { altKey: true }), { type: 'send', data: '\x1bf' });
	assert.deepEqual(k('ArrowUp', { metaKey: true }), { type: 'scroll', to: 'top' });
	assert.deepEqual(k('v', { metaKey: true }), { type: 'app' }, '⌘V is the window\'s: it pastes pictures too');
	assert.equal(k('a'), undefined);
	assert.equal(k('c', { ctrlKey: true }), undefined, 'Ctrl+C still stops the program');
});

test('the conversation as text has no colors or cursor moves and keeps the newest part', () => {
	assert.equal(model.cleanTranscript('\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07ok\x07'), 'red\nok');
	const long = 'a'.repeat(50) + 'Z'.repeat(100);
	const b = model.boundedTranscript(long, 80);
	assert.ok(b.endsWith('Z'.repeat(30)) && b.length <= 80 && !b.includes('aa'));
	assert.match(b, /Earlier output left out/);
});

test('fork and continuation prompts carry the conversation and say what to do, in plain words', () => {
	const fork = model.buildForkPrompt({ text: 'did step 1\nnow step 2', agentName: 'Claude Code', folder: '/p' });
	assert.match(fork, /try another way/);
	assert.match(fork, /did step 1\nnow step 2/);
	const cont = model.buildContinuationPrompt({ text: '', transcriptPath: '/h/.claude/projects/-p/u.jsonl' });
	assert.match(cont, /\/h\/\.claude\/projects\/-p\/u\.jsonl/);
	assert.match(cont, /Where the files and the conversation disagree, the files are right/);
	assert.equal(model.buildForkPrompt({ text: '   ' }), undefined);
	assert.equal(model.claudeTranscriptPath('/h', '/Users/me/my.app', 'u'), '/h/.claude/projects/-Users-me-my-app/u.jsonl');
	assert.equal(model.claudeTranscriptPath('/h', '/Users/me/my_app v2', 'u'), '/h/.claude/projects/-Users-me-my-app-v2/u.jsonl', 'every character but letters and digits, as Claude Code names it');
	assert.equal(model.claudeTranscriptPath('/h', '/tmp/demo', 'u'), '/h/.claude/projects/-private-tmp-demo/u.jsonl', '/tmp is /private/tmp on a Mac');
});

test('a paste is one block, and a picture path is quoted for the shell', () => {
	assert.equal(model.pasteBytes('a\nb', true), '\x1b[200~a\rb\x1b[201~');
	assert.equal(model.pasteBytes('x\x1b[201~y', true), '\x1b[200~xy\x1b[201~', 'a paste cannot end the paste early');
	assert.equal(model.pasteBytes('a\nb', false), 'a\rb');
	assert.equal(model.shellQuotePath('/tmp/dispatch-paste/p.png'), '/tmp/dispatch-paste/p.png');
	assert.equal(model.shellQuotePath("/Users/me/My Shot's.png"), "'/Users/me/My Shot'\\''s.png'");
});

test('an agent\'s terminal shows the agent\'s own mark', () => {
	assert.equal(model.agentIconId('claude'), 'claude');
	assert.equal(model.agentIconId('codex'), 'openai');
	assert.equal(model.agentIconId('opencode'), 'dispatch-opencode');
	assert.equal(model.agentIconId('aider'), 'terminal');
});

test('the terminal answers ⌘V, ⌘C, ⌘A, ⌘K and ⌘F itself, and only those', () => {
	const s = (code, mods = {}) => model.terminalShortcut({ key: code.replace('Key', '').toLowerCase(), code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
	assert.equal(s('KeyV'), 'paste');
	assert.equal(s('KeyC'), 'copy');
	assert.equal(s('KeyA'), 'selectAll');
	assert.equal(s('KeyK'), 'clear');
	assert.equal(s('KeyF'), 'find');
	assert.equal(s('KeyW'), 'closePane', '⌘W closes a pane (the terminal lets it through to the window when there is none)');
	assert.equal(s('KeyV', { shiftKey: true }), undefined);
	assert.equal(s('KeyV', { metaKey: false, ctrlKey: true }), undefined, 'Ctrl+V goes to the program');
});

test('Claude Code\'s record reads as a chat: what was said and one line per tool', () => {
	const lines = [
		{ type: 'user', message: { content: 'Fix the login bug' } },
		{ type: 'user', isMeta: true, message: { content: 'meta' } },
		{ type: 'user', message: { content: '<command-name>/clear</command-name>' } },
		{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/p/login.ts' } }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', content: 'file text' }] } },
		{ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub agent' }] } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it.' }] } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'Tests pass.' }] } },
		{ type: 'ai-title', title: 'x' },
	].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n';
	assert.deepEqual(model.parseClaudeTranscript(lines), [
		{ role: 'user', text: 'Fix the login bug' },
		{ role: 'assistant', text: 'Looking.' },
		{ role: 'tool', text: 'Read  /p/login.ts' },
		{ role: 'assistant', text: 'Fixed it.\n\nTests pass.' },
	]);
});

test('the sub-agents Claude Code sent out, and which came back', () => {
	const lines = [
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Read the daemon', subagent_type: 'Explore' } }, { type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'Check the tests\nall of them' } }, { type: 'tool_use', id: 't3', name: 'Read', input: {} }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } },
		{ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's1', name: 'Task', input: { description: 'nested' } }] } },
	].map(o => JSON.stringify(o)).join('\n');
	assert.deepEqual(model.claudeSubAgents(lines).map(({ id, name, kind, done }) => ({ id, name, kind, done })), [
		{ id: 't1', name: 'Read the daemon', kind: 'Explore', done: true },
		{ id: 't2', name: 'Check the tests', kind: undefined, done: false },
	]);
});

test('⌘= ⌘- ⌘0 size the terminal text', () => {
	const s = code => model.terminalShortcut({ key: '', code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
	assert.equal(s('Equal'), 'zoomIn');
	assert.equal(s('Minus'), 'zoomOut');
	assert.equal(s('Digit0'), 'zoomReset');
});

test('the pane keys are Orca\'s: ⌘D, ⌘⇧D, ⌘W, ⌘], ⌘[, ⌘⇧Enter', () => {
	const s = (code, key, mods = {}) => model.terminalShortcut({ key, code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
	assert.equal(s('KeyD', 'd'), 'splitRight');
	assert.equal(s('KeyD', 'D', { shiftKey: true }), 'splitDown');
	assert.equal(s('BracketRight', ']'), 'nextPane');
	assert.equal(s('BracketLeft', '['), 'previousPane');
	assert.equal(s('Enter', 'Enter', { shiftKey: true }), 'expandPane');
	assert.equal(s('Enter', 'Enter'), undefined);
	assert.equal(s('BracketRight', '}', { shiftKey: true }), 'nextSession', '⌘⇧] the next session of the folder (Orca: next tab)');
	assert.equal(s('BracketLeft', '{', { shiftKey: true }), 'previousSession');
	assert.equal(s('KeyD', 'd', { metaKey: false, ctrlKey: true }), undefined, 'Ctrl+D (end of input) goes to the program');
});

test('panes split, close and step the way a person expects', () => {
	let l = { pane: 'a' };
	l = model.splitPane(l, 'a', 'b', 'row');
	assert.deepEqual(model.paneIds(l), ['a', 'b']);
	l = model.splitPane(l, 'b', 'c', 'row');
	assert.deepEqual(l.children.length, 3, 'the same way again adds a sibling');
	l = model.splitPane(l, 'b', 'd', 'column');
	assert.deepEqual(model.paneIds(l), ['a', 'b', 'd', 'c']);
	assert.equal(l.children[1].dir, 'column');
	assert.equal(model.stepPane(l, 'c', 1), 'a', 'wraps around');
	assert.equal(model.stepPane(l, 'a', -1), 'c');
	l = model.removePane(l, 'd');
	assert.deepEqual(l.children.map(c => c.pane), ['a', 'b', 'c'], 'a column of one becomes its pane');
	assert.equal(model.removePane({ pane: 'a' }, 'a'), undefined);
});

test('a kept layout drops panes that are gone and always holds the session\'s own', () => {
	const raw = { dir: 'row', children: [{ pane: 'a' }, { dir: 'column', children: [{ pane: 'x' }, { pane: 'b' }], sizes: [1, 1] }], sizes: [300, 200] };
	const l = model.sanePaneLayout(raw, 'a', new Set(['b']));
	assert.deepEqual(l, { dir: 'row', children: [{ pane: 'a' }, { pane: 'b' }], sizes: [300, 200] });
	assert.deepEqual(model.sanePaneLayout({ pane: 'zzz' }, 'a', new Set()), { pane: 'a' });
	assert.deepEqual(model.sanePaneLayout('nonsense', 'a', new Set()), { pane: 'a' });
});

test('a copy leaves out the margin an agent draws its reply behind, and nothing else', () => {
	assert.equal(model.copyableSelection('  Done.\n    - one\n  Next'), 'Done.\n  - one\nNext');
	assert.equal(model.copyableSelection('$ ls\n  a'), '$ ls\n  a', 'a line at the left edge keeps it as it was');
	assert.equal(model.copyableSelection('  a\n\n  b'), 'a\n\nb', 'blank lines say nothing');
	assert.equal(model.copyableSelection('  a\r\n  b'), 'a\r\nb');
});

test('sub-agents: in the foreground back with their result, in the background back with their notification', () => {
	const line = o => JSON.stringify(o);
	const t = '2026-10-02T10:00:00.000Z';
	const text = [
		line({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', id: 'fg', name: 'Task', input: { description: 'Read the docs', subagent_type: 'Explore', model: 'sonnet' } }] } }),
		line({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { description: 'Port the daemon' } }] } }),
		line({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', id: 'bad', name: 'Task', input: { description: 'Try a thing' } }] } }),
		line({ type: 'user', timestamp: '2026-10-02T10:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'fg', content: [{ type: 'text', text: 'Found it.' }] }] } }),
		line({ type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', tool_use_id: 'bg', content: 'Async agent launched successfully. agentId: a1' }] } }),
		line({ type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: 'boom' }] } }),
		line({ type: 'user', isSidechain: true, timestamp: t, message: { content: [{ type: 'tool_use', id: 'inner', name: 'Task', input: { description: 'nested' } }] } }),
	].join('\n');
	let subs = model.claudeSubAgents(text);
	assert.deepEqual(subs.map(s => [s.id, s.name, s.done, !!s.failed]), [['fg', 'Read the docs', true, false], ['bg', 'Port the daemon', false, false], ['bad', 'Try a thing', true, true]]);
	assert.equal(subs[0].model, 'sonnet');
	assert.equal(subs[0].endedAt - subs[0].startedAt, 60000, 'how long it ran');
	const later = text + '\n' + line({ type: 'user', timestamp: '2026-10-02T10:05:00.000Z', message: { content: '<task-notification>\n<task-id>x</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n</task-notification>' } });
	subs = model.claudeSubAgents(later);
	assert.equal(subs[1].done, true, 'the background one is back when its notification says so');
	assert.equal(subs[1].endedAt - subs[1].startedAt, 300000);
	assert.deepEqual(model.readSubAgentMeta('{"toolUseId":"bg","model":"opus","agentType":"general-purpose"}'), { toolUseId: 'bg', model: 'opus', parent: undefined });
	assert.equal(model.claudeSubAgentsFolder('/h/.claude/projects/p/abc.jsonl'), '/h/.claude/projects/p/abc/subagents');
});

test('a pane dragged onto another pane goes to the edge it is dropped nearest to', () => {
	const two = { dir: 'row', children: [{ pane: 'a' }, { pane: 'b' }] };
	assert.deepEqual(model.paneSideAt(0.1, 0.5), 'left');
	assert.deepEqual(model.paneSideAt(0.9, 0.4), 'right');
	assert.deepEqual(model.paneSideAt(0.5, 0.05), 'top');
	assert.deepEqual(model.paneSideAt(0.45, 0.95), 'bottom');
	// b to a's left: the row turns around
	assert.deepEqual(model.paneIds(model.movePane(two, 'b', 'a', 'left')), ['b', 'a']);
	// b under a: one column of two
	assert.deepEqual(model.movePane(two, 'b', 'a', 'bottom'), { dir: 'column', children: [{ pane: 'a' }, { pane: 'b' }] });
	// c out of a column into the row, above b
	const three = { dir: 'row', children: [{ pane: 'a' }, { dir: 'column', children: [{ pane: 'b' }, { pane: 'c' }] }] };
	assert.deepEqual(JSON.parse(JSON.stringify(model.movePane(three, 'c', 'a', 'top'))), { dir: 'row', children: [{ dir: 'column', children: [{ pane: 'c' }, { pane: 'a' }] }, { pane: 'b' }] });
	// nothing to move: the same layout
	assert.equal(model.movePane(two, 'a', 'a', 'left'), two);
	assert.equal(model.movePane(two, 'x', 'a', 'left'), two);
});

test('the pane, session and text-size keys are commands the person can rebind; the basic five stay the terminal own', () => {
	assert.equal(model.shortcutOfCommand('dispatch.terminal.splitRight'), 'splitRight');
	assert.equal(model.shortcutOfCommand('dispatch.terminal.zoomIn'), 'zoomIn');
	assert.equal(model.shortcutOfCommand('dispatch.terminal.paste'), undefined);
	assert.equal(model.shortcutOfCommand('workbench.action.closeWindow'), undefined);
	assert.equal(model.shortcutOfCommand(null), undefined);
	for (const s of ['paste', 'copy', 'selectAll', 'clear', 'find']) {
		assert.ok(!model.REBINDABLE_SHORTCUTS.includes(s), s);
	}
});

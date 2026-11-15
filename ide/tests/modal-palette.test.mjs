import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const root = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const m = await import(pathToFileURL(path.join(root, 'workbench/contrib/dispatchModalPalette/common/dispatchModalPalette.ts')));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('F1 and ⇧⌘P are one command, and a modal editor lets it through (task-oprqa)', () => {
	const commands = read('workbench/contrib/quickaccess/browser/commandsQuickAccess.ts');
	assert.match(commands, /static readonly ID = 'workbench\.action\.showCommands'/);
	assert.match(commands, /primary: !isFirefox \? \(KeyMod\.CtrlCmd \| KeyMod\.Shift \| KeyCode\.KeyP\)/);
	assert.match(commands, /secondary: \[KeyCode\.F1\]/);
	assert.deepEqual([...m.MODAL_PALETTE_COMMANDS], ['workbench.action.showCommands']);
});

test('the modal editor still stops what is not on its list, and the list is the one Dispatch adds to', () => {
	const modal = read('workbench/browser/parts/editor/modalEditorPart.ts');
	assert.match(modal, /export const defaultModalEditorAllowableCommands = new Set\(\[/);
	assert.match(modal, /!defaultModalEditorAllowableCommands\.has\(resolved\.commandId\)/);
	// when VS Code lets the palette through itself, this hook can go
	const list = modal.slice(modal.indexOf('defaultModalEditorAllowableCommands = new Set(['), modal.indexOf(']);', modal.indexOf('defaultModalEditorAllowableCommands = new Set([')));
	assert.ok(!list.includes("'workbench.action.showCommands'"), 'VS Code lists the palette itself now: drop ui10');
	const contribution = read('workbench/contrib/dispatchModalPalette/browser/dispatchModalPalette.contribution.ts');
	assert.match(contribution, /defaultModalEditorAllowableCommands\.add\(id\)/);
	for (const main of ['workbench/workbench.desktop.main.ts', 'sessions/sessions.desktop.main.ts']) {
		assert.match(read(main), /dispatchModalPalette\/browser\/dispatchModalPalette\.contribution\.js/, main);
	}
});

test('a toolbar drawn again takes the focus back only from itself or from nothing, not from the palette', () => {
	const bar = read('base/browser/ui/actionbar/actionbar.ts');
	const at = bar.indexOf('We should preserve focus #97128');
	assert.ok(at > 0);
	const guard = bar.slice(bar.lastIndexOf('if (', at), at);
	assert.match(guard, /active === active\.ownerDocument\.body/);
	assert.match(guard, /DOM\.isAncestor\(active, this\.domNode\)/);
});

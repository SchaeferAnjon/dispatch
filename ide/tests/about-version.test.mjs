// The About dialog's first line is Dispatch's version (product.json dispatchVersion, kanban task-mpidn): the same as the
// CLI's VERSION and the app's package.json, which release.sh checks before it publishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('product.json says the version app/cli/VERSION and app/package.json say', () => {
	const product = JSON.parse(read('../vscode/product.json'));
	const cli = read('../../app/cli/VERSION').trim();
	assert.match(cli, /^\d+\.\d+\.\d+$/);
	assert.equal(product.dispatchVersion, cli);
	assert.equal(JSON.parse(read('../../app/package.json')).version, cli);
});

test('both About dialogs put "Dispatch <version>" first and call VS Code\'s version VS Code', () => {
	for (const file of ['../vscode/src/vs/platform/dialogs/electron-browser/dialog.ts', '../vscode/src/vs/workbench/browser/parts/dialogs/dialog.ts']) {
		const src = read(file);
		assert.match(src, /`Dispatch \$\{productService\.dispatchVersion\}\\n`/, file);
		assert.match(src, /"VS Code: \{0\}\\n/, file);
	}
});

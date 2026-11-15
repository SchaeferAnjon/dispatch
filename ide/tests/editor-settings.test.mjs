import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('workbench/contrib/dispatchEditorSettings/browser/dispatchEditorSettingsModel.ts'));

const s = { tab: { enabled: true, model: 'deepseek-flash', cap_usd: 0.5, today: { count: 3, usd: 0.0012 }, month: { count: 9, usd: 0.004 } }, tab_models: [], edit_model: 'claude:sonnet', edit_models: [] };

test('the editor window\'s four settings carry Dispatch\'s values (task-9rj7k)', () => {
 assert.deepEqual(m.settingValues(s), { 'dispatch.editor.tabCompletion': true, 'dispatch.editor.tabCompletionModel': 'deepseek-flash', 'dispatch.editor.tabCompletionDailyCap': 0.5, 'dispatch.editor.rewriteModel': 'claude:sonnet' });
 for (const k of m.EDITOR_SETTING_KEYS) {
  assert.ok(k.startsWith(m.EDITOR_SETTINGS_QUERY), k);
 }
});

test('a change there is saved as the Dispatch setting it is, checked', () => {
 assert.deepEqual(m.savePatch(m.TAB_ENABLED, false), { ide_tab_completion: false });
 assert.deepEqual(m.savePatch(m.TAB_MODEL, 'claude:haiku'), { ide_tab_model: 'claude:haiku' });
 assert.deepEqual(m.savePatch(m.TAB_CAP, 0.255), { ide_tab_daily_cap_usd: 0.26 });
 assert.deepEqual(m.savePatch(m.EDIT_MODEL, 'codex:gpt-6-astra'), { ide_edit_model: 'codex:gpt-6-astra' });
 assert.equal(m.savePatch(m.TAB_CAP, -1), undefined);
 assert.equal(m.savePatch(m.TAB_ENABLED, 'yes'), undefined);
 assert.equal(m.savePatch('editor.fontSize', 12), undefined);
 assert.equal(m.money(0.0012), '$0.0012');
});

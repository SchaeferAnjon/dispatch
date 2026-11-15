import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('platform/agentHost/node/opencode/opencodeSkillTurn.ts'));

// what OpenCode 1.18.34 stores for `/neat-freak` (packages/opencode/src/command/index.ts: the skill's content, the
// base directory lines, then what was typed after the command when the skill has no $ARGUMENTS)
const SKILL = '# 洁癖 — Knowledge and Governance Closeout\n\n> 改编自 KKKKhazix/khazix-skills …\n\n' + 'A line of the skill.\n'.repeat(200).trim();
const TAIL = dir => `\n\nBase directory for this skill: ${dir}\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`;

test('a replayed /neat-freak turn reads as the command, not the skill file (task-wkq5g)', () => {
	const text = SKILL + TAIL('/Users/me/.dispatch/skills/neat-freak');
	assert.deepEqual(m.openCodeSkillTurn(text), { name: 'neat-freak', args: '' });
	assert.equal(m.openCodeUserText(text), '/neat-freak');
});

test('what was typed after the command stays with it', () => {
	const text = SKILL + TAIL('/Applications/Dispatch IDE.app/Contents/Resources/app/dispatch-cli/dispatch/agent/skills/delivery-page/') + '\n\nfor the login page';
	assert.equal(m.openCodeUserText(text), '/delivery-page for the login page');
});

test('a message the person typed is left as it is, even one that talks about skills', () => {
	for (const text of ['Fix the login bug', 'What does "Base directory for this skill: x" mean?', '/neat-freak', '']) {
		assert.equal(m.openCodeSkillTurn(text), undefined, text);
		assert.equal(m.openCodeUserText(text), text);
	}
});

test('a Windows folder names the skill too', () => {
	assert.equal(m.openCodeUserText('body' + TAIL('C:\\Users\\me\\.dispatch\\skills\\built-in-browser')), '/built-in-browser');
});

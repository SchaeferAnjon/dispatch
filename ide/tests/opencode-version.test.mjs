import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const v = await import(moduleAt('platform/agentHost/node/opencode/opencodeVersion.ts'));
const notice = await import(moduleAt('sessions/contrib/dispatchOpenCodeVersion/browser/dispatchOpenCodeVersionModel.ts'));

const at = (p, text) => ({ path: p, version: v.parseOpenCodeVersion(text) });

test('the minimum is 1.18.0, the same as engines.py MIN_VERSIONS', () => {
 assert.deepEqual([...v.OPENCODE_MIN_VERSION], [1, 18, 0]);
 assert.equal(v.openCodeMinVersionText(), '1.18.0');
});
// the CLI's OpenCode adapter (engines/opencode.py since engines became a package; the old engines.py check
// skipped itself for good once that file was gone)
const kanban = process.env.DISPATCH_REPO ?? fileURLToPath(new URL('../../kanban', import.meta.url));
const adapter = path.join(kanban, 'app/cli/engines/opencode.py');
test('the kanban repo (DISPATCH_REPO) has the same minimum in engines/opencode.py', { skip: !existsSync(adapter) && 'no kanban checkout next to this one (set DISPATCH_REPO)' }, () => {
 assert.match(readFileSync(adapter, 'utf8'), /min_version = \(1, 18, 0\)/);
});
test('versions parse from `opencode --version` output', () => {
 assert.deepEqual(v.parseOpenCodeVersion('1.18.32\n'), [1, 18, 32]);
 assert.deepEqual(v.parseOpenCodeVersion('opencode 1.14.31'), [1, 14, 31]);
 assert.deepEqual(v.parseOpenCodeVersion('2.0'), [2, 0, 0]);
 assert.equal(v.parseOpenCodeVersion('no number'), undefined);
 assert.equal(v.parseOpenCodeVersion(undefined), undefined);
});
test('supported means 1.18.0 or newer', () => {
 for (const ok of [[1, 18, 0], [1, 18, 32], [1, 19, 0], [2, 0, 0]]) assert.equal(v.isSupportedOpenCodeVersion(ok), true, ok.join('.'));
 for (const bad of [[1, 17, 99], [1, 14, 31], [0, 99, 0]]) assert.equal(v.isSupportedOpenCodeVersion(bad), false, bad.join('.'));
 assert.equal(v.isSupportedOpenCodeVersion(undefined), false);
});
test('an older copy in front does not shadow a new one behind it', () => {
 const pick = v.pickOpenCode([at('/home/.opencode/bin/opencode', '1.14.31'), at('/home/.bun/bin/opencode', '1.18.32')]);
 assert.equal(pick.binary, '/home/.bun/bin/opencode');
 assert.equal(pick.version, '1.18.32');
 assert.equal(pick.supported, true);
});
test('the first new enough copy wins, in search order', () => {
 const pick = v.pickOpenCode([at('/a', '1.18.0'), at('/b', '1.19.4')]);
 assert.equal(pick.binary, '/a');
});
test('all older: the newest is returned and flagged unsupported', () => {
 const pick = v.pickOpenCode([at('/a', '1.14.31'), at('/b', '1.17.9'), at('/c', '1.2.0')]);
 assert.equal(pick.binary, '/b');
 assert.equal(pick.version, '1.17.9');
 assert.equal(pick.supported, false);
 assert.equal(pick.candidates.length, 3);
});
test('a copy that prints no version loses to one that does, and alone it is unsupported', () => {
 assert.equal(v.pickOpenCode([at('/a', 'garbage'), at('/b', '1.14.31')]).binary, '/b');
 const alone = v.pickOpenCode([at('/a', 'garbage')]);
 assert.equal(alone.binary, '/a');
 assert.equal(alone.supported, false);
 assert.equal(alone.version, '');
});
test('no copy, no pick', () => {
 assert.equal(v.pickOpenCode([]), undefined);
});
test('the too old message names both versions', () => {
 const message = v.openCodeTooOldMessage(v.pickOpenCode([at('/a', '1.14.31')]));
 assert.match(message, /OpenCode 1\.14\.31 is older than the 1\.18\.0/);
 assert.match(message, /dispatch engines upgrade opencode/);
});

function fakeOpenCode(dir, version) {
 mkdirSync(dir, { recursive: true });
 const file = path.join(dir, 'opencode');
 writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
 chmodSync(file, 0o755);
 return file;
}
test('real files: candidates keep search order and drop the same file twice', () => {
 const root = mkdtempSync(path.join(tmpdir(), 'ocv-'));
 const old = fakeOpenCode(path.join(root, 'old'), '1.14.31');
 const fresh = fakeOpenCode(path.join(root, 'new'), '1.18.32');
 mkdirSync(path.join(root, 'link'));
 symlinkSync(fresh, path.join(root, 'link', 'opencode'));
 const list = v.opencodeCandidatePaths([path.join(root, 'nothing'), path.join(root, 'old'), path.join(root, 'new'), path.join(root, 'link'), ''].join(path.delimiter));
 assert.deepEqual(list, [old, fresh]);
});
test('real files: resolveOpenCode runs --version and picks the new one', async () => {
 const root = mkdtempSync(path.join(tmpdir(), 'ocv-'));
 fakeOpenCode(path.join(root, 'old'), '1.14.31');
 const fresh = fakeOpenCode(path.join(root, 'new'), '1.18.32');
 const pick = await v.resolveOpenCode([path.join(root, 'old'), path.join(root, 'new')].join(path.delimiter), process.env);
 assert.equal(pick.binary, fresh);
 assert.equal(pick.supported, true);
});
test('real files: only an old copy gives the unsupported pick, and an upgrade in place is seen', async () => {
 const root = mkdtempSync(path.join(tmpdir(), 'ocv-'));
 const old = fakeOpenCode(path.join(root, 'old'), '1.14.31');
 const searchPath = path.join(root, 'old');
 const before = await v.resolveOpenCode(searchPath, process.env);
 assert.equal(before.binary, old);
 assert.equal(before.supported, false);
 assert.equal(before.version, '1.14.31');
 // the installer replaces the file: a new size / mtime asks again
 fakeOpenCode(path.join(root, 'old'), '1.18.32 # upgraded');
 const after = await v.resolveOpenCode(searchPath, process.env);
 assert.equal(after.version, '1.18.32');
 assert.equal(after.supported, true);
});
test('real files: no opencode at all', async () => {
 const root = mkdtempSync(path.join(tmpdir(), 'ocv-'));
 assert.equal(await v.resolveOpenCode(root, process.env), undefined);
});

test('the notice shows only for an installed OpenCode that the CLI says is too old', () => {
 const row = over => ({ id: 'opencode', installed: true, version: '1.14.31', min_version: '1.18.0', supported: false, command: 'opencode upgrade', ...over });
 assert.equal(notice.openCodeTooOld([row({})]).version, '1.14.31');
 assert.equal(notice.openCodeTooOld([row({ supported: true, version: '1.18.32' })]), undefined);
 assert.equal(notice.openCodeTooOld([row({ installed: false })]), undefined);
 assert.equal(notice.openCodeTooOld([row({ supported: undefined })]), undefined);
 assert.equal(notice.openCodeTooOld([row({ min_version: '' })]), undefined);
 assert.equal(notice.openCodeTooOld([row({ id: 'codex' })]), undefined);
 assert.equal(notice.openCodeTooOld(undefined), undefined);
 assert.equal(notice.openCodeTooOld([]), undefined);
});

// the notice's look (designer review 2026-09-29) lives in CSS and two small hooks in native files: keep them in step
const sourceOf = relative => readFileSync(src ? path.join(src, 'src/vs', relative) : new URL('../vscode/src/vs/' + relative, import.meta.url), 'utf8');
const css = () => sourceOf('sessions/contrib/dispatchOpenCodeVersion/browser/media/dispatchOpenCodeVersion.css');
const block = (text, selector) => {
 const at = text.indexOf(selector + ' {');
 assert.ok(at >= 0, `no rule for ${selector}`);
 return text.slice(at, text.indexOf('}', at));
};
test('the notice and the input are one shell: the top corners of the input (--dispatch-radius-input), the input squares its own', () => {
 const notice = block(css(), '.chat-input-notice.chat-input-notification-widget.severity-error');
 assert.match(notice, /border-radius: var\(--dispatch-radius-input\) var\(--dispatch-radius-input\) 0 0/);
 assert.match(notice, /border-color: var\(--vscode-agentsChatInput-border/);
 assert.match(notice, /background-color: var\(--vscode-agentsChatInput-background/);
 assert.match(css(), /border-top-left-radius: 0;\s+border-top-right-radius: 0;\s+border-top-width: 0;\s+padding-top: 1px;/);
});
test('title 13/500, description 12, xs button 24 high with 8 on the sides and 12/500', () => {
 const text = css();
 const title = block(text, '.chat-input-notice.chat-input-notification-widget.severity-error .chat-input-notification-title');
 assert.match(title, /font-size: 13px/);
 assert.match(title, /font-weight: 500/);
 assert.match(block(text, '.chat-input-notice.chat-input-notification-widget.severity-error .chat-input-notification-description'), /font-size: 12px/);
 const button = block(text, '.chat-input-notice.chat-input-notification-widget.severity-error .chat-input-notification-action-button');
 assert.match(button, /height: 24px/);
 assert.match(button, /padding: 0 8px/);
 assert.match(button, /font-size: 12px/);
 assert.match(button, /font-weight: 500/);
});
test('the input keeps its place: the CSS variable the contribution sets is the one the CSS reads', () => {
 const contribution = sourceOf('sessions/contrib/dispatchOpenCodeVersion/browser/dispatchOpenCodeVersion.contribution.ts');
 assert.match(contribution, /NOTICE_HEIGHT_VAR = '--dispatch-notice-height'/);
 assert.match(block(css(), '.agent-sessions-workbench .new-chat-widget-content'), /margin-top: calc\(-1 \* var\(--dispatch-notice-height, 0px\)\)/);
});
test('the wait bar: the classes the widget draws are the classes the CSS styles, 4 high, 1.5s linear', () => {
 const widget = sourceOf('workbench/contrib/chat/browser/widget/input/chatInputNotificationWidget.ts');
 assert.match(widget, /\$\('\.chat-input-notification-progress'\)/);
 assert.match(widget, /\$\('\.chat-input-notification-progress-band'\)/);
 const text = css();
 assert.match(block(text, '.chat-input-notification-widget .chat-input-notification-progress'), /height: 4px/);
 assert.match(block(text, '.chat-input-notification-widget .chat-input-notification-progress-band'), /animation: dispatch-notice-sweep 1\.5s linear infinite alternate/);
 assert.match(sourceOf('sessions/contrib/dispatchOpenCodeVersion/browser/dispatchOpenCodeVersion.contribution.ts'), /progress: true/);
});

const keep = await import(moduleAt('platform/agentHost/node/opencode/opencodeModelKeep.ts'));

test('a listing that misses a provider once keeps its models; twice in a row drops them (task-8hy0)', () => {
 const m = (providerId, id) => ({ providerId, id });
 const before = [m('deepseek', 'deepseek/flash'), m('zhipuai-coding-plan', 'zhipuai-coding-plan/glm-5.3-flash'), m('opencode', 'opencode/big-pickle')];
 const short = [m('deepseek', 'deepseek/flash'), m('opencode', 'opencode/big-pickle')];
 const once = keep.keepMissingProviders(before, short, new Set());
 assert.deepEqual(once.kept, ['zhipuai-coding-plan']);
 assert.deepEqual(once.dropped, []);
 assert.ok(once.models.some(x => x.id === 'zhipuai-coding-plan/glm-5.3-flash'));
 const twice = keep.keepMissingProviders(once.models, short, new Set(once.kept));
 assert.deepEqual(twice.kept, []);
 assert.deepEqual(twice.dropped, ['zhipuai-coding-plan']);
 assert.ok(!twice.models.some(x => x.providerId === 'zhipuai-coding-plan'));
 const back = keep.keepMissingProviders(once.models, before, new Set(once.kept));
 assert.deepEqual([back.kept, back.dropped, back.models.length], [[], [], 3]);
 assert.deepEqual(keep.keepMissingProviders([], short, new Set()).models, short);
});

test('a provider whose key OpenCode keeps stays listed however many listings miss it (task-8hy0)', () => {
 const m = (providerId, id) => ({ providerId, id });
 const before = [m('deepseek', 'deepseek/flash'), m('zhipuai-coding-plan', 'zhipuai-coding-plan/glm-5.3-flash')];
 const short = [m('deepseek', 'deepseek/flash')];
 const configured = keep.configuredProviders({ 'zhipuai-coding-plan': { type: 'api' }, deepseek: {} }, [{ provider: { mine: {} } }, null, 'x']);
 assert.deepEqual([...configured].sort(), ['deepseek', 'mine', 'zhipuai-coding-plan']);
 const twice = keep.keepMissingProviders(before, short, new Set(['zhipuai-coding-plan']), configured);
 assert.deepEqual([twice.kept, twice.dropped], [['zhipuai-coding-plan'], []]);
 assert.ok(twice.models.some(x => x.id === 'zhipuai-coding-plan/glm-5.3-flash'));
});

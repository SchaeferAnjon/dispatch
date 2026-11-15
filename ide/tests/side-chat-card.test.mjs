// The side chat card (direction A「Bottom-right card」, user 2026-11-15, task-23iin, kanban design/side-chat): where it
// sits and how big, what its pill says, the passage it lights in a document, and the answers kept as comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const M = await import(pathToFileURL(path.join(vs, 'sessions/contrib/dispatchSideChat/common/dispatchSideChatModel.ts')));

test('a wide window: 380 wide, at most 470 high, 16 from the side pane\'s bottom right corner', () => {
	// the prototype's 1440 × 887 window: its side pane is 682 × 819
	assert.deepEqual(M.cardBox(682, 819, 1440), { right: 16, bottom: 16, width: 380, height: 470, narrow: false });
	// a short pane leaves its top 96 free (the tabs and the document's head)
	assert.equal(M.cardBox(682, 500, 1440).height, 388, 'the top 96 free above a card 16 off the bottom');
	assert.equal(M.cardBox(682, 536, 1440).height, 424, 'under the terminal (task-q9x2r): the card\'s top 96 below the pane\'s');
	// a pane narrower than the card: the card fits inside it, 16 each side
	assert.equal(M.cardBox(380, 819, 1440).width, 348);
	// never shorter than 240 while the pane has room, never taller than the pane
	assert.equal(M.cardBox(682, 300, 1440).height, 240);
	assert.equal(M.cardBox(682, 200, 1440).height, 168);
});

test('a window 1200 wide or less: the card fills the pane\'s width, 12 each side, 58% of its height up to 420', () => {
	assert.deepEqual(M.cardBox(500, 700, 1100), { right: 12, bottom: 12, width: 476, height: 406, narrow: true });
	assert.equal(M.cardBox(500, 900, 1100).height, 420);
	assert.equal(M.cardBox(500, 700, 1200).narrow, true);
	assert.equal(M.cardBox(500, 700, 1201).narrow, false);
	assert.equal(M.pillOffset(1100), 12);
	assert.equal(M.pillOffset(1440), 16);
});

test('the pill: Answering while it writes, 500 once an answer came unseen, else just Side chat', () => {
	assert.deepEqual(M.pillLabel(true, 0), { text: 'Side chat · Answering', bold: false, answering: true });
	assert.deepEqual(M.pillLabel(true, 1), { text: 'Side chat · Answering', bold: false, answering: true }, 'writing again: that comes first');
	assert.deepEqual(M.pillLabel(false, 1), { text: 'Side chat · 1 new answer', bold: true, answering: false });
	assert.deepEqual(M.pillLabel(false, 2), { text: 'Side chat · 2 new answers', bold: true, answering: false });
	assert.deepEqual(M.pillLabel(false, 0), { text: 'Side chat', bold: false, answering: false });
	assert.equal(M.unreadAfterAnswer('open', 0), 0, 'seen as it came');
	assert.equal(M.unreadAfterAnswer('min', 0), 1);
	assert.equal(M.unreadAfterAnswer('closed', 1), 2);
});

test('the quote\'s second line names the file and its lines; the words are one line', () => {
	assert.equal(M.passageWhere({ path: '/p/docs/HANDOFF.md', start: 3, end: 3 }), 'HANDOFF.md · line 3');
	assert.equal(M.passageWhere({ path: '/p/docs/HANDOFF.md', start: 3, end: 5 }), 'HANDOFF.md · lines 3-5');
	assert.equal(M.passageLine('任务：Folio Reader\n迁到本机   并对照'), '任务：Folio Reader 迁到本机 并对照');
	assert.equal(M.passageLine('a'.repeat(200), 10), 'aaaaaaaaa…');
	assert.equal(M.fileName('/a/b/c.md'), 'c.md');
});

test('a side chat without a known passage: the selection it carries is `<file>:<lines>` then the words', () => {
	assert.deepEqual(M.splitSelection('docs/HANDOFF.md:3\n任务：Folio Reader'), { where: 'HANDOFF.md · line 3', text: '任务：Folio Reader' });
	assert.deepEqual(M.splitSelection('docs/HANDOFF.md:3-5\nline one\nline two'), { where: 'HANDOFF.md · lines 3-5', text: 'line one\nline two' });
	assert.deepEqual(M.splitSelection('words from a reply\nand more'), { where: '', text: 'words from a reply\nand more' }, 'a reply\'s words carry no place');
	assert.deepEqual(M.splitSelection(undefined), { where: '', text: '' });
});

test('the passage is found in the page\'s words when line breaks and spaces differ', () => {
	const hay = 'Intro.\n任务：Folio Reader 迁到本机\n并对照 Folioread 补齐功能。 Tail';
	const at = M.findPassage(hay, '任务：Folio Reader 迁到本机 并对照 Folioread');
	assert.ok(at);
	assert.equal(hay.slice(at.start, at.end), '任务：Folio Reader 迁到本机\n并对照 Folioread');
	assert.deepEqual(M.findPassage(hay, '  Intro.  '), { start: 0, end: 6 }, 'the selection\'s own spaces at the ends do not count');
	assert.deepEqual(M.findPassage(hay, 'Intro.'), { start: 0, end: 6 });
	assert.equal(M.findPassage(hay, 'not there'), undefined);
	assert.equal(M.findPassage(hay, '   '), undefined);
});

test('comments: one per answer and passage, a document\'s own top to bottom, nothing that is not one', () => {
	const c = (o) => ({ id: 'x', path: '/p/a.md', start: 3, end: 3, text: 't', body: 'b', at: 1, ...o });
	let all = M.withComment([], c({ id: '1' }));
	all = M.withComment(all, c({ id: '2' }));
	assert.equal(all.length, 1, 'the same answer kept twice on the same passage stays one');
	all = M.withComment(all, c({ id: '3', start: 1, end: 2, body: 'other' }));
	all = M.withComment(all, c({ id: '4', path: '/p/b.md' }));
	assert.deepEqual(M.commentsOf(all, '/p/a.md').map(x => x.id), ['3', '1']);
	assert.deepEqual(M.parseComments(JSON.stringify([...all, { id: 5 }, null, 'x'])).map(x => x.id), ['1', '3', '4']);
	assert.deepEqual(M.parseComments('not json'), []);
	assert.deepEqual(M.parseComments(undefined), []);
});

test('the quote names where it was asked: a file\'s lines, Changes for a diff, Terminal, or the place given (task-q9x2r)', () => {
	assert.equal(M.passageSource({ path: '/p/src/reminder.ts', start: 3, end: 3 }), 'reminder.ts · line 3');
	assert.equal(M.passageSource({ path: '/p/src/reminder.ts', start: 3, end: 4, from: 'file' }), 'reminder.ts · lines 3-4');
	assert.equal(M.passageSource({ path: '/p/src/reminder.ts', start: 3, end: 3, from: 'diff' }), 'reminder.ts · line 3 · Changes');
	assert.equal(M.passageSource({ path: '', start: 0, end: 0, from: 'terminal' }), 'Terminal');
	assert.equal(M.passageSource({ path: '', start: 1, end: 1, from: 'learn', where: 'Command · Installed' }), 'Command · Installed');
});

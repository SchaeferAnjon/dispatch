/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: task mentions in chat replies (patches/330-task-links.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { findTaskRefs, titleWrittenBefore } from '../../browser/widget/chatContentParts/dispatchTaskRefs.js';

function refs(text: string): { id: string; label: string; drop: string; bare: boolean }[] {
	return findTaskRefs(text).map(r => ({ id: r.id, label: text.slice(r.labelStart, r.labelEnd), drop: text.slice(r.start, r.end), bare: r.bare }));
}

suite('Dispatch task mentions', () => {

	test('a title with the id in brackets: the title is the link, the id goes', () => {
		assert.deepStrictEqual(refs('做完了仓库拆分修 Bug（task-2vcx），接着做下一个。'), [{ id: 'task-2vcx', label: '做完了仓库拆分修 Bug', drop: '（task-2vcx）', bare: false }]);
		assert.deepStrictEqual(refs('已提交。仓库拆分修 Bug（task-2vcx）'), [{ id: 'task-2vcx', label: '仓库拆分修 Bug', drop: '（task-2vcx）', bare: false }]);
		assert.deepStrictEqual(refs('Done: Fix the login (task-a1b2).'), [{ id: 'task-a1b2', label: 'Fix the login', drop: ' (task-a1b2)', bare: false }]);
	});

	test('a quoted title: only the words inside the quotes', () => {
		assert.deepStrictEqual(refs('我把「仓库拆分修 Bug」（task-2vcx）做完了'), [{ id: 'task-2vcx', label: '仓库拆分修 Bug', drop: '（task-2vcx）', bare: false }]);
		assert.deepStrictEqual(refs('Finished "Fix the login" (task-a1b2)'), [{ id: 'task-a1b2', label: 'Fix the login', drop: ' (task-a1b2)', bare: false }]);
	});

	test('two in one line', () => {
		assert.deepStrictEqual(refs('我的世界（task-aa11）、超级玛丽（task-bb22）').map(r => r.label), ['我的世界', '超级玛丽']);
	});

	test('nothing before the bracket in this text: the element before is the title', () => {
		assert.deepStrictEqual(refs('（task-2vcx）已完成'), [{ id: 'task-2vcx', label: '', drop: '（task-2vcx）', bare: false }]);
	});

	test('a bare id, or a bracket after a break or a long sentence, shows the title from the board', () => {
		assert.deepStrictEqual(refs('见 task-2vcx 的记录'), [{ id: 'task-2vcx', label: '', drop: 'task-2vcx', bare: true }]);
		assert.deepStrictEqual(refs('做完了。（task-2vcx）'), [{ id: 'task-2vcx', label: '', drop: '（task-2vcx）', bare: true }]);
		const long = 'I went through every single file in the repository and rewrote the parts that were slow (task-2vcx)';
		assert.strictEqual(refs(long)[0].bare, true);
	});

	test('the title already written before a bare id shows once (task-lj06.30)', () => {
		const before = 'Dark mode is on the board in Later (Add dark mode, ';
		assert.deepStrictEqual(refs(before + 'task-fsn)'), [{ id: 'task-fsn', label: '', drop: 'task-fsn', bare: true }]);
		const cut = titleWrittenBefore(before, 'Add dark mode');
		assert.strictEqual(before.slice(0, before.length - cut), 'Dark mode is on the board in Later (');
		assert.strictEqual(titleWrittenBefore('Done: add dark mode: ', 'Add dark mode'), 'add dark mode: '.length);
		assert.strictEqual(titleWrittenBefore('我加了暗色模式 ', '暗色模式'), '暗色模式 '.length);
		assert.strictEqual(titleWrittenBefore('See ', 'Add dark mode'), -1);
		assert.strictEqual(titleWrittenBefore('Undark mode, ', 'dark mode'), -1);
		assert.strictEqual(titleWrittenBefore('', 'Add dark mode'), -1);
	});

	test('leaves other things alone', () => {
		assert.deepStrictEqual(refs('subtask-abc, v1.2.3, (issue-12), mytask-12'), []);
	});
});

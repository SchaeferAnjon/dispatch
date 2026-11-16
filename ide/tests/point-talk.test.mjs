// Point and talk (direction A, the person picked it 2026-11-16, task-0y0km; kanban design/screen-talk): where the
// pointer rested, Soniox's words as sentences (real tokens of a 13.5 s take in fixtures/point-talk-tokens.json), which
// spots become keyframes and their numbers, the red box, and the message the agent gets read back for the bubble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const M = await import(pathToFileURL(path.join(vs, 'sessions/contrib/dispatchPointTalk/common/dispatchPointTalkModel.ts')));
const TOKENS = JSON.parse(readFileSync(new URL('./fixtures/point-talk-tokens.json', import.meta.url), 'utf8')).tokens;

test('times read m:ss', () => {
	assert.equal(M.clock(0), '0:00');
	assert.equal(M.clock(7.9), '0:07');
	assert.equal(M.clock(65), '1:05');
	assert.equal(M.clock(-3), '0:00');
});

const still = (tracker, x, y, from, to, step = 100) => {
	const marked = [];
	for (let t = from; t <= to; t += step) {
		const r = tracker.push({ t, x, y });
		if (r) {
			marked.push(r);
		}
	}
	return marked;
};

test('a pointer still for a second marks one spot, and not again until it moves on', () => {
	const r = new M.RestTracker();
	assert.deepEqual(still(r, 100, 100, 0, 900), [], 'not yet a second');
	const first = still(r, 102, 99, 1000, 4000);
	assert.equal(first.length, 1, 'a few points of wobble is still resting, and one stop is one spot');
	assert.deepEqual([first[0].n, first[0].t, first[0].x, first[0].y], [1, 0, 100, 100]);
	assert.equal(first[0].until, 4000, 'the rest lasts as long as the pointer stays');
	assert.deepEqual(still(r, 112, 100, 4100, 6000), [], 'moved a little, rested again close by: the same spot');
	const second = still(r, 400, 300, 6100, 7200);
	assert.equal(second.length, 1);
	assert.deepEqual([second[0].n, second[0].x, second[0].y], [2, 400, 300]);
	assert.equal(r.rests.length, 2);
});

test('the pointer leaving the display breaks a rest', () => {
	const r = new M.RestTracker();
	still(r, 10, 10, 0, 600);
	r.push(undefined);
	assert.deepEqual(still(r, 10, 10, 700, 1500), [], 'the clock started again when it came back');
	assert.equal(still(r, 10, 10, 1600, 1800).length, 1);
});

test('Soniox tokens become the four sentences that were said, a mark kept with the words before it', () => {
	const s = M.sentencesOf(TOKENS);
	assert.deepEqual(s.map(x => x.text), [
		'这里我把国家切到 Canada。',
		'运费还是 15.4，应该跟着变。',
		'然后点 Pay now 它就一直转圈不停。',
		'两个都修，先修转圈那个。',
	]);
	assert.equal(s[0].start, 210);
	assert.ok(s[0].end < s[1].start, 'a sentence ends at its last word, before the pause');
	assert.ok(s[1].start >= 2900 && s[1].start <= 3000);
});

test('a full stop inside a word token ("ada.") still ends the sentence at a pause', () => {
	const tok = (text, start) => ({ text, start_ms: start, end_ms: start + 60, is_final: true });
	const s = M.sentencesOf([tok('切', 1500), tok('到', 1560), tok(' Can', 1800), tok('ada.', 2100), tok(' ', 2700), tok('运', 2940), tok('费', 3120)]);
	assert.deepEqual(s.map(x => x.text), ['切到 Canada.', '运费']);
});

test('translations and tokens without times are left out; the live words join final and pending', () => {
	assert.deepEqual(M.sentencesOf([{ text: 'fee', translation_status: 'translation' }, { text: '运费', start_ms: 0, end_ms: 100 }]).map(s => s.text), ['运费']);
	assert.equal(M.liveWords([{ text: '这里' }, { text: '我' }], [{ text: '把国家' }, { text: ' x', translation_status: 'translation' }]), '这里我把国家');
});

const rest = (n, t, until, x = 100, y = 100) => ({ n, t, until, x, y });

test('each sentence keeps the spot it was said over; numbers go in time order', () => {
	const sentences = M.sentencesOf(TOKENS);
	// on Ship to while saying the first, on the fee for the second, on Pay now for the third; the fourth said walking away
	const { frames, lines } = M.pickFrames([rest(1, 300, 2600, 170, 137), rest(2, 3000, 5500, 700, 186), rest(3, 6300, 9000, 640, 368)], sentences);
	assert.deepEqual(frames.map(f => [f.n, f.line]), [[1, 0], [2, 1], [3, 2]]);
	assert.deepEqual(lines.map(l => l.n), [1, 2, 3, undefined], 'the last sentence was said without pointing');
	assert.equal(frames[0].t, 0.21, 'a frame shows when its sentence starts');
	assert.deepEqual([frames[2].x, frames[2].y], [640, 368]);
});

test('two spots over one sentence: the one rested on longest stays', () => {
	const sentences = [{ start: 0, end: 5000, text: 'a' }];
	const { frames } = M.pickFrames([rest(1, 500, 1600, 1, 1), rest(2, 2000, 4800, 2, 2)], sentences);
	assert.deepEqual(frames.map(f => [f.n, f.rest]), [[1, 2]]);
});

test('spots without words stay as frames without a line, after those with words, at most eight in all', () => {
	const sentences = [{ start: 0, end: 1000, text: 'a' }];
	const many = Array.from({ length: 12 }, (_, i) => rest(i + 1, 10000 + i * 5000, 11000 + i * 5000 + i * 10));
	const { frames, lines } = M.pickFrames([rest(99, 0, 900), ...many], sentences);
	assert.equal(frames.length, M.MAX_FRAMES);
	assert.equal(frames[0].rest, 99, 'the spot with words is kept');
	assert.equal(lines[0].n, 1);
	assert.equal(frames.filter(f => f.line === undefined).length, M.MAX_FRAMES - 1);
	assert.ok(!frames.some(f => f.rest === 1), 'the shortest rests without words go first');
});

test('the red box is round the spot in picture pixels and stays inside the picture', () => {
	assert.deepEqual(M.spotBox(700, 400, 2, [2880, 1800]), [1240, 728, 320, 144]);
	assert.deepEqual(M.spotBox(5, 5, 2, [2880, 1800]), [0, 0, 320, 144], 'pushed in at the corner');
	assert.deepEqual(M.spotBox(1440, 900, 2, [2880, 1800]), [2560, 1656, 320, 144]);
	assert.deepEqual(M.spotBox(100, 100, 1, [100, 50]), [0, 0, 100, 50], 'a picture smaller than the box');
});

test('the message the agent gets reads back the same for the bubble', () => {
	const take = {
		note: '看一下结账页',
		duration: 15.4,
		lines: [{ t: 2, text: '这里我把国家切到 Canada，', n: 1 }, { t: 7, text: '运费还是 15.40，\n应该跟着变。', n: 3 }, { t: 12, text: '两个都修。' }],
		folder: '/Users/me/.dispatch/recordings/2026-11-16/0912',
		video: '/Users/me/.dispatch/recordings/2026-11-16/0912/screen.mp4',
	};
	const text = M.composeMessage(take);
	assert.ok(text.startsWith('看一下结账页\n\nPoint and talk · 0:15 screen recording.'));
	assert.match(text, /\n\[1\] 0:02 这里我把国家切到 Canada，\n\[3\] 0:07 运费还是 15.40，应该跟着变。\n0:12 两个都修。\nVideo: \/Users\/me/);
	const back = M.parseMessage(text);
	assert.equal(back.note, '看一下结账页');
	assert.equal(back.duration, 15);
	assert.deepEqual(back.lines, [{ t: 2, text: '这里我把国家切到 Canada，', n: 1 }, { t: 7, text: '运费还是 15.40，应该跟着变。', n: 3 }, { t: 12, text: '两个都修。', n: undefined }]);
	assert.equal(back.folder, take.folder);
	assert.equal(M.parseMessage('Point and talk is a feature'), undefined, 'a message that only mentions it is not one');
	assert.equal(M.oneLine('fix this\nand that'), 'fix this and that');
	assert.match(M.composeMessage({ ...take, lines: [], note: '' }), /^Point and talk · 0:15 screen recording\. What I said, with when I said it:\n\(nothing was said\)\n/);
});

/** A white picture with a grey-bordered field and a blue button, like the checkout page. */
function page(w, h) {
	const px = new Uint8ClampedArray(w * h * 4).fill(255);
	const rect = (x, y, rw, rh, c) => { for (let j = y; j < y + rh; j++) { for (let i = x; i < x + rw; i++) { const k = (j * w + i) * 4; px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; } } };
	rect(40, 40, 240, 36, [231, 229, 228]);   // the field's border
	rect(41, 41, 238, 34, [255, 255, 255]);   // its inside
	rect(400, 200, 296, 42, [59, 111, 216]);  // the button
	return px;
}

test('the red box snaps to the thing under the pointer, plus 4 points', () => {
	const px = page(800, 400);
	assert.deepEqual(M.snapBox(px, 800, 400, 560, 225, 1), [396, 196, 304, 50], 'the button');
	assert.deepEqual(M.snapBox(px, 800, 400, 150, 60, 1), [37, 37, 246, 42], 'the inside of the field');
	assert.equal(M.snapBox(px, 800, 400, 200, 330, 1), undefined, 'the page itself is no thing: the fixed box is used');
});

test('no space before Chinese punctuation or between Chinese characters; English keeps its spaces', () => {
	assert.equal(M.tidyText(' 然后点 Pay now ，它就一直转圈不停。'), '然后点 Pay now，它就一直转圈不停。');
	assert.equal(M.tidyText('运费 还是 15.4'), '运费还是 15.4');
	assert.equal(M.tidyText('Fix both, the spinner first.'), 'Fix both, the spinner first.');
});

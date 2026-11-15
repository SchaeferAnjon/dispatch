// Dispatch terminal daemon: the unparsed end of a terminal stream.
//
// Ported from Orca (https://github.com/stablyai/orca), src/shared/terminal-partial-escape-tail.ts and
// src/shared/terminal-escape-introducer.ts. Copyright (c) 2026 Lovecast Inc. MIT License, full text in
// ORCA-LICENSE.txt next to this file.
//
// A read from the shell can end in the middle of an escape sequence. The bytes already given to the
// emulator sit in its parser, not on the screen, so a saved screen cannot carry them, and the next
// chunk would then print as plain text after a restore. Keeping the trailing partial sequence lets a
// snapshot end with it, so the continuation completes exactly as it would have live.
'use strict';

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;

/** Past this the tail is dropped: OSC and DCS payloads have no length limit. */
const MAX_PARTIAL_ESCAPE_TAIL_LENGTH = 4096;

/** What the code unit after ESC opens. NaN (ESC at the end) reads as 'final'. */
function classifyEscapeIntroducer(code) {
	if (code === 0x5b) { return 'csi'; }
	if (code === 0x5d) { return 'osc'; }
	if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) { return 'string'; }
	if (code >= 0x20 && code <= 0x2f) { return 'intermediate'; }
	if (code < 0x20 || code === 0x7f) { return 'execute'; }
	return 'final';
}

function stateAfterEscByte(code) {
	switch (classifyEscapeIntroducer(code)) {
		case 'csi': return 'csi';
		case 'osc': return 'osc';
		case 'string': return 'string';
		case 'intermediate': return 'escIntermediate';
		case 'execute': return 'esc';
		default: return 'ground';
	}
}

/**
 * The trailing incomplete escape sequence of `stream` ('' when it ends clean). Fold-safe:
 * extract(a + b) === extract(extract(a) + b).
 */
function extractPartialEscapeTail(stream) {
	let state = 'ground';
	let start = 0;
	for (let i = 0; i < stream.length; i++) {
		if (state === 'ground') {
			const escape = stream.charCodeAt(i) === ESC ? i : stream.indexOf('\x1b', i);
			if (escape === -1) {
				return '';
			}
			start = escape;
			i = escape;
			state = 'esc';
			continue;
		}
		const code = stream.charCodeAt(i);
		if (code === ESC && state !== 'osc' && state !== 'string' && state !== 'oscEsc' && state !== 'stringEsc') {
			start = i;
			state = 'esc';
			continue;
		}
		if ((code === CAN || code === SUB) && (state === 'esc' || state === 'escIntermediate')) {
			state = 'ground';
			continue;
		}
		switch (state) {
			case 'esc':
				state = stateAfterEscByte(code);
				break;
			case 'escIntermediate':
				if (code >= 0x30 && code <= 0x7e) {
					state = 'ground';
				}
				break;
			case 'csi':
				if (code === CAN || code === SUB || (code >= 0x40 && code <= 0x7e)) {
					state = 'ground';
				}
				break;
			case 'osc':
				if (code === BEL || code === CAN || code === SUB) {
					state = 'ground';
				} else if (code === ESC) {
					state = 'oscEsc';
				}
				break;
			case 'oscEsc':
				if (code === 0x5c) {
					state = 'ground';
				} else {
					start = code === ESC ? i : i - 1;
					state = code === ESC ? 'esc' : code === CAN || code === SUB ? 'ground' : stateAfterEscByte(code);
				}
				break;
			case 'string':
				if (code === CAN || code === SUB) {
					state = 'ground';
				} else if (code === ESC) {
					state = 'stringEsc';
				}
				break;
			case 'stringEsc':
				if (code === 0x5c) {
					state = 'ground';
				} else {
					start = code === ESC ? i : i - 1;
					state = code === ESC ? 'esc' : code === CAN || code === SUB ? 'ground' : stateAfterEscByte(code);
				}
				break;
		}
	}
	return state === 'ground' ? '' : stream.slice(start);
}

/** Advance the tracked tail by one chunk; '' when tracking gives up (see the cap). */
function advancePartialEscapeTail(pendingTail, chunk) {
	if (pendingTail.length === 0 && !chunk.includes('\x1b')) {
		return '';
	}
	const tail = extractPartialEscapeTail(pendingTail + chunk);
	return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail;
}

module.exports = { extractPartialEscapeTail, advancePartialEscapeTail, classifyEscapeIntroducer, MAX_PARTIAL_ESCAPE_TAIL_LENGTH };

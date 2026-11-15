// Dispatch terminal daemon: the smallest WebSocket server the window needs (RFC 6455, text messages).
//
// The Agents window talks to the daemon straight from its page (its content policy allows ws:), so the
// keystrokes and the screen do not go through any other process. Only 127.0.0.1 listens, and every
// connection must carry the daemon's token (a file only this user can read).
'use strict';

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

function acceptKey(key) {
	return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** One frame, server to client: never masked. */
function encodeFrame(opcode, payload) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = len;
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = 0x80 | opcode;
	return Buffer.concat([header, payload]);
}

/**
 * Splits `buffer` into frames. Returns the frames found and what is left over (an unfinished frame).
 * Throws on a frame no client may send (unmasked) or one too big.
 */
function decodeFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (buffer.length - offset >= 2) {
		const b0 = buffer[offset];
		const b1 = buffer[offset + 1];
		const fin = (b0 & 0x80) !== 0;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let len = b1 & 0x7f;
		let pos = offset + 2;
		if (len === 126) {
			if (buffer.length - pos < 2) { break; }
			len = buffer.readUInt16BE(pos);
			pos += 2;
		} else if (len === 127) {
			if (buffer.length - pos < 8) { break; }
			const big = buffer.readBigUInt64BE(pos);
			if (big > BigInt(MAX_MESSAGE)) { throw new Error('frame too large'); }
			len = Number(big);
			pos += 8;
		}
		if (!masked) {
			throw new Error('client frames must be masked');
		}
		if (buffer.length - pos < 4 + len) {
			break;
		}
		const mask = buffer.subarray(pos, pos + 4);
		pos += 4;
		const payload = Buffer.allocUnsafe(len);
		for (let i = 0; i < len; i++) {
			payload[i] = buffer[pos + i] ^ mask[i & 3];
		}
		frames.push({ fin, opcode, payload });
		offset = pos + len;
	}
	return { frames, rest: buffer.subarray(offset) };
}

/** A connection after the handshake: `onMessage(text)`, `send(text)`, `close()`. */
class WsConnection {
	constructor(socket) {
		this.socket = socket;
		this.pending = Buffer.alloc(0);
		this.fragments = [];
		this.closed = false;
		this.onMessage = () => { };
		this.onClose = () => { };
		socket.setNoDelay(true);
		socket.on('data', chunk => this._data(chunk));
		socket.on('close', () => this._closed());
		socket.on('error', () => this._closed());
	}

	_data(chunk) {
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		let decoded;
		try {
			decoded = decodeFrames(this.pending);
		} catch {
			this.close(1002);
			return;
		}
		this.pending = Buffer.from(decoded.rest);
		for (const frame of decoded.frames) {
			if (frame.opcode === 0x8) {
				this.close(1000);
				return;
			}
			if (frame.opcode === 0x9) {
				this._write(encodeFrame(0xA, frame.payload));
				continue;
			}
			if (frame.opcode === 0xA) {
				continue;
			}
			if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
				this.fragments.push(frame.payload);
				if (frame.fin) {
					const whole = Buffer.concat(this.fragments);
					this.fragments = [];
					try {
						this.onMessage(whole.toString('utf8'));
					} catch (e) {
						process.stderr.write(`termd: message failed: ${e && e.stack || e}\n`);
					}
				}
			}
		}
	}

	_write(buf) {
		if (!this.closed && !this.socket.destroyed) {
			this.socket.write(buf);
		}
	}

	send(text) {
		this._write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
	}

	/** Bytes still waiting to go out: the daemon slows a flood down when the window cannot keep up. */
	get buffered() {
		return this.socket.writableLength;
	}

	close(code = 1000) {
		if (this.closed) {
			return;
		}
		const body = Buffer.alloc(2);
		body.writeUInt16BE(code, 0);
		this._write(encodeFrame(0x8, body));
		this.socket.end();
		this._closed();
	}

	_closed() {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.onClose();
	}
}

/**
 * Takes over an HTTP upgrade request. Returns the connection, or undefined after answering 400 for a
 * request that is not a WebSocket handshake.
 */
function acceptUpgrade(req, socket) {
	const key = req.headers['sec-websocket-key'];
	if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
		socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
		return undefined;
	}
	socket.write([
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Accept: ${acceptKey(key)}`,
		'', '',
	].join('\r\n'));
	return new WsConnection(socket);
}

/** Client side, for the daemon's own tests and `dispatch terminal daemon` checks: one masked frame. */
function encodeClientFrame(opcode, payload) {
	const server = encodeFrame(opcode, payload);
	const headerLen = server.length - payload.length;
	const header = Buffer.from(server.subarray(0, headerLen));
	header[1] |= 0x80;
	const mask = crypto.randomBytes(4);
	const body = Buffer.allocUnsafe(payload.length);
	for (let i = 0; i < payload.length; i++) {
		body[i] = payload[i] ^ mask[i & 3];
	}
	return Buffer.concat([header, mask, body]);
}

module.exports = { acceptUpgrade, acceptKey, encodeFrame, decodeFrames, encodeClientFrame, WsConnection };

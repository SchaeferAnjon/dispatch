#!/usr/bin/env python3
"""Minimal QR encoder: byte mode, error correction level L, versions 1-10. Standard library only.

Only what `dispatch serve qr` needs: a URL is short, so byte mode up to version 10 (271 bytes)
covers it and keeps the spec tables small. Three renderers share one matrix: Unicode half
blocks for the terminal, SVG for the settings page, and the raw matrix for tests.

Reference: ISO/IEC 18004. Tested against the `qrcode` package matrices and decoded with
macOS Vision (see test_qr.py).
"""
from typing import List, Sequence

# version -> data codewords (level L), error codewords per block, and the data codewords of each block
_DATA_CW = {1: 19, 2: 34, 3: 55, 4: 80, 5: 108, 6: 136, 7: 156, 8: 194, 9: 232, 10: 274}
_EC_CW = {1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18, 7: 20, 8: 24, 9: 30, 10: 18}
_BLOCKS = {1: [19], 2: [34], 3: [55], 4: [80], 5: [108], 6: [68, 68], 7: [78, 78], 8: [97, 97], 9: [116, 116], 10: [68, 68, 69, 69]}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]}
# byte-mode payload capacity per version at level L
CAPACITY = {v: _DATA_CW[v] - (1 if v <= 9 else 2) - 1 for v in _DATA_CW}
_FINDER = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
]

# GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _generator(n: int) -> List[int]:
    """Product (x - a^0)…(x - a^(n-1)); index 0 is the x^n coefficient."""
    g = [1]
    for i in range(n):
        nxt = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            nxt[j] ^= c
            nxt[j + 1] ^= _mul(c, _EXP[i])
        g = nxt
    return g


def _rs_remainder(data: Sequence[int], ec_len: int) -> List[int]:
    gen = _generator(ec_len)
    rem = [0] * ec_len
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        if factor:
            for i in range(ec_len):
                rem[i] ^= _mul(gen[i + 1], factor)
    return rem


def _bch(data: int, generator: int) -> int:
    d = data << (generator.bit_length() - 1)
    while d.bit_length() >= generator.bit_length():
        d ^= generator << (d.bit_length() - generator.bit_length())
    return d


def _format_bits(mask: int) -> int:
    """15-bit format information: level L (01) + mask, BCH(15,5), fixed XOR mask."""
    data = (0b01 << 3) | mask
    return ((data << 10) | _bch(data, 0x537)) ^ 0x5412


def _version_bits(version: int) -> int:
    """18-bit version information (versions 7+): version + BCH(18,6)."""
    return (version << 12) | _bch(version, 0x1F25)


def _choose_version(n: int) -> int:
    for v in sorted(CAPACITY):
        if n <= CAPACITY[v]:
            return v
    raise ValueError(f"内容太长（{n} 字节），这个编码器最多支持 {CAPACITY[10]} 字节")


def _codewords(data: bytes, version: int) -> List[int]:
    bits = "0100"  # byte mode
    bits += format(len(data), "08b" if version <= 9 else "016b")
    for b in data:
        bits += format(b, "08b")
    cap = _DATA_CW[version] * 8
    bits += "0" * min(4, cap - len(bits))
    bits += "0" * (-len(bits) % 8)
    words = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]
    k = 0
    while len(words) < _DATA_CW[version]:
        words.append(pad[k % 2])
        k += 1
    return words


def _interleave(words: List[int], version: int) -> List[int]:
    ec_len = _EC_CW[version]
    blocks, pos = [], 0
    for n in _BLOCKS[version]:
        blocks.append(words[pos:pos + n])
        pos += n
    ecs = [_rs_remainder(b, ec_len) for b in blocks]
    out: List[int] = []
    for i in range(max(len(b) for b in blocks)):
        out += [b[i] for b in blocks if i < len(b)]
    for i in range(ec_len):
        out += [e[i] for e in ecs]
    return out


def _blank(size: int) -> List[List[int]]:
    return [[0] * size for _ in range(size)]


def _function_patterns(version: int):
    """The matrix of function modules plus a reserved mask: data never goes there."""
    size = 17 + 4 * version
    m, reserved = _blank(size), [[False] * size for _ in range(size)]

    def put(r: int, c: int, v: int) -> None:
        if 0 <= r < size and 0 <= c < size:
            m[r][c] = v
            reserved[r][c] = True

    for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                if dr in (-1, 7) or dc in (-1, 7):
                    put(r0 + dr, c0 + dc, 0)  # separator
                else:
                    put(r0 + dr, c0 + dc, _FINDER[dr][dc])
    # Alignment patterns go in before the timing lines: they interrupt them.
    for r in _ALIGN[version]:
        for c in _ALIGN[version]:
            if (r <= 8 and c <= 8) or (r <= 8 and c >= size - 9) or (r >= size - 9 and c <= 8):
                continue  # overlaps a finder
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    put(r + dr, c + dc, 0 if max(abs(dr), abs(dc)) == 1 else 1)
    for i in range(8, size - 8):
        if not reserved[6][i]:
            put(6, i, 1 if i % 2 == 0 else 0)
        if not reserved[i][6]:
            put(i, 6, 1 if i % 2 == 0 else 0)
    put(size - 8, 8, 1)  # dark module

    # Format information cells, two copies (same layout as the spec's Figure 25).
    # Reserve them now, fill after masking.
    fmt1 = [(i, 8) if i < 6 else (i + 1, 8) if i < 8 else (size - 15 + i, 8) for i in range(15)]
    fmt2 = [(8, size - 1 - i) if i < 8 else (8, 7) if i == 8 else (8, 14 - i) for i in range(15)]
    for r, c in fmt1 + fmt2:
        reserved[r][c] = True
    ver1 = ver2 = []
    if version >= 7:
        ver1 = [(i // 3, size - 11 + i % 3) for i in range(18)]
        ver2 = [(size - 11 + i % 3, i // 3) for i in range(18)]
        for r, c in ver1 + ver2:
            reserved[r][c] = True
    return m, reserved, fmt1, fmt2, ver1, ver2


def _mask_bit(mask: int, r: int, c: int) -> bool:
    if mask == 0:
        return (r + c) % 2 == 0
    if mask == 1:
        return r % 2 == 0
    if mask == 2:
        return c % 3 == 0
    if mask == 3:
        return (r + c) % 3 == 0
    if mask == 4:
        return (r // 2 + c // 3) % 2 == 0
    if mask == 5:
        return (r * c) % 2 + (r * c) % 3 == 0
    if mask == 6:
        return ((r * c) % 2 + (r * c) % 3) % 2 == 0
    return ((r + c) % 2 + (r * c) % 3) % 2 == 0


def _penalty(m: List[List[int]]) -> int:
    size, score = len(m), 0
    # rule 1: runs of five or more same-colour modules
    for line in list(m) + [list(col) for col in zip(*m)]:
        run, prev = 0, None
        for v in line:
            if v == prev:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run, prev = 1, v
        if run >= 5:
            score += 3 + (run - 5)
    # rule 2: 2x2 blocks
    for r in range(size - 1):
        for c in range(size - 1):
            v = m[r][c]
            if v == m[r][c + 1] == m[r + 1][c] == m[r + 1][c + 1]:
                score += 3
    # rule 3: 1:1:3:1:1 pattern with four light modules on either side
    pat = [1, 0, 1, 1, 1, 0, 1]
    for line in list(m) + [list(col) for col in zip(*m)]:
        for i in range(len(line) - 6):
            if line[i:i + 7] == pat:
                before = line[max(0, i - 4):i]
                after = line[i + 7:i + 11]
                if len(before) == 4 and not any(before):
                    score += 40
                if len(after) == 4 and not any(after):
                    score += 40
    # rule 4: dark-module proportion
    dark = sum(sum(row) for row in m)
    score += 10 * int(abs(dark * 100 / (size * size) - 50) / 5)
    return score


def matrix(data, mask=None) -> List[List[int]]:
    """QR module matrix (1 = dark) for `data` (str is encoded as UTF-8).

    `mask` forces one of the eight mask patterns (tests); None picks the one with the
    lowest penalty, as the spec asks.
    """
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    version = _choose_version(len(raw))
    words = _interleave(_codewords(raw, version), version)
    bits = "".join(format(w, "08b") for w in words)
    size = 17 + 4 * version
    base, reserved, fmt1, fmt2, ver1, ver2 = _function_patterns(version)

    def with_data(mask: int) -> List[List[int]]:
        m = [row[:] for row in base]
        i, up, col = 0, True, size - 1
        while col > 0:
            if col == 6:
                col -= 1
            rows = range(size - 1, -1, -1) if up else range(size)
            for r in rows:
                for c in (col, col - 1):
                    if not reserved[r][c]:
                        bit = int(bits[i]) if i < len(bits) else 0
                        m[r][c] = bit ^ (1 if _mask_bit(mask, r, c) else 0)
                        i += 1
            up = not up
            col -= 2
        f = _format_bits(mask)
        for j, (r, c) in enumerate(fmt1):
            m[r][c] = (f >> j) & 1
        for j, (r, c) in enumerate(fmt2):
            m[r][c] = (f >> j) & 1
        if version >= 7:
            v = _version_bits(version)
            for j in range(18):
                bit = (v >> j) & 1
                m[ver1[j][0]][ver1[j][1]] = bit
                m[ver2[j][0]][ver2[j][1]] = bit
        return m

    return min((with_data(m) for m in range(8)), key=_penalty) if mask is None else with_data(mask)


def render_blocks(m: List[List[int]], quiet: int = 4) -> str:
    """Terminal rendering: two modules per character cell, half-block glyphs."""
    width = len(m) + 2 * quiet
    pad = [0] * width
    rows = [pad[:] for _ in range(quiet)] + [[0] * quiet + row + [0] * quiet for row in m] + [pad[:] for _ in range(quiet)]
    if len(rows) % 2:
        rows.append(pad[:])
    out = []
    for i in range(0, len(rows), 2):
        top, bot = rows[i], rows[i + 1]
        out.append("".join("█" if t and b else "▀" if t else "▄" if b else " " for t, b in zip(top, bot)))
    return "\n".join(out)


def render_svg(m: List[List[int]], quiet: int = 4, scale: int = 8, dark: str = "#000000", light: str = "#ffffff") -> str:
    """SVG for embedding; one path keeps the markup small. Colours are fixed so a dark UI still scans."""
    dim = (len(m) + 2 * quiet) * scale
    path = []
    for r, row in enumerate(m):
        for c, v in enumerate(row):
            if v:
                x, y = (c + quiet) * scale, (r + quiet) * scale
                path.append(f"M{x} {y}h{scale}v{scale}h-{scale}z")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" width="{dim}" height="{dim}" '
            f'shape-rendering="crispEdges" role="img" aria-label="二维码">'
            f'<rect width="{dim}" height="{dim}" fill="{light}"/>'
            f'<path d="{"".join(path)}" fill="{dark}"/></svg>')


if __name__ == "__main__":
    import sys
    print(render_svg(matrix(sys.argv[1])) if "--svg" in sys.argv else render_blocks(matrix(sys.argv[1])))

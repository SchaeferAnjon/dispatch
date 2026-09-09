"""Tests for the QR encoder. The golden matrices come from the independent `qrcode` package
(same input, version, level L, mask 0, byte mode) and were decoded back with macOS Vision."""
import unittest

import qr

# `a` * 17, version 1, level L, mask 0
GOLDEN_SHORT = [
    "111111100010001111111",
    "100000100000001000001",
    "101110101111101011101",
    "101110100111001011101",
    "101110100010001011101",
    "100000100000001000001",
    "111111101010101111111",
    "000000001100000000000",
    "111011111010111000100",
    "010010011011110111011",
    "111110110001111111111",
    "101101000000000000000",
    "111000100100100010001",
    "000000001101110111011",
    "111111101101111111111",
    "100000101100000000000",
    "101110101110100010001",
    "101110100011110111000",
    "101110101101111111101",
    "100000101110000000010",
    "111111101000100010011",
]
# a real serve URL (73 bytes), version 4, level L, mask 0
GOLDEN_URL = [
    "111111100100101000100011001111111",
    "100000100011110111011111101000001",
    "101110101110100010001001101011101",
    "101110100111011101110010001011101",
    "101110100010001000100111001011101",
    "100000100100010111011011101000001",
    "111111101010101010101010101111111",
    "000000001110111101110100100000000",
    "111011111011100010001111111000100",
    "101001010011010111011010111101101",
    "000001111100001000100000110110001",
    "000001000001011101110111111101010",
    "101001101000100010001000001100001",
    "011101000001110111011100101100101",
    "110001100110001000100010001001011",
    "100010011101011101110110111011010",
    "000101110100100010001001001000011",
    "110111010011110111011100001100101",
    "110000110100001000100010000011011",
    "000101001101011101110110111001010",
    "000110111100100010001001101101011",
    "010111011001110111011100001101001",
    "100101101000001000100010011001111",
    "011101000111011101110111001001010",
    "101101111000100010001001111111000",
    "000000001101110111011100100011011",
    "111111101110001000100011101010111",
    "100000101111011101110111100011000",
    "101110101110100010001000111111000",
    "101110100111110111011100010011010",
    "101110101100001000100010010010111",
    "100000101011011101110110100111010",
    "111111101110100010001000110100011",
]
URL = "http://100.64.1.2:7799/?token=" + "A" * 43


def rows(matrix):
    return ["".join(str(v) for v in row) for row in matrix]


class GoldenMatrix(unittest.TestCase):
    def test_short(self):
        self.assertEqual(rows(qr.matrix("a" * 17, mask=0)), GOLDEN_SHORT)

    def test_serve_url(self):
        self.assertEqual(rows(qr.matrix(URL, mask=0)), GOLDEN_URL)


class VersionSelection(unittest.TestCase):
    def test_capacity_boundaries(self):
        self.assertEqual(qr._choose_version(17), 1)
        self.assertEqual(qr._choose_version(18), 2)
        self.assertEqual(qr._choose_version(78), 4)
        self.assertEqual(qr._choose_version(79), 5)
        self.assertEqual(qr._choose_version(271), 10)

    def test_too_long(self):
        with self.assertRaises(ValueError):
            qr._choose_version(272)

    def test_size_follows_version(self):
        for version in range(1, 11):
            self.assertEqual(len(qr.matrix(b"x" * qr.CAPACITY[version])), 17 + 4 * version)


class Structure(unittest.TestCase):
    def test_finders_and_timing(self):
        m = qr.matrix(URL)
        size = len(m)
        for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
            for dr in range(7):
                for dc in range(7):
                    edge = dr in (0, 6) or dc in (0, 6)
                    core = 2 <= dr <= 4 and 2 <= dc <= 4
                    self.assertEqual(m[r0 + dr][c0 + dc], 1 if edge or core else 0)
        for i in range(8, size - 8):
            self.assertEqual(m[6][i], 1 if i % 2 == 0 else 0)
            self.assertEqual(m[i][6], 1 if i % 2 == 0 else 0)
        self.assertEqual(m[size - 8][8], 1)

    def test_format_info_of_mask_zero(self):
        self.assertEqual(format(qr._format_bits(0), "015b"), "111011111000100")

    def test_auto_mask_returns_a_full_matrix(self):
        m = qr.matrix(URL)
        self.assertEqual(len(m), 33)
        self.assertTrue(all(v in (0, 1) for row in m for v in row))


class Rendering(unittest.TestCase):
    def test_blocks_are_half_height_with_quiet_zone(self):
        m = qr.matrix("a" * 17)
        text = qr.render_blocks(m, quiet=4)
        lines = text.split("\n")
        self.assertEqual(len(lines), (len(m) + 8 + 1) // 2)
        self.assertEqual(len(lines[0]), len(m) + 8)
        self.assertTrue(set(text) <= {"█", "▀", "▄", " ", "\n"})
        # first and last character cells are quiet zone
        self.assertTrue(lines[0][0] == lines[-1][-1] == " ")

    def test_svg_is_one_path_with_quiet_zone(self):
        svg = qr.render_svg(qr.matrix(URL), quiet=4, scale=8)
        self.assertTrue(svg.startswith("<svg "))
        self.assertTrue(svg.endswith("</svg>"))
        self.assertEqual(svg.count("<path"), 1)
        self.assertIn('viewBox="0 0 328 328"', svg)
        self.assertIn('fill="#000000"', svg)

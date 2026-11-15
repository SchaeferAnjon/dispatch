// The extension manifest, its translations and the vsix packer.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module without types
import { crc32, zip } from "../scripts/zip.mjs";

const ext = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ext, p), "utf8");
const pkg = JSON.parse(read("package.json"));

function l10nKeys(): string[] {
  const keys = new Set<string>();
  for (const f of fs.readdirSync(path.join(ext, "src"))) {
    if (!f.endsWith(".ts")) continue;
    const s = read(path.join("src", f));
    for (const m of s.matchAll(/l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
  }
  return [...keys];
}

describe("manifest", () => {
  it("is the dispatch.dispatch-bridge extension ide.py installs", () => {
    expect(`${pkg.publisher}.${pkg.name}`).toBe("dispatch.dispatch-bridge");
    expect(pkg.main).toBe("./out/extension.js");
  });

  it("has every %key% in the English, German and Chinese nls files", () => {
    const used = [...JSON.stringify(pkg.contributes).matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]).concat(["displayName", "description"]);
    for (const f of ["package.nls.json", "package.nls.de.json", "package.nls.zh-cn.json"]) {
      const nls = JSON.parse(read(f));
      for (const k of used) expect(nls[k], `${f}: ${k}`).toBeTruthy();
    }
  });

  it("has a German and a Chinese string for every runtime message", () => {
    const keys = l10nKeys();
    expect(keys.length).toBeGreaterThan(50);
    for (const lang of ["de", "zh-cn"]) {
      const b = JSON.parse(read(`l10n/bundle.l10n.${lang}.json`));
      for (const k of keys) expect(b[k], `${lang}: ${k}`).toBeTruthy();
      // placeholders survive translation
      for (const k of keys) for (const ph of k.match(/\{\d\}/g) || []) expect(b[k]).toContain(ph);
    }
  });

  it("uses no em or en dashes", () => {
    const files = ["package.json", "package.nls.json", "package.nls.de.json", "package.nls.zh-cn.json", "l10n/bundle.l10n.de.json", "l10n/bundle.l10n.zh-cn.json", "README.md"];
    for (const f of files) expect(read(f), f).not.toMatch(/[–—]/);
  });

  it("binds only commands it declares", () => {
    const declared = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    for (const k of pkg.contributes.keybindings) expect(declared.has(k.command), k.command).toBe(true);
    for (const list of Object.values(pkg.contributes.menus) as Array<Array<{ command: string }>>) for (const m of list) expect(declared.has(m.command), m.command).toBe(true);
    const keys = pkg.contributes.keybindings.map((k: { mac?: string; key: string }) => k.mac || k.key);
    expect(keys).toContain("cmd+k");
    expect(keys).toContain("cmd+e");
  });
});

describe("vsix packer", () => {
  it("computes the standard crc32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("writes entries that inflate back, the same bytes every time", () => {
    const entries = [
      { name: "extension/package.json", data: Buffer.from('{"name":"x"}'.repeat(20)) },
      { name: "b.txt", data: Buffer.from("b") },
    ];
    const z: Buffer = zip(entries);
    expect(z.equals(zip(entries))).toBe(true);
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
    expect(z.readUInt16LE(z.length - 12)).toBe(2);
    // first local header
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const method = z.readUInt16LE(8);
    const size = z.readUInt32LE(18);
    const nameLen = z.readUInt16LE(26);
    expect(z.toString("utf8", 30, 30 + nameLen)).toBe("extension/package.json");
    const body = z.subarray(30 + nameLen, 30 + nameLen + size);
    expect(method).toBe(8);
    expect(zlib.inflateRawSync(body).toString()).toBe('{"name":"x"}'.repeat(20));
    expect(z.readUInt32LE(14)).toBe(crc32(entries[0].data));
  });
});

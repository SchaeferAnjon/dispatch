import { describe, expect, it } from "vitest";
import { answerError, cliEnv, cliTarget, lastJson } from "../src/core/cliOutput";

describe("dispatch CLI", () => {
  const has = (...ps: string[]) => (p: string) => ps.includes(p);

  it("prefers the setting, then DISPATCH_BIN, then DISPATCH_CLI, then ~/.local/bin", () => {
    expect(cliTarget({}, "/h", has(), "/opt/dispatch")).toEqual({ cmd: "/opt/dispatch", pre: [] });
    expect(cliTarget({ DISPATCH_BIN: "/r/cli/dispatch.py", DISPATCH_PYTHON: "/py" }, "/h", has("/r/cli/dispatch.py"))).toEqual({ cmd: "/py", pre: ["/r/cli/dispatch.py"] });
    expect(cliTarget({ DISPATCH_BIN: "/usr/local/bin/dispatch" }, "/h", has("/usr/local/bin/dispatch"))).toEqual({ cmd: "/usr/local/bin/dispatch", pre: [] });
    expect(cliTarget({ DISPATCH_BIN: "/gone", DISPATCH_CLI: "/r/d.py" }, "/h", has("/r/d.py"))).toEqual({ cmd: "python3", pre: ["/r/d.py"] });
    expect(cliTarget({}, "/h", has("/h/.local/bin/dispatch"))).toEqual({ cmd: "/h/.local/bin/dispatch", pre: [] });
    expect(cliTarget({}, "/h", has("/opt/homebrew/bin/dispatch"))).toEqual({ cmd: "/opt/homebrew/bin/dispatch", pre: [] });
    // nothing found (a bare PATH from the Dock): still the fixed path, never a bare "dispatch"
    expect(cliTarget({}, "/h", has())).toEqual({ cmd: "/h/.local/bin/dispatch", pre: [] });
  });

  it("falls back to the CLI inside the app when none is installed (a new Mac's first run)", () => {
    const b = "/A/Resources/app/dispatch-cli/dispatch/cli/dispatch.py";
    expect(cliTarget({}, "/h", has(b), "", b)).toEqual({ cmd: "python3", pre: [b] });
    // an installed one still wins: it is what the wizard links, or a developer's checkout
    expect(cliTarget({}, "/h", has(b, "/h/.local/bin/dispatch"), "", b)).toEqual({ cmd: "/h/.local/bin/dispatch", pre: [] });
    // an app without the bundled CLI keeps the old answer
    expect(cliTarget({}, "/h", has(), "", b)).toEqual({ cmd: "/h/.local/bin/dispatch", pre: [] });
  });

  it("adds the tool folders a bare PATH lacks, after what is there", () => {
    expect(cliEnv({ PATH: "/usr/bin:/bin" }, "", "/h").PATH).toBe("/usr/bin:/bin:/h/.local/bin:/opt/homebrew/bin:/usr/local/bin");
    expect(cliEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }, "", "/h").PATH).toBe("/opt/homebrew/bin:/usr/bin:/h/.local/bin:/usr/local/bin");
    expect(cliEnv({ PATH: "/bin" }).PATH).toBe("/bin");
  });

  it("never hands the code-server password to the CLI", () => {
    const e = cliEnv({ PASSWORD: "s", HASHED_PASSWORD: "h", PATH: "/bin" });
    expect(e.PASSWORD).toBeUndefined();
    expect(e.HASHED_PASSWORD).toBeUndefined();
    expect(e.PATH).toBe("/bin");
  });

  it("hands the CLI Dispatch IDE's bin folder when there is one", () => {
    expect(cliEnv({ PATH: "/bin" }, "/App/Contents/Resources/app/tools").DISPATCH_IDE_BIN).toBe("/App/Contents/Resources/app/tools");
    expect(cliEnv({ PATH: "/bin" }).DISPATCH_IDE_BIN).toBeUndefined();
  });

  it("reads the last JSON line and ok:false answers", () => {
    expect(lastJson('{"progress": 0.5}\n{"ok": true, "x": 1}\n')).toEqual({ ok: true, x: 1 });
    expect(lastJson("[1,2]")).toEqual([1, 2]);
    expect(lastJson('[\n  {"a": 1}\n]\n')).toEqual([{ a: 1 }]);
    expect(lastJson("plain text")).toBeUndefined();
    expect(answerError({ ok: false, error: "conflict", message: "m" })).toEqual({ code: "conflict", message: "m" });
    expect(answerError({ ok: false, unsupported: true })).toEqual({ code: "unsupported", message: "unsupported" });
    expect(answerError({ ok: true })).toBeUndefined();
    expect(answerError([])).toBeUndefined();
  });
});

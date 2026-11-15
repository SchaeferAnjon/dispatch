import { describe, expect, it } from "vitest";
import { authLoginTerminal, OPENCODE_INSTALL_PLUGIN_ARGS, opencodeBinary, opencodeStatusArgs } from "../src/core/opencode";

describe("OpenCode bridge", () => {
  it("asks the CLI for OpenCode's status, refreshing the allowance only when asked", () => {
    expect(opencodeStatusArgs(undefined)).toEqual(["engines", "status", "opencode", "--json"]);
    expect(opencodeStatusArgs(false)).toEqual(["engines", "status", "opencode", "--json"]);
    expect(opencodeStatusArgs(true)).toEqual(["engines", "status", "opencode", "--json", "--refresh"]);
    expect(opencodeStatusArgs("yes")).toEqual(["engines", "status", "opencode", "--json"]);
    expect(OPENCODE_INSTALL_PLUGIN_ARGS).toEqual(["engines", "install-plugin", "opencode", "--json"]);
  });

  it("runs auth login in a shell that closes quietly when given up and waits after a failure", () => {
    const t = authLoginTerminal("/Users/x/.bun/bin/opencode", "darwin");
    expect(t.shellPath).toBe("/bin/sh");
    expect(t.shellArgs[0]).toBe("-c");
    expect(t.shellArgs[1]).toContain("trap 'exit 0' INT; '/Users/x/.bun/bin/opencode' auth login ||");
    expect(authLoginTerminal("/o'dd/opencode", "linux").shellArgs[1]).toContain("'/o'\\''dd/opencode' auth login");
    expect(authLoginTerminal("C:\\bin\\opencode.exe", "win32")).toEqual({ shellPath: "C:\\bin\\opencode.exe", shellArgs: ["auth", "login"] });
  });

  it("runs auth login with the binary the CLI found, else the usual places, else PATH", () => {
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(opencodeBinary("/Users/x/.bun/bin/opencode", "/Users/x", has("/Users/x/.bun/bin/opencode"))).toBe("/Users/x/.bun/bin/opencode");
    expect(opencodeBinary("/gone/opencode", "/Users/x", has("/opt/homebrew/bin/opencode"))).toBe("/opt/homebrew/bin/opencode");
    expect(opencodeBinary(undefined, "/Users/x", has("/Users/x/.opencode/bin/opencode", "/opt/homebrew/bin/opencode"))).toBe("/Users/x/.opencode/bin/opencode");
    expect(opencodeBinary("", "/Users/x", has())).toBe("opencode");
  });
});

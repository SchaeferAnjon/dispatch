import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { jsonLines, limitWindows, machinesArgs, remoteFolder, serverCommands, serverStartScript, sshAuthority, withAuthority } from "../src/core/machines";

describe("server install", () => {
  const c = "92b4277a62a7e0f0572aa846242655dbe03ca94c";
  it("targets the folder Open Remote - SSH looks in", () => {
    const s = serverCommands(".dispatch-ide-server", "dispatch-ide-server", c)!;
    expect(s.check).toBe(`uname -sm; test -x "$HOME/.dispatch-ide-server/bin/${c}"/bin/dispatch-ide-server && echo present || true`);
    expect(s.install).toContain(`tar -xzf - -C "$HOME/.dispatch-ide-server/bin/${c}.part" --strip-components 1`);
    expect(s.install.endsWith("echo installed")).toBe(true);
  });
  it("starts the server in the logged-in session with the extension's own files", () => {
    const s = serverStartScript(".dispatch-ide-server", "dispatch-ide-server", c)!;
    expect(s).toContain(`C="${c}"`);
    expect(s).toContain('launchctl bootstrap "gui/$(id -u)" "$P"');
    expect(s).toContain("<string>--connection-token-file</string><string>$TOK</string>");
    expect(s).toContain('PID="$D/.$C.pid"; LOG="$D/.$C.log"; TOK="$D/.$C.token"');
    execFileSync("bash", ["-n"], { input: s }); // the script parses
    expect(serverStartScript("a b", "x", c)).toBeUndefined();
  });
  it("refuses values that are not plain names", () => {
    expect(serverCommands("a b", "x", c)).toBeUndefined();
    expect(serverCommands(".d", "x;rm", c)).toBeUndefined();
    expect(serverCommands(".d", "x", "abc")).toBeUndefined();
    expect(serverCommands(".d", "-x", c)).toBeUndefined();
  });
});

describe("machines", () => {
  it("lists, and asks one Mac", () => {
    expect(machinesArgs(undefined)).toEqual(["machines", "--json"]);
    expect(machinesArgs("sessions", "kiwi-mac-mini")).toEqual(["machines", "sessions", "kiwi-mac-mini", "--json"]);
    expect(machinesArgs("projects", "local")).toBeUndefined();
  });
  it("refuses a host that is not an id", () => {
    expect(machinesArgs("sessions", "--json")).toBeUndefined();
    expect(machinesArgs("projects", "a b")).toBeUndefined();
    expect(machinesArgs("projects", "mini; rm -rf /")).toBeUndefined();
    expect(machinesArgs("ssh", "mini")).toBeUndefined();
  });
  it("adds, checks, edits and removes machines through `dispatch hosts`", () => {
    expect(machinesArgs("refresh", "mini")).toEqual(["hosts", "--refresh", "mini", "--json"]);
    expect(machinesArgs("discover")).toEqual(["hosts", "discover", "--json"]);
    expect(machinesArgs("check", "100.64.0.11", "apple")).toEqual(["hosts", "add", "100.64.0.11", "--user", "apple", "--check", "--json"]);
    expect(machinesArgs("check", "mac-mini.tail1.ts.net", "apple", "pw")).toEqual(["hosts", "add", "mac-mini.tail1.ts.net", "--user", "apple", "--check", "--json", "--password-stdin"]);
    expect(machinesArgs("check", "fd7a:115c::1", "apple")?.[2]).toBe("fd7a:115c::1");
    expect(machinesArgs("add", "100.64.0.11", "apple", " mini ")).toEqual(["hosts", "add", "100.64.0.11", "--user", "apple", "--name", "mini", "--json"]);
    expect(machinesArgs("add", "100.64.0.11", "apple", "Studio 的 Mac")).toContain("Studio 的 Mac");
    expect(machinesArgs("set", "mini", { name: "mini 2" })).toEqual(["hosts", "set", "mini", "--name", "mini 2", "--json"]);
    expect(machinesArgs("set", "mini", { address: "10.0.0.2", user: "apple" })).toEqual(["hosts", "set", "mini", "--address", "10.0.0.2", "--user", "apple", "--json"]);
    expect(machinesArgs("remove", "mini")).toEqual(["hosts", "remove", "mini", "--json"]);
  });
  it("refuses what would read as an option or a second line", () => {
    expect(machinesArgs("check", "-oProxyCommand=x", "apple")).toBeUndefined();
    expect(machinesArgs("check", "10.0.0.2", "-l")).toBeUndefined();
    expect(machinesArgs("add", "10.0.0.2", "apple", "--name")).toBeUndefined();
    expect(machinesArgs("add", "10.0.0.2", "apple", "a\nb")).toBeUndefined();
    expect(machinesArgs("add", "10.0.0.2", "apple", "")).toBeUndefined();
    expect(machinesArgs("set", "mini", {})).toBeUndefined();
    expect(machinesArgs("set", "mini", { address: "a b" })).toBeUndefined();
    expect(machinesArgs("set", "mini", "name")).toBeUndefined();
    expect(machinesArgs("remove", "local")).toBeUndefined();
    expect(machinesArgs("refresh", "--all")).toBeUndefined();
  });
});

describe("machine rows", () => {
  it("gives each other Mac its window's authority", () => {
    const rows = withAuthority([
      { id: "local", name: "小蓝", local: true },
      { id: "mini", label: "mini", local: false, ssh: "apple@100.64.0.11" },
    ]);
    expect(rows[0].authority).toBeUndefined();
    expect(rows[1].name).toBe("mini");
    expect(rows[1].authority).toBe(sshAuthority("apple@100.64.0.11"));
  });
  it("reads streamed check lines", () => {
    const out = 'noise\n{"step":"reach","state":"ok"}\n{"step":"login","state":"need_password"}\n{bad\n{"done":true,"ok":false}\n';
    expect(jsonLines(out)).toEqual([{ step: "reach", state: "ok" }, { step: "login", state: "need_password" }, { done: true, ok: false }]);
  });
});

describe("limit windows", () => {
  const rows = [
    { agent: "claude-code", windows: [
      { kind: "session", label: "5 小时", used_percent: 74, resets_at: 1790556600.4 },
      { kind: "weekly", label: "每周", used_percent: 59, resets_at: 1790827200.4 },
      { kind: "weekly_model", label: "每周 · Fable", used_percent: 52, resets_at: 1790827200.5 },
    ] },
    { agent: "codex", windows: [{ label: "每周", used_percent: 6, resets_at: 1791053154 }, { label: "5 小时", used_percent: 1 }, { label: "?", used_percent: 3 }] },
  ];
  it("keeps every Claude window with its kind", () => {
    expect(limitWindows(rows, "claude-code").map((w) => [w.kind, w.usedPercent])).toEqual([["session", 74], ["weekly", 59], ["weekly_model", 52]]);
  });
  it("reads a window without a kind from its label", () => {
    expect(limitWindows(rows, "codex")).toEqual([
      { kind: "weekly", label: "Weekly", usedPercent: 6, resetsAt: 1791053154 },
      { kind: "session", label: "5h", usedPercent: 1 },
    ]);
    expect(limitWindows(undefined, "codex")).toEqual([]);
    expect(limitWindows(rows, "claude-code").map((w) => w.label)).toEqual(["5h", "Weekly", "Weekly · Fable"]);
    expect(limitWindows([{ agent: "codex", windows: [{ label: "Weekly", used_percent: 12 }, { label: "5h", used_percent: 25 }] }], "codex").map((w) => w.kind)).toEqual(["weekly", "session"]);
    expect(limitWindows(rows, "zcode")).toEqual([]);
  });
});


describe("remote ssh", () => {
  it("encodes the destination the way Open Remote - SSH parses it", () => {
    const a = sshAuthority("apple@100.64.0.11")!;
    expect(a.startsWith("ssh-remote+")).toBe(true);
    expect(JSON.parse(Buffer.from(a.slice(11), "hex").toString())).toEqual({ hostName: "100.64.0.11", user: "apple" });
    expect(JSON.parse(Buffer.from(sshAuthority("mini")!.slice(11), "hex").toString())).toEqual({ hostName: "mini" });
  });
  it("refuses odd targets and paths", () => {
    expect(sshAuthority("-oProxyCommand=x")).toBeUndefined();
    expect(sshAuthority("a b@c")).toBeUndefined();
    expect(sshAuthority("")).toBeUndefined();
    expect(remoteFolder("/Users/apple/Projects/会议记录")).toBe("/Users/apple/Projects/会议记录");
    expect(remoteFolder("relative")).toBeUndefined();
    expect(remoteFolder("/a/../b")).toBeUndefined();
  });
});

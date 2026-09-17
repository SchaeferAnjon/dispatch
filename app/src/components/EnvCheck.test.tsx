import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api, EnvReport } from "../api";
import { EnvCheck } from "./EnvCheck";

const api = { copy: async () => {} } as unknown as Api;
const report = (over: Partial<EnvReport>): EnvReport => ({ python: { path: null, version: null, ok: false }, brew: null, bd: null, dolt: null, herdr: null, tmux: null, tailscale: null, git: null, clt: false, macos: "15.1", arch: "aarch64", cli: "/Applications/Dispatch.app/Contents/Resources/cli/dispatch.py", cli_exists: true, ...over });

describe("EnvCheck", () => {
  it("a fresh Mac: says Python is missing and offers the Command Line Tools when there is no Homebrew", () => {
    const html = renderToStaticMarkup(<EnvCheck api={api} report={report({})} error="No usable Python found" onRetry={async () => {}} />);
    expect(html).toContain("没找到 3.9 或更新的版本");
    expect(html).toContain('title="xcode-select --install"');
    expect(html).toContain("重新检查");
    expect(html).toContain("还没装 Xcode 命令行工具");
  });
  it("with Homebrew present the Python fix is a brew command, and found tools show their path", () => {
    const html = renderToStaticMarkup(<EnvCheck api={api} report={report({ brew: "/opt/homebrew/bin/brew", bd: "/opt/homebrew/bin/bd", clt: true })} error="" onRetry={async () => {}} />);
    expect(html).toContain('title="brew install python@3.12"');
    expect(html).toContain("/opt/homebrew/bin/bd");
    expect(html).not.toContain("原始错误");
  });
  it("a broken bundle is named", () => {
    const html = renderToStaticMarkup(<EnvCheck api={api} report={report({ python: { path: "/usr/bin/python3", version: "3.9.6", ok: true }, cli_exists: false })} error="x" onRetry={async () => {}} />);
    expect(html).toContain("应用包里没找到命令行文件");
  });
});

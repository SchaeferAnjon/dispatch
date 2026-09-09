import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "../api";
import { SetupView, type InitStatus } from "./Setup";

const api = { on: async () => "", copy: async () => {}, openPath: async () => {} } as unknown as Api;
const noop = () => {};

function statusWith(board: Record<string, unknown>): InitStatus {
  const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, ok: true, detail: "", ...extra });
  return {
    done: false, skipped: false, all_ok: true, machine: { name: "mac", user: "me", tailscale_ip: "100.1.1.2", lan_ip: "" },
    state: {},
    steps: [step("deps"), step("cli"), step("board", { board }), step("agents"), step("rules"), step("review", { optional: true })],
  };
}

const render = (board: Record<string, unknown>) =>
  renderToStaticMarkup(<SetupView api={api} status={statusWith(board)} onStatus={noop} onDone={noop} onError={noop} onNotify={noop} />);

const joined = { exists: true, server_up: true, mode: "join", hub: { name: "hub-mac", ssh: "hub@100.1.1.1" } };

describe("SetupView reverse ssh", () => {
  it("says the hub can ssh back once the check passed", () => {
    const html = render({ ...joined, reverse_ssh: { checked: true, ok: true, ssh: "me@100.1.1.2", hub: "hub@100.1.1.1" } });
    expect(html).toContain("能连回本机");
    expect(html).toContain("me@100.1.1.2");
  });

  it("points at 远程登录 when the hub cannot reach back", () => {
    const html = render({ ...joined, reverse_ssh: { checked: true, ok: false, ssh: "me@100.1.1.2", hint: "本机没在监听 ssh：「远程登录」没开。系统设置 → 通用 → 共享 → 打开「远程登录」，打开后点「检查一次」。" } });
    expect(html).toContain("枢纽连不回本机");
    expect(html).toContain("远程登录");
  });

  it("offers a check when nothing has been checked yet", () => {
    const html = render(joined);
    expect(html).toContain("还没检查");
    expect(html).toContain("检查一次");
  });

  it("keeps the row off the hub itself", () => {
    const html = render({ exists: true, server_up: true, mode: "first", hub: null });
    expect(html).not.toContain("连回本机");
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { targets } from "./cdp.mjs";

afterEach(() => vi.unstubAllGlobals());

function serveTargets() {
  const items = [
    { type: "page", id: "window", url: "vscode-file://sessions.html" },
    { type: "iframe", id: "delivery", url: "http://127.0.0.1:63000/token/index.html" },
    { type: "worker", id: "worker", url: "" },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => items }));
}

it("finds a Docs delivery iframe as well as standalone pages", async () => {
  serveTargets();
  expect((await targets(63551, ["page", "iframe"])).map(t => t.id)).toEqual(["window", "delivery"]);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:63551/json/list");
});

it("keeps window-only discovery as the default", async () => {
  serveTargets();
  expect((await targets(63551)).map(t => t.id)).toEqual(["window"]);
});

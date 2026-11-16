import { describe, expect, it } from "vitest";
import { pointTalkCall } from "../src/core/pointTalk";

describe("pointTalkCall", () => {
  it("asks the CLI for the key's presence and for a temporary key, always as JSON", () => {
    expect(pointTalkCall("status", undefined)).toEqual({ args: ["point-talk", "status", "--json"], timeoutMs: 15000 });
    expect(pointTalkCall("key", undefined).args).toEqual(["point-talk", "key", "--json"]);
  });

  it("transcribes a recording by its full path only", () => {
    const c = pointTalkCall("transcribe", { file: "/Users/me/.dispatch/recordings/2026-11-16/0912/audio.webm" });
    expect(c.args).toEqual(["point-talk", "transcribe", "/Users/me/.dispatch/recordings/2026-11-16/0912/audio.webm", "--json"]);
    expect(c.timeoutMs).toBeGreaterThanOrEqual(300000);
    expect(() => pointTalkCall("transcribe", { file: "audio.webm" })).toThrow();
    expect(() => pointTalkCall("transcribe", { file: "--json" })).toThrow();
    expect(() => pointTalkCall("transcribe", {})).toThrow();
  });

  it("refuses an operation it does not know", () => {
    expect(() => pointTalkCall("get", undefined)).toThrow();
    expect(() => pointTalkCall("", undefined)).toThrow();
  });
});

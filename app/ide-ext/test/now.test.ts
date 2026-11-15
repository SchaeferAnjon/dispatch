import { describe, expect, it } from "vitest";
import { nowArgs } from "../src/core/now";

describe("now", () => {
  it("reads one session", () => {
    expect(nowArgs({ session: "agent-host-claude:/6236a956-274b" })).toEqual(["now", "--session", "agent-host-claude:/6236a956-274b", "--json"]);
    expect(nowArgs({ session: " ses_abc123 " })).toEqual(["now", "--session", "ses_abc123", "--json"]);
    expect(nowArgs({ session: "ses_abc123", live: true })).toEqual(["now", "--session", "ses_abc123", "--live", "--json"]);
    expect(nowArgs({ session: "ses_abc123", live: "yes" })).toEqual(["now", "--session", "ses_abc123", "--json"]);
  });
  it("refuses anything else", () => {
    expect(nowArgs(undefined)).toBeUndefined();
    expect(nowArgs({})).toBeUndefined();
    expect(nowArgs({ session: "--clear" })).toBeUndefined();
    expect(nowArgs({ session: "a/../../b" })).toBeUndefined();
    expect(nowArgs({ session: "abc" })).toBeUndefined();
    expect(nowArgs({ session: 42 })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { netArgs } from "../src/core/net";

describe("dispatch.net arguments", () => {
  it("reads the report, fresh or cached", () => {
    expect(netArgs(undefined)).toEqual(["net", "status", "--json"]);
    expect(netArgs("refresh")).toEqual(["net", "status", "--refresh", "--json"]);
    expect(netArgs("env")).toEqual(["net", "env", "--json"]);
  });

  it("saves a proxy: auto, off or an address", () => {
    expect(netArgs("set", "proxy", "auto")).toEqual(["net", "set", "proxy", "auto", "--json"]);
    expect(netArgs("set", "proxy", " off ")).toEqual(["net", "set", "proxy", "off", "--json"]);
    expect(netArgs("set", "proxy", "http://127.0.0.1:7890")).toEqual(["net", "set", "proxy", "http://127.0.0.1:7890", "--json"]);
    expect(netArgs("set", "proxy", "127.0.0.1:7890")).toEqual(["net", "set", "proxy", "127.0.0.1:7890", "--json"]);
    expect(netArgs("set", "proxy", "socks5://127.0.0.1:7891")?.[3]).toBe("socks5://127.0.0.1:7891");
    expect(netArgs("set", "proxy", "file:///tmp/x.pac")?.[3]).toBe("file:///tmp/x.pac");
  });

  it("refuses anything else", () => {
    expect(netArgs("set", "proxy", "http://x:1; rm -rf ~")).toBeUndefined();
    expect(netArgs("set", "proxy", "--json")).toBeUndefined();
    expect(netArgs("set", "proxy", 7890)).toBeUndefined();
    expect(netArgs("set", "mirror", "moon")).toBeUndefined();
    expect(netArgs("set", "mirror", "china")).toEqual(["net", "set", "mirror", "china", "--json"]);
    expect(netArgs("delete")).toBeUndefined();
  });
});

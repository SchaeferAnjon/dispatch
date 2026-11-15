import { describe, expect, it } from "vitest";
import { buildsArgs } from "../src/core/builds";

describe("builds args", () => {
  it("maps the bottom bar's operations to the CLI", () => {
    expect(buildsArgs(undefined)).toEqual(["build", "queue", "--json"]);
    expect(buildsArgs("queue")).toEqual(["build", "queue", "--json"]);
    expect(buildsArgs("log", "9a83d18bb7ca-1363ef79b259")).toEqual(["build", "log", "9a83d18bb7ca-1363ef79b259", "--follow"]);
    expect(buildsArgs("log", "9a83d18bb7ca-1363ef79b259-min")).toEqual(["build", "log", "9a83d18bb7ca-1363ef79b259-min", "--follow"]);
    expect(buildsArgs("log", "6d02573ff7fa-dev")).toEqual(["build", "log", "6d02573ff7fa-dev", "--follow"]);
    expect(buildsArgs("retry", "6d02573ff7fa")).toEqual(["build", "start", "6d02573ff7fa", "--rebuild"]);
    expect(buildsArgs("retry", "6d02573ff7fa-min")).toEqual(["build", "start", "6d02573ff7fa", "--rebuild", "--min"]);
  });
  it("refuses names that are not a build's, and other operations", () => {
    expect(buildsArgs("log", "--all")).toBeUndefined();
    expect(buildsArgs("log", "main; rm -rf ~")).toBeUndefined();
    expect(buildsArgs("log")).toBeUndefined();
    expect(buildsArgs("start", "main")).toBeUndefined();
    expect(buildsArgs("install", "9a83d18bb7ca-1363ef79b259")).toBeUndefined();
    // Try again is for a package of yours: never a development build, an old two-commit name or anything else
    expect(buildsArgs("retry", "6d02573ff7fa-dev")).toBeUndefined();
    expect(buildsArgs("retry", "9a83d18bb7ca-1363ef79b259")).toBeUndefined();
    expect(buildsArgs("retry", "main")).toBeUndefined();
    expect(buildsArgs("retry")).toBeUndefined();
  });
});

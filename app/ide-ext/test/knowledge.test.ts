import { describe, expect, it } from "vitest";
import { knowledgeCall } from "../src/core/knowledge";

describe("knowledgeCall", () => {
  it("lists and searches the wiki", () => {
    expect(knowledgeCall("wikiList").args).toEqual(["wiki", "list", "--dated", "--json"]);
    expect(knowledgeCall("wikiSearch", { query: " tauri " }).args).toEqual(["wiki", "search", "tauri", "--dated", "--json"]);
    expect(knowledgeCall("wikiSearch", { query: "" }).args).toEqual(["wiki", "list", "--dated", "--json"]);
    // a query that looks like an option stays the query (the CLI strips the space)
    expect(knowledgeCall("wikiSearch", { query: "--all" }).args).toEqual(["wiki", "search", " --all", "--dated", "--json"]);
  });

  it("adds an entry with the kind's own fields only", () => {
    expect(knowledgeCall("wikiAdd", { kind: "pit", body: "- list first", fields: { fix: "-x", why: "ignored" }, project: "kanban" })).toEqual({
      args: ["wiki", "add", "--kind", "pit", "--json", "--body", "-", "--fix=-x", "--project=kanban"],
      input: "- list first",
    });
    expect(knowledgeCall("wikiAdd", { kind: "howto", body: "b", fields: { fix: "no" } }).args).toEqual(["wiki", "add", "--kind", "howto", "--json", "--body", "-"]);
    expect(() => knowledgeCall("wikiAdd", { kind: "note", body: "b" })).toThrow();
    expect(() => knowledgeCall("wikiAdd", { kind: "win", body: "  " })).toThrow();
  });

  it("edits the body through stdin and the given fields", () => {
    const c = knowledgeCall("wikiEdit", { key: "retro-a", body: " new\nbody ", fields: { bad: "", good: " ok " } });
    expect(c.args).toEqual(["wiki", "edit", "retro-a", "--json", "--body", "-", "--good=ok", "--bad="]);
    expect(c.input).toBe("new\nbody");
    expect(knowledgeCall("wikiEdit", { key: "pit-a", fields: { fix: "f" } }).input).toBeUndefined();
    expect(() => knowledgeCall("wikiEdit", { key: "pit-a" })).toThrow("nothing to change");
    expect(() => knowledgeCall("wikiEdit", { key: "pit-a", body: "" })).toThrow();
    expect(() => knowledgeCall("wikiEdit", { body: "x" })).toThrow();
    expect(() => knowledgeCall("wikiEdit", { key: "--all", body: "x" })).toThrow("no key");
  });

  it("removes by key", () => {
    expect(knowledgeCall("wikiRemove", { key: "pit-a" }).args).toEqual(["wiki", "rm", "pit-a", "--json"]);
    expect(() => knowledgeCall("wikiRemove", {})).toThrow();
  });

  it("lists facts and About me and deletes one entry by its line", () => {
    expect(knowledgeCall("factsList").args).toEqual(["facts", "list", "--json"]);
    expect(knowledgeCall("profileShow").args).toEqual(["profile", "show", "--json"]);
    expect(knowledgeCall("factsDrop", { line: 12, text: "- a -b" }).args).toEqual(["facts", "drop", "12", "--text=- a -b", "--json"]);
    expect(knowledgeCall("profileDrop", { line: 3, text: "x" }).args).toEqual(["profile", "drop", "3", "--text=x", "--json"]);
    expect(() => knowledgeCall("factsDrop", { line: 0, text: "x" })).toThrow("no line");
    expect(() => knowledgeCall("factsEdit", { topic: "x" })).toThrow("unknown operation");
  });

  it("reads and changes preferences by id, what a person typed never read as an option", () => {
    expect(knowledgeCall("prefsList").args).toEqual(["prefs", "list", "--all", "--thumbs", "chip", "--json"]);
    expect(knowledgeCall("prefsNames").args).toEqual(["prefs", "list", "--json"]);
    expect(knowledgeCall("prefsIds", { ids: ["pref-7k2m", "--all", "pref-ab12", "pref-7k2m"] }).args).toEqual(["prefs", "list", "--ids=pref-7k2m,pref-ab12", "--thumbs", "chip", "--json"]);
    expect(knowledgeCall("prefsShow", { id: "pref-7k2m" }).args).toEqual(["prefs", "show", "pref-7k2m", "--thumbs", "card", "--json"]);
    expect(() => knowledgeCall("prefsShow", { id: "--all" })).toThrow("no preference id");
    expect(knowledgeCall("prefsAdd", { text: " -开关用方角 ", polarity: "avoid", area: "design", scope: "kanban:Tasks tab", name: "-方角", quote: "别用胶囊" })).toEqual({
      args: ["prefs", "add", "-", "--json", "--name=-方角", "--scope=kanban:Tasks tab", "--quote=别用胶囊", "--area=design", "--avoid"],
      input: "-开关用方角",
    });
    expect(() => knowledgeCall("prefsAdd", { text: " " })).toThrow("empty");
    expect(() => knowledgeCall("prefsAdd", { text: "x", area: "colour" })).toThrow("area");
    expect(knowledgeCall("prefsEdit", { id: "pref-7k2m", text: "新的一句", polarity: "like" })).toEqual({
      args: ["prefs", "edit", "pref-7k2m", "--json", "--like", "--text=-"],
      input: "新的一句",
    });
    expect(() => knowledgeCall("prefsEdit", { id: "pref-7k2m" })).toThrow("nothing to change");
    expect(knowledgeCall("prefsForget", { ids: ["pref-7k2m", "pref-ab12"] }).args).toEqual(["prefs", "forget", "pref-7k2m", "pref-ab12", "--json"]);
    expect(knowledgeCall("prefsForget", { ids: ["pref-7k2m"], justSaid: true }).args).toEqual(["prefs", "forget", "pref-7k2m", "--just-said", "--json"]);
    expect(knowledgeCall("prefsUndo", {}).args).toEqual(["prefs", "undo", "--json"]);
    expect(knowledgeCall("prefsUndo", { id: "pref-7k2m" }).args).toEqual(["prefs", "undo", "pref-7k2m", "--json"]);
    expect(knowledgeCall("prefsKeep", { id: "pref-7k2m" }).args).toEqual(["prefs", "keep", "pref-7k2m", "--json"]);
    expect(knowledgeCall("prefsSeen").args).toEqual(["prefs", "seen", "--all", "--json"]);
    expect(knowledgeCall("prefsCite", { names: ["方角开关", "-x"], ref: "resp-1" }).args).toEqual(["prefs", "cite", "方角开关", " -x", "--ref=resp-1", "--by=reply", "--json"]);
    expect(knowledgeCall("prefsImport", {}).args).toEqual(["prefs", "import", "--dry-run", "--json"]);
    expect(knowledgeCall("prefsImport", { apply: true }).args).toEqual(["prefs", "import", "--apply", "--sure-only", "--json"]);
    expect(knowledgeCall("memoriesList").args).toEqual(["memories", "list", "--json"]);
  });

  it("refuses anything else", () => {
    expect(() => knowledgeCall("env", { name: "X" })).toThrow("unknown operation");
  });
});

import { describe, expect, it } from "vitest";
import { contentType, DRAW_SCROLL_AGENT, hostOk, pageState, parsePick, pickAllowed, pickAnswer, pickArgs, routeOf, tokenOf, withDrawScrollAgent } from "../src/core/deliveryPage";
import { parseShowRequest } from "../src/core/ideShow";

const token = "0123456789abcdef0123456789abcdef";

describe("delivery page routes", () => {
  it("serves the page's own files under its token", () => {
    expect(routeOf(`/${token}/index.html`, token)).toEqual({ kind: "file", rel: "index.html" });
    expect(routeOf(`/${token}/`, token)).toEqual({ kind: "file", rel: "index.html" });
    expect(routeOf(`/${token}/01-usage%20page.png?x=1`, token)).toEqual({ kind: "file", rel: "01-usage page.png" });
    expect(routeOf(`/${token}/shots/a.png`, token)).toEqual({ kind: "file", rel: "shots/a.png" });
    expect(routeOf(`/${token}/__dispatch/state`, token)).toEqual({ kind: "state" });
    expect(routeOf(`/${token}/__dispatch/pick`, token)).toEqual({ kind: "pick" });
  });

  it("refuses anything outside the folder or another token", () => {
    expect(routeOf(`/${token}/../secret.png`, token)).toBeUndefined();
    expect(routeOf(`/${token}/%2e%2e/secret.png`, token)).toBeUndefined();
    expect(routeOf(`/${token}/a/../../b.png`, token)).toBeUndefined();
    expect(routeOf(`/${token}//etc/passwd`, token)).toBeUndefined();
    expect(routeOf(`/${token}/a%5c..%5cb`, token)).toBeUndefined();
    expect(routeOf(`/${token}/.git/config`, token)).toBeUndefined();
    expect(routeOf(`/${token}/__dispatch/run`, token)).toBeUndefined();
    expect(routeOf(`/ffffffffffffffffffffffffffffffff/index.html`, token)).toBeUndefined();
    expect(routeOf(`/index.html`, token)).toBeUndefined();
    expect(routeOf(`/${token}/%E0%A4%A`, token)).toBeUndefined();
    expect(tokenOf(`/${token}/x.png`)).toBe(token);
    expect(tokenOf(`/nope/x.png`)).toBe("");
  });

  it("serves only known file kinds", () => {
    expect(contentType("index.html")).toMatch(/^text\/html/);
    expect(contentType("a.PNG")).toBe("image/png");
    expect(contentType("notes.md")).toMatch(/^text\/plain/);
    expect(contentType("run.sh")).toBeUndefined();
    expect(contentType("noext")).toBeUndefined();
  });
});

describe("delivery page picks", () => {
  const port = 51234;
  const same = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };

  it("takes a pick only from the page itself", () => {
    expect(hostOk(`127.0.0.1:${port}`, port)).toBe(true);
    expect(hostOk(`localhost:${port}`, port)).toBe(false);
    expect(hostOk(`evil.example:${port}`, port)).toBe(false);
    expect(pickAllowed(same, port)).toBe(true);
    expect(pickAllowed({ ...same, "content-type": "application/json; charset=utf-8" }, port)).toBe(true);
    expect(pickAllowed({ ...same, origin: "https://evil.example" }, port)).toBe(false);
    expect(pickAllowed({ ...same, origin: "null" }, port)).toBe(false);
    expect(pickAllowed({ ...same, "content-type": "text/plain" }, port)).toBe(false);
    expect(pickAllowed({ ...same, host: "attacker.test" }, port)).toBe(false);
  });

  it("reads A to F and a one-line reason", () => {
    expect(parsePick('{"option":"a","reason":"  短一点\\n更直观 "}')).toEqual({ option: "A", reason: "短一点 更直观" });
    expect(parsePick('{"option":"B"}')).toEqual({ option: "B", reason: "" });
    expect(parsePick('{"option":"G"}')).toHaveProperty("error");
    expect(parsePick('{"option":"A; rm -rf /"}')).toHaveProperty("error");
    expect(parsePick('{"option":"A","reason":42}')).toHaveProperty("error");
    expect(parsePick("[1]")).toHaveProperty("error");
    expect(parsePick("nope")).toHaveProperty("error");
    expect((parsePick(JSON.stringify({ option: "A", reason: "x".repeat(1000) })) as { reason: string }).reason.length).toBe(300);
  });

  it("runs exactly dispatch flow pick for the page's task", () => {
    expect(pickArgs("task-pm9j", { option: "A", reason: "--force; rm" })).toEqual(["flow", "pick", "task-pm9j", "A", "--reason", "--force; rm", "--json"]);
    expect(() => pickArgs("--help", { option: "A", reason: "" })).toThrow();
    expect(() => pickArgs("", { option: "A", reason: "" })).toThrow();
  });

  it("tells the page the words, not the ids", () => {
    const ans = pickAnswer({ ok: true, task: "task-1", picked: "B", option: { key: "B", title: "Latest on top" }, reason: "r", impl: { id: "task-2", title: "按方向 B 实现" }, project: "kanban", facts: "/Users/x/FACTS.md" });
    expect(ans).toEqual({ ok: true, picked: "B", title: "Latest on top", reason: "r", impl: { title: "按方向 B 实现" }, project: "kanban" });
    expect(JSON.stringify(ans)).not.toMatch(/task-/);
    expect(pickAnswer({ ok: false, error: "task-1 is not waiting for a direction" })).toEqual({ ok: false, error: "task-1 is not waiting for a direction" });
    expect(pageState("proposal", { state: "picked", picked: "A", reason: "why", dir: "/x" })).toEqual({ ok: true, kind: "proposal", state: "picked", picked: "A", reason: "why" });
    expect(pageState("impl", { state: "picked" })).toEqual({ ok: true, kind: "impl" });
  });
});

describe("ide show requests for delivery pages", () => {
  const now = 1_790_000_000;
  const req = (o: Record<string, unknown>) => JSON.stringify({ id: "a1b2c3d4e5f6", target: "/Users/me/design/x/impl/index.html", session: "", at: now, ...o });

  it("carries the page kind and its task", () => {
    expect(parseShowRequest(req({ delivery: "proposal", task: "task-pm9j" }), now)).toMatchObject({ delivery: "proposal", task: "task-pm9j" });
    expect(parseShowRequest(req({ delivery: "impl" }), now)).toMatchObject({ delivery: "impl" });
    // a proposal without a usable task is not acted on; other kinds and other files are plain shows
    expect(parseShowRequest(req({ delivery: "proposal", task: "--help" }), now)).toBeUndefined();
    expect(parseShowRequest(req({ delivery: "run" }), now)?.delivery).toBeUndefined();
    expect(parseShowRequest(req({ delivery: "impl", target: "/Users/me/x.md" }), now)?.delivery).toBeUndefined();
    expect(parseShowRequest(req({ delivery: "impl", target: "https://example.com/x.html" }), now)?.delivery).toBeUndefined();
  });
});

describe("delivery page scroll agent", () => {
  it("goes first in the head, or right after the doctype, or first", () => {
    expect(withDrawScrollAgent('<!doctype html><html><head lang="x"><title>t</title></head><body></body></html>')).toBe(
      `<!doctype html><html><head lang="x">${DRAW_SCROLL_AGENT}<title>t</title></head><body></body></html>`,
    );
    expect(withDrawScrollAgent("<!DOCTYPE html>\n<p>x</p>")).toBe(`<!DOCTYPE html>${DRAW_SCROLL_AGENT}\n<p>x</p>`);
    expect(withDrawScrollAgent("<p>x</p>")).toBe(`${DRAW_SCROLL_AGENT}<p>x</p>`);
  });

  it("answers only its parent", () => {
    expect(DRAW_SCROLL_AGENT).toContain("e.source!==window.parent");
    expect(DRAW_SCROLL_AGENT.startsWith("<script>")).toBe(true);
    expect(DRAW_SCROLL_AGENT.endsWith("</script>")).toBe(true);
  });

  it("is a script that parses", () => {
    const body = DRAW_SCROLL_AGENT.slice("<script>".length, -"</script>".length);
    expect(() => new Function(body)).not.toThrow();
    expect(body).toContain("settle(done)");
    expect(body).toContain("loading='eager'");
  });
});


describe("Docs delivery page controls", () => {
  function page() {
    const listeners: Record<string, (event: any) => void> = {};
    const posted: unknown[] = [];
    let overlay = false;
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const doc = { head: { appendChild() {} }, createElement: () => ({ textContent: "" }), querySelector: () => overlay ? {} : null };
    const script = DRAW_SCROLL_AGENT.slice(8, -9);
    new Function("window", "document", "addEventListener", "setTimeout", script)({ parent }, doc, (name: string, handler: (e: any) => void) => { listeners[name] = handler; }, (fn: () => void) => fn());
    return { listeners, posted, overlay: (on: boolean) => { overlay = on; } };
  }
  it("leaves Escape to a picture overlay, then asks Docs to restore the document", () => {
    const p = page();
    p.overlay(true); p.listeners.keydown({ key: "Escape" });
    expect(p.posted).toEqual([]);
    p.overlay(false); p.listeners.keydown({ key: "Escape", defaultPrevented: true });
    expect(p.posted).toEqual([]);
    p.listeners.keydown({ key: "Escape" });
    expect(p.posted).toEqual([{ dispatchDraw: "escape" }]);
  });
  it("opens a picture on a click, but keeps dragging as panning", () => {
    const p = page(); let opens = 0, stopped = 0;
    const viewport = { closest: () => ({ querySelector: (selector: string) => selector === ".enl" ? ({ click: () => opens++ }) : null }) };
    const down = { target: { closest: () => viewport }, clientX: 100, clientY: 100 };
    const up = { clientX: 101, clientY: 100, stopImmediatePropagation: () => stopped++ };
    p.listeners.pointerdown(down); p.listeners.pointerup(up);
    expect([opens, stopped]).toEqual([1, 0]);
    p.listeners.pointerdown(down); p.listeners.pointerup({ ...up, clientY: 140 });
    expect([opens, stopped]).toEqual([1, 0]);
  });
});

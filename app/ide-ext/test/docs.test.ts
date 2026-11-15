import { describe, expect, it } from "vitest";
import { deliveryKind, docGroup, docRows } from "../src/core/docs";

describe("delivery pages", () => {
  it("knows a dispatch deliver page and its kind", () => {
    const page = (k: string) => `<!doctype html><head><meta charset="utf-8"><meta name="generator" content="dispatch deliver">\n<meta name="dispatch-delivery" content="${k}">`;
    expect(deliveryKind(page("proposal"))).toBe("proposal");
    expect(deliveryKind(page("impl"))).toBe("impl");
    expect(deliveryKind(page("other"))).toBeUndefined();
    expect(deliveryKind(`<meta name="dispatch-delivery" content="impl">`)).toBeUndefined();
    expect(deliveryKind("<title>A prototype</title>")).toBeUndefined();
  });
});

describe("docs tab rows", () => {
  it("takes the CLI's group, else the kind's", () => {
    expect(docGroup("delivered", "设计")).toBe("delivered");
    expect(docGroup(undefined, "设计")).toBe("design");
    expect(docGroup(undefined, "交付")).toBe("delivered");
    expect(docGroup(undefined, "调研")).toBe("research");
    expect(docGroup(undefined, "复审")).toBe("research");
    expect(docGroup("bogus", "文档")).toBe("notes");
    expect(docGroup(undefined, undefined)).toBe("notes");
  });

  it("keeps local files only, newest first, with the display title", () => {
    const rows = docRows({
      project: "kanban",
      docs: [
        { id: "a", title: "Old", kind: "设计", path: "/p/design/a/README.md", mtime: 1, ext: "md" },
        { id: "b", title: " ", kind: "文档", path: "/p/design/b/index.html", mtime: 3 },
        { id: "u", title: "Paper", kind: "其他", path: "https://example.com/x", mtime: 9, url: true },
        { id: "h", title: "Elsewhere", kind: "设计", path: "/other/mac.md", mtime: 8, host: "mini" },
        { id: "c", title: "引擎（task-ab12）", display_title: "引擎", group: "delivered", path: "/p/design/c/README.md", mtime: 0, delivered_at: 2 },
        null,
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows[0]).toMatchObject({ title: "index.html", group: "notes", ext: "html", tasks: [], unseen: false });
    expect(rows[1]).toMatchObject({ title: "引擎", group: "delivered", delivered_at: 2, today: false });
    expect(rows[2]).toMatchObject({ title: "Old", group: "design", ext: "md" });
  });

  it("adds the reader-only rows after the list, flagged", () => {
    const rows = docRows({
      docs: [{ id: "d", title: "Page", group: "delivered", path: "/p/design/d/index.html", mtime: 2 }],
      reader: [{ id: "h", title: "Context handoff", kind: "handoff", path: "/p/h/1.md", mtime: 3, tasks: [{ id: "task-h1", title: "T", status: "done", delivered_at: 0 }] }],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.d.reader_only).toBeUndefined();
    expect(byId.h).toMatchObject({ reader_only: true, group: "handoff" });
    expect(byId.h.tasks.map((t) => t.id)).toEqual(["task-h1"]);
  });

  it("reads tasks, the prototype and the where picture", () => {
    const [r] = docRows({
      docs: [{
        id: "e", title: "E", group: "delivered", path: "/p/design/e/README.md", mtime: 5, unseen: true, in_session: true, today: true,
        tasks: [{ id: "task-a1", title: "Build it", status: "done", delivered_at: 4, sessions: ["s"] }, { title: "no id" }],
        attachments: [{ path: "/p/design/e/index.html", kind: "prototype" }],
        where: { image: "/p/design/e/00-where-is-what.png", size: [100, 200], items: [{ n: 1, box: [1, 2, 3, 4], what: "A", where: "B", how: "C" }, { n: 2, box: "x" }] },
      }],
    });
    expect(r.tasks).toEqual([{ id: "task-a1", title: "Build it", status: "done", delivered_at: 4 }]);
    expect(r.prototype).toBe("/p/design/e/index.html");
    expect(r.unseen && r.in_session && r.today).toBe(true);
    expect(r.where).toEqual({ image: "/p/design/e/00-where-is-what.png", size: [100, 200], items: [{ n: 1, box: [1, 2, 3, 4], what: "A", where: "B", how: "C" }], drawn: true });
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocRow } from "../src/core/docs";
import { displayTitle, inSession, projectRoot, quickAnswer, quickRows, scanDocFiles, sessionKey, writeDocsCache } from "../src/core/docsQuick";

let tmp = "";
let root = "";
const write = (rel: string, text = "# Title\n", ageSec = 0) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (ageSec) {
    const t = Date.now() / 1000 - ageSec;
    fs.utimesSync(p, t, t);
  }
  return p;
};
const page = (title: string, kind = "proposal") =>
  `<!doctype html><head><meta charset="utf-8"><meta name="generator" content="dispatch deliver">\n<meta name="dispatch-delivery" content="${kind}"><title>${title}</title>`;
const groups = (rows: DocRow[]) => Object.fromEntries(rows.map((r) => [path.relative(root, r.path), r.group]));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "docs-quick-")));
  root = path.join(tmp, "kanban");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the Docs tab's first frame from the project's files", () => {
  it("finds the documents under design/, docs/ and 研究/, two folders deep, not published sites", () => {
    write("design/a/README.md");
    write("design/a/b/notes.md");
    write("design/a/b/c/too-deep.md");
    write("design/node_modules/x.md");
    write("design/en/manual.md");
    write("docs/guide.md");
    write("研究/调研.md");
    write("src/not-a-doc.md");
    write("design/a/picture.png");
    const found = scanDocFiles(root).map((f) => path.relative(root, f.path)).sort();
    expect(found).toEqual(["design/a/README.md", "design/a/b/notes.md", "docs/guide.md", "研究/调研.md"]);
  });

  it("sorts files into the picker's groups the way docs list does", () => {
    write("design/frenzy/index.html", page("狂暴模式"));
    write("design/frenzy/notes.md", "# 狂暴模式\n");
    write("design/frenzy/proto-a.html", "<title>Turbo · A</title>");
    write("design/frenzy/graphs.html", "<title>Graphs</title>");
    write("design/frenzy/qa.md", "# 验证记录\n");
    write("design/frenzy/impl2/index.html", page("Turbo built", "impl"));
    write("design/bars/README.md", "# 标题栏和底栏\n");
    write("design/bars/index.html", "<title>原型</title>");
    write("design/bars/impl/README.md", "# 标题栏：实现\n");
    write("design/review/README.md", "# 上手审读\n");
    write("design/task-model/DECISIONS.md", "# 定稿\n");
    write("design/handoff/briefs/x.md", "# 任务书\n");
    write("design/e2e/projects/README.md", "# Projects\n");
    write("docs/protocol.md", "# Protocol\n");
    const rows = quickRows(scanDocFiles(root));
    expect(groups(rows)).toEqual({
      "design/frenzy/index.html": "design",
      "design/frenzy/proto-a.html": "design",
      "design/frenzy/graphs.html": "design",
      "design/frenzy/impl2/index.html": "delivered",
      "design/bars/README.md": "design",
      "design/bars/impl/README.md": "delivered",
      "design/review/README.md": "research",
      "design/task-model/DECISIONS.md": "notes",
      "design/handoff/briefs/x.md": "notes",
      "docs/protocol.md": "notes",
    });
    const bars = rows.find((r) => r.path.endsWith("design/bars/README.md"))!;
    expect(bars.prototype).toBe(path.join(root, "design/bars/index.html"));
    expect(bars.title).toBe("标题栏和底栏");
    expect(rows.find((r) => r.path.endsWith("proto-a.html"))!.title).toBe("Turbo · A");
  });

  it("drops bookkeeping brackets from titles", () => {
    expect(displayTitle("任务模块真机截图（task-ha7k，2026-09-27）")).toBe("任务模块真机截图");
    expect(displayTitle("~/.dispatch 目录（A 组，2026-09-27）")).toBe("~/.dispatch 目录");
    expect(displayTitle("任务模型定稿（2026-09-27，和用户讨论后）")).toBe("任务模型定稿（2026-09-27，和用户讨论后）");
  });

  it("reads a worktree as the repository it was made from", () => {
    const wt = path.join(tmp, "kanban-wt", "docs-fast");
    fs.mkdirSync(path.join(root, ".git", "worktrees", "docs-fast"), { recursive: true });
    fs.mkdirSync(path.join(wt, "app"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "docs-fast")}\n`);
    expect(projectRoot(path.join(wt, "app"))).toBe(root);
    expect(projectRoot(path.join(root, "design"))).toBe(root);
  });

  it("knows a session by its id, from its resource or a prefix", () => {
    expect(sessionKey("claude-code:/abc12345-1111")).toBe("abc12345-1111");
    expect(inSession(["abc12345-1111"], "claude-code:/abc12345-1111")).toBe(true);
    expect(inSession(["abc12345-1111"], "abc12345")).toBe(true);
    expect(inSession(["abc12345-1111"], "abc")).toBe(false);
    expect(inSession(undefined, "abc12345")).toBe(false);
  });
});

describe("the cached list", () => {
  const cacheDir = () => path.join(tmp, "cache");
  const cacheFile = (r: string) => path.join(cacheDir(), path.basename(r) + ".json");

  it("shows the last full list at once, without files that are gone, with new ones, and this session's own", () => {
    const kept = write("design/kept/README.md", "# Kept\n", 3600);
    const gone = write("design/gone/README.md", "# Gone\n", 3600);
    const hidden = write("design/hidden/README.md", "# Removed from Docs\n", 3600);
    const row = (p: string, extra: Partial<DocRow> = {}): DocRow => ({
      id: "a1b2c3d4", title: "Kept · from the board", group: "delivered", path: p, mtime: 1, ext: "md", tasks: [{ id: "task-a", title: "A", status: "done", delivered_at: 5 }],
      delivered_at: 5, unseen: false, today: false, in_session: false, sessions: ["abc12345-1111"], ...extra,
    });
    writeDocsCache(cacheFile(root), root, "kanban", [row(kept), row(gone, { id: "e5f6a7b8" })], Date.now() - 60_000);
    fs.rmSync(gone);
    const fresh = write("design/fresh/README.md", "# Fresh design\n");
    const ans = quickAnswer(path.join(root, "design"), "claude-code:/abc12345-1111", cacheFile);
    const paths = ans.docs.map((d) => d.path);
    expect(paths).toContain(kept);
    expect(paths).toContain(fresh);
    expect(paths).not.toContain(gone);
    // older than the cache and not in it: the board left it out ("Remove from Docs"), so it stays out
    expect(paths).not.toContain(hidden);
    const k = ans.docs.find((d) => d.path === kept)!;
    expect(k.title).toBe("Kept · from the board");
    expect(k.tasks[0].id).toBe("task-a");
    expect(k.in_session).toBe(true);
    expect(ans.docs.find((d) => d.path === fresh)!.group).toBe("design");
    expect(ans.project).toBe("kanban");
    expect(ans.partial).toBe(true);
  });

  it("without a cache lists the scan, named after the folder", () => {
    write("design/x/README.md", "# X 设计\n");
    const ans = quickAnswer(root, "", cacheFile);
    expect(ans.cached).toBe(0);
    expect(ans.project).toBe("kanban");
    expect(ans.docs.map((d) => d.title)).toEqual(["X 设计"]);
  });

  it("answers 300 documents well inside the first frame", () => {
    for (let i = 0; i < 260; i++) write(`docs/notes/n-${i}.md`, `# Note ${i}\n\ntext\n`);
    for (let i = 0; i < 40; i++) write(`design/d-${i}/proto-a.html`, `<title>Prototype ${i}</title>`);
    const cold = quickAnswer(root, "", cacheFile);
    expect(cold.docs.length).toBe(300);
    expect(cold.ms).toBeLessThan(300);
  });
});

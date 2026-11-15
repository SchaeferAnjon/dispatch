// Who wrote each changed line: an agent, you, or something else (task-6qpx, task-m6hek), for the Agents window's Changes and diffs
// (Dispatch IDE patches/340-attribution.patch). All the work is the CLI's (kanban app/cli/attribution.py);
// these commands only run it.
//
//   dispatch.attributionShow(file)                  → `attribution show <file>`: runs of lines by author
//   dispatch.attributionFiles(files[])              → `attribution files …`: counts per file
//   dispatch.attributionMark(event, session, cwd)   → `attribution mark --event --host-session --cwd`:
//                                                     a session's turn started or ended in the window
//   dispatch.attributionSteps(session, cwd)         → `attribution steps --host-session --cwd`: the session's
//                                                     turns, their commits and the lines you changed between them
//   dispatch.attributionConfig([coAuthor])          → `attribution config [--co-author on|off]`: Settings › Agents
//   dispatch.attributionEdit(file, before, saved, since, at) → `attribution edit --file --since --at` (the two texts
//                                                     on stdin): you saved a file you changed by hand (task-m6hek)
import * as vscode from "vscode";
import { log, runJson } from "./cli";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const local = (v: string) => (v.startsWith("file:") ? vscode.Uri.parse(v).fsPath : v);

export function registerAttribution(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.attributionShow", async (file: unknown) => {
      const p = local(str(file));
      if (!p.startsWith("/")) return { ok: false, error: "bad_request" };
      try {
        return await runJson(["attribution", "show", p, "--json"], { timeoutMs: 20000 });
      } catch (e) {
        log(`attribution show ${p}: ${(e as Error).message}`);
        return { ok: false, error: "failed" };
      }
    }),
    vscode.commands.registerCommand("dispatch.attributionFiles", async (files: unknown) => {
      const paths = (Array.isArray(files) ? files : []).map((f) => local(str(f))).filter((p) => p.startsWith("/")).slice(0, 200);
      if (!paths.length) return { ok: true, files: {} };
      try {
        return await runJson(["attribution", "files", ...paths, "--json"], { timeoutMs: 30000 });
      } catch (e) {
        log(`attribution files: ${(e as Error).message}`);
        return { ok: false, error: "failed" };
      }
    }),
    vscode.commands.registerCommand("dispatch.attributionSteps", async (session: unknown, cwd: unknown) => {
      const s = str(session), dir = local(str(cwd));
      if (!s || !dir.startsWith("/")) return { ok: false, error: "bad_request" };
      try {
        return await runJson(["attribution", "steps", "--host-session", s, "--cwd", dir, "--json"], { timeoutMs: 30000 });
      } catch (e) {
        log(`attribution steps ${s}: ${(e as Error).message}`);
        return { ok: false, error: "failed" };
      }
    }),
    vscode.commands.registerCommand("dispatch.attributionConfig", async (coAuthor: unknown) => {
      const args = ["attribution", "config", "--json"];
      if (typeof coAuthor === "boolean") args.push("--co-author", coAuthor ? "on" : "off");
      try {
        return await runJson(args, { timeoutMs: 20000 });
      } catch (e) {
        log(`attribution config: ${(e as Error).message}`);
        return { ok: false, error: "failed" };
      }
    }),
    vscode.commands.registerCommand("dispatch.attributionEdit", async (file: unknown, before: unknown, saved: unknown, since: unknown, at: unknown) => {
      const p = local(str(file));
      const t = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      if (!p.startsWith("/") || typeof before !== "string" || typeof saved !== "string" || !t(since) || !t(at)) return { ok: false, error: "bad_request" };
      try {
        return await runJson(["attribution", "edit", "--file", p, "--since", String(t(since)), "--at", String(t(at)), "--json"],
          { timeoutMs: 30000, input: JSON.stringify({ before, saved }) });
      } catch (e) {
        log(`attribution edit ${p}: ${(e as Error).message}`);
        return { ok: false, error: "failed" };
      }
    }),
    vscode.commands.registerCommand("dispatch.attributionMark", async (event: unknown, session: unknown, cwd: unknown) => {
      const ev = str(event), s = str(session), dir = local(str(cwd));
      if (!/^(start|end)$/.test(ev) || !s || !dir.startsWith("/")) return { ok: false, error: "bad_request" };
      try {
        return await runJson(["attribution", "mark", "--event", ev, "--host-session", s, "--cwd", dir, "--json"], { timeoutMs: 20000 });
      } catch (e) {
        log(`attribution mark ${ev} ${s}: ${(e as Error).message}`);
        return { ok: false, error: "failed" };
      }
    }),
  );
}

// Checkpoints (design/full-ide/PLAN.md §3.5): chatd snapshots the project before every message it
// sends (turn_started carries the id); `dispatch checkpoint` lists them and brings the files back
// to before a turn. The chat page asks for a dry run first (the files it would touch, and the ones
// changed after the agents finished), then restores and tells the agent with a `note`.
import type { Api } from "./api";
import { t } from "./i18n";

export interface CheckpointFile { path: string; status: string }
export interface Checkpoint { turn_id: string; kind: "turn" | "restore"; sid: string; message_id: string; agent_turn_id?: string; text: string; ts: number; before_tree: string; after_tree: string; after_ts?: number; files_changed: CheckpointFile[]; restored_turn?: string }
export type RestoreAction = "restore" | "delete" | "create";
/** `unsure`: files a restore would delete that no agent edit tool wrote (maybe yours); they are in `conflicts` too.
 *  `running`: chat sessions whose agent works in this project now (the restore itself is refused until they finish). */
export interface RestorePlan { turn_id: string; files: { path: string; action: RestoreAction }[]; conflicts: string[]; unsure?: string[]; running?: string[] }
export interface RestoreDone { ok: true; turn_id: string; restored: string[]; deleted: string[]; skipped: string[]; files: string[]; rollback_from: string; note: string; sid: string }
export type RestoreAnswer = RestoreDone | { ok: false; error: string; message: string; files?: string[] };

/** One JSON object from a CLI answer (a stray line before it is skipped). */
export function parseAnswer<T>(raw: string): T {
  const i = raw.indexOf("{");
  if (i < 0) throw new Error(raw.trim() || "no answer");
  return JSON.parse(raw.slice(i)) as T;
}

function fail(o: { ok?: boolean; error?: string; message?: string }): never {
  throw new Error(o.message || o.error || "checkpoint failed");
}

export function checkpointApi(api: Pick<Api, "on">, root: string, host = "local") {
  const run = async <T,>(args: string[]) => parseAnswer<T>(await api.on(host, ["checkpoint", ...args, "--root", root, "--json"]));
  return {
    async list(sid?: string): Promise<Checkpoint[]> {
      const r = await run<{ ok: boolean; error?: string; message?: string; turns?: Checkpoint[] }>(["list", ...(sid ? ["--sid", sid] : [])]);
      if (!r.ok) fail(r);
      return r.turns ?? [];
    },
    async plan(turn: string): Promise<RestorePlan> {
      const r = await run<RestorePlan & { ok: boolean; error?: string; message?: string }>(["restore", "--turn", turn, "--dry-run"]);
      if (!r.ok) fail(r);
      return { turn_id: r.turn_id, files: r.files ?? [], conflicts: r.conflicts ?? [], unsure: r.unsure ?? [], running: r.running ?? [] };
    },
    /** `note: false` when the caller tells chatd itself (a live session); otherwise the note waits on disk for the session's next message. */
    async restore(turn: string, o: { force?: boolean; onlyClean?: boolean; sid?: string; note?: boolean } = {}): Promise<RestoreAnswer> {
      const args = ["restore", "--turn", turn];
      if (o.sid) args.push("--sid", o.sid);
      if (o.force) args.push("--force");
      else if (o.onlyClean) args.push("--only-clean");
      if (o.note === false) args.push("--no-note");
      return run<RestoreAnswer>(args);
    },
  };
}

/** What the agent reads at the start of its next turn after a restore. */
export function restoreNote(r: Pick<RestoreDone, "restored" | "deleted" | "skipped">, turnText: string): string {
  const what = turnText.trim().split("\n")[0].slice(0, 60);
  const list = (xs: string[]) => xs.slice(0, 8).join(t("、")) + (xs.length > 8 ? t(" 等 {n} 个文件", { n: xs.length }) : "");
  const parts = [
    r.restored.length ? t("恢复了 {files}", { files: list(r.restored) }) : "",
    r.deleted.length ? t("删掉了这之后新建的 {files}", { files: list(r.deleted) }) : "",
    r.skipped.length ? t("{files} 在这之后又被改过，保持现在的内容", { files: list(r.skipped) }) : "",
  ].filter(Boolean);
  const head = what ? t("用户把项目文件回到了这一轮之前（「{what}」）", { what }) : t("用户把项目文件回到了这一轮之前");
  return `${head}${parts.length ? t("：") + parts.join(t("；")) : ""}${t("。按现在磁盘上的内容继续，不要重做被撤回的改动，除非用户再要求。")}`;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** The checkpoint of a user message from the transcript (history before chatd's live turns): same
 *  session, sent within two minutes of it, and the message starts with the text chatd recorded
 *  (the transcript may carry notes in front and @codebase results after). */
export function checkpointForMessage(list: Checkpoint[], text: string, ts: number): Checkpoint | null {
  const body = squash(text.replace(/^(\[system\][^\n]*\n)+\n?/, ""));
  let best: Checkpoint | null = null;
  for (const c of list) {
    if (c.kind !== "turn" || !c.before_tree) continue;
    const want = squash(c.text).slice(0, 80);
    if (!want || !body.startsWith(want)) continue;
    if (Math.abs(c.ts - ts) > 120) continue;
    if (!best || Math.abs(c.ts - ts) < Math.abs(best.ts - ts)) best = c;
  }
  return best;
}

/** The restore's files as the confirm dialog lists them: conflicts first. */
export function planRows(p: RestorePlan): { path: string; action: RestoreAction; conflict: boolean; unsure: boolean }[] {
  const c = new Set(p.conflicts);
  const u = new Set(p.unsure ?? []);
  return p.files.map((f) => ({ ...f, conflict: c.has(f.path), unsure: u.has(f.path) })).sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.path.localeCompare(b.path));
}

// 工作台 v2: which conversations go in which section, and what each row leads with. Pure, so the
// grouping is tested without rendering (homeModel.test.ts). Home.tsx turns the items into rows.
//
//   等你          要确认 (a permission dialog or picker), 问你 (the reply ends on a question), then 交了
//                 (a plain unread reply); the first two sort first
//   在跑          working conversations that do not wait on the person
//   今天做完的    read replies from today, newest first, at most five
//   没人在做的任务 open, unclaimed P0/P1 tasks; the P2s are only counted
import type { Activity, Issue, Session } from "./types";
import { parseAcceptance } from "./derive";
import { linkedSessions } from "./projectModel";

export type Verb = "confirm" | "ask" | "delivered" | "running" | "done";
export interface SessionItem { id: string; verb: Verb; a?: Activity; s?: Session; at: number }
export interface HomeModel { urgent: SessionItem[]; delivered: SessionItem[]; running: SessionItem[]; today: SessionItem[]; unowned: Issue[]; unownedP2: number }
export interface HomeInput { waiting: Session[]; unread: Activity[]; running: Activity[]; read: Activity[]; rows: Activity[]; issues: Issue[]; now?: number }

const sKey = (s: { host?: string; agent: string; session_id: string }) => `${s.host ?? "local"}:${s.agent}:${s.session_id}`;
const aKey = (a: Activity) => `${a.host ?? "local"}:${a.key}`;
/** Local midnight of the day `now` (epoch seconds) falls on. */
export const startOfDay = (now: number) => { const d = new Date(now * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
export const TODAY_CAP = 5;

export function homeModel({ waiting, unread, running, read, rows, issues, now = Date.now() / 1000 }: HomeInput): HomeModel {
  const bySid = new Map<string, Activity>();
  for (const a of rows) if (!bySid.has(a.session_id) || bySid.get(a.session_id)!.last_at < a.last_at) bySid.set(a.session_id, a);
  const taken = new Set<string>();
  const urgent: SessionItem[] = [];
  for (const s of waiting) {
    const a = bySid.get(s.session_id) ?? (s.probable_session_id ? bySid.get(s.probable_session_id) : undefined);
    urgent.push({ id: `w:${sKey(s)}`, verb: a?.waiting === "question" ? "ask" : "confirm", a, s, at: Math.max(s.last_at, a?.last_at ?? 0) });
    taken.add(s.session_id); if (a) taken.add(a.session_id);
  }
  // A dialog or question the activity snapshot saw (another machine's hooks) that presence did not report.
  for (const a of [...unread, ...running]) {
    if (taken.has(a.session_id) || (a.waiting !== "question" && a.waiting !== "dialog")) continue;
    urgent.push({ id: `a:${aKey(a)}`, verb: a.waiting === "question" ? "ask" : "confirm", a, at: a.last_at });
    taken.add(a.session_id);
  }
  // 要确认 before 问你, newest first within each.
  urgent.sort((x, y) => Number(x.verb !== "confirm") - Number(y.verb !== "confirm") || y.at - x.at);
  const delivered = unread.filter((a) => !taken.has(a.session_id)).sort((x, y) => y.last_at - x.last_at)
    .map((a): SessionItem => ({ id: `a:${aKey(a)}`, verb: "delivered", a, at: a.last_at }));
  delivered.forEach((x) => taken.add(x.a!.session_id));
  const live = running.filter((a) => !taken.has(a.session_id));
  live.forEach((a) => taken.add(a.session_id));
  const day = startOfDay(now);
  const today = read.filter((a) => !taken.has(a.session_id) && a.last_at >= day && !(a.state === "working" && !a.stale))
    .sort((x, y) => y.last_at - x.last_at).slice(0, TODAY_CAP)
    .map((a): SessionItem => ({ id: `a:${aKey(a)}`, verb: "done", a, at: a.last_at }));
  const open = issues.filter((i) => i.status === "open" && !i.assignee);
  const unowned = open.filter((i) => i.priority <= 1).sort((x, y) => x.priority - y.priority || y.updated_at.localeCompare(x.updated_at));
  return {
    urgent, delivered,
    running: live.map((a): SessionItem => ({ id: `a:${aKey(a)}`, verb: "running", a, at: a.last_at })),
    today, unowned, unownedP2: open.filter((i) => i.priority === 2).length,
  };
}

/** Tasks a conversation works on: the ids its transcript mentions plus tasks that name the session. Open ones first. */
export function tasksOf(a: Activity | undefined, issues: Issue[]): Issue[] {
  if (!a) return [];
  const ids = new Set(a.tasks ?? []);
  const found = issues.filter((i) => ids.has(i.id) || linkedSessions(i).includes(a.session_id));
  const rank = (i: Issue) => (i.status === "in_progress" ? 0 : i.status === "closed" ? 2 : 1);
  return found.sort((x, y) => rank(x) - rank(y) || x.priority - y.priority);
}

/** The acceptance meter a running row shows: its first open task that has acceptance items. */
export function acceptanceOf(a: Activity | undefined, issues: Issue[]): { done: number; total: number; id: string } | null {
  for (const i of tasksOf(a, issues)) {
    if (i.status === "closed") continue;
    const ac = parseAcceptance(i.acceptance_criteria);
    if (ac.length) return { done: ac.filter((x) => x.done).length, total: ac.length, id: i.id };
  }
  return null;
}

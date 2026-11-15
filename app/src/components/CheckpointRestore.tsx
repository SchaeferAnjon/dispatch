import { useEffect, useState } from "react";
import type { Api } from "../api";
import { useT } from "../i18n";
import { checkpointApi, planRows, restoreNote, type RestorePlan } from "../checkpoints";

// 「回到这一轮之前」 on a user bubble: a dry run lists the files the restore would write back, delete
// or recreate, with the ones changed after the agents finished marked; then restore (all, or only
// the clean ones). A live session gets a `note` from the page (the chat shows it as a system line);
// otherwise the note waits on disk for the session's next message. While an agent works in the
// project nothing can be restored (the CLI refuses too). With conflicts Enter does not restore:
// the focus starts on 算了. Afterwards the page offers to undo the restore (its rollback_from).

/** Which button takes the focus (Enter) and what can be pressed: with conflicts the danger button
 *  never starts focused; while an agent works nothing restores. */
export function dialogButtons(plan: RestorePlan | null, running: boolean) {
  const rows = plan?.files.length ?? 0;
  const conflicts = plan?.conflicts.length ?? 0;
  const blocked = running || !!plan?.running?.length;
  return { blocked, focusCancel: !plan || conflicts > 0 || blocked, focusGo: !!plan && rows > 0 && !conflicts && !blocked, goDisabled: blocked, clean: conflicts > 0 ? rows - conflicts : 0 };
}

interface Props {
  api: Pick<Api, "on">;
  root: string;
  session: string;
  turn: string;
  turnText: string;
  /** This dialog undoes an earlier restore (`turn` is its rollback_from record). */
  undo?: boolean;
  /** The page's session is in the middle of a turn. */
  running?: boolean;
  /** The session runs in Dispatch: tell the agent now (chatd `note`). */
  onNote?: (text: string) => Promise<unknown>;
  onDone: (message: string, rollbackFrom?: string) => void;
  onClose: () => void;
}

export function CheckpointRestore({ api, root, session, turn, turnText, undo, running, onNote, onDone, onClose }: Props) {
  const t = useT();
  const cps = checkpointApi(api, root);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let alive = true;
    setPlan(null); setError("");
    cps.plan(turn).then((p) => { if (alive) setPlan(p); }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [turn, root, loads]);  // eslint-disable-line react-hooks/exhaustive-deps
  const rows = plan ? planRows(plan) : [];
  const conflicts = plan?.conflicts.length ?? 0;
  const unsure = plan?.unsure?.length ?? 0;
  const clean = rows.length - conflicts;
  const buttons = dialogButtons(plan, !!running);
  const blocked = buttons.blocked;
  const go = async (mode: "all" | "clean") => {
    if (busy || blocked) return;
    setBusy(true); setError("");
    try {
      const r = await cps.restore(turn, { force: mode === "all", onlyClean: mode === "clean", sid: session, note: !onNote });
      if (!r.ok) {
        if (r.error === "conflict") { setLoads((n) => n + 1); setError(t("刚才又有文件变了，重新看一下再决定")); return; }
        if (r.error === "running") { setLoads((n) => n + 1); throw new Error(t("Agent 正在这个项目里干活，等这一轮做完（或先打断）再回去")); }
        throw new Error(r.message || r.error);
      }
      if (onNote && (r.restored.length || r.deleted.length)) await onNote(restoreNote(r, turnText)).catch(() => {});
      const n = r.restored.length + r.deleted.length;
      const done = undo ? t("已撤销刚才的回退：{n} 个文件", { n })
        : r.skipped.length ? t("已回到这一轮之前：{n} 个文件，{k} 个有之后改动的没动", { n, k: r.skipped.length }) : t("已回到这一轮之前：{n} 个文件", { n });
      onDone(done, n ? r.rollback_from : undefined);
      onClose();
    } catch (e) { setError(t("没回去：{err}", { err: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  };
  const title = undo ? t("撤销这次回退") : t("回到这一轮之前");
  const label = (a: string) => (a === "delete" ? t("删掉") : a === "create" ? t("恢复（已删）") : t("改回"));
  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <div className="dialog cp-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } }}>
        <h3>{title}</h3>
        {!undo && turnText.trim() && <p className="cp-quote muted">「{turnText.trim().split("\n")[0].slice(0, 120)}」</p>}
        {!plan && !error && <p className="muted">{t("正在比对文件…")}</p>}
        {plan && !rows.length && <p>{t("项目文件和这一轮之前一样，没有要回的。")}</p>}
        {plan && rows.length > 0 && <>
          <p className="muted small">{conflicts
            ? t("{n} 个文件在 Agent 做完之后又被改过（标了「之后改过」），全部回去会盖掉那些改动。", { n: conflicts })
            : t("这些文件会回到这一轮开始前的样子，Agent 之后新建的文件会删掉。回去之前会先存一份现在的，可以再回来。")}</p>
          {unsure > 0 && <p className="muted small">{t("{n} 个新文件不是 Agent 用编辑工具写的（标了「不确定是 Agent 建的」），可能是你建的；「只回没冲突的」会留下它们。", { n: unsure })}</p>}
          <ul className="cp-files" aria-label={t("要动的文件")}>
            {rows.map((r) => <li key={r.path} className={r.conflict ? "conflict" : ""}>
              <span className={`cp-act ${r.action}`}>{label(r.action)}</span>
              <span className="mono p" title={r.path}>{r.path}</span>
              {r.conflict && <span className="tag orange">{r.unsure ? t("不确定是 Agent 建的") : t("之后改过")}</span>}
            </li>)}
          </ul>
        </>}
        {plan && blocked && <div className="chat-note" role="status">{t("Agent 正在这个项目里干活，等这一轮做完（或先打断）再回去")}</div>}
        {error && <div className="chat-error" role="alert">{error}</div>}
        <div className="foot">
          {/* with conflicts the danger button must not take Enter: the focus starts on 算了 */}
          <button type="button" className="btn ghost" disabled={busy} autoFocus={buttons.focusCancel} onClick={onClose}>{t("算了")}</button>
          {plan && rows.length > 0 && conflicts > 0 && clean > 0 && <button type="button" className="btn" disabled={busy || blocked} onClick={() => void go("clean")}>{t("只回没冲突的 {n} 个", { n: clean })}</button>}
          {plan && rows.length > 0 && <button type="button" className={`btn ${conflicts ? "danger" : "primary"}`} disabled={busy || blocked} autoFocus={buttons.focusGo} onClick={() => void go("all")}>{busy ? t("正在回去…") : conflicts ? t("全部回去") : title}</button>}
        </div>
      </div>
    </div>
  );
}

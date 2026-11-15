// Read-only view contracts for Quiet markers. Unknown measurements stay absent.
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const str = (v: unknown) => typeof v === "string" ? v : "";
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
export function lifeSnapshot(value: unknown) {
  const r = row(value);
  return {
    session: str(r.session), elapsed_seconds: number(r.elapsed_seconds), rounds: number(r.rounds),
    tool_steps: number(r.tool_steps), context_tokens: number(r.context_tokens),
    cumulative_read_tokens: number(r.cumulative_read_tokens), limit_tokens: number(r.limit_tokens),
    percent: number(r.percent), status: str(r.status), handoff_state: str(r.handoff_state),
    handoffs: handoffRows(r.handoffs), breakdown: breakdown(r.breakdown),
  };
}
/** What fills a Claude Code session's context by kind (its own /context rows), or undefined. */
export function breakdown(value: unknown) {
  const r = row(value), max = number(r.max);
  const categories = (Array.isArray(r.categories) ? r.categories : []).flatMap(v => {
    const c = row(v), name = str(c.name), tokens = number(c.tokens);
    return name && tokens !== undefined ? [{ name, tokens, deferred: c.deferred === true }] : [];
  });
  return max && categories.length ? { total: number(r.total), max, model: str(r.model), at: number(r.at), categories } : undefined;
}
export function handoffRows(value: unknown) {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap(v => {
    const r = row(v), id = str(r.id), path = str(r.path);
    if (!id || seen.has(id) || !path.startsWith("/") || r.registered === false) return [];
    seen.add(id);
    return [{ id, path, task: str(r.task), title: str(r.title) || "Context handed off", session: str(r.session),
      created_at: number(r.created_at), after_message: number(r.after_message), after_turn: number(r.after_turn),
      plan_step: planStep(r.plan_step) }];
  }).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}
export function lifeSession(value: unknown): string | undefined {
  const s = str(value).replace(/^(?:vscode-)?agent-host-(claude|codex|opencode):\/*/, (_, engine) => `${engine === "claude" ? "claude-code" : engine}:`);
  return /^[A-Za-z0-9][\w.+:/-]{3,300}$/.test(s) ? s : undefined;
}
/** The plan step in progress when a handoff was written: {index (from 0), text, state}. */
function planStep(value: unknown) {
  const r = row(value);
  const index = number(r.index), text = str(r.text);
  return index === undefined && !text ? undefined : { index, text, state: str(r.state) };
}

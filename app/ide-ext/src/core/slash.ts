// Pure helpers for dispatch.slash (no vscode import, vitest runs them from app/): the grey rows of the
// Agents window's slash menu (Dispatch IDE, dispatchSlashMenu.ts), from `dispatch slash --engine <id> --json`.

export const SLASH_ENGINES = ["claude", "codex", "opencode"] as const;

export interface SlashRow {
  /** the command without its slash */
  name: string;
  /** why it cannot run in this session */
  why: string;
  /** where to do it instead */
  where: string;
  /** what Enter does on the row: sessions, changes, permissions, accounts, new, customizations:<page>, alias:<name>, or "" */
  go: string;
}

export interface SlashTable {
  engine: string;
  name: string;
  rows: SlashRow[];
}

/** The CLI arguments for one engine's table, or undefined for an engine the CLI does not know. */
export function slashArgs(engine: unknown): string[] | undefined {
  return typeof engine === "string" && (SLASH_ENGINES as readonly string[]).includes(engine) ? ["slash", "--engine", engine, "--json"] : undefined;
}

const GO = /^(|sessions|changes|permissions|accounts|new|customizations:[A-Za-z]+|alias:[a-z0-9-]+)$/;

/** The CLI's answer, checked: rows without a name or a reason are dropped, an unknown go becomes "". */
export function parseSlashTable(raw: unknown): SlashTable | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.engine !== "string" || !Array.isArray(o.rows)) return undefined;
  const rows: SlashRow[] = [];
  for (const r of o.rows as unknown[]) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.name !== "string" || !/^[\w.:-]+$/.test(x.name) || typeof x.why !== "string" || !x.why) continue;
    const go = typeof x.go === "string" && GO.test(x.go) ? x.go : "";
    rows.push({ name: x.name, why: x.why, where: typeof x.where === "string" ? x.where : "", go });
  }
  return { engine: o.engine, name: typeof o.name === "string" ? o.name : o.engine, rows };
}

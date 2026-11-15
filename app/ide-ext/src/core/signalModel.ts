// Data for the signals the extension sends to the app.

/** Ports a local dev server usually answers on (Vite, Next, Tauri dev, Django, Rails, …). */
export const PREVIEW_PORTS = [5173, 3000, 1420, 8000, 8080, 4200, 4321, 5000, 8888, 3001];

export const ADD_TO_CHAT_LIMIT = 8000;

export interface ChatRef {
  root: string;
  path: string;
  start: number;
  end: number;
  /** "@path:12-20" (or "@path:12"), what the chat box gets */
  mention: string;
  text: string;
  truncated: boolean;
}

/** `add-to-chat` payload: the selection as a mention the chat box can insert. Lines are 1-based here. */
export function chatRef(i: { root: string; file: string; startLine: number; endLine: number; text: string; sep: string }): ChatRef {
  let rel = i.file;
  const r = i.root.endsWith(i.sep) ? i.root : i.root + i.sep;
  if (i.root && i.file.startsWith(r)) rel = i.file.slice(r.length);
  rel = rel.split(i.sep).join("/");
  const start = i.startLine + 1;
  const end = Math.max(start, i.endLine + 1);
  const truncated = i.text.length > ADD_TO_CHAT_LIMIT;
  return {
    root: i.root,
    path: rel,
    start,
    end,
    mention: `@${rel}:${start === end ? start : `${start}-${end}`}`,
    text: truncated ? i.text.slice(0, ADD_TO_CHAT_LIMIT) : i.text,
    truncated,
  };
}

/**
 * When to write the unsaved-file count the app reads on ⌘Q: at once when it grows (a ⌘Q right
 * after the first keystroke must already ask), a moment later when it shrinks (a save-all fires
 * one event per file), never when it did not change.
 */
export function dirtyReport(last: number, n: number): "now" | "later" | "none" {
  if (n === last) return "none";
  return n > last ? "now" : "later";
}

/** dirty.json as `dispatch ide dirty N` writes it (the app reads `count` and the file's mtime). */
export function dirtyJson(n: number, nowMs: number): string {
  return JSON.stringify({ count: Math.max(0, Math.floor(n)), at: Math.floor(nowMs / 1000) });
}

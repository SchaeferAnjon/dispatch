// Pure part of dispatch.pointTalk (no vscode import; vitest runs it from app/): which CLI call an operation of the
// Agents window's Point and talk is, and what comes back. See ../pointTalk.ts and app/cli/point_talk.py.

export interface PointTalkCall {
  args: string[];
  timeoutMs: number;
}

/** What the CLI answers: `ok` and the operation's fields, or `ok: false` with a code and a sentence. */
export type PointTalkAnswer =
  | { ok: true; key?: boolean | string; name?: string; expires_at?: string; model?: string; url?: string; languages?: string[]; tokens?: unknown[] }
  | { ok: false; error: string; message: string };

/** The CLI call for an operation; throws for one it does not make. */
export function pointTalkCall(op: string, payload: unknown): PointTalkCall {
  switch (op) {
    case "status":
      return { args: ["point-talk", "status", "--json"], timeoutMs: 15000 };
    case "key":
      return { args: ["point-talk", "key", "--json"], timeoutMs: 30000 };
    case "transcribe": {
      const file = payload && typeof payload === "object" ? (payload as { file?: unknown }).file : undefined;
      if (typeof file !== "string" || !file.startsWith("/") || file.includes("\0")) {
        throw new Error("Point and talk transcribes a recording by its full path.");
      }
      // a long recording: upload, Soniox's own time, and the download of the words
      return { args: ["point-talk", "transcribe", file, "--json"], timeoutMs: 600000 };
    }
    default:
      throw new Error(`Point and talk has no operation "${op}".`);
  }
}

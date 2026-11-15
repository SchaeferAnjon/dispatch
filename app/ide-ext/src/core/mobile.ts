// dispatch.mobile: the pure part. The title bar's phone button (Dispatch IDE patches/465-mobile.patch)
// asks the bridge for a pairing code, the paired phones and the state of the background service; only these
// argument shapes reach `dispatch mobile` and `dispatch chatd`.

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function id(v: unknown): string | undefined {
  return typeof v === "string" && ID.test(v.trim()) ? v.trim() : undefined;
}

/** The CLI call for one popover operation, or undefined for a request that is not one. */
export function mobileArgs(op: unknown, ...a: unknown[]): string[] | undefined {
  switch (op) {
    case undefined:
    case "state":
      return ["mobile", "status", "--json"];
    case "pair": {
      const old = id(a[0]);
      return ["mobile", "pair", "--json", "--inline", ...(old ? ["--replace", old] : [])];
    }
    case "revoke": {
      const x = id(a[0]);
      return x ? ["mobile", "revoke", x, "--json"] : undefined;
    }
    case "install":
      return ["chatd", "install", "--json"];
    case "on":
      return ["mobile", "on", "--json"];
    case "off":
      return ["mobile", "off", "--json"];
    case "another-port":
      return ["mobile", "config", "port", "0", "--json"];
    default:
      return undefined;
  }
}

/** Why phone access is on but the phone cannot reach this Mac (the port is taken, no background service). */
export interface MobileProblem {
  reason: string;
  message: string;
  fix: string;
  port: number;
}

export interface MobileState {
  /** The phone service answers (this Mac's own, on the port from the pairing state). */
  running: boolean;
  /** Phone access as the person set it: off on a new Mac, on once they pair a phone. */
  access: "on" | "off";
  /** On but not running: why, in words. */
  problem?: MobileProblem;
  /** A chatd is up: it starts the phone service as soon as a code exists. */
  chatd: boolean;
  /** This Mac's name, as the phone shows it. */
  name: string;
  phones: { id: string; name: string; pairedAt: number; lastSeen: number }[];
  /** The pairing code the popover shows: still waiting, or a phone took it. */
  pair?: { id: string; status: string; name: string };
}

interface RawStatus {
  name?: string;
  running?: boolean;
  access?: string;
  problem?: Partial<MobileProblem> | null;
  chatd?: boolean;
  devices?: { id?: string; status?: string; device_name?: string; paired_at?: number; last_seen?: number }[];
}

/** `dispatch mobile status --json` as the popover reads it: paired phones only, newest first, no secrets. */
export function shapeState(raw: unknown, pairId?: string): MobileState {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawStatus;
  const rows = Array.isArray(r.devices) ? r.devices : [];
  const phones = rows
    .filter((d) => d && d.status === "paired" && typeof d.id === "string")
    .map((d) => ({ id: d.id as string, name: d.device_name || "iPhone", pairedAt: d.paired_at || 0, lastSeen: d.last_seen || 0 }))
    .sort((x, y) => y.pairedAt - x.pairedAt);
  const mine = pairId ? rows.find((d) => d && d.id === pairId) : undefined;
  const p = r.problem && typeof r.problem === "object" ? r.problem : undefined;
  return {
    running: !!r.running,
    access: r.access === "on" ? "on" : "off",
    problem: p && typeof p.message === "string" && p.message
      ? { reason: String(p.reason || "failed"), message: p.message, fix: typeof p.fix === "string" ? p.fix : "", port: Number(p.port) || 0 }
      : undefined,
    chatd: !!r.chatd,
    name: r.name || "",
    phones,
    pair: mine && typeof mine.id === "string" ? { id: mine.id, status: mine.status || "", name: mine.device_name || "iPhone" } : undefined,
  };
}

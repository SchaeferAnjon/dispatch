// dispatch.machines: the pure part. The title bar's Machines menu (Dispatch IDE patches/285-machines.patch)
// asks the bridge for `dispatch machines` and opens folders on another Mac over Open Remote - SSH; only these
// argument shapes reach the CLI, only these URIs reach the extension.

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
/** An address to hand to ssh: a name, an IPv4 address or an IPv6 one. */
const ADDRESS = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9A-Fa-f:]{2,39})$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** A machine's name as the user types it: one line, no leading dash, at most 40 characters. */
function machineName(v: unknown): string | undefined {
  const n = text(v);
  return n && n.length <= 40 && !n.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(n) ? n : undefined;
}

/**
 * `dispatch machines` and `dispatch hosts`, for the machine button, its panel, Add machine and the Machines
 * page: the list; one Mac's live sessions; a fresh look at one Mac ("Try again"); the Macs nearby; the
 * connection checks for a new one (NDJSON, a line per step); adding, renaming, readdressing, removing.
 */
export function machinesArgs(op: unknown, ...a: unknown[]): string[] | undefined {
  const [x, y, z] = a;
  switch (op) {
    case undefined:
    case "list":
      return ["machines", "--json"];
    case "sessions":
      return HOST.test(text(x)) ? ["machines", "sessions", text(x), "--json"] : undefined;
    case "refresh":
      return HOST.test(text(x)) ? ["hosts", "--refresh", text(x), "--json"] : undefined;
    case "discover":
      return ["hosts", "discover", "--json"];
    case "check": {
      if (!ADDRESS.test(text(x)) || !USER.test(text(y))) return undefined;
      const args = ["hosts", "add", text(x), "--user", text(y), "--check", "--json"];
      if (typeof z === "string" && z) args.push("--password-stdin");
      return args;
    }
    case "add": {
      const name = machineName(z);
      if (!ADDRESS.test(text(x)) || !USER.test(text(y)) || !name) return undefined;
      return ["hosts", "add", text(x), "--user", text(y), "--name", name, "--json"];
    }
    case "set": {
      if (!HOST.test(text(x)) || !y || typeof y !== "object") return undefined;
      const change = y as { name?: unknown; address?: unknown; user?: unknown };
      const args = ["hosts", "set", text(x)];
      if (change.name !== undefined) {
        const name = machineName(change.name);
        if (!name) return undefined;
        args.push("--name", name);
      }
      if (change.address !== undefined) {
        if (!ADDRESS.test(text(change.address))) return undefined;
        args.push("--address", text(change.address));
      }
      if (change.user !== undefined && text(change.user)) {
        if (!USER.test(text(change.user))) return undefined;
        args.push("--user", text(change.user));
      }
      return args.length > 3 ? [...args, "--json"] : undefined;
    }
    case "remove":
      return HOST.test(text(x)) && text(x) !== "local" ? ["hosts", "remove", text(x), "--json"] : undefined;
    default:
      return undefined;
  }
}

/** Every JSON object line of a streamed answer (`hosts add --check` prints one per step). */
export function jsonLines(out: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push(v as Record<string, unknown>);
    } catch {
      // not a line of the answer
    }
  }
  return rows;
}

/**
 * The machines list as the IDE reads it: each other Mac gets `authority`, the Open Remote - SSH authority of
 * its window, so the IDE can find a window already open on it. `name` falls back to an older CLI's `label`.
 */
export function withAuthority<T extends { local?: boolean; ssh?: unknown; name?: unknown; label?: unknown }>(rows: T[]): (T & { authority?: string; name: string })[] {
  return rows.map((r) => {
    const name = text(r.name) || text(r.label);
    const authority = r.local ? undefined : sshAuthority(r.ssh);
    return { ...r, name, ...(authority ? { authority } : {}) };
  });
}

export type LimitWindow = { kind: string; label: string; usedPercent: number; resetsAt?: number };

/**
 * One subscription's limit windows from `dispatch quota --json` (rows per agent: "claude-code", "codex"):
 * kind "session" (5 hours), "weekly", "weekly_model" (one model's weekly); a window without a kind is read
 * from its label.
 */
export function limitWindows(rows: unknown, agent: string): LimitWindow[] {
  if (!Array.isArray(rows)) return [];
  const row = rows.find((r) => r && typeof r === "object" && (r as { agent?: unknown }).agent === agent) as { windows?: unknown } | undefined;
  const out: LimitWindow[] = [];
  for (const w of Array.isArray(row?.windows) ? row!.windows : []) {
    if (!w || typeof w !== "object") continue;
    const { kind, label, used_percent, resets_at } = w as { kind?: unknown; label?: unknown; used_percent?: unknown; resets_at?: unknown };
    if (typeof used_percent !== "number" || !Number.isFinite(used_percent)) continue;
    // Read labels from older CLIs too; the allowance shown in this window is always English.
    const l = text(label).replace(/^5\s*小时$/, "5h").replace(/^每周/, "Weekly").replace(/单模型/g, "Model");
    const k = text(kind) || (/5\s*(h|小时|hour)/i.test(l) ? "session" : /·/.test(l) ? "weekly_model" : /周|week/i.test(l) ? "weekly" : "");
    if (!k) continue;
    out.push({ kind: k, label: l, usedPercent: used_percent, ...(typeof resets_at === "number" ? { resetsAt: resets_at } : {}) });
  }
  return out;
}

/**
 * Open Remote - SSH's authority for a hosts.json `ssh` target (user@host or an ~/.ssh/config alias):
 * `ssh-remote+<hex of {"hostName","user"}>`, the encoded form it parses first (a plain `user@host` would
 * read as URI user info). Undefined when the target is not something to hand to ssh.
 */
export function sshAuthority(ssh: unknown): string | undefined {
  const target = typeof ssh === "string" ? ssh.trim() : "";
  const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9][A-Za-z0-9.-]*)$/.exec(target);
  if (!m) return undefined;
  const dest: { hostName: string; user?: string } = { hostName: m[2] };
  if (m[1]) dest.user = m[1];
  return "ssh-remote+" + Buffer.from(JSON.stringify(dest), "utf8").toString("hex");
}

/**
 * The shell commands that put Dispatch IDE's own server (REH) where Open Remote - SSH looks for it on another
 * Mac: `~/<serverDataFolderName>/bin/<commit>/bin/<serverApplicationName>`. `check` prints the platform and
 * "present" when that server is there; `install` unpacks the tarball read from stdin into that folder.
 * Undefined when a value is not something to put in a command line.
 */
export function serverCommands(folder: unknown, name: unknown, commit: unknown): { check: string; install: string } | undefined {
  const token = /^[A-Za-z0-9._-]{1,64}$/;
  if (typeof folder !== "string" || typeof name !== "string" || typeof commit !== "string") return undefined;
  if (!token.test(folder) || folder.startsWith("-") || !token.test(name) || name.startsWith("-") || !/^[0-9a-f]{40}$/.test(commit)) return undefined;
  const dir = `"$HOME/${folder}/bin/${commit}"`;
  const part = `"$HOME/${folder}/bin/${commit}.part"`;
  return {
    check: `uname -sm; test -x ${dir}/bin/${name} && echo present || true`,
    install: `rm -rf ${part} && mkdir -p ${part} && tar -xzf - -C ${part} --strip-components 1 && rm -rf ${dir} && mv ${part} ${dir} && test -x ${dir}/bin/${name} && echo installed`,
  };
}

export const SERVER_LAUNCHD_LABEL = "dev.dispatch.ide-server";

/**
 * A bash script (run over ssh) that starts Dispatch IDE's server on that Mac inside its logged-in session
 * (launchd's gui domain) when it is not running yet, the way Open Remote - SSH would, with the same pid, log
 * and token files, so the extension finds it running and connects to it. Started from an ssh login instead,
 * the server (and the Claude it starts) cannot read the login keychain: Claude says "Not logged in".
 * Prints "running", "started", "nogui" (nobody logged in there: the extension starts it over ssh) or "timeout".
 */
export function serverStartScript(folder: string, name: string, commit: string): string | undefined {
  if (!serverCommands(folder, name, commit)) return undefined;
  const plist = (pairs: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${pairs}</dict></plist>`;
  const args = ["$S", "--start-server", "--host=127.0.0.1", "--port=0", "--connection-token-file", "$TOK", "--telemetry-level", "off", "--enable-remote-auto-shutdown", "--accept-server-license-terms"];
  const body = plist(
    `<key>Label</key><string>${SERVER_LAUNCHD_LABEL}</string>` +
      `<key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array>` +
      `<key>StandardOutPath</key><string>$LOG</string><key>StandardErrorPath</key><string>$LOG</string>` +
      `<key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>` +
      `<key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/>`,
  );
  return [
    `D="$HOME/${folder}"; C="${commit}"; S="$D/bin/$C/bin/${name}"`,
    `PID="$D/.$C.pid"; LOG="$D/.$C.log"; TOK="$D/.$C.token"; L="${SERVER_LAUNCHD_LABEL}"; P="$D/launchd/$L.plist"`,
    `if [ -f "$PID" ] && ps -o pid,args -p "$(cat "$PID")" | grep -qF "$S"; then echo running; exit 0; fi`,
    `mkdir -p "$D/launchd"; rm -f "$LOG"; (umask 077; uuidgen | tr A-Z a-z > "$TOK")`,
    `cat > "$P" <<PLIST\n${body}\nPLIST`,
    `launchctl bootout "gui/$(id -u)/$L" 2>/dev/null`,
    `launchctl bootstrap "gui/$(id -u)" "$P" 2>/dev/null || { echo nogui; exit 0; }`,
    `for i in $(seq 1 60); do`,
    `  pid="$(launchctl list | awk -v l="$L" '$3==l{print $1}')"`,
    `  if [ -n "$pid" ] && [ "$pid" != "-" ] && grep -q "Extension host agent listening on" "$LOG" 2>/dev/null; then echo "$pid" > "$PID"; echo started; exit 0; fi`,
    `  sleep 0.5`,
    `done`,
    `echo timeout`,
  ].join("\n");
}

/** A folder path on another Mac that is safe to open: absolute, no `..`. */
export function remoteFolder(dir: unknown): string | undefined {
  const path = typeof dir === "string" ? dir.trim() : "";
  return path.startsWith("/") && !path.includes("\u0000") && !path.split("/").includes("..") ? path : undefined;
}

// dispatch.onboarding: the pure part. The setup wizard (Dispatch IDE patches/505-onboarding.patch) and
// Customizations > Migrations ask the bridge for `dispatch onboard <op>`; only these argument shapes reach the CLI.

export type OnboardingOp =
  | "status" | "unconnected" | "scan" | "scan-status" | "folders" | "register" | "prefs" | "prefs-apply" | "rules"
  | "apply-dir" | "apply-rules" | "apply-skills" | "apply-command" | "vscode" | "vscode-apply"
  | "log" | "available" | "undo" | "step" | "draft" | "finish" | "skip" | "reset";

const PLAIN = new Set<string>(["status", "unconnected", "scan", "scan-status", "folders", "prefs", "rules", "apply-dir", "apply-command", "vscode", "log", "available", "finish", "skip", "reset"]);
const STEPS = new Set(["agents", "projects", "prefs", "autonomy", "appearance", "notifications", "rules"]);
const AGENTS = /^(claude|codex|opencode)(,(claude|codex|opencode))*$/;
const PICKS = /^[0-9,\-\s]{0,4000}$/;
const ENTRY = /^ob-[a-z0-9]{4,12}$/;

export interface IRegisterItem {
  readonly dir: string;
  readonly name?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function absPath(v: unknown): string | undefined {
  const s = str(v);
  return s.startsWith("/") && !s.includes("\u0000") && s.length < 1024 ? s : undefined;
}

/** The `dispatch` argv for an op, or undefined when the op or its argument is not one the window can send. */
export function onboardingArgs(op: unknown, arg?: unknown, extra?: unknown): string[] | undefined {
  if (typeof op !== "string") return undefined;
  if (PLAIN.has(op)) return ["onboard", op, "--json"];
  switch (op) {
    case "register":
    case "draft":
    case "vscode-apply":
      return ["onboard", op, "--json"];
    case "prefs-apply": {
      const picks = str(arg);
      return PICKS.test(picks) ? ["onboard", op, "--pick", picks, "--json"] : undefined;
    }
    case "apply-rules":
    case "apply-skills": {
      const agents = str(arg);
      return AGENTS.test(agents) ? ["onboard", op, "--agents", agents, "--json"] : undefined;
    }
    case "undo": {
      const id = str(arg);
      return ENTRY.test(id) ? ["onboard", "undo", id, ...(extra === true ? ["--also-git"] : []), "--json"] : undefined;
    }
    case "step": {
      const step = str(arg);
      return STEPS.has(step) ? ["onboard", "step", step, "--json"] : undefined;
    }
    default:
      return undefined;
  }
}

/** The JSON a `register` sends on stdin: absolute folders and optional names, nothing else. */
export function registerInput(arg: unknown): string | undefined {
  if (!Array.isArray(arg) || arg.length === 0 || arg.length > 500) return undefined;
  const dirs: IRegisterItem[] = [];
  for (const it of arg) {
    const r = (it ?? {}) as Record<string, unknown>;
    const dir = absPath(r.dir);
    const name = str(r.name);
    if (!dir || name.length > 120 || name.includes("\u0000")) return undefined;
    dirs.push(name ? { dir, name } : { dir });
  }
  return JSON.stringify({ dirs });
}

/** The JSON `vscode-apply` sends on stdin: the setting keys to copy and two switches. */
export function vscodeApplyInput(arg: unknown): string | undefined {
  const r = (arg ?? {}) as Record<string, unknown>;
  const settings = Array.isArray(r.settings) ? r.settings.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length < 200) : [];
  return JSON.stringify({ settings, keybindings: r.keybindings === true, snippets: r.snippets === true });
}

export function draftInput(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) return undefined;
  const value = JSON.stringify(arg);
  return value.length <= 100000 ? value : undefined;
}

/** Extension ids `publisher.name`, as many as VS Code had. */
export function extensionIds(arg: unknown): string[] {
  return Array.isArray(arg) ? arg.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9][\w-]*\.[\w.-]+$/.test(x)).slice(0, 200) : [];
}

/** Apple's command line tools (git, python3) on this Mac: a new Mac has only stubs that ask to install them, and the
 *  dispatch CLI runs on that python3. `developerDir`: what `xcode-select -p` printed ("" when it failed). */
export function macToolsReady(platform: string, developerDir: string, exists: (p: string) => boolean): boolean {
  if (platform !== "darwin") return true;
  const dir = developerDir.trim();
  if (dir && exists(dir) && (exists(`${dir}/usr/bin/git`) || exists(`${dir}/Toolchains/XcodeDefault.xctoolchain/usr/bin/git`) || exists("/Library/Developer/CommandLineTools/usr/bin/git"))) return true;
  // Homebrew's own python3 and git do the same job
  return ["/opt/homebrew/bin", "/usr/local/bin"].some((d) => exists(`${d}/python3`) && exists(`${d}/git`));
}

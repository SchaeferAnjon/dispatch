/** One-shot navigation belongs to the destination Agents window, never its editor window. */
export function validLanding(value: unknown, now = Date.now() / 1000): value is { land: "waiting"; at: number; id: string } {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.land === "waiting" && typeof r.id === "string" && /^[a-f0-9]{32}$/.test(r.id)
    && typeof r.at === "number" && r.at <= now + 10 && now - r.at < 300;
}

export function landingOptions(value: unknown): { land?: "waiting"; dir?: string } {
  if (typeof value === "string") return { dir: value };
  if (!value || typeof value !== "object") return {};
  const r = value as Record<string, unknown>;
  return { ...(r.land === "waiting" ? { land: "waiting" as const } : {}), ...(typeof r.dir === "string" ? { dir: r.dir } : {}) };
}

export function serverStartFailure(code: number | null, out: string, err: string): string | undefined {
  // No GUI login is supported: the resolver can launch the server over SSH.
  if (code === 0 && /^(running|started|nogui)$/m.test(out)) return undefined;
  return (err.trim().split("\n").pop() || out.trim().split("\n").pop() || `exit ${code}`);
}

// The preferences walk (preferences.mjs) with every session on OpenCode and the cheap test model: the walk without
// the Claude allowance (Claude Code's own run is preferences.mjs, skipped unless DISPATCH_E2E_CLAUDE=1). OpenCode gets
// the session-start context (prime) from Dispatch's plugin, so the walk ends with a new session that carries it.
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.ENGINE = "OpenCode";
process.env.MODEL = "";

const walk = await import(pathToFileURL(path.join(path.dirname(process.argv[1]), "scenarios", "preferences.mjs")).href);

export const meta = { ...walk.meta, needs: ['opencode'], timeout: 1800, title: `${walk.meta.title}（OpenCode）` };
export default walk.default;

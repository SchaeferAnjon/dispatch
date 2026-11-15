// The preferences walk (preferences.mjs) with every session on Codex: test sessions do not use Claude Code
// (the person's Claude allowance is for the dispatcher). Codex has the session-start context (prime) too, so
// the walk still ends with a new session that carries the preference. Runs where the build's own runner is:
// a build request copies only this file, so preferences.mjs is loaded from the runner's scenarios folder.
//
// Codex in a test instance has its own CODEX_HOME without the rules a set-up Mac has (Set up puts Dispatch's block
// into ~/.codex/AGENTS.md: record a preference with prefs_add, Dispatch's tool); this walk puts the build's own rules there
// first, as Set up would, so Codex knows what to do with "use a square switch, not a pill".
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.ENGINE = "Codex";
process.env.MODEL = "";

const walk = await import(pathToFileURL(path.join(path.dirname(process.argv[1]), "scenarios", "preferences.mjs")).href);

export const meta = { ...walk.meta, needs: ['codex'], timeout: 1800, title: `${walk.meta.title}（Codex）` };
export default async function (ui) {
  const home = ui.rec.fixture_home ? path.join(ui.rec.fixture_home, ".codex") : path.join(ui.rec.root, "codex-home");
  const rules = path.join(path.dirname(path.dirname(path.dirname(ui.rec.cli))), "agent", "rules", "dispatch.md");
  if (fs.existsSync(rules)) {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, "AGENTS.md");
    const block = `<!-- BEGIN DISPATCH GLOBAL RULES (e2e) -->\n${fs.readFileSync(rules, "utf8")}\n<!-- END DISPATCH GLOBAL RULES -->\n`;
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fs.rmSync(file);
    fs.writeFileSync(file, block);
  }
  return walk.default(ui);
}

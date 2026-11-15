// Asking once for a star on GitHub (kanban app/cli/star.py; the idea is Orca's star-nag, nothing copied).
// The CLI decides when: a week of use and ten sessions with a reply, the repository public (open source), not
// starred already, never asked before. This side only looks now and then (a minute after the Agents window opens,
// then every few hours, and when star.json changes), and when it is due the first window to claim it shows one
// notification: "Star on GitHub" opens the page in the browser, "Not now" closes it. Either way it is not asked again.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { dispatchDir, log, runAnswer, runJson } from "./cli";
import { starAction, StarState, starState, STAR_TEXT } from "./core/star";

const FIRST_LOOK_MS = 60_000;
const EVERY_MS = 4 * 3600_000;

export function registerStar(ctx: vscode.ExtensionContext) {
  if (vscode.env.remoteName) return; // a window on another Mac: that Mac's own window asks
  let busy = false;
  let again = false; // star.json changed while a look was under way (GitHub can be slow): look once more after it
  let shown = false;
  const look = async (): Promise<void> => {
    if (shown) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const s: StarState = starState(await runJson(["star", "check", "--json"], { timeoutMs: 30000 }));
      if (!s.due) return;
      const claimed = await runAnswer<{ ok?: boolean }>(["star", "claim", "--json"], { timeoutMs: 20000 });
      if (claimed?.ok !== true) return; // another window asked, or it was asked before
      shown = true;
      const picked = await vscode.window.showInformationMessage(STAR_TEXT.message, STAR_TEXT.star, STAR_TEXT.later);
      const action = starAction(picked);
      if (action === "open") await vscode.env.openExternal(vscode.Uri.parse(s.url));
      await runAnswer(["star", "answer", action, "--json"], { timeoutMs: 20000 });
      log(`star: ${action}`);
    } catch (e) {
      log(`star: ${(e as Error).message}`);
    } finally {
      busy = false;
      if (again && !shown) {
        again = false;
        void look();
      }
    }
  };
  const first = setTimeout(() => void look(), FIRST_LOOK_MS);
  const every = setInterval(() => void look(), EVERY_MS);
  const file = path.join(dispatchDir(), "star.json");
  fs.watchFile(file, { interval: 5000 }, () => void look());
  ctx.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(every); fs.unwatchFile(file); } });
}

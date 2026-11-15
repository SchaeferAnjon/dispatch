// dispatch.mobile: the phone button in the title bar (Dispatch IDE patches/465-mobile.patch) and its popover.
//   state [pairId]     the service, the paired phones, and whether the code on screen was taken
//   pair [oldPairId]   a fresh one-time code: { pair, code, expires_in, svg_text, service }
//   revoke <id>        forget a phone
//   on / install       phone access on (`dispatch mobile on`); with no background service running, `dispatch chatd
//                      install` first: { ok, state }
//   off                phone access off: { ok, state }
//   another-port       the port was taken: let the service pick a free one, then on: { ok, state }
import * as vscode from "vscode";
import { runAnswer, runJson } from "./cli";
import { mobileArgs, shapeState } from "./core/mobile";

/** Phone access on; when no background service runs to carry it, that service is installed first. */
async function turnOn(): Promise<{ ok: boolean; state: ReturnType<typeof shapeState> }> {
  let r = await runAnswer<{ ok?: boolean; service?: string; chatd?: boolean }>(["mobile", "on", "--json"], { timeoutMs: 30000 });
  if (r?.service === "not_running" && !r.chatd) {
    await runAnswer(["chatd", "install", "--json"], { timeoutMs: 60000 });
    r = await runAnswer(["mobile", "on", "--json"], { timeoutMs: 30000 });
  }
  return { ok: r?.ok === true, state: shapeState(r) };
}

export function registerMobile(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.mobile", async (op?: unknown, ...a: unknown[]) => {
      const args = mobileArgs(op, ...a);
      if (!args) throw new Error(`dispatch.mobile: bad request ${String(op)}`);
      if (op === undefined || op === "state") return shapeState(await runJson(args, { timeoutMs: 15000 }), typeof a[0] === "string" ? a[0] : undefined);
      if (op === "pair") {
        const r = await runAnswer<{ ok?: boolean }>(args, { timeoutMs: 30000 });
        return r && r.ok === false ? { ...r, state: shapeState(r) } : r;
      }
      if (op === "install" || op === "on") return turnOn();
      if (op === "another-port") {
        await runAnswer(args, { timeoutMs: 15000 });
        return turnOn();
      }
      if (op === "off") {
        const r = await runAnswer<{ ok?: boolean }>(args, { timeoutMs: 15000 });
        return { ok: r?.ok !== false, state: shapeState(r) };
      }
      return runAnswer(args, { timeoutMs: 15000 });
    }),
  );
}

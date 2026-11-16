// dispatch.pointTalk: Point and talk's speech recognition for the Agents window's camera button (Dispatch IDE
// contrib/dispatchPointTalk). The CLI (app/cli/point_talk.py) holds the Soniox key: `status` says whether there is
// one, `key` hands out a temporary key for one real-time socket (single use, a minute to connect), `transcribe` runs a
// whole recording through the async API when the live words broke off. Keys never go into the log; only the
// operation and how it ended do.
import * as vscode from "vscode";
import { log, runAnswer } from "./cli";
import { pointTalkCall, PointTalkAnswer } from "./core/pointTalk";

export function registerPointTalk(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.pointTalk", async (op: unknown, payload: unknown): Promise<PointTalkAnswer> => {
      const name = String(op ?? "");
      try {
        const call = pointTalkCall(name, payload);
        // every call goes to the CLI by itself: a temporary key is good for one socket only
        const cts = new vscode.CancellationTokenSource();
        try {
          const answer = await runAnswer<PointTalkAnswer>(call.args, { timeoutMs: call.timeoutMs, token: cts.token });
          log(`point-talk ${name} → ${answer.ok ? "ok" : answer.error}`);
          return answer;
        } finally {
          cts.dispose();
        }
      } catch (e) {
        log(`point-talk ${name}: failed`);
        return { ok: false, error: "bridge", message: (e as Error).message };
      }
    }),
  );
}

// The delivery page's local server (the rules are in core/deliveryPage.ts).
//
// `dispatch deliver … --show` → ide show request with {delivery, task} → ideShow.ts asks here for a
// URL: the page's folder is served at http://127.0.0.1:<port>/<token>/ (a random token per folder,
// only for this window's lifetime) and opened from there in the right panel. The page reads
// `__dispatch/state` to know it is inside Dispatch and POSTs `__dispatch/pick`; the bridge runs
// `dispatch flow pick <that task> <A-F> --reason …` and nothing else. The same file opened any other
// way (the system browser, a file:// URL) has no server behind it and only shows what would happen.
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { log, runAnswer } from "./cli";
import { contentType, hostOk, isTask, MAX_BODY, pageState, parsePick, pickAllowed, pickAnswer, pickArgs, routeOf, tokenOf, withDrawScrollAgent } from "./core/deliveryPage";

interface Served {
  dir: string;
  task: string;
  kind: string;
}

let server: http.Server | undefined;
let port = 0;
const byToken = new Map<string, Served>();

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, obj: unknown) {
  send(res, status, JSON.stringify(obj));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!hostOk(req.headers.host, port)) return json(res, 403, { ok: false, error: "wrong host" });
  const url = req.url || "/";
  const token = tokenOf(url);
  const served = token ? byToken.get(token) : undefined;
  const route = served ? routeOf(url, token) : undefined;
  if (!served || !route) return json(res, 404, { ok: false, error: "not found" });

  if (route.kind === "state") {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
    let flow: Record<string, unknown> | undefined;
    if (served.kind === "proposal") {
      try {
        flow = await runAnswer<Record<string, unknown>>(["flow", "show", served.task, "--json"], { timeoutMs: 15000 });
      } catch (e) {
        log(`delivery page state: ${(e as Error).message}`);
      }
    }
    return json(res, 200, pageState(served.kind, flow));
  }

  if (route.kind === "pick") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
    if (!pickAllowed(req.headers as Record<string, string>, port)) return json(res, 403, { ok: false, error: "not from this page" });
    if (served.kind !== "proposal") return json(res, 400, { ok: false, error: "this page has nothing to pick" });
    let body = "";
    let tooBig = false;
    req.setEncoding("utf8");
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        break;
      }
    }
    if (tooBig) return json(res, 413, { ok: false, error: "too long" });
    const pick = parsePick(body);
    if ("error" in pick) return json(res, 400, { ok: false, error: pick.error });
    log(`delivery page: pick ${pick.option} for ${served.task}`);
    try {
      const ans = await runAnswer<Record<string, unknown>>(pickArgs(served.task, pick), { timeoutMs: 60000 });
      return json(res, 200, pickAnswer(ans));
    } catch (e) {
      return json(res, 500, { ok: false, error: (e as Error).message });
    }
  }

  // a file of the page's folder, and only of it
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, error: "GET only" });
  const type = contentType(route.rel);
  if (!type) return json(res, 404, { ok: false, error: "not found" });
  try {
    const root = fs.realpathSync(served.dir);
    const file = fs.realpathSync(path.join(root, route.rel));
    if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return json(res, 404, { ok: false, error: "not found" });
    let data = await fs.promises.readFile(file);
    // an HTML page answers Draw and ask's scroll through it (the Docs tab's whole-page picture)
    if (type.startsWith("text/html")) data = Buffer.from(withDrawScrollAgent(data.toString("utf8")), "utf8");
    return send(res, 200, req.method === "HEAD" ? Buffer.alloc(0) : data, type);
  } catch {
    return json(res, 404, { ok: false, error: "not found" });
  }
}

function start(): Promise<number> {
  if (server && port) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        log(`delivery page: ${(e as Error).message}`);
        try {
          json(res, 500, { ok: false, error: "failed" });
        } catch {
          /* already answered */
        }
      });
    });
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") return reject(new Error("no port"));
      server = s;
      port = a.port;
      log(`delivery page server on 127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

/** The URL of a delivery page served from its folder, for the task it was delivered to. */
export async function servedUrl(file: string, task: string, kind: string): Promise<string> {
  const dir = path.dirname(file);
  if (!isTask(task) && kind === "proposal") throw new Error("a proposal page needs its task");
  const p = await start();
  let token = [...byToken.entries()].find(([, v]) => v.dir === dir && v.task === task && v.kind === kind)?.[0];
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    byToken.set(token, { dir, task, kind });
  }
  return `http://127.0.0.1:${p}/${token}/${encodeURIComponent(path.basename(file))}`;
}

export function disposeDeliveryServer() {
  server?.close();
  server = undefined;
  port = 0;
  byToken.clear();
}

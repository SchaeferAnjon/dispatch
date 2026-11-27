// Keeps a test instance's windows off the person's screen (user 2026-10-01; task-t8s1). Started by
// `dispatch ide instance start` right after the app, with the app's own Electron as Node:
//
//   hide-windows.mjs <inspector port> [wait ms] [DevTools port]
//
// The app runs with --inspect=<port> (its main process, 127.0.0.1 only). This connects there before the first
// window and, inside the main process, makes every window fully transparent and click-through from the moment
// it is created, shows windows without activating the app (show → showInactive, focus and app.focus do
// nothing) and takes the app out of the Dock. A transparent window still draws, so CDP pictures, clicks and
// typing work as before. What did not work: CDP's Browser.setWindowBounds (not in this Electron), window.moveTo
// (stops at the screen's edge), and hiding the app (⌘H): a window shown while the app is hidden is never drawn
// and Page.captureScreenshot waits for ever. Prints one JSON line: {ok, windows, error}.
import { hideMain } from "./cdp.mjs";

// the answer is written out before the exit: on macOS a pipe is written asynchronously, and an exit right after
// console.log can leave the caller an empty stdout
const answer = (v, code) => process.stdout.write(JSON.stringify(v) + "\n", () => process.exit(code));
hideMain(Number(process.argv[2]), Number(process.argv[3] || 30000), Number(process.argv[4] || 0)).then(
  (v) => answer({ ok: true, ...v }, 0),
  (e) => answer({ ok: false, error: String(e.message || e) }, 1),
);

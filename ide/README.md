# Dispatch IDE

Dispatch's desktop app: VS Code 1.139.1 (Code - OSS, github.com/microsoft/vscode, MIT) with Dispatch's changes,
kept as full source in `vscode/`. Dispatch Agent is its Agents window; the editor window is Dispatch IDE.

Since 2026-10-07 this is our own copy of the source, edited directly and compiled incrementally. Dispatch does not
follow new VS Code versions: when a serious security fix lands upstream, port that fix by hand. Before that date the
changes were 89 patches applied at build time to a fresh checkout of the tag, in a repository of their own
(github.com/SchaeferAnjon/dispatch-ide); its history is in this one under `ide/`, every commit ending in
`dispatch-ide: <its old id>` (`git log --grep=<old id>` finds one). The source here is byte for byte what those
patches made (task-dgfei); what each feature does, as its patch described it: `git show c10dc41b:ide/PATCHES.md`.

## What is where

| | |
|---|---|
| `vscode/` | the source: VS Code 1.139.1 as released, plus Dispatch's code and edits. Its `LICENSE.txt` and `ThirdPartyNotices.txt` are VS Code's and stay as they are |
| `vscode/src/vs/sessions/contrib/dispatch*/` | Dispatch's own features in the Agents window; `vscode/src/vs/workbench/contrib/dispatch*/` the ones for both windows |
| `vscode/product.json` | name, data folders, bundle id, Open VSX, the update feed, the agent SDKs, default settings (`configurationDefaults`) |
| `dev.sh` | the development build: compile what changed, run from source |
| `build.sh`, `parts.sh`, `build-server.sh`, `update-bridge.sh` | the full package (`.app`) and what goes into it besides VS Code |
| `bundle-*.sh`, `opencode-kit/` | bd and Dolt, OpenCode's plugin kit, Open Remote - SSH, pinned and checked by sha256 |
| `sign.sh`, `sign.mjs`, `install.sh`, `release.sh`, `checksums.py` | signing, notarizing, installing into /Applications, the update feed |
| `remote-build.sh` | the build machine's side of `dispatch build` (app/cli/builds.py) |
| `whats-new/` | this version's What's new pages |
| `tests/`, `test_sign.py`, `typecheck.sh` | the checks below |

Dispatch's side outside the app (the `dispatch` CLI, chatd, the dispatch-bridge extension in `app/ide-ext`) is in
the rest of this repository; `parts.sh` puts the bridge and the CLI into the app.

## Adding or changing a feature

- **Dispatch's code goes in new files**: a feature of the Agents window in `vscode/src/vs/sessions/contrib/dispatch<Feature>/`
  (`common/` for pure logic with its tests in `test/` or `ide/tests/`, `browser/`, `electron-browser/`, `media/` for CSS),
  one for both windows in `vscode/src/vs/workbench/contrib/dispatch<Feature>/`, agent host code next to the harness it
  serves (`vscode/src/vs/platform/agentHost/node/<engine>/`) in files of its own. One feature, one folder: it can be
  read, reviewed and taken out on its own.
- **VS Code's own files get as little as possible**: an import line in a main file (`sessions.desktop.main.ts`,
  `sessions.common.main.ts`, `workbench.desktop.main.ts`), a call into your module, a slot element, a CSS class. Mark
  it `// Dispatch IDE: <what this is for>`, so it reads as ours. Better no edit at all: a contribution registered in
  your own file (`registerWorkbenchContribution2`), a command, a menu item, a view or a setting needs only the import line.
- **Export a type as a type** (`export type { … }`, `import { type … }`): the development build compiles one file at
  a time, and there a type re-exported as a value stops the page that loads it. `./typecheck.sh` catches it.
- **What Dispatch changed in VS Code**, any time: `git diff $(git log --format=%H --diff-filter=A -- ide/vscode/package.json | tail -1) -- ide/vscode`
  (add `--stat` for the list of files). That first commit is VS Code 1.139.1 exactly as released.
- Two groups do not change the same file at the same time: say in the task which folders and VS Code files you edit.
- Interface text is English for now, like VS Code's own; the app icon is `vscode/resources/darwin/code.icns`, a copy of
  `app/icons/icon.icns` (copy it again when the icon changes).

## Trying a change: the development build

`dev.sh` compiles `vscode/` in place and runs it from source with VS Code's own Electron, the way VS Code's developers
work. Only what changed since the last build is compiled (VS Code's `build-fast`: esbuild, one file at a time):

    ./dev.sh build      # first time: npm ci (minutes) and a full compile (about 15 s); after a change: a few seconds
    ./dev.sh watch      # or keep compiling on save; then Developer: Reload Window (⌘R) in the running window
    ./dev.sh run        # a window of its own ("Dispatch IDE Dev": own settings, secrets in memory, no keychain)

A test instance of it, for end-to-end scenarios (`app/scripts/ide-e2e`):

    dispatch ide instance start <name> --app ide --agents     # from the checkout: its development build
    dispatch ide e2e run <scenario> --instance <name>

On the build service, with nothing compiled on this Mac: commit, then

    dispatch build start HEAD --dev [--e2e <scenario.mjs> …] [--task <task>]

builds it in the mini's development tree (`~/dispatch-builds/work/dev`, which keeps its compiled output between
builds, so again only what changed is compiled) and runs the scenarios there while the tree stays on that commit.

Run from source, VS Code adds " Dev" to its name and keeps its settings apart; Copilot and the colour themes the
package leaves out are switched off (`.build/dispatch-dev.json` has the launch line).

## The full package

    dispatch build start [<ref>] [--task <task>] [--e2e …]   # on the mini: Dispatch IDE.app at that commit, a few minutes
    dispatch build get <name>       # copy it to ide/staging/<name>/ here
    dispatch build sign <name>      # Developer ID and notarization (this Mac's keychain only)
    dispatch build install <name>   # into /Applications (quit Dispatch IDE first)

`./build.sh` makes the same package on this Mac (`MIN=1` minified, `DISPATCH_UPDATE_URL` for another update feed);
the mini keeps a tree for it too (`~/dispatch-builds/work/dispatch`) with its node_modules and download caches.
Output: `ide/VSCode-darwin-arm64/Dispatch IDE.app`. `./update-bridge.sh` puts a newly built dispatch-bridge and CLI
into that app without packaging VS Code again. `release.sh <app>` publishes a signed build to the update feed.

## Checks

    ./typecheck.sh                     # types of everything Dispatch changed, isolatedModules on; about 45 s
    node --test tests/*.test.mjs       # Dispatch's pure modules (Node 23+, it imports the .ts files directly)
    python3 -m unittest test_sign      # signing

## Licences

VS Code is MIT (`vscode/LICENSE.txt`, its third-party notices in `vscode/ThirdPartyNotices.txt`). The tools bundled
into the app keep their own licences next to them (`tools/licenses`): bd MIT, Dolt Apache-2.0, OpenCode's plugin kit
MIT, Open Remote - SSH MIT. Dispatch's own code is under the repository's licence.

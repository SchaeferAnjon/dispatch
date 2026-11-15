# Dispatch context in OpenCode

Dispatch's local OpenCode plugin loads the current tasks, preferences, identity and parallel
sessions before the first model request. It also supplies the session ID to shell commands
and forwards `todowrite` to the task's plan.

```sh
dispatch engines install-plugin opencode
dispatch engines uninstall-plugin opencode
```

Selecting OpenCode in the setup wizard installs the same plugin. The plugin lives in
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/dispatch.js`, linked to this file's sibling
`dispatch.js`, or copied when symlinks are unavailable. Installation and removal leave
`opencode.json` and other plugins unchanged. Replaced plugins get a `.bak` backup, with a
numeric suffix when needed. Removal preserves the Dispatch plugin as `.disabled`, outside
OpenCode's plugin scan. Earlier backups are retained without being automatically activated.

The plugin runs `dispatch prime --opencode --cwd <directory>` as `opencode`, with the actual
`DISPATCH_SESSION_ID`. It waits at most 15 seconds and silently skips missing commands,
errors, empty output and timeouts. It caches the result once per session per OpenCode
process, sharing in-flight requests. Subsequent model calls receive the same context until a
compaction. Deleting the session or disposing the plugin clears that cache.
Restarting OpenCode refreshes the snapshot on the session's next request.

Context lifetime works as in Claude Code and Codex. When a turn ends (`session.idle`) the plugin
runs `dispatch handoff hook --agent opencode` with the Stop hook's JSON. Its reminder (the warning
line) or handoff request (the limit) is added to that session's system prompt for every request
until the next turn ends, so the agent writes `dispatch handoff write` at the next safe step. After a
compaction (`session.compacted`, automatic or `/compact`) the cached brief is dropped and the next
request loads `dispatch prime --opencode --source compact`, which starts with the latest handoff.
The lifetime meter reads OpenCode's SQLite store and starts a new epoch at each compaction.

The plain-text digest is at most 10,000 UTF-8 bytes including its final newline. Identity,
the preference recording rule, tasks, parallel sessions and preferences take precedence over
optional static rules and facts. Preferences use the same entry and character limits as
Codex's compact preference section. Run `dispatch prime` for the full digest.

`DISPATCH_CLI` can point to an explicit Dispatch executable, including for isolated tests.
No npm dependencies are required by this plugin.

OpenCode itself installs its plugin kit (`@opencode-ai/plugin`) from npm into every config folder it reads
(`~/.config/opencode`, `~/.opencode`, a project's `.opencode`), and once any plugin is loaded it waits for
that install before the first answer: about five minutes when npm cannot be reached. Dispatch IDE ships the
kit (`Resources/app/tools/opencode-plugin-kit.tgz`), and `dispatch engines opencode-kit` unpacks it into those
folders that have no packages yet, so OpenCode finds it installed. Installing the plugin does it, so does
installing OpenCode from Dispatch, and the Agents window checks again before it starts OpenCode.

Verified against OpenCode 1.18.32. The system prompt hook is an experimental upstream API:

- [Official plugin documentation](https://opencode.ai/docs/plugins/) describes automatic local plugin loading.
- [1.18.32 plugin discovery](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/plugin.ts#L18) accepts `plugin/` and `plugins/`, including symlinks.
- [1.18.32 hook contract](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/plugin/src/index.ts#L291) provides `sessionID` and a mutable `system` array.
- [1.18.32 request preparation](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/llm/request.ts#L68) awaits the hook before submitting the model request. This keeps injection on the request path without adding a synthetic user message or depending on a `session.created` event race.

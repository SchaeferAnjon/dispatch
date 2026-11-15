/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dispatch IDE (kanban task-qb6j, "run a session on another Mac"): the command the SSH agent host runs on the other
// Mac instead of downloading Microsoft's CLI (which this build cannot use). It starts Dispatch IDE's own server there,
// at this app's commit (dispatch-bridge copies it over first, `dispatch.machines runOn`), with an agent host on a
// local port and a fresh token, inside that Mac's logged-in session (launchd's gui domain) so the agents it starts
// can read that Mac's keychain; then it prints the address the SSH tunnel connects to and stays while the server
// runs. A server already running at this commit is reused. Nobody logged in there: started from the SSH login.
// The server stops by itself once nothing is connected and no session is running (--enable-remote-auto-shutdown).

const SCRIPT = [
	'C="$1"; D="$HOME/$2"; R="$D/bin/$C"',
	'if [ ! -x "$R/node" ] || [ ! -f "$R/out/server-main.js" ]; then echo "Dispatch is not set up on this computer for this version yet ($C)." >&2; exit 3; fi',
	'L=dev.dispatch.agent-host; PF="$D/.ah.$C.port"; TOK="$D/.ah.$C.token"; LOG="$D/.ah.$C.log"; PL="$D/launchd/$L.plist"',
	'up() { [ -s "$PF" ] && [ -s "$TOK" ] && nc -z 127.0.0.1 "$(cat "$PF")" >/dev/null 2>&1; }',
	'if ! up; then',
	'  P=$(python3 -c \'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])\' 2>/dev/null || echo $((40000 + $$ % 20000)))',
	'  (umask 077; uuidgen | tr A-Z a-z > "$TOK"); echo "$P" > "$PF"; mkdir -p "$D/launchd"; rm -f "$LOG"',
	'  A="--host=127.0.0.1 --port=0 --agent-host-port=$P --connection-token-file $TOK --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms"',
	'  { echo \'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>\'',
	'    echo "<key>Label</key><string>$L</string><key>ProgramArguments</key><array><string>$R/node</string><string>$R/out/server-main.js</string>"',
	'    for a in $A; do echo "<string>$a</string>"; done',
	'    echo "</array><key>StandardOutPath</key><string>$LOG</string><key>StandardErrorPath</key><string>$LOG</string>"',
	'    echo "<key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>"',
	'    echo "<key>RunAtLoad</key><true/></dict></plist>"; } > "$PL"',
	'  launchctl bootout "gui/$(id -u)/$L" >/dev/null 2>&1',
	'  if ! launchctl bootstrap "gui/$(id -u)" "$PL" >/dev/null 2>&1; then nohup "$R/node" "$R/out/server-main.js" $A >"$LOG" 2>&1 </dev/null & fi',
	'  i=0; until up; do i=$((i+1)); if [ $i -gt 120 ]; then echo "Dispatch could not start on this computer." >&2; tail -5 "$LOG" >&2; exit 4; fi; sleep 0.5; done',
	'fi',
	'echo "ws://127.0.0.1:$(cat "$PF")?tkn=$(cat "$TOK")"',
	'while up; do sleep 15; done',
].join('\n');

function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command for this app (its server folder name and commit), or undefined for a build without them. */
export function dispatchAgentHostCommand(serverDataFolderName: string | undefined, commit: string | undefined): string | undefined {
	if (!serverDataFolderName || !/^[A-Za-z0-9._-]{1,64}$/.test(serverDataFolderName) || serverDataFolderName.startsWith('-')) {
		return undefined;
	}
	if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
		return undefined;
	}
	return `sh -c ${shQuote(SCRIPT)} _ ${commit} ${serverDataFolderName}`;
}

#!/bin/bash
# macOS only. The Windows first run (winget deps, CLI shims, embedded board) is covered by the CI smoke tests in the cli-windows job.
# Walk a brand-new Mac from "download Dispatch" to "an agent answers", the way a new user does, inside the VM from
# vm.sh: put Dispatch IDE in /Applications, open it, click through the setup wizard it shows, make a task in a new
# Terminal, install an agent from the new-session page and get an answer from it, restart the Mac. The clicking is
# real (CDP from inside the VM, the app's own Electron as Node running scripts/ide-e2e/runner.mjs with wizard.mjs);
# every step prints PASS / FAIL with what it saw, nothing is skipped silently. A new user gets the dispatch command
# from the app (the wizard links it), so there is no separate CLI download here.
#
#   first-run.sh                      the latest release; the repository is private, so gh downloads it on this Mac
#   first-run.sh --zip FILE           a Dispatch-IDE-*.zip instead
#   first-run.sh --dmg FILE           a Dispatch-IDE-*.dmg as released (Developer ID, not notarized), the way a person
#                                     installs it: Gatekeeper on, the dmg in ~/Downloads with the quarantine mark,
#                                     double-clicked, the app dragged onto Applications in its window, the first open
#                                     stopped by macOS and let through as the README says (Done, Privacy & Security,
#                                     Open Anyway twice, the login password); the buttons are found by name (vm.sh ocr)
#   first-run.sh --app DIR            a built "Dispatch IDE.app" (dispatch build's ~/dispatch-builds/<name>/Dispatch IDE.app)
#   first-run.sh --overlay-cli        put this checkout's CLI package into the app first (cli/bundle.json: the CLI,
#                                     Dispatch's agent rules, skills, plugins), to try a fix before it is built
#   first-run.sh --shots DIR          copy the GUI steps' screenshots and checks.json to DIR
#   first-run.sh --as-download        install the zip the way a person does after a browser download: Gatekeeper on,
#                                     the zip in ~/Downloads with the quarantine mark, Archive Utility opens it, the
#                                     Finder moves the app into Applications, the first open is stopped and let through
#                                     as with --dmg (the clicks and keys go through the VM's Screen Sharing)
#   first-run.sh --no-clt             take the image's command line tools out first: a new Mac has none (no git, and
#                                     python3 is a stub that asks to install them)
#   first-run.sh --scenario FILE      what to click through after the first window (default wizard.mjs; newuser.mjs:
#                                     the new-user walk of the 0.9.1 release, with times)
#   first-run.sh --from STEP          continue from a step (install|image|open|wizard|reboot)
#   first-run.sh --to STEP            stop after that step (NEWUSER_FROM=setup|project|session|settings goes on with
#                                     newuser.mjs from there: first-run.sh --from wizard --to wizard --scenario newuser.mjs)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; VM="$HERE/vm.sh"; APPDIR="$(cd "$HERE/../.." && pwd)"
ZIP=""; DMG=""; APPSRC=""; OVERLAY=0; FROM=""; TO=""; ENDED=0; SHOTS=""; DOWNLOAD=0; NOCLT=0; SCENARIO="$HERE/wizard.mjs"
while [ $# -gt 0 ]; do case "$1" in --zip) ZIP="$2"; shift 2;; --dmg) DMG="$2"; DOWNLOAD=1; shift 2;; --app) APPSRC="$2"; shift 2;; --overlay-cli) OVERLAY=1; shift;; --shots) SHOTS="$2"; shift 2;; --from) FROM="$2"; shift 2;; --to) TO="$2"; shift 2;; --as-download) DOWNLOAD=1; shift;; --no-clt) NOCLT=1; shift;; --scenario) SCENARIO="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2;; *) echo "unknown: $1" >&2; exit 2;; esac; done
APP='/Applications/Dispatch IDE.app'
ELECTRON="$APP/Contents/MacOS/Dispatch IDE"
PORT=9333
PASS=0; FAIL=0; SKIPPING=$([ -n "$FROM" ] && echo 1 || echo 0)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
step() {
  if [ "$ENDED" = 1 ] || { [ "$SKIPPING" = 1 ] && [ "$1" != "$FROM" ]; }; then return 1; fi
  SKIPPING=0; [ "$1" = "$TO" ] && ENDED=1; say "$2"; return 0
}
# a command in a new Terminal window: a login, interactive zsh, as the person
term() { "$VM" ssh "$*"; }
now() { python3 -c 'import time; print(time.time())'; }
secs() { python3 -c "import sys; print(f'{float(sys.argv[2]) - float(sys.argv[1]):.1f}')" "$1" "$(now)"; }
# the whole screen, as a person sees it (Screen Sharing), into the shots folder
shot() { [ -n "$SHOTS" ] && mkdir -p "$SHOTS" && "$VM" shot "$SHOTS/$1.png" >/dev/null 2>&1; }

# A browser download, then what a person does with it (--as-download). Times go to $SHOTS/times.txt.
download_install() {
  local zip="$1" name; name="$(basename "$zip")"
  local times="${SHOTS:-$TMP}/times.txt"; mkdir -p "$(dirname "$times")"
  "$VM" raw "sudo spctl --global-enable 2>/dev/null || sudo spctl --master-enable; pkill -x 'Dispatch IDE' 2>/dev/null; rm -rf '$APP' ~/Downloads/'Dispatch IDE.app'"
  case "$("$VM" raw 'spctl --status 2>&1')" in *enabled*) ok "Gatekeeper is on, as on a new Mac";; *) bad "Gatekeeper could not be turned on";; esac
  "$VM" put "$zip" "Downloads/$name" >/dev/null
  # what Safari leaves on a download: the quarantine mark (Gatekeeper checks the app it holds) and where it came from
  "$VM" raw "xattr -w com.apple.quarantine \"0083;\$(printf %x \$(date +%s));Safari;\$(uuidgen)\" ~/Downloads/$name && xattr -w com.apple.metadata:kMDItemWhereFroms https://github.com/SchaeferAnjon/dispatch/releases ~/Downloads/$name"
  # the DevTools port for the clicking below, in argv.json: the first open is the person's own double click
  "$VM" raw "mkdir -p ~/.dispatch-ide && echo '{\"remote-debugging-port\": \"$PORT\"}' > ~/.dispatch-ide/argv.json"
  local t; t=$(now)
  "$VM" raw "open ~/Downloads/$name; for i in \$(seq 1 180); do sleep 1; [ -d ~/Downloads/'Dispatch IDE.app' ] && ! pgrep -x 'Archive Utility' >/dev/null && break; done"
  "$VM" raw "test -d ~/Downloads/'Dispatch IDE.app'" && ok "double-clicked in Downloads, Archive Utility unpacked it ($(secs "$t") s)" || bad "Archive Utility did not unpack $name"
  echo "unzip $(secs "$t")" >> "$times"
  # into Applications with the Finder: the window `open /Applications` brings up, its side bar's Downloads, then the
  # app (the newest, on top of the list) dragged onto the side bar's Applications. Where these are on a new Mac's
  # 2048x1536 screen; key chords do not reach the Finder through Screen Sharing here.
  "$VM" raw "open /Applications"; sleep 2
  "$VM" screen click 309 628 sleep 1.5 >/dev/null
  shot 00a-downloads
  t=$(now)
  "$VM" screen drag 644 423 316 460 >/dev/null
  "$VM" raw "for i in \$(seq 1 120); do [ -d '$APP' ] && ! [ -d ~/Downloads/'Dispatch IDE.app' ] && break; sleep 1; done"
  local mark; mark=$("$VM" raw "xattr -p com.apple.quarantine '$APP' 2>/dev/null")
  "$VM" raw "test -d '$APP'" && ok "the Finder moved it into Applications ($(secs "$t") s), still marked from the internet: ${mark%%;*}" || bad "the app is not in Applications"
  echo "move $(secs "$t")" >> "$times"
  shot 00b-in-applications
  first_open
}

# Where a piece of text is on the VM's screen now, as "X Y" (the first line OCR reads as exactly TEXT, or containing it
# with --part); nothing when it is not there. Buttons are clicked by name: the dialogs move with what else is open.
at_text() {
  local part=0; [ "$1" = --part ] && { part=1; shift; }
  "$VM" ocr 2>/dev/null | awk -F'\t' -v t="$1" -v p="$part" '(p && index($3, t)) || $3 == t { print $1, $2; f = 1; exit } END { exit !f }'
}
# wait_text SECONDS [--part] TEXT: wait for it to be on screen; prints where
wait_text() {
  local w="" end=$(( $(date +%s) + $1 )); shift
  while [ "$(date +%s)" -lt "$end" ]; do w=$(at_text "$@"); [ -n "$w" ] && { echo "$w"; return 0; }; sleep 2; done
  return 1
}
devtools() { "$VM" raw "curl -s -m 2 http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }

# The first open of a download. Releases are signed with a Developer ID and not notarized (2026-11-15), so macOS stops
# the first double-click and the person lets it through once, the way the README says: Done, then System Settings ›
# Privacy & Security, Open Anyway, Open Anyway again in the question that comes up, the login password, OK. Each click
# finds its button by its name on screen; a step that is not there is a FAIL, and the app is then let through with
# the README's other way (xattr) so the rest of the run still tests the app.
first_open() {
  local t w y1; t=$(now)
  "$VM" raw "open '$APP'"
  if w=$(wait_text 90 --part 'Not Opened'); then
    shot 00c-blocked
    devtools && bad "the app started although macOS said it was not opened" \
      || ok "the first open is stopped and the app does not start ($(secs "$t") s): $("$VM" ocr | awk -F'\t' '/Not Opened|could not verify/ { printf "%s ", $3 }')"
    echo "blocked $(secs "$t")" >> "$times"
    # Done, never Move to Trash next to it
    w=$(at_text Done) && "$VM" screen click $w >/dev/null && sleep 2
    "$VM" raw "pgrep -x 'Dispatch IDE' >/dev/null" && bad "Dispatch IDE is still running after Done" || ok "Done: nothing runs, the app stays in Applications"
  else
    shot 00c-no-question; bad "no \"Not Opened\" question within 90 s of the first open"
  fi
  # System Settings › Privacy & Security (the deep link is where its side bar's item goes), down to Security
  "$VM" raw "open 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'"
  wait_text 30 'Privacy & Security' >/dev/null
  for _ in 1 2 3 4 5 6 7 8; do w=$(at_text "Open Anyway") && break; "$VM" screen scroll 1200 900 500 >/dev/null; sleep 1; done
  if [ -n "$w" ]; then
    shot 00d-privacy-security
    ok "Privacy & Security shows: $("$VM" ocr | awk -F'\t' '/was blocked/ { print $3; exit }') · Open Anyway"
    y1=${w#* }; t=$(now)
    "$VM" screen click $w >/dev/null
    # the question that follows has its own Open Anyway (not the one in the list behind it)
    if wait_text 20 --part 'Apple is not able to verify' >/dev/null; then
      shot 00e-open-anyway-question
      w=$("$VM" ocr | awk -F'\t' -v y="$y1" '$3 == "Open Anyway" && ($2 - y > 20 || y - $2 > 20) { print $1, $2; exit }')
      [ -n "$w" ] && "$VM" screen click $w >/dev/null && ok "the question Open \"Dispatch IDE\"? answered with Open Anyway" || bad "the question has no Open Anyway"
    else
      bad "no Open \"Dispatch IDE\"? question after Open Anyway"
    fi
    if wait_text 20 --part 'Enter an administrator' >/dev/null; then
      w=$(at_text Password)
      [ -n "$w" ] && "$VM" screen click $w type admin sleep 0.5 >/dev/null
      shot 00f-password
      w=$(at_text OK) && "$VM" screen click $w >/dev/null \
        && ok "asked for an administrator's password (user admin filled in): typed it, then OK" || bad "the password question has no OK"
    else
      bad "no password question after Open Anyway"
    fi
    for _ in $(seq 1 30); do devtools && break; sleep 2; done
  else
    shot 00d-no-open-anyway; bad "Privacy & Security shows no Open Anyway"
  fi
  if devtools; then
    ok "Dispatch IDE opened $(secs "$t") s after Open Anyway"; echo "first-window $(secs "$t")" >> "$times"
    "$VM" raw "osascript -e 'quit app \"System Settings\"'" >/dev/null 2>&1
  else
    bad "Dispatch IDE did not open by Open Anyway: let through with xattr, the README's other way"; shot 00g-no-window
    "$VM" raw "osascript -e 'quit app \"System Settings\"'; pkill -x 'Dispatch IDE'; xattr -dr com.apple.quarantine '$APP'; open '$APP'" >/dev/null 2>&1
    for _ in $(seq 1 30); do devtools && break; sleep 2; done
  fi
}

# The dmg a person downloads (--dmg): Gatekeeper sees a Developer ID signature without notarization, a double-click
# opens the dmg, the app is dragged onto the Applications link beside it (the Finder gives the copy the download's mark)
download_install_dmg() {
  local dmg="$1" name w a; name="$(basename "$dmg")"
  local times="${SHOTS:-$TMP}/times.txt"; mkdir -p "$(dirname "$times")"
  "$VM" raw "sudo spctl --global-enable 2>/dev/null || sudo spctl --master-enable; pkill -x 'Dispatch IDE' 2>/dev/null; rm -rf '$APP'"
  case "$("$VM" raw 'spctl --status 2>&1')" in *enabled*) ok "Gatekeeper is on, as on a new Mac";; *) bad "Gatekeeper could not be turned on";; esac
  "$VM" put "$dmg" "Downloads/$name" >/dev/null
  "$VM" raw "xattr -w com.apple.quarantine \"0083;\$(printf %x \$(date +%s));Safari;\$(uuidgen)\" ~/Downloads/$name && xattr -w com.apple.metadata:kMDItemWhereFroms https://github.com/SchaeferAnjon/dispatch/releases ~/Downloads/$name"
  local gk; gk=$("$VM" raw "spctl -a -vv -t open --context context:primary-signature ~/Downloads/$name 2>&1")
  case "$gk" in *'source=Unnotarized Developer ID'*) ok "Gatekeeper on the dmg: Developer ID, not notarized, as released ($(echo "$gk" | sed -n 's/^origin=//p'))";; *) bad "Gatekeeper on the dmg: $(echo "$gk" | tr '\n' ' ')";; esac
  "$VM" raw "mkdir -p ~/.dispatch-ide && echo '{\"remote-debugging-port\": \"$PORT\"}' > ~/.dispatch-ide/argv.json"
  local t; t=$(now)
  "$VM" raw "open ~/Downloads/$name; for i in \$(seq 1 60); do ls /Volumes | grep -q '^Dispatch IDE' && break; sleep 1; done; sleep 3"
  local vol; vol=$("$VM" raw "ls /Volumes | grep -m1 '^Dispatch IDE'"); [ -n "$vol" ] && vol="/Volumes/$vol"
  [ -n "$vol" ] && ok "double-clicked, the dmg opened ($(secs "$t") s): $vol holds $("$VM" raw "ls '$vol' | tr '\n' ' '")" || bad "the dmg did not open on a double-click"
  # its window: Applications and Dispatch IDE side by side; the app's icon sits above its name
  w=$(wait_text 20 'Dispatch IDE'); a=$(at_text Applications)
  shot 00a-dmg-window
  t=$(now)
  if [ -n "$vol" ] && [ -n "$w" ] && [ -n "$a" ]; then
    set -- $w $a
    "$VM" screen drag "$1" $(( $2 - 80 )) "$3" $(( $4 - 80 )) >/dev/null
    "$VM" raw "for i in \$(seq 1 240); do [ -x '$ELECTRON' ] && [ \"\$(du -sk '$APP' | cut -f1)\" -ge \"\$(du -sk '$vol/Dispatch IDE.app' | cut -f1)\" ] && break; sleep 1; done; sleep 2"
  fi
  local mark; mark=$("$VM" raw "xattr -p com.apple.quarantine '$APP' 2>/dev/null")
  if "$VM" raw "test -x '$ELECTRON'" && [ -n "$mark" ]; then
    ok "dragged onto Applications in the dmg's window ($(secs "$t") s), marked from the internet: ${mark%%;*}"
  else
    bad "the drag onto Applications did not copy the app with the download's mark: copied with ditto instead"
    "$VM" raw "rm -rf '$APP'; ditto '$vol/Dispatch IDE.app' '$APP' && xattr -w com.apple.quarantine \"\$(xattr -p com.apple.quarantine ~/Downloads/$name)\" '$APP'"
  fi
  echo "copy $(secs "$t")" >> "$times"
  shot 00b-in-applications
  gk=$("$VM" raw "spctl -a -vv -t exec '$APP' 2>&1")
  case "$gk" in *'source=Unnotarized Developer ID'*) ok "Gatekeeper on the app: Developer ID, not notarized, as released";; *) bad "Gatekeeper on the app: $(echo "$gk" | tr '\n' ' ')";; esac
  first_open
}

if step install "Download Dispatch IDE and put it in /Applications"; then
  if [ -n "$DMG" ]; then
    :
  elif [ -n "$APPSRC" ]; then
    ditto -c -k --sequesterRsrc --keepParent "$APPSRC" "$TMP/DispatchIDE.zip" && ZIP="$TMP/DispatchIDE.zip"
  elif [ -z "$ZIP" ]; then
    # the release assets of a private repository are not on a public URL (an unauthenticated curl gets 404)
    gh release download --repo SchaeferAnjon/dispatch --pattern 'Dispatch-IDE-*-macos-*.zip' -D "$TMP" >/dev/null 2>&1 \
      && ZIP="$(ls "$TMP"/Dispatch-IDE-*.zip | head -1)" || bad "gh could not download the latest release (gh auth status?)"
  fi
  if [ "$NOCLT" = 1 ]; then
    "$VM" raw 'sudo rm -rf /Library/Developer/CommandLineTools && sudo xcode-select --reset' >/dev/null 2>&1
    "$VM" raw 'xcode-select -p' >/dev/null 2>&1 && bad "the command line tools are still here" || ok "no command line tools, as on a new Mac"
  fi
  if [ -n "$DMG" ]; then
    download_install_dmg "$DMG"
  elif [ "$DOWNLOAD" = 1 ] && [ -n "$ZIP" ]; then
    download_install "$ZIP"
  else
    [ -n "$ZIP" ] && "$VM" put "$ZIP" /tmp/DispatchIDE.zip
    "$VM" raw "pkill -x 'Dispatch IDE' 2>/dev/null; rm -rf '$APP'; ditto -x -k /tmp/DispatchIDE.zip /Applications && xattr -dr com.apple.quarantine '$APP'"
  fi
  "$VM" raw "defaults read '$APP/Contents/Info.plist' CFBundleShortVersionString; cat '$APP/Contents/Resources/app/dispatch-cli/dispatch/cli/VERSION'" > "$TMP/ver.txt" 2>&1
  IDEV=$(sed -n 1p "$TMP/ver.txt"); DV=$(sed -n 2p "$TMP/ver.txt")
  case "$DV" in [0-9]*) ok "installed Dispatch $DV (Dispatch IDE $IDEV)";; *) bad "install: $(tail -3 "$TMP/ver.txt" | tr '\n' ' ')";; esac
  if [ "$OVERLAY" = 1 ]; then
    # the whole package, as release.sh and the IDE build pack it: a CLI fix alone with older rules or skills tests a
    # mix no one ships (built-in-browser and computer-use failed to mount that way, 2026-10-06)
    python3 - "$APPDIR" "$TMP/overlay/dispatch" <<'PY'
import json, os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
conf = json.load(open(os.path.join(src, "cli", "bundle.json")))
for f in conf["files"]:
    os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
    shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
for s, d in conf["dirs"].items():
    if os.path.isdir(os.path.join(src, s)):
        shutil.copytree(os.path.join(src, s), os.path.join(dst, d), dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", "node_modules"))
PY
    "$VM" raw 'rm -rf /tmp/overlay' && "$VM" put "$TMP/overlay" /tmp/overlay \
      && "$VM" raw "rm -rf '$APP/Contents/Resources/app/dispatch-cli/dispatch' && cp -R /tmp/overlay/dispatch '$APP/Contents/Resources/app/dispatch-cli/dispatch'" \
      && ok "put this checkout's CLI package into the app (CLI, agent rules, skills)" || bad "overlay failed"
  fi
fi

if step image "Is this VM as bare as a new Mac?"; then
  # cirruslabs' vanilla image is not: it has the command line tools (a new Mac has only a python3 stub that asks to
  # install them) and Gatekeeper off (a download from the internet is not checked). Said here, not hidden.
  CLT=$("$VM" raw 'xcode-select -p 2>/dev/null'); [ -n "$CLT" ] && warn "the image has the command line tools ($CLT): a new Mac does not, so python3 works here without asking"
  GK=$("$VM" raw 'spctl --status 2>&1'); case "$GK" in *disabled*) warn "Gatekeeper is off in this image ($GK): the download check a new Mac makes is not tested";; esac
  "$VM" raw 'test -x /opt/homebrew/bin/brew' && warn "Homebrew is already here: a new Mac has none"
  # without the command line tools /usr/bin/python3 is a stub whose first run asks to install them: not run here,
  # so a question on screen later is the app's own
  if [ -n "$CLT" ]; then
    OUT=$("$VM" raw '/usr/bin/python3 -c "import sys;print(sys.version.split()[0])" 2>&1' | tail -1)
    case "$OUT" in 3.*) ok "python3 runs ($OUT)";; *) bad "no working python3: $OUT";; esac
  else
    ok "no command line tools, as on a new Mac: python3 is the stub that asks to install them"
  fi
fi

if step open "Open Dispatch IDE the way a person does (Finder / Dock)"; then
  # `open` gives the app the launch a double click gives it; the DevTools port is for the clicking below only
  [ "$DOWNLOAD" = 1 ] || "$VM" raw "pkill -x 'Dispatch IDE' 2>/dev/null; sleep 1; open -a '$APP' --args --remote-debugging-port=$PORT"
  for _ in $(seq 1 60); do "$VM" raw "curl -s http://127.0.0.1:$PORT/json/list" > "$TMP/targets.json" 2>/dev/null && grep -q '"type": "page"' "$TMP/targets.json" && break; sleep 2; done
  grep -q '"type": "page"' "$TMP/targets.json" && ok "Dispatch IDE opened a window" || bad "no window after 120 s"
fi

if step wizard "Click through what the app shows: setup, a task in Terminal, an agent, its answer"; then
  "$VM" raw 'rm -rf ~/fresh-e2e /tmp/fresh-out /tmp/fresh-screen; mkdir -p ~/fresh-e2e /tmp/fresh-screen' >/dev/null
  for f in runner.mjs cdp.mjs focus.mjs locate.mjs keep-clear.mjs; do "$VM" put "$APPDIR/scripts/ide-e2e/$f" "fresh-e2e/$f" >/dev/null; done
  "$VM" put "$SCENARIO" "fresh-e2e/$(basename "$SCENARIO")" >/dev/null
  "$VM" raw "echo '{\"name\": \"fresh-mac\", \"port\": $PORT}' > ~/fresh-e2e/rec.json"
  # an AI service for OpenCode, the way a person adds one (newuser.mjs types it into OpenCode's own login): this
  # Mac's DeepSeek key from its OpenCode, kept in the VM only for the run and never printed
  if [ "$(basename "$SCENARIO")" = newuser.mjs ]; then
    python3 -c 'import json,os,sys; k=json.load(open(os.path.expanduser("~/.local/share/opencode/auth.json"))).get("deepseek",{}).get("key",""); sys.stdout.write(k)' > "$TMP/k" 2>/dev/null
    if [ -s "$TMP/k" ]; then "$VM" put "$TMP/k" fresh-e2e/k >/dev/null; "$VM" raw 'chmod 600 ~/fresh-e2e/k'; else warn "no DeepSeek key in this Mac's OpenCode: the walk uses OpenCode's free model"; fi
    rm -f "$TMP/k"
  fi
  # the scenario asks for the whole screen (a system dialog, a banner) by leaving a name in /tmp/fresh-screen, or for
  # a person's click or keys on it (macOS's own dialogs) with screen.py's steps in the file
  ( while :; do for n in $("$VM" raw 'ls /tmp/fresh-screen 2>/dev/null'); do
      what=$("$VM" raw "cat /tmp/fresh-screen/$n")
      if [ -n "$what" ]; then "$VM" screen $what >/dev/null; else shot "$n"; fi
      "$VM" raw "rm -f /tmp/fresh-screen/$n"
    done; sleep 1; done ) &
  WATCH=$!
  "$VM" raw "cd ~/fresh-e2e && NEWUSER_FROM='${NEWUSER_FROM:-}' ELECTRON_RUN_AS_NODE=1 '$ELECTRON' runner.mjs --record rec.json --scenario $(basename "$SCENARIO") --out /tmp/fresh-out --timeout 2700" 2>&1 | tee "$TMP/wizard.log" | grep -E '^  (PASS|FAIL|WARN|TIME)|^\{'
  kill "$WATCH" 2>/dev/null; "$VM" raw 'rm -f ~/fresh-e2e/k'
  P=$(grep -c '^  PASS' "$TMP/wizard.log"); F=$(grep -c '^  FAIL' "$TMP/wizard.log")
  PASS=$((PASS+P)); FAIL=$((FAIL+F))
  tail -1 "$TMP/wizard.log" | grep -q '"ok":true' || { bad "the wizard run stopped: $(tail -1 "$TMP/wizard.log" | head -c 400)"; }
  if [ -n "$SHOTS" ]; then mkdir -p "$SHOTS" && "$VM" get /tmp/fresh-out "$TMP/out" && cp -R "$TMP/out/." "$SHOTS/" && echo "  screenshots: $SHOTS"; fi
fi

if step reboot "Restart the Mac: does the board come back on its own?"; then
  "$VM" reboot >/dev/null 2>&1; sleep 25
  R=$(term 'cd ~ && dispatch list --json >/dev/null && dispatch begin "Board check after a restart: tasks still work" -P demo -d "After the Mac restarts the task board must come back by itself, so a new task can be made in Terminal." 2>&1 | tail -1')
  ID=$(echo "$R" | grep -oE 'task-[a-z0-9]+' | head -1)
  [ -n "$ID" ] && ok "after a restart Terminal makes $ID" || bad "after a restart: $R"
  [ -n "$ID" ] && term "dispatch done $ID --reason 'checked after a restart' >/dev/null 2>&1"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" = 0 ]

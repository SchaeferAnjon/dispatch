#!/bin/bash
# Two-way sync of this machine's Beads board with the hub (the Mac mini's Dolt server,
# remotesapi on :3309). launchd runs it every 2 minutes; unreachable hub = silent skip.
# The local dolt sql-server must carry DOLT_REMOTE_PASSWORD (set in the beads-dolt
# LaunchAgent; the value lives in `dispatch env`). Pull first, then push.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
HUB="${BOARD_HUB:-100.118.80.86}"
PORT="$(cat "$HOME/.beads/shared-server/dolt-server.port" 2>/dev/null || echo 3308)"
USER_="$(dispatch env get DOLT_REMOTE_USER 2>/dev/null || echo sync)"
curl -s -m 3 -o /dev/null "http://$HUB:3309/" || exit 0
q() { dolt --host 127.0.0.1 --port "$PORT" --user root --password "" --no-tls --use-db task sql -q "$1" 2>&1 | grep -vE '^\+|^$' | tail -1; }
# A dirty working set (bd writes that auto-commit skipped) blocks DOLT_PULL; commit it first.
q "CALL DOLT_COMMIT('-A','-m','board-sync: local working set')" >/dev/null 2>&1
echo "$(date '+%F %T') pull: $(q "CALL DOLT_PULL('--user','$USER_','origin','main')")"
echo "$(date '+%F %T') push: $(q "CALL DOLT_PUSH('--user','$USER_','origin','main')")"

#!/bin/bash
# Claude Code statusline wrapper: cache the official stdin JSON (which carries
# rate_limits.five_hour / seven_day) for Dispatch, then hand it to the real
# statusline unchanged. Never fails the statusline.
set -u
Q="$HOME/tasks/.dispatch/quota"
mkdir -p "$Q" 2>/dev/null
tmp="$Q/.claude-code.$$"
cat > "$tmp"
# Atomic replace so readers never see a half-written file; the temp file must not linger.
mv -f "$tmp" "$Q/claude-code.json" 2>/dev/null || cp "$tmp" "$Q/claude-code.json"
[ -f "$tmp" ] && rm -f "$tmp"
# Hand the same JSON to the status line the person had before Dispatch was set up (saved by
# `dispatch init` into statusline-orig). None saved: print nothing, Claude Code shows its default.
ORIG="$HOME/tasks/.dispatch/statusline-orig"
[ -s "$ORIG" ] || exit 0
exec bash -c "$(cat "$ORIG")" < "$Q/claude-code.json"

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
exec bash -c 'command -v bun >/dev/null 2>&1 || exit 0; plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/claude-hud/claude-hud/*/ 2>/dev/null | awk -F/ '"'"'{ print $(NF-1) "\t" $(0) }'"'"' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); [ -n "$plugin_dir" ] && exec bun --env-file /dev/null "${plugin_dir}src/index.ts"' < "$Q/claude-code.json"

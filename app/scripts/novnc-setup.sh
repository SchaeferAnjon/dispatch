#!/bin/bash
# Thin wrapper kept for old muscle memory and scripts: the real work lives in
# `dispatch screen setup` (app/cli/screen_setup.py), which is also what the app's
# 设置 → 屏幕访问 → 配置 button runs — one implementation, no drift.
# Usage: bash novnc-setup.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/../cli/dispatch.py" screen setup

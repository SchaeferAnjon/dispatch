# -*- coding: utf-8 -*-
"""ZCode (Z.ai): a desktop app with its own agent (`zcode`). Dispatch reads its conversations and its allowance; it
has no command to continue a conversation outside the app."""
import json
import os
import re
from lang import t as _t

from engines.base import Engine


class ZCode(Engine):
    id = "zcode"
    name = "ZCode"
    color = "#6b5bd6"
    about = "Z.ai's coding assistant. Needs a Z.ai account or key."
    bins = ("zcode",)
    url = "https://zcode.z.ai/en/docs"

    config_home = "{home}/.zcode"
    rules_file = "{home}/.zcode/AGENTS.md"

    desktop_app = "ZCode"

    # no skills folder of its own and no user-level hooks: it gets the same session brief and skill through a plugin
    setup_args = ("zcode-plugin", "install")

    database = True

    def sqlite_store(self, home):
        # an OpenCode-based desktop app: the same tables, plus a `sequence` column that orders parts
        return {"db": os.path.join(home, ".zcode", "cli", "db", "db.sqlite"), "proc": "zcode-cli", "app": "ZCode", "seq": "sequence",
                "entrypoint": "desktop", "task_links": True}  # session_task_link: each child session's type and label

    def live_sessions(self, table):
        import dispatch as D
        return D.store_live(self.agent, table)

    def resume(self, sid, key=""):
        from engines.base import Unsupported
        raise Unsupported("ZCode has no command to pick a conversation up outside its own app, so Dispatch cannot continue "
                          "it here. Open ZCode and continue it there.")

    def own_quota(self):
        return own_quota()

    # its long-term memory: ~/.zcode/cli/memories/projects/<slug>-<sha256(dir)[:16]>/memory/*.md
    def memory_files(self, home):
        return os.path.join(home, ".zcode", "cli", "memories", "projects", "*", "memory", "*.md")

    def memory_where(self, path, ctx):
        import memories
        folder = os.path.basename(os.path.dirname(os.path.dirname(path)))
        m = re.search(r"-([0-9a-fA-F]{16})$", folder)
        real = ctx.once("zcode-dirs", project_dirs).get(m.group(1)) if m else None
        if not real:
            return re.sub(r"-[0-9a-fA-F]{16}$", "", folder) or _t("General", "通用"), "", True
        return memories.project_name(real, ctx.names, ctx.roots), real, not os.path.isdir(real)


# ---------------------------------------------------------------- its allowance
def own_quota():
    """ZCode's credentials are encrypted, so the API is off limits; scan its JSONL logs for the
    last quota snapshot it fetched itself (usage-stats logger)."""
    import glob
    import dispatch as D
    logs = sorted(glob.glob(os.path.join(D.HOME, ".zcode", "cli", "log", "zcode-*.jsonl")), reverse=True)[:2]
    for lg in logs:
        try:
            with open(lg, "rb") as fh:
                fh.seek(max(0, os.path.getsize(lg) - 2_000_000))
                tail = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        for line in reversed(tail.splitlines()):
            if "percentage" not in line and "TIME_LIMIT" not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            blob = json.dumps(d, ensure_ascii=False)
            m = re.search(r'"percentage":\s*([0-9.]+)', blob)
            if not m:
                continue
            pct = float(m.group(1))
            mr = re.search(r'"nextResetTime":\s*([0-9]+)', blob)
            reset = int(mr.group(1)) if mr else None
            if reset and reset > 10**11:
                reset //= 1000
            ml = re.search(r'"level":\s*"([^"]+)"', blob)
            ts = d.get("time") or d.get("timestamp") or d.get("ts")
            upd = None
            if isinstance(ts, (int, float)):
                upd = ts / 1000 if ts > 10**11 else ts
            return {"agent": "zcode", "plan": ("GLM Coding " + ml.group(1).capitalize()) if ml else "GLM Coding", "windows": [{"label": "Current period", "used_percent": 100 - pct if pct <= 100 else None, "resets_at": reset}], "updated_at": upd, "source": "zcode log", "note": "Calculated from the remaining allowance in ZCode logs"}
    return {"agent": "zcode", "plan": "", "windows": [], "updated_at": None, "source": "", "note": "ZCode credentials are encrypted. Check the allowance in ZCode; its logs have no reading yet."}


# ---------------------------------------------------------------- its memory folders
def project_dirs():
    """hash[:16] -> real directory, from ZCode's sqlite. The folder name's slug is lossy; the sha256 of the session
    directory is what actually identifies a project."""
    import hashlib
    import dispatch as D
    known = {}
    for r in D.zcode_query("select distinct directory from session"):
        d = r.get("directory") or ""
        if d:
            known.setdefault(hashlib.sha256(d.encode("utf-8")).hexdigest()[:16], d)
    return known


ENGINE = ZCode()

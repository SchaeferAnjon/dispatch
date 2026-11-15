# -*- coding: utf-8 -*-
"""One read-only board export shared by CLI views, invalidated by local Dolt writes.

The manifest alone is insufficient: Dolt appends writes to its chunk journal until GC.
Unknown or remote storage always uses bd directly. No TTL can hide a board update.
"""
import hashlib
import json
import os
import re
from pathlib import Path

from instructions import _Locked, atomic_write

JOURNAL = "v" * 32
VERSION = 1


def _config(path):
    """Read only simple dolt scalars, in nested or dotted Beads config syntax."""
    out, nested = {}, False
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return out
    for line in lines:
        clean = line.split(" #", 1)[0].rstrip()
        if not clean.strip() or clean.lstrip().startswith("#"):
            continue
        if not clean[0].isspace():
            nested = clean.strip() == "dolt:"
        m = re.fullmatch(r"\s*(?:dolt\.)?([\w-]+):\s*(.*?)\s*", clean)
        if m and (nested or clean.startswith("dolt.")):
            out[m[1]] = m[2].strip("\"'")
    return out


def local_store(beads_dir, home):
    """Resolve only a known local shared-server or embedded database, without starting bd."""
    if not beads_dir or not home:
        return None
    board = Path(beads_dir).expanduser().resolve()
    try:
        meta = json.loads((board / "metadata.json").read_text(encoding="utf-8"))
        cfg = _config(board / "config.yaml")
        if not isinstance(meta, dict) or meta.get("backend", "dolt") != "dolt":
            return None
        # Environment settings win over metadata / config. Never fingerprint a local copy
        # when bd actually connects to a remote server (including an explicit data-dir).
        host = (os.environ.get("BEADS_DOLT_SERVER_HOST") or os.environ.get("BEADS_DOLT_HOST")
                or meta.get("dolt_server_host") or cfg.get("host") or "127.0.0.1")
        if host not in ("localhost", "127.0.0.1", "::1", "[::1]"):
            return None
        if any(os.environ.get(k) for k in ("BEADS_DOLT_DATA_DIR", "BEADS_DB")) or meta.get("dolt_data_dir") or cfg.get("data-dir"):
            return None
        db = (os.environ.get("BEADS_DOLT_DATABASE") or meta.get("dolt_database") or cfg.get("database") or "")
        if not re.fullmatch(r"[\w.-]+", db) or db in (".", ".."):
            return None
        mode = os.environ.get("BEADS_DOLT_MODE") or meta.get("dolt_mode") or cfg.get("mode")
        if mode == "embedded":
            root = board / "embeddeddolt" / db
        elif mode == "server":
            shared = Path(home).expanduser() / ".beads" / "shared-server"
            port = (os.environ.get("BEADS_DOLT_SERVER_PORT") or os.environ.get("BEADS_DOLT_PORT")
                    or meta.get("dolt_server_port") or cfg.get("port"))
            shared_port = (shared / "dolt-server.port").read_text().strip()
            if port and str(port) != shared_port:
                return None
            if cfg.get("shared-server") != "true":
                if (board / "dolt-server.port").read_text().strip() != shared_port:
                    return None
            root = shared / "dolt" / db
        else:
            return None
        return root.resolve() if (root / ".dolt" / "noms").is_dir() else None
    except (OSError, ValueError, TypeError):
        return None


def fingerprint(root):
    """Small immutable state plus the mutable journal. None means bypass the cache."""
    if root is None:
        return None
    try:
        noms = root / ".dolt" / "noms"
        manifest = (noms / "manifest").read_bytes()
        state = (root / ".dolt" / "repo_state.json").read_bytes()
        try:
            st = (noms / JOURNAL).stat()
            journal = [st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]
        except FileNotFoundError:
            journal = None  # older stores without a journal change their manifest on writes
        h = hashlib.sha256()
        for part in (str(root).encode(), manifest, state, json.dumps(journal).encode()):
            h.update(len(part).to_bytes(8, "big"))
            h.update(part)
        return h.hexdigest()
    except OSError:
        return None


def _export(run):
    code, output, _ = run(["bd", "export"], timeout=60)
    rows = []
    if code == 0:
        for line in output.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("_type", "issue") == "issue" and row.get("id"):
                rows.append(row)
    return code, rows


def cached_issues(*, beads_dir=None, dispatch_dir=None, home=None):
    """The last export on disk however old, [] when there is none; never runs bd. For what a quick label query
    (`bd list`) leaves out: comments and dependencies."""
    root = local_store(beads_dir, home) if dispatch_dir else None
    if root is None:
        return []
    cache = Path(dispatch_dir) / "board-export" / (hashlib.sha256(str(root).encode()).hexdigest() + ".json")
    try:
        rows = json.loads(cache.read_text(encoding="utf-8")).get("issues")
    except (OSError, ValueError, AttributeError):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []


def export_issues(run, *, beads_dir=None, dispatch_dir=None, home=None):
    root = local_store(beads_dir, home) if dispatch_dir else None
    before = fingerprint(root)
    if before is None:
        return _export(run)[1]
    key = hashlib.sha256(str(root).encode()).hexdigest()
    cache = Path(dispatch_dir) / "board-export" / (key + ".json")
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with _Locked(str(cache) + ".lock"):
            # Another exporter may have filled the cache while this process waited.
            before = fingerprint(root)
            try:
                hit = json.loads(cache.read_text(encoding="utf-8"))
                if (before and hit.get("version") == VERSION and hit.get("fingerprint") == before
                        and isinstance(hit.get("issues"), list)
                        and all(isinstance(r, dict) and r.get("id") for r in hit["issues"])):
                    return hit["issues"]
            except (OSError, ValueError, AttributeError):
                pass
            code, rows = _export(run)
            # An export racing a writer must never be labelled with the newer fingerprint.
            if code == 0 and before and fingerprint(root) == before:
                try:
                    atomic_write(cache, json.dumps({"version": VERSION, "fingerprint": before, "issues": rows}, ensure_ascii=False))
                except OSError:
                    pass
            return rows
    except OSError:
        return _export(run)[1]

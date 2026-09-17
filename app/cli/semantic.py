# -*- coding: utf-8 -*-
"""Semantic search over the knowledge base (`dispatch wiki search --semantic`, `wiki related`).

Every wiki entry (pit / win / retro / howto) is embedded (OpenAI `text-embedding-3-small`
when `OPENAI_API_KEY` is set, else 智谱 `embedding-3` on pay-as-you-go) and kept in
~/tasks/.dispatch/semantic.sqlite. When the local `sqlite_vec` package is installed the vectors
also live in a `vec0` virtual table and KNN runs there; without it the same stored float32 blobs
are ranked in Python, so the feature still works — only the candidate selection is slower.

Incremental: a row is re-embedded only when its text hash changes, so after the first run a
search costs one embedding call for the query.

No embedding key at all (or no network) → `available()` is false and callers keep the old keyword /
project matching. Nothing here is imported at process start, and the index is never synced to
the board: it is a local cache that can be deleted at any time.
"""
import hashlib
import json
import math
import os
import re
import sqlite3
import struct
import sys
import time
import urllib.request

import dispatch as D

# Embedding providers, first configured key wins. OpenAI first by the person's choice (2026-09-16):
# the 智谱 key is on the GLM Coding Plan, which does not include embeddings — that endpoint answers
# 429/1113 「余额不足」 for it, so 智谱 only helps when the pay-as-you-go account has money.
EMBED_PROVIDERS = [
    ("OPENAI_API_KEY", "openai", "https://api.openai.com/v1/embeddings", "text-embedding-3-small"),
    ("ZHIPU_API_KEY", "zhipu", "https://open.bigmodel.cn/api/paas/v4/embeddings", "embedding-3"),
]
EMBED_URL = EMBED_PROVIDERS[0][2]
EMBED_MODEL = EMBED_PROVIDERS[0][3]
DB_NAME = "semantic.sqlite"
BATCH = 32
TIMEOUT = 60
# vec0 preallocates a chunk of vectors per partition; the default (1024) would make a ~8 MB
# hole per kind for a knowledge base this small. 64 keeps the whole index under a megabyte.
VEC_CHUNK = 64
VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")


def db_path():
    return os.path.join(D.DISPATCH_DIR, DB_NAME)


def _off():
    try:
        import summarize
        return None if summarize.use_enabled("semantic") else summarize.gate_message("semantic")
    except Exception:
        return None


def provider():
    """{id, url, model, key} of the first embedding provider with a key in `dispatch env`; None = off."""
    try:
        env = {i["name"]: i["value"] for i in D.env_read()}
    except Exception:
        return None
    for name, pid, url, model in EMBED_PROVIDERS:
        if env.get(name):
            return {"id": pid, "url": url, "model": model, "key": env[name]}
    return None


def api_key():
    """The embedding key from `dispatch env`; empty string means semantic search is off."""
    p = provider()
    return p["key"] if p else ""


def model_tag():
    """Which model the stored vectors must come from; vectors from another model are re-made."""
    p = provider()
    return f"{p['id']}:{p['model']}" if p else ""


def available():
    return bool(api_key()) and not _off()


def entry_text(it):
    """What gets embedded: the entry's own words plus its labelled fields, so a pit about
    sqlite and a win about sqlite stay distinguishable."""
    body = it.get("text") or ""
    for label, value in (it.get("fields") or {}).items():
        if value:
            body += f" {label}{value}"
    return re.sub(r"\s+", " ", body).strip()


def entry_hash(it):
    return hashlib.sha1(entry_text(it).encode("utf-8")).hexdigest()


def embed(texts, key=None, timeout=TIMEOUT):
    """Vectors for a batch of strings, in input order. Raises on any API problem. OpenAI and 智谱
    share the OpenAI response shape (`data[].embedding`, `index`)."""
    p = provider()
    key = (p["key"] if p else "") if key is None else key
    if not key:
        raise RuntimeError("没有 OPENAI_API_KEY / ZHIPU_API_KEY")
    url, model = (p["url"], p["model"]) if p else (EMBED_URL, EMBED_MODEL)
    out = []
    for i in range(0, len(texts), BATCH):
        chunk = [(t or " ").strip() or " " for t in texts[i:i + BATCH]]
        body = json.dumps({"model": model, "input": chunk}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
        rows = sorted(d.get("data") or [], key=lambda x: x.get("index", 0))
        if len(rows) != len(chunk):
            raise RuntimeError("embedding 返回的条数不对")
        out += [row["embedding"] for row in rows]
    return out


def _blob(vec):
    return struct.pack(f"<{len(vec)}f", *vec)


def _unblob(raw):
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def cosine(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def connect(path=None):
    p = path or db_path()
    if p != ":memory:":
        os.makedirs(os.path.dirname(p), exist_ok=True)
    db = sqlite3.connect(p, timeout=10)
    db.execute("CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, kind TEXT, vec BLOB NOT NULL, updated REAL NOT NULL)")
    if "kind" not in {r[1] for r in db.execute("PRAGMA table_info(entries)")}:
        db.execute("ALTER TABLE entries ADD COLUMN kind TEXT")
    db.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
    return db


def _stored_model(db):
    row = db.execute("SELECT v FROM meta WHERE k='model'").fetchone()
    return row[0] if row else ""


def load_vec(db):
    """True when the optional local `sqlite_vec` package is importable and its extension loads."""
    if VENDOR not in sys.path:
        sys.path.append(VENDOR)
    try:
        import sqlite_vec
    except Exception:
        return False
    try:
        db.enable_load_extension(True)
        sqlite_vec.load(db)
        db.enable_load_extension(False)
        return True
    except Exception:
        return False


def _put(db, it, vec):
    raw = _blob(vec)
    row = db.execute("SELECT id FROM entries WHERE key=?", (it["key"],)).fetchone()
    if row:
        db.execute("UPDATE entries SET hash=?, kind=?, vec=?, updated=? WHERE id=?", (entry_hash(it), it["kind"] or "", raw, time.time(), row[0]))
    else:
        db.execute("INSERT INTO entries(key, hash, kind, vec, updated) VALUES(?,?,?,?,?)", (it["key"], entry_hash(it), it["kind"] or "", raw, time.time()))


def _rebuild_vec(db):
    """The vec0 table is a mirror of `entries`; rebuilding it wholesale keeps the two in step
    after a schema change, a kind fix, or a run that happened before sqlite_vec was installed."""
    db.execute("DELETE FROM vec_entries")
    db.executemany("INSERT INTO vec_entries(rowid, kind, embedding) VALUES(?,?,?)",
                   [(r[0], r[1] or "", r[2]) for r in db.execute("SELECT id, kind, vec FROM entries")])


def _vec_table(db, dim):
    """vec0 table with the entry kind as a partition key, so `kind="pit"` searches pits only
    instead of filtering whatever happens to be nearest overall. An older table (different dim,
    no partition, or the default chunk size) is dropped and rebuilt."""
    row = db.execute("SELECT sql FROM sqlite_master WHERE name='vec_entries'").fetchone()
    sql = (row[0] if row else "") or ""
    if row and ("partition key" not in sql or f"float[{dim}]" not in sql or f"chunk_size={VEC_CHUNK}" not in sql):
        db.execute("DROP TABLE vec_entries")
        row = None
    db.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(kind text partition key, embedding float[{dim}], chunk_size={VEC_CHUNK})")
    n_vec = db.execute("SELECT count(*) FROM vec_entries").fetchone()[0]
    n_ent = db.execute("SELECT count(*) FROM entries").fetchone()[0]
    if not row or n_vec != n_ent:
        _rebuild_vec(db)


def sync(items, key=None, force=False, path=None, embed_fn=None):
    """Embed new/changed entries and drop ones that disappeared. Returns a small report."""
    off = _off()
    if off:
        return {"backend": "none", "embedded": 0, "removed": 0, "indexed": 0, "reason": off}
    key = api_key() if key is None else key
    db = connect(path)
    try:
        known = {r[0]: (r[1], r[2] or "") for r in db.execute("SELECT key, hash, kind FROM entries")}
        want = {it["key"]: entry_hash(it) for it in items}
        # Vectors from one model are meaningless next to another's: a provider switch re-embeds all.
        tag = model_tag() if embed_fn is None else (model_tag() or "test")
        if known and _stored_model(db) != tag:
            force = True
        todo = [it for it in items if force or known.get(it["key"], ("", ""))[0] != want[it["key"]]]
        gone = [k for k in known if k not in want]
        # A row whose text did not change but whose kind did (schema gained a kind column, or an
        # entry was re-tagged) keeps its vector: only the partition label is refreshed.
        rekind = [it for it in items if it["key"] in known and known[it["key"]][0] == want[it["key"]] and known[it["key"]][1] != (it["kind"] or "")]
        for it in rekind:
            db.execute("UPDATE entries SET kind=? WHERE key=?", (it["kind"] or "", it["key"]))
        for k in gone:
            db.execute("DELETE FROM entries WHERE key=?", (k,))
        if not key:
            db.commit()
            return {"backend": "none", "embedded": 0, "removed": len(gone), "indexed": len(want) - len(gone), "reason": "没有 ZHIPU_API_KEY"}
        vectors = (embed_fn or embed)([entry_text(it) for it in todo], key) if todo else []
        for it, vec in zip(todo, vectors):
            _put(db, it, vec)
        db.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('model', ?)", (tag,))
        # Keep the vec0 mirror in step every run (not only when something changed): a schema or
        # chunk-size change is noticed here, so the freelist below can reclaim the old chunks.
        use_vec = load_vec(db)
        dim = len(vectors[0]) if vectors else next((len(r[0]) // 4 for r in db.execute("SELECT vec FROM entries LIMIT 1")), 0)
        if use_vec and dim:
            _vec_table(db, dim)
            if todo or rekind or gone:
                _rebuild_vec(db)
        db.commit()
        # vec0 chunks and dropped tables leave pages behind; a small knowledge base should stay small.
        if db.execute("PRAGMA freelist_count").fetchone()[0] > 200:
            db.execute("VACUUM")
        return {"backend": "vec" if use_vec else "python", "embedded": len(todo), "removed": len(gone), "indexed": len(want)}
    finally:
        db.close()


def _candidates(db, qvec, want, kind=""):
    """Keys to rank: vec0 KNN when the extension is here, every stored key otherwise."""
    if load_vec(db):
        try:
            _vec_table(db, len(qvec))
            if kind and kind != "all":
                hits = db.execute("SELECT rowid, distance FROM vec_entries WHERE embedding MATCH ? AND k = ? AND kind = ? ORDER BY distance",
                                  (_blob(qvec), want, kind)).fetchall()
            else:
                hits = db.execute("SELECT rowid, distance FROM vec_entries WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                                  (_blob(qvec), want)).fetchall()
            if hits:
                ids = [h[0] for h in hits]
                q = "SELECT id, key FROM entries WHERE id IN (%s)" % ",".join("?" * len(ids))
                by_id = {r[0]: r[1] for r in db.execute(q, ids)}
                keys = [by_id[h[0]] for h in hits if h[0] in by_id]
                if keys:
                    return keys
        except sqlite3.Error:
            pass
    return [r[0] for r in db.execute("SELECT key FROM entries")]


def search(query, items, limit=8, kind="", project="", key=None, path=None, embed_fn=None):
    """Top entries by cosine similarity to `query`. Empty list when semantic search is off."""
    if _off():
        return []
    key = api_key() if key is None else key
    query = (query or "").strip()
    if not key or not query:
        return []
    sync(items, key, path=path, embed_fn=embed_fn)
    qvec = (embed_fn or embed)([query], key)[0]
    by_key = {it["key"]: it for it in items}
    db = connect(path)
    try:
        keys = _candidates(db, qvec, max(limit * 6, 30), kind)
        vectors = {r[0]: r[1] for r in db.execute("SELECT key, vec FROM entries")}
        scored = []
        for k in keys:
            it = by_key.get(k)
            if not it:
                continue
            if kind and kind != "all" and it["kind"] != kind:
                continue
            if project and it["project"] != project:
                continue
            raw = vectors.get(k)
            if raw:
                scored.append((cosine(qvec, _unblob(raw)), it))
        scored.sort(key=lambda x: -x[0])
        return [{**it, "score": round(s, 4)} for s, it in scored[:limit]]
    finally:
        db.close()


def related(task_id, query, items, limit=8, kind="pit", key=None, path=None, embed_fn=None):
    """What to show next to a task: its own tagged entries first, then the nearest ones.
    Returns [] when there is no key, so the caller can fall back to project matching."""
    if _off():
        return []
    key = api_key() if key is None else key
    if not key:
        return []
    tagged = [{**it, "score": 1.0} for it in items
              if it.get("task") == task_id and (not kind or kind == "all" or it["kind"] == kind)]
    hits = search(query, items, limit=limit, kind=kind, key=key, path=path, embed_fn=embed_fn) if (query or "").strip() else []
    seen, out = set(), []
    for it in tagged + hits:
        if it["key"] in seen:
            continue
        seen.add(it["key"])
        out.append(it)
    return out[:limit]

# -*- coding: utf-8 -*-
"""`dispatch code-search`: search a project's code by meaning, with keyword search as the floor.

  code-search "<question>" [--root DIR] [-n 12] [--keyword] [--json]
  code-search index [--root DIR] [--full] [--file F …] [--no-embed] [--json]
  code-search status [--root DIR] [--json]

One sqlite file per project under ~/tasks/.dispatch/code-index/<name>-<hash>.sqlite:
`chunks(path, start_line, end_line, sha, text, vec)` plus an FTS5 table over (path, text).
Files come from `git ls-files` (tracked + untracked, not ignored) or, with an explicit --root that
is not a git repo, a walk that skips build and dependency folders; binaries, lock files, minified
files and anything over 1 MB are left out. Secrets never reach the index or OpenAI: .env files,
private keys, credential files and key stores are skipped by name, a file holding a PEM private key
is skipped by content, well-known token formats, Bearer / Basic header values and the values of
KEY / SECRET / TOKEN / PASSWORD / PWD assignments (quoted, or unquoted with a digit, a trailing
comment allowed) are replaced by <redacted>, and a symlink that points outside the project is
not followed. The home folder (or anything above it) is never indexed, and without --root the
working directory must be inside a git repo. The index folder is 0700 and each database 0600.
Files are cut at top-level definitions (Python def/class, Rust fn/impl/struct, Swift func/struct/
class, TS function/class/export, Markdown headings), small neighbours are packed together and long
stretches are cut into 60-line windows with 10 lines of overlap, never more than 1500 characters.

Vectors come from OpenAI `text-embedding-3-small` (512 dimensions) with OPENAI_API_KEY from
`dispatch env`; an OPENAI_API_KEY in the process environment overrides it, and an empty one turns
embeddings off. A query takes the 40 nearest chunks and the 40 best FTS matches and fuses the two
lists with reciprocal rank fusion. With no key, no network or no vectors yet the answer comes from
FTS alone and says `mode: "keyword"`.

Incremental: a file is re-read only when its size or mtime changed, re-cut only when its sha1
changed, and a chunk is re-embedded only when its own text is new (vectors are reused by chunk
sha1). Every query refreshes the index first (a stat pass, tens of milliseconds when nothing
changed); `refresh(root)` is the hook chatd calls after a turn.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import array
import concurrent.futures
import hashlib
import json
import operator
import os
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from lang import t as _t

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dplatform as P  # noqa: E402

EMBED_URL = "https://api.openai.com/v1/embeddings"
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 512
EMBED_USD_PER_M = 0.02          # text-embedding-3-small, 2026-09 list price
EMBED_BATCH = 96
EMBED_BATCH_CHARS = 120000
EMBED_TIMEOUT = 60
EMBED_WORKERS = 3
EMBED_RETRIES = 10
CHARS_PER_TOKEN = 3.5           # estimate for code before the API reports real usage

MAX_CHUNK_CHARS = 1500
WINDOW_LINES = 60
OVERLAP_LINES = 10
MAX_FILE_BYTES = 1000000
MAX_FILES = 20000
MAX_LINE = 3000                 # a file with lines this long and a high average is minified
TOP_K = 40
RRF_K = 60
DEFAULT_N = 12
LOCK_STALE_S = 3600
SCHEMA = "1"
FILTER_VERSION = "2"            # bump when the secret filter changes: the next run re-reads every file

SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__",
             ".next", ".nuxt", ".build", "Pods", "DerivedData", ".gradle", ".idea", ".mypy_cache", ".pytest_cache",
             ".ruff_cache", ".tox", "coverage", ".cache", ".turbo", ".parcel-cache", "vendor", ".dispatch"}
SKIP_NAMES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock",
              "composer.lock", "go.sum", "Pipfile.lock", "bun.lockb", ".DS_Store"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tif", ".tiff", ".heic", ".svg", ".pdf",
            ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".woff", ".woff2", ".ttf", ".otf", ".eot",
            ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".dmg", ".pkg", ".app", ".exe", ".dll", ".so",
            ".dylib", ".a", ".o", ".class", ".jar", ".pyc", ".wasm", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
            ".lock", ".map", ".vsix", ".psd", ".sketch", ".fig", ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".key",
            ".numbers", ".pages", ".ttc", ".npy", ".pt", ".onnx", ".safetensors", ".parquet"}

# ---- secrets: never indexed, never sent ------------------------------------------------------------
SECRET_DIRS = {".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".secrets", "secrets"}
SECRET_NAMES = {".netrc", "_netrc", ".npmrc", ".pypirc", ".pgpass", ".htpasswd", ".git-credentials", ".dockercfg",
                ".my.cnf", ".s3cfg", ".boto", "credentials", "known_hosts", "authorized_keys", "terraform.tfstate",
                "terraform.tfstate.backup", ".vault-token", "keychain", ".envrc", ".dev.vars", ".flaskenv"}
SECRET_EXT = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk", ".gpg", ".pgp", ".age", ".ovpn",
              ".tfvars", ".tfstate", ".mobileprovision", ".p8", ".cer", ".crt", ".der", ".csr"}
# .env, .env.local, .env.production, prod.env, .dev.vars.staging (Cloudflare), but not the checked-in examples
ENV_RE = re.compile(r"^(?:\.env(?:\..+)?|.+\.env|\.dev\.vars(?:\..+)?)$")
ENV_OK_RE = re.compile(r"\.(?:example|sample|template|dist|defaults?)$")
KEYFILE_RE = re.compile(r"^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\..*)?$")
# credentials.json, client_secret_123.json, service-account-prod.json, secrets.yaml, api-keys.txt
CRED_NAME_RE = re.compile(r"(?:secret|credential|service[-_]?account|api[-_]?keys?|private[-_]?key|passwords?|tokens?)", re.I)
CRED_EXT = {"", ".json", ".yaml", ".yml", ".toml", ".ini", ".txt", ".cfg", ".conf", ".xml", ".properties", ".plist", ".csv"}
PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")
TOKEN_RES = [re.compile(x) for x in (
    r"\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{16,}",       # OpenAI, Anthropic
    r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}",              # Stripe keys
    r"\bwhsec_[A-Za-z0-9+/=]{16,}",                                # Stripe webhook secrets
    r"\bgh[pousr]_[A-Za-z0-9]{30,}", r"\bgithub_pat_[A-Za-z0-9_]{30,}",
    r"\bglpat-[A-Za-z0-9_\-]{20,}",
    r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bxox[abposr]-[A-Za-z0-9\-]{10,}",
    r"\bAIza[0-9A-Za-z_\-]{35}",
    r"\bhf_[A-Za-z0-9]{30,}",
    r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",  # JWT
    r"(?<=://)[^/\s:@]+:[^/\s@]{4,}(?=@)",                         # user:password@ in URLs
    r"(?i)(?<=\bbearer )[A-Za-z0-9._~+/\-]{16,}=*",                 # Authorization: Bearer <token>
    r"(?i)(?<=\bbasic )[A-Za-z0-9+/]{16,}=*",                        # Authorization: Basic <base64>
)]
# KEY = "value", "api_key": "value", "pwd": "value", PASSWORD=value123 # comment (unquoted values
# need a digit, so `token = config.token` stays readable)
ASSIGN_RE = re.compile(r"""(?ix)
    ( ["']?[A-Za-z0-9_.\-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|passphrase|private[_-]?key|access[_-]?key|credential|authorization)[A-Za-z0-9_.\-]*["']?
      \s*(?::=|=>|[:=])\s* )
    (?: (["'])(?P<q>[^"'\s]{8,})\2 | (?P<u>(?=[^\s"'#]*\d)[A-Za-z0-9_+/=.\-]{12,})(?=\s*(?:$|\#|//|;)) )""", re.M)
REDACTED = "<redacted>"


def secret_path(rel):
    """True for files that hold secrets by their name or folder: never read, never indexed."""
    parts = [p for p in re.split(r"[\\/]", rel) if p]
    if not parts:
        return False
    if any(p.lower() in SECRET_DIRS for p in parts[:-1]):
        return True
    name = parts[-1].lower()
    if name in SECRET_NAMES or KEYFILE_RE.match(name):
        return True
    if ENV_RE.match(name) and not ENV_OK_RE.search(name):
        return True
    stem, ext = os.path.splitext(name)
    if ext in SECRET_EXT:
        return True
    if ext in CRED_EXT and CRED_NAME_RE.search(stem) and not ENV_OK_RE.search(name):
        return True
    return False


def redact(text):
    """The text with token-shaped strings and the values of secret-looking assignments replaced."""
    for rx in TOKEN_RES:
        text = rx.sub(REDACTED, text)

    def sub(m):
        if m.group("q") is not None:
            return m.group(1) + m.group(2) + REDACTED + m.group(2)
        return m.group(1) + REDACTED
    return ASSIGN_RE.sub(sub, text)


def _inside(path, root):
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def forbidden_root(path):
    """Why a folder may not be indexed as a whole, or "": the home folder, anything above it and the
    file system root would send a person's documents to the embedding API."""
    home = os.path.realpath(P.HOME)
    if path == os.path.dirname(path) or _inside(home, path):
        return "home"
    return ""


# Where a new chunk may start: a definition at the top level (or one indent in, for methods).
_DEF = {
    "py": r"^(?: {0,4}|\t?)(?:async\s+def|def|class)\s+\w",
    "rs": r"^(?: {0,4})(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+\"[^\"]*\"\s+)*(?:fn|impl|struct|enum|trait|mod|macro_rules!)\b",
    "swift": r"^(?: {0,4})(?:(?:public|private|internal|fileprivate|open|final|static|override|class|mutating|@\w+(?:\([^)]*\))?)\s+)*(?:func|struct|class|enum|protocol|extension|actor|init)\b",
    "ts": r"^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|abstract\s+class)\s+[\w$]",
    "go": r"^(?:func|type)\s",
    "sh": r"^(?:function\s+[\w-]+|[\w-]+\s*\(\)\s*\{?)",
    "md": r"^#{1,3}\s",
    "c": r"^(?:[A-Za-z_][\w\s\*&:<>,]*\s)?[A-Za-z_][\w:~]*\s*\([^;]*$",
}
_LANG = {".py": "py", ".pyi": "py", ".rs": "rs", ".swift": "swift", ".ts": "ts", ".tsx": "ts", ".js": "ts", ".jsx": "ts",
         ".mjs": "ts", ".cjs": "ts", ".go": "go", ".sh": "sh", ".bash": "sh", ".zsh": "sh", ".fish": "sh", ".md": "md",
         ".markdown": "md", ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".hpp": "c", ".m": "c", ".mm": "c"}
DEF_RE = {k: re.compile(v) for k, v in _DEF.items()}
# Lines that belong to the definition below them (decorators, attributes, doc comments).
LEAD_RE = re.compile(r"^\s*(?:@|#\[|#!\[|//|/\*|\*|#(?!#))")

STOP = {"a", "an", "the", "is", "are", "was", "be", "to", "of", "in", "on", "at", "for", "and", "or", "do", "does",
        "did", "how", "what", "where", "when", "why", "which", "who", "with", "from", "by", "it", "this", "that",
        "can", "i", "we", "you", "me", "my", "our", "get", "find", "code", "file", "function",
        "怎么", "如何", "什么", "哪里", "在哪", "在哪里", "为什么", "的", "是", "给", "了", "在", "和", "吗", "呢", "哪个", "怎样", "代码"}


class SearchError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


# ---- where things live ------------------------------------------------------------------------

def dispatch_dir():
    return os.environ.get("DISPATCH_DIR") or os.path.join(P.HOME, "tasks", ".dispatch")


def index_dir():
    return os.path.join(dispatch_dir(), "code-index")


def _git(root, args, timeout=30):
    try:
        r = subprocess.run(["git", "-C", root] + args, capture_output=True, timeout=timeout,
                           creationflags=P.no_window_flags())
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def resolve_root(root=None):
    """The folder to index: --root as given, or the git top level of the working directory. Outside
    a git repo --root is required, and the home folder (or anything above it) is refused."""
    if root:
        path = os.path.realpath(os.path.expanduser(root))
    else:
        cwd = os.getcwd()
        top = _git(cwd, ["rev-parse", "--show-toplevel"])
        if not (top and top.strip()):
            raise SearchError("not_a_repo", "The current folder is not in a Git repository. Use --root to choose a project (%s)." % os.path.realpath(cwd))
        path = os.path.realpath(top.decode("utf-8", "replace").strip())
    if not os.path.isdir(path):
        raise SearchError("no_root", "Folder does not exist: %s" % path)
    if forbidden_root(path):
        raise SearchError("root_too_broad", "Cannot index the home folder or its parents: %s. Use --root to choose a project." % path)
    return path


def project_key(root):
    name = re.sub(r"[^\w.-]+", "_", os.path.basename(root.rstrip("/\\")) or "root")[:40]
    return "%s-%s" % (name, hashlib.sha1(P.norm_path(root).encode("utf-8")).hexdigest()[:10])


def db_path(root):
    return os.path.join(index_dir(), project_key(root) + ".sqlite")


def progress_path(root):
    return db_path(root) + ".progress.json"


# ---- the key ----------------------------------------------------------------------------------

def api_key():
    """OPENAI_API_KEY: the process environment wins (an empty value means "no embeddings"),
    otherwise `dispatch env`. Empty string = keyword search only."""
    if os.environ.get("DISPATCH_CODE_SEARCH_EMBED", "1") == "0":
        return ""
    if "OPENAI_API_KEY" in os.environ:
        return os.environ["OPENAI_API_KEY"].strip()
    try:
        import dispatch as D
        for it in D.env_read():
            if it["name"] == "OPENAI_API_KEY":
                return (it["value"] or "").strip()
    except Exception:
        pass
    return ""


def model_tag():
    return "openai:%s:%d" % (EMBED_MODEL, EMBED_DIMS)


def embed(texts, key, timeout=EMBED_TIMEOUT):
    """(vectors, prompt_tokens) for a list of strings, in order. Raises on any API problem."""
    out, tokens = [], 0
    i = 0
    while i < len(texts):
        batch, size = [], 0
        while i < len(texts) and len(batch) < EMBED_BATCH and (not batch or size + len(texts[i]) <= EMBED_BATCH_CHARS):
            t = (texts[i] or " ").strip() or " "
            batch.append(t)
            size += len(t)
            i += 1
        body = json.dumps({"model": EMBED_MODEL, "input": batch, "dimensions": EMBED_DIMS}).encode()
        for attempt in range(EMBED_RETRIES + 1):
            req = urllib.request.Request(EMBED_URL, data=body, headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    d = json.load(r)
                break
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = json.loads(e.read().decode("utf-8", "replace")).get("error", {}).get("message", "")
                except Exception:
                    pass
                if e.code in (429, 500, 502, 503, 504) and attempt < EMBED_RETRIES:
                    # the per-minute token limit says how long to wait ("try again in 1.03s")
                    m = re.search(r"try again in ([\d.]+)(ms|s)", detail)
                    wait = (float(m.group(1)) / (1000.0 if m.group(2) == "ms" else 1.0)) if m else 1.5 * (attempt + 1)
                    time.sleep(min(wait + 0.5 * (attempt + 1), 20))
                    continue
                raise SearchError("embed_failed", "OpenAI embeddings %d %s" % (e.code, detail[:200]))
        rows = sorted(d.get("data") or [], key=lambda x: x.get("index", 0))
        if len(rows) != len(batch):
            raise SearchError("embed_failed", "The embedding response has an unexpected number of entries")
        out += [row["embedding"] for row in rows]
        tokens += int((d.get("usage") or {}).get("prompt_tokens") or 0)
    return out, tokens


def _blob(vec):
    a = array.array("f", vec)
    if sys.byteorder != "little":
        a.byteswap()
    return a.tobytes()


def _unblob(raw):
    a = array.array("f")
    a.frombytes(raw)
    if sys.byteorder != "little":
        a.byteswap()
    return a


def _normalize(vec):
    n = sum(x * x for x in vec) ** 0.5
    return [x / n for x in vec] if n else list(vec)


# ---- files and chunks -------------------------------------------------------------------------

def _skip_path(rel):
    parts = re.split(r"[\\/]", rel)
    if any(p in SKIP_DIRS for p in parts[:-1]):
        return True
    if secret_path(rel):
        return True
    name = parts[-1]
    if name in SKIP_NAMES or name.endswith((".min.js", ".min.css", ".bundle.js")):
        return True
    return os.path.splitext(name)[1].lower() in SKIP_EXT


def list_files(root):
    """Relative paths (forward slashes) of the files worth indexing, and whether the list was cut."""
    out = _git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], timeout=60)
    rels = []
    if out is not None:
        seen = set()
        for raw in out.split(b"\0"):
            if not raw:
                continue
            rel = raw.decode("utf-8", "surrogateescape").replace("\\", "/")
            if rel in seen or _skip_path(rel):
                continue
            seen.add(rel)
            rels.append(rel)
    else:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
            for fn in sorted(filenames):
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace("\\", "/")
                if not fn.startswith(".") and not _skip_path(rel):
                    rels.append(rel)
            if len(rels) > MAX_FILES:
                break
    cut = len(rels) > MAX_FILES
    return rels[:MAX_FILES], cut


def read_text(path):
    """The file's text, or None for binaries, huge files and minified bundles."""
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    if b"\0" in raw[:8192]:
        return None
    text = raw.decode("utf-8", "replace")
    if PRIVATE_KEY_RE.search(text):
        return None
    lines = text.split("\n")
    if lines and max(len(l) for l in lines) > MAX_LINE and len(text) / max(len(lines), 1) > 250:
        return None
    return text


def _windows(lines, s, e):
    """[s, e) cut into windows of at most WINDOW_LINES lines and MAX_CHUNK_CHARS characters."""
    out = []
    i = s
    while i < e:
        j, size = i, 0
        while j < e and j - i < WINDOW_LINES and (j == i or size + len(lines[j]) + 1 <= MAX_CHUNK_CHARS):
            size += len(lines[j]) + 1
            j += 1
        out.append((i, j))
        if j >= e:
            break
        back = min(OVERLAP_LINES, (j - i) // 4)
        i = max(j - back, i + 1)
    return out


def chunk_text(text, rel):
    """[(start_line, end_line, text)] with 1-based inclusive line numbers."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        return []
    rx = DEF_RE.get(_LANG.get(os.path.splitext(rel)[1].lower(), ""))
    bounds = [0]
    if rx:
        for i in range(1, len(lines)):
            if rx.match(lines[i]):
                j = i
                while j - 1 > bounds[-1] and LEAD_RE.match(lines[j - 1]) and lines[j - 1].strip():
                    j -= 1
                if j > bounds[-1]:
                    bounds.append(j)
    segments = [(bounds[k], bounds[k + 1] if k + 1 < len(bounds) else len(lines)) for k in range(len(bounds))]
    spans, cur = [], None
    for s, e in segments:
        size = sum(len(lines[i]) + 1 for i in range(s, e))
        if size > MAX_CHUNK_CHARS or e - s > WINDOW_LINES:
            if cur:
                spans.append(cur)
                cur = None
            spans += _windows(lines, s, e)
            continue
        if cur and (sum(len(lines[i]) + 1 for i in range(cur[0], cur[1])) + size > MAX_CHUNK_CHARS or e - cur[0] > WINDOW_LINES):
            spans.append(cur)
            cur = None
        cur = (cur[0], e) if cur else (s, e)
    if cur:
        spans.append(cur)
    out = []
    for s, e in spans:
        body = "\n".join(lines[s:e])
        if not body.strip():
            continue
        out.append((s + 1, e, body[:MAX_CHUNK_CHARS]))
    return out


def _sha(text):
    return hashlib.sha1(text.encode("utf-8", "surrogatepass")).hexdigest()


def embed_input(path, text):
    return "%s\n%s" % (path, text)


# ---- the database -----------------------------------------------------------------------------

def _tokenizer(db):
    try:
        db.execute("CREATE VIRTUAL TABLE temp.t_probe USING fts5(x, tokenize='trigram')")
        db.execute("DROP TABLE temp.t_probe")
        return "trigram"
    except sqlite3.Error:
        return "unicode61"


def _private_dir(d):
    os.makedirs(d, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass


def _private_files(path):
    """The database and its -wal / -shm files readable by their owner only (they hold code)."""
    for p in (path, path + "-wal", path + "-shm"):
        try:
            if os.path.exists(p) and os.stat(p).st_mode & 0o077:
                os.chmod(p, 0o600)
        except OSError:
            pass


def connect(root, create=True):
    path = db_path(root)
    if not create and not os.path.exists(path):
        return None
    _private_dir(os.path.dirname(path))
    if not os.path.exists(path):
        # created 0600 before sqlite opens it: sqlite gives -wal / -shm the same mode
        try:
            os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
        except OSError:
            pass
    _private_files(path)
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    _private_files(path)
    db.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, sha TEXT, size INTEGER, mtime REAL, chunks INTEGER)")
    db.execute("CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER, end_line INTEGER, sha TEXT, text TEXT, vec BLOB)")
    db.execute("CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)")
    db.execute("CREATE INDEX IF NOT EXISTS chunks_sha ON chunks(sha)")
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='fts'").fetchone():
        tok = _tokenizer(db)
        spec = "trigram" if tok == "trigram" else "unicode61 tokenchars '_'"
        db.execute("CREATE VIRTUAL TABLE fts USING fts5(path, text, tokenize=\"%s\")" % spec)
        _meta_set(db, "tokenizer", tok)
        _meta_set(db, "schema", SCHEMA)
        _meta_set(db, "root", root)
    db.commit()
    return db


def _meta(db, k, default=""):
    row = db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row[0] if row else default


def _meta_set(db, k, v):
    db.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (k, str(v)))


class Lock(object):
    """One indexer per project at a time (chatd's refresh, the IDE's save hook, a query)."""

    def __init__(self, root, wait=0.0):
        self.path = db_path(root) + ".lock"
        self.wait = wait
        self.held = False

    def __enter__(self):
        _private_dir(os.path.dirname(self.path))
        deadline = time.time() + self.wait
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(str(os.getpid()))
                self.held = True
                return self
            except FileExistsError:
                if self._stale():
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    continue
                if time.time() >= deadline:
                    return self
                time.sleep(0.2)

    def _stale(self):
        try:
            with open(self.path) as f:
                pid = int(f.read().strip() or 0)
            age = time.time() - os.path.getmtime(self.path)
        except (OSError, ValueError):
            return True
        return age > LOCK_STALE_S or not pid or not P.pid_alive(pid)

    def __exit__(self, *exc):
        if self.held:
            try:
                os.unlink(self.path)
            except OSError:
                pass
        return False


def _progress(root, phase, done, total):
    try:
        with open(progress_path(root), "w", encoding="utf-8") as f:
            json.dump({"phase": phase, "done": done, "total": total, "pid": os.getpid(), "ts": time.time()}, f)
    except OSError:
        pass


def _progress_clear(root):
    try:
        os.unlink(progress_path(root))
    except OSError:
        pass


def _say(quiet, msg):
    if not quiet:
        print(msg, file=sys.stderr, flush=True)


# ---- indexing ---------------------------------------------------------------------------------

def _norm_rel(root, f):
    p = f if os.path.isabs(f) else os.path.join(root, f)
    return os.path.relpath(os.path.realpath(p), root).replace("\\", "/")


def index(root=None, full=False, files=None, embed_ok=True, wait=120.0, quiet=True):
    """Bring the index up to date. files = only these paths (the IDE's save hook). Returns a report;
    {"skipped": "busy"} when another indexer holds the project and `wait` ran out."""
    root = resolve_root(root)
    t0 = time.time()
    with Lock(root, wait) as lk:
        if not lk.held:
            return {"ok": True, "root": root, "skipped": "busy"}
        try:
            return _index(root, full, files, embed_ok, quiet, t0)
        finally:
            _progress_clear(root)


def _index(root, full, files, embed_ok, quiet, t0):
    fresh = not os.path.exists(db_path(root))
    db = connect(root)
    try:
        known = {r[0]: (r[1], r[2], r[3]) for r in db.execute("SELECT path, sha, size, mtime FROM files")}
        if _meta(db, "filter") != FILTER_VERSION:
            full = True  # an index from before this secret filter: re-read (and drop) everything
        cut = False
        if files is None:
            rels, cut = list_files(root)
        else:
            rels = [_norm_rel(root, f) for f in files]
            rels = [r for r in rels if not r.startswith("..")]
        want = set()
        changed, unchanged, dropped = 0, 0, []
        new_chunks = 0
        total = len(rels)
        for n, rel in enumerate(rels):
            if n % 200 == 0:
                _progress(root, "scan", n, total)
            full_path = os.path.join(root, rel)
            try:
                st = os.stat(full_path)
            except OSError:
                if rel in known:
                    dropped.append(rel)
                continue
            if not os.path.isfile(full_path) or (files is not None and _skip_path(rel)) \
                    or not _inside(os.path.realpath(full_path), root):
                # a symlink out of the project is not followed; a secret named by --file is not read
                if rel in known:
                    dropped.append(rel)
                continue
            old = known.get(rel)
            if old and not full and old[1] == st.st_size and abs((old[2] or 0) - st.st_mtime) < 1e-6:
                want.add(rel)
                unchanged += 1
                continue
            text = read_text(full_path)
            if text is None:
                if rel in known:
                    dropped.append(rel)
                continue
            text = redact(text)
            want.add(rel)
            sha = _sha(text)
            if old and old[0] == sha and not full:
                db.execute("UPDATE files SET size=?, mtime=? WHERE path=?", (st.st_size, st.st_mtime, rel))
                unchanged += 1
                continue
            new_chunks += _replace_file(db, rel, text, sha, st)
            changed += 1
        if files is None:
            dropped += [p for p in known if p not in want and p not in dropped]
        for rel in dropped:
            _drop_file(db, rel)
        _meta_set(db, "indexed_at", time.time())
        if files is None:
            _meta_set(db, "filter", FILTER_VERSION)
        db.commit()
        n_chunks = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
        n_files = db.execute("SELECT count(*) FROM files").fetchone()[0]
        _say(quiet is not False, _t("Looked at %d files: %d changed, %d removed, %d chunks", "扫了 %d 个文件：%d 个有改动，%d 个删掉，共 %d 块") % (total, changed, len(dropped), n_chunks))
        res = {"ok": True, "root": root, "db": db_path(root), "fresh": fresh, "files": n_files, "chunks": n_chunks,
               "scanned": total, "changed_files": changed, "unchanged_files": unchanged, "removed_files": len(dropped),
               "new_chunks": new_chunks, "truncated": cut}
        res.update(_embed_missing(db, root, embed_ok, quiet))
        res["ms"] = int((time.time() - t0) * 1000)
        return res
    finally:
        db.close()


def _drop_file(db, rel):
    ids = [r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (rel,))]
    for i in ids:
        db.execute("DELETE FROM fts WHERE rowid=?", (i,))
    db.execute("DELETE FROM chunks WHERE path=?", (rel,))
    db.execute("DELETE FROM files WHERE path=?", (rel,))


def _replace_file(db, rel, text, sha, st):
    """Re-cut one file. A chunk whose text is unchanged keeps its vector (looked up by sha)."""
    old_vecs = {r[0]: r[1] for r in db.execute("SELECT sha, vec FROM chunks WHERE path=? AND vec IS NOT NULL", (rel,))}
    _drop_file(db, rel)
    pieces = chunk_text(text, rel)
    for start, end, body in pieces:
        csha = _sha(rel + "\n" + body)
        vec = old_vecs.get(csha)
        if vec is None:
            row = db.execute("SELECT vec FROM chunks WHERE sha=? AND vec IS NOT NULL LIMIT 1", (csha,)).fetchone()
            vec = row[0] if row else None
        cur = db.execute("INSERT INTO chunks(path, start_line, end_line, sha, text, vec) VALUES(?,?,?,?,?,?)",
                         (rel, start, end, csha, body, vec))
        db.execute("INSERT INTO fts(rowid, path, text) VALUES(?,?,?)", (cur.lastrowid, rel, body))
    db.execute("INSERT OR REPLACE INTO files(path, sha, size, mtime, chunks) VALUES(?,?,?,?,?)",
               (rel, sha, st.st_size, st.st_mtime, len(pieces)))
    return len(pieces)


def _embed_missing(db, root, embed_ok, quiet):
    """Embed every chunk without a vector. Vectors from another model are thrown away first."""
    key = api_key() if embed_ok else ""
    if not key:
        missing = db.execute("SELECT count(*) FROM chunks WHERE vec IS NULL").fetchone()[0]
        return {"mode": "keyword", "embedded": 0, "tokens": 0, "usd": 0.0, "unembedded": missing,
                "reason": "no_key" if embed_ok else "no_embed"}
    tag = model_tag()
    if _meta(db, "model") and _meta(db, "model") != tag:
        db.execute("UPDATE chunks SET vec=NULL")
    _meta_set(db, "model", tag)
    db.commit()
    todo = db.execute("SELECT id, path, text FROM chunks WHERE vec IS NULL ORDER BY id").fetchall()
    if quiet == "auto":  # a query's refresh only talks when it has a real build to do
        quiet = len(todo) < 200
    est_tokens = int(sum(len(r[1]) + 1 + len(r[2]) for r in todo) / CHARS_PER_TOKEN)
    if todo:
        _say(quiet, _t("Embedding %d chunks, about %d tokens, ≈ $%.4f (%s, $%.2f / M tokens)", "要嵌入 %d 块，约 %d token，≈ $%.4f（%s，$%.2f / M token）") % (len(todo), est_tokens, est_tokens * EMBED_USD_PER_M / 1e6, EMBED_MODEL, EMBED_USD_PER_M))
    done, tokens, err = 0, 0, ""
    parts = [todo[i:i + EMBED_BATCH] for i in range(0, len(todo), EMBED_BATCH)]
    _progress(root, "embed", 0, len(todo))
    # A few requests in flight at once; results are written from this thread only.
    with concurrent.futures.ThreadPoolExecutor(max_workers=EMBED_WORKERS) as pool:
        futs = {pool.submit(embed, [embed_input(r[1], r[2]) for r in part], key): part for part in parts}
        for fut in concurrent.futures.as_completed(futs):
            part = futs[fut]
            if fut.cancelled():
                continue
            try:
                vecs, used = fut.result()
            except (SearchError, OSError, ValueError) as e:
                err = err or str(e)
                for f in futs:
                    f.cancel()
                continue
            for r, v in zip(part, vecs):
                db.execute("UPDATE chunks SET vec=? WHERE id=?", (_blob(_normalize(v)), r[0]))
            db.commit()
            done += len(part)
            tokens += used
            _progress(root, "embed", done, len(todo))
            _say(quiet, _t("Embedded %d / %d", "嵌入 %d / %d") % (done, len(todo)))
    usd = round(tokens * EMBED_USD_PER_M / 1e6, 6)
    if tokens:
        _record_use(tokens)
    missing = len(todo) - done
    res = {"mode": "hybrid" if not missing else "keyword", "embedded": done, "tokens": tokens, "usd": usd,
           "est_tokens": est_tokens, "unembedded": missing}
    if err:
        res["reason"] = "embed_failed"
        res["error"] = err
    return res


def _record_use(tokens):
    try:
        import summarize
        summarize.record_use("code_search", tokens, "openai:" + EMBED_MODEL)
    except Exception:
        pass


def refresh(root):
    """chatd's hook after a turn: bring an existing index up to date, never build a new one, never
    wait for another indexer, never raise."""
    try:
        root = resolve_root(root)
        if not os.path.exists(db_path(root)):
            return None
        return index(root, wait=0, quiet=True)
    except Exception:
        return None


# ---- searching --------------------------------------------------------------------------------

def fts_query(query, tokenizer="trigram"):
    """An OR query of the question's words, stop words and (for trigram) words under 3 characters
    dropped; Chinese runs are cut into overlapping 3-character pieces."""
    terms = []
    for tok in re.findall(r"[\w$.\-]+", query or ""):
        tok = tok.strip(".-$").lower()
        if not tok or tok in STOP:
            continue
        cjk = re.fullmatch(r"[㐀-鿿豈-﫿]+", tok)
        if cjk and tokenizer == "trigram" and len(tok) >= 3:
            for w in re.split("|".join(sorted((s for s in STOP if re.match(r"[㐀-鿿]", s)), key=len, reverse=True)), tok):
                terms += [w[i:i + 3] for i in range(max(len(w) - 2, 0))]
            continue
        if tokenizer == "trigram" and len(tok) < 3:
            continue
        terms.append(tok)
        if "_" in tok or "." in tok or "-" in tok:
            terms += [p for p in re.split(r"[_.\-]+", tok) if len(p) >= 3 and p not in STOP]
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append('"%s"%s' % (t.replace('"', '""'), "" if tokenizer == "trigram" else "*"))
    return " OR ".join(out[:32])


def _fts_hits(db, query, k):
    q = fts_query(query, _meta(db, "tokenizer", "trigram"))
    if not q:
        return []
    try:
        return [r[0] for r in db.execute("SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, 4.0, 1.0) LIMIT ?", (q, k))]
    except sqlite3.Error:
        return []


def _vec_hits(db, qvec, k):
    q = array.array("f", _normalize(qvec))
    mul = operator.mul
    scored = []
    for cid, raw in db.execute("SELECT id, vec FROM chunks WHERE vec IS NOT NULL"):
        v = _unblob(raw)
        if len(v) != len(q):
            continue
        scored.append((sum(map(mul, q, v)), cid))
    scored.sort(reverse=True)
    return [cid for _, cid in scored[:k]]


def fuse(lists, k=RRF_K):
    """Reciprocal rank fusion: {id: score}, best first."""
    scores = {}
    for hits in lists:
        for rank, cid in enumerate(hits):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: -x[1])


def search(query, root=None, n=DEFAULT_N, keyword=False, refresh_first=True, quiet=True):
    query = (query or "").strip()
    if not query:
        raise SearchError("usage", "Provide a query: dispatch code-search \"…\"")
    root = resolve_root(root)
    t0 = time.time()
    built = None
    if refresh_first:
        built = index(root, wait=0, embed_ok=not keyword, quiet="auto")
    db = connect(root)
    try:
        fts = _fts_hits(db, query, TOP_K)
        vec, reason, error = [], "", ""
        key = "" if keyword else api_key()
        has_vec = db.execute("SELECT 1 FROM chunks WHERE vec IS NOT NULL LIMIT 1").fetchone() is not None
        if keyword:
            reason = "keyword_flag"
        elif not key:
            reason = "no_key"
        elif not has_vec or _meta(db, "model") != model_tag():
            reason = "not_embedded"
        else:
            try:
                qv, used = embed([query], key)
                vec = _vec_hits(db, qv[0], TOP_K)
                if used:
                    _record_use(used)
            except (SearchError, OSError, ValueError) as e:
                reason, error = "embed_failed", str(e)
        ranked = fuse([vec, fts] if vec else [fts])[:max(1, n)]
        vec_set, fts_set = set(vec), set(fts)
        results = []
        for cid, score in ranked:
            row = db.execute("SELECT path, start_line, end_line, text FROM chunks WHERE id=?", (cid,)).fetchone()
            if not row:
                continue
            via = "both" if cid in vec_set and cid in fts_set else ("vector" if cid in vec_set else "keyword")
            results.append({"path": row[0], "start": row[1], "end": row[2], "score": round(score, 5), "via": via, "text": row[3]})
        out = {"ok": True, "query": query, "root": root, "mode": "hybrid" if vec else "keyword", "results": results,
               "ms": int((time.time() - t0) * 1000)}
        if reason:
            out["reason"] = reason
        if error:
            out["error"] = error
        if built and built.get("skipped"):
            out["indexing"] = True
        return out
    finally:
        db.close()


def status(root=None):
    root = resolve_root(root)
    path = db_path(root)
    key = bool(api_key())
    out = {"ok": True, "root": root, "db": path, "exists": os.path.exists(path), "key": key,
           "mode": "hybrid" if key else "keyword", "files": 0, "chunks": 0, "embedded": 0}
    prog = None
    try:
        with open(progress_path(root), encoding="utf-8") as f:
            prog = json.load(f)
        if not P.pid_alive(int(prog.get("pid") or 0)):
            prog = None
    except (OSError, ValueError):
        prog = None
    out["building"] = prog
    if not out["exists"]:
        return out
    db = sqlite3.connect(path, timeout=10)
    try:
        out["files"] = db.execute("SELECT count(*) FROM files").fetchone()[0]
        out["chunks"] = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
        out["embedded"] = db.execute("SELECT count(*) FROM chunks WHERE vec IS NOT NULL").fetchone()[0]
        out["model"] = _meta(db, "model")
        out["tokenizer"] = _meta(db, "tokenizer")
        at = _meta(db, "indexed_at")
        out["indexed_at"] = float(at) if at else None
    except sqlite3.Error as e:
        out["error"] = str(e)
    finally:
        db.close()
    out["size_mb"] = round(sum(os.path.getsize(p) for p in (path, path + "-wal") if os.path.exists(p)) / 1048576.0, 2)
    if out["chunks"] and out["embedded"] < out["chunks"]:
        out["mode"] = "keyword" if not out["embedded"] else out["mode"]
    return out


# ---- command line -----------------------------------------------------------------------------

def _print(obj, as_json, text):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False), flush=True)
    else:
        print(text(obj))


def _results_text(r):
    head = []
    if r["mode"] == "keyword":
        why = {"no_key": _t("no OPENAI_API_KEY", "没有 OPENAI_API_KEY"), "not_embedded": _t("not embedded yet", "还没嵌入"), "embed_failed": _t("embedding failed: %s", "嵌入失败：%s") % r.get("error", ""),
               "keyword_flag": "--keyword"}.get(r.get("reason", ""), r.get("reason", ""))
        head.append(_t("(keyword mode%s)", "（关键词模式%s）") % (_t(": ", "：") + why if why else ""))
    if not r["results"]:
        return "\n".join(head + [_t("Nothing found", "没找到")])
    lines = head
    for it in r["results"]:
        lines.append("%s:%d-%d  %.4f  %s" % (it["path"], it["start"], it["end"], it["score"], it["via"]))
        body = [l for l in it["text"].split("\n") if l.strip()][:3]
        lines += ["    " + l[:140] for l in body]
    return "\n".join(lines)


def _index_text(r):
    if r.get("skipped"):
        return _t("Another process is building this project's index; try again in a moment", "另一个进程正在建这个项目的索引，稍后再试")
    s = _t("%s: %d files, %d chunks; this time %d files changed, %d removed, %d new chunks", "%s：%d 个文件，%d 块；这次改了 %d 个文件、删了 %d 个，新切 %d 块") % (
        _t("New index", "新建索引") if r.get("fresh") else _t("Index updated", "索引已更新"), r["files"], r["chunks"], r["changed_files"], r["removed_files"], r["new_chunks"])
    if r.get("embedded"):
        s += _t("; embedded %d chunks, %d tokens, $%.4f", "；嵌入 %d 块，%d token，$%.4f") % (r["embedded"], r["tokens"], r["usd"])
    if r["mode"] == "keyword":
        s += _t("; keyword search only (%s)", "；只有关键词搜索（%s）") % {"no_key": _t("no OPENAI_API_KEY", "没有 OPENAI_API_KEY"), "no_embed": "--no-embed", "embed_failed": _t("embedding failed: %s", "嵌入失败：%s") % r.get("error", "")}.get(r.get("reason", ""), r.get("reason", ""))
    return s + _t(" (%d ms)", "（%d ms）") % r["ms"]


def _status_text(s):
    if not s["exists"]:
        return _t("%s has no index yet (dispatch code-search index --root %s)", "%s 还没有索引（dispatch code-search index --root %s）") % (s["root"], s["root"])
    lines = [_t("%s: %d files, %d chunks, %d with vectors (%s), %.1f MB", "%s：%d 个文件，%d 块，%d 块有向量（%s），%.1f MB") % (s["root"], s["files"], s["chunks"], s["embedded"], s.get("model") or _t("none", "无"), s.get("size_mb", 0))]
    if s.get("building"):
        b = s["building"]
        lines.append(_t("Building the index: %s %d / %d", "正在建索引：%s %d / %d") % (b.get("phase"), b.get("done", 0), b.get("total", 0)))
    if not s["key"]:
        lines.append(_t("No OPENAI_API_KEY: keyword search only", "没有 OPENAI_API_KEY：只用关键词搜索"))
    return "\n".join(lines)


def parser():
    p = argparse.ArgumentParser(prog="dispatch code-search", description="search the project's code by meaning (embeddings + full text, RRF fusion; full text only without a key)")
    p.add_argument("words", nargs="*", help="the question; or the index / status subcommand")
    p.add_argument("--root", default=None, help="the project folder (default: the git repository of the current folder; needed outside a git repository)")
    p.add_argument("-n", type=int, default=DEFAULT_N, help="how many results (default 12)")
    p.add_argument("--keyword", action="store_true", help="keywords only (no embeddings)")
    p.add_argument("--no-refresh", action="store_true", help="do not update the index before searching")
    p.add_argument("--full", action="store_true", help="index: cut everything again (vectors are reused by chunk content)")
    p.add_argument("--file", action="append", default=None, help="index: update only these files (repeatable)")
    p.add_argument("--no-embed", action="store_true", help="index: full-text index only")
    p.add_argument("--json", action="store_true")
    return p


def run(a):
    words = list(a.words)
    op = "search"
    if words and words[0] in ("index", "status", "search"):
        op = words.pop(0)
    if op == "index":
        res = index(a.root, full=a.full, files=a.file, embed_ok=not a.no_embed, quiet=False)
        _print(res, a.json, _index_text)
        return 0 if res.get("ok") else 1
    if op == "status":
        _print(status(a.root), a.json, _status_text)
        return 0
    res = search(" ".join(words), a.root, n=a.n, keyword=a.keyword, refresh_first=not a.no_refresh, quiet=a.json)
    _print(res, a.json, _results_text)
    return 0


def main(argv=None):
    """Entry from `dispatch code-search …` and `python3 code_search.py …`."""
    a = parser().parse_args(argv)
    try:
        return run(a) or 0
    except SearchError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": e.code, "message": str(e)}, ensure_ascii=False), flush=True)
        else:
            print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    P.utf8_stdio()
    sys.exit(main(sys.argv[1:]))

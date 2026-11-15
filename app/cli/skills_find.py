#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`dispatch skills find <words>`: the skill pool first, then public skills.

Public skills come from the skills.sh index (the open directory behind `npx skills`: GitHub repos
that carry a SKILL.md, no key needed); when it cannot be reached, `gh search code` for SKILL.md files
on GitHub if the gh CLI is signed in. A result from outside names its repo; `dispatch skills install
<owner/repo> --as <skill>` (= import) puts it in the pool and mounts it.
"""
import json, os, re, shutil, subprocess, urllib.parse, urllib.request

SKILLS_SH = "https://skills.sh/api/search"


def _words(q):
    return [w for w in re.split(r"\s+", (q or "").lower().strip()) if w]


def local(rows, q):
    """Pool and mounted skills whose name or description has every word of the query."""
    words = _words(q)
    hits = []
    for r in rows:
        hay = (r["name"] + " " + (r.get("description") or "")).lower()
        if all(w in hay for w in words):
            score = (0 if words and r["name"].lower().startswith(words[0]) else 1, r["name"])
            hits.append((score, r))
    hits.sort(key=lambda x: x[0])
    return [{"name": r["name"], "description": r.get("description") or "", "source": "pool" if r.get("in_pool") else "local",
             "repo": "", "installs": 0, "installed": True, "mounted": dict(r.get("agents") or {}), "path": r.get("path") or ""}
            for _, r in hits]


def _get_json(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": "dispatch-skills-find", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def skills_sh(q, limit=20, fetch=_get_json):
    d = fetch(f"{SKILLS_SH}?q={urllib.parse.quote(q)}&limit={int(limit)}")
    out = []
    for s in (d or {}).get("skills") or []:
        repo, sid = s.get("source") or "", s.get("skillId") or s.get("name") or ""
        if not repo or not sid or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            continue
        out.append({"name": s.get("name") or sid, "skill_id": sid, "description": "", "source": "skills.sh", "repo": repo,
                    "installs": int(s.get("installs") or 0), "installed": False, "mounted": {}, "path": "",
                    "url": f"https://github.com/{repo}"})
    return out


def gh_search(q, limit=15, run=subprocess.run):
    if not shutil.which("gh"):
        return []
    r = run(["gh", "search", "code", q, "--filename", "SKILL.md", "--json", "repository,path", "-L", str(limit)],
            capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        return []
    out, seen = [], set()
    for hit in json.loads(r.stdout or "[]"):
        repo = (hit.get("repository") or {}).get("nameWithOwner") or ""
        path = hit.get("path") or ""
        sid = os.path.basename(os.path.dirname(path)) or repo.split("/")[-1]
        if not repo or (repo, sid) in seen:
            continue
        seen.add((repo, sid))
        out.append({"name": sid, "skill_id": sid, "description": "", "source": "github", "repo": repo, "installs": 0,
                    "installed": False, "mounted": {}, "path": "", "subpath": os.path.dirname(path), "url": f"https://github.com/{repo}"})
    return out


def find(q, rows, online=True, limit=20, fetch=_get_json, run=subprocess.run):
    """Local hits first, then public ones not already in the pool (same name counts as installed)."""
    mine = local(rows, q)
    res = {"query": q, "local": mine, "online": [], "online_source": "", "error": ""}
    if not online or not q.strip():
        return res
    names = {r["name"] for r in rows}
    try:
        found, res["online_source"] = skills_sh(q, limit, fetch), "skills.sh"
    except Exception as e:
        res["error"] = f"skills.sh: {e}"
        found, res["online_source"] = gh_search(q, limit, run), "github"
    seen = set()
    for r in found:
        key = (r["repo"], r.get("skill_id") or r["name"])
        if key in seen:  # the index can list one skill of one repo twice
            continue
        seen.add(key)
        if r["name"] in names or r.get("skill_id") in names:
            r["installed"] = True
        res["online"].append(r)
    return res


def cmd(a, all_skills, out):
    q = a.name or a.query or ""
    res = find(q, all_skills(), online=not getattr(a, "local", False))

    def text(r):
        for x in r["local"]:
            on = ",".join(k for k, v in x["mounted"].items() if v) or "not mounted"
            print(f"  {x['name']:<30} {on:<14} {x['description'][:70]}")
        if not r["local"]:
            print("  (nothing in the pool)")
        if r["online"]:
            print(f"\nfrom {r['online_source']}:")
            for x in r["online"]:
                tag = "installed" if x["installed"] else f"dispatch skills install {x['repo']} --as {x['skill_id']}"
                print(f"  {x['name']:<30} {x['repo']:<34} {x['installs'] or '':>7}  {tag}")
        if r["error"]:
            print(f"\n({r['error']})")
    out(res, a.json, text)

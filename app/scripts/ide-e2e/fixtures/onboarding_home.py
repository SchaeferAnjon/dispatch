"""A throw-away HOME for the first-run setup: what a person who has used agents in a terminal (or nobody at
all) has on a Mac, without touching the real one.

    python3 app/scripts/ide-e2e/fixtures/onboarding_home.py --home /tmp/ob-home --kind terminal   # used a terminal
    python3 app/scripts/ide-e2e/fixtures/onboarding_home.py --home /tmp/ob-fresh --kind fresh      # nothing yet

`terminal`: git and plain folders under ~/Projects and an iCloud Drive folder, each with Claude Code sessions
of different ages (the newest a minute old, the oldest a year), Codex sessions, a CLAUDE.md and an AGENTS.md
with a few rules, Claude and Codex memory notes, VS Code settings and extensions. `fresh`: only the agents.
The agents themselves (Claude Code, Codex, OpenCode, and Gemini CLI, Aider and Kiro CLI that Dispatch only detects) are small scripts on a PATH folder in the HOME (`.local/bin/`), so `dispatch onboard status`
finds them without the real ones; `--real-agents` links the real claude / codex / opencode instead.

Nothing here is real data: the folders are made up, the sessions say "Fixture".
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

DAY = 86400

FOLDERS = [
    # (relative to HOME, git?, [session ages in days], claude titles)
    ("Projects/notes-site", True, [0.01, 1.5, 4], ["Fix the RSS feed dates", "Add a dark mode", "Tidy the build script"]),
    ("Projects/thesis-code", True, [2, 3, 8, 10], ["Plot the benchmark results", "Rename the modules", "Explain the cache miss", "Speed up the loader"]),
    ("Projects/photo-tools", False, [5], ["Batch rename photos"]),
    ("Projects/api-gateway", True, [13, 14], ["Rate limit the login route", "Add request ids"]),
    ("Projects/dotfiles", True, [21], ["Move the zsh config"]),
    ("Documents/ml-notes", False, [27], ["Summarise chapter 4"]),
    ("Projects/old-blog", True, [44, 50], ["Migrate to a static generator", "Fix the sitemap"]),
    ("Projects/hpc-lab", True, [70, 71, 75], ["Submit the job array", "Read the scheduler log", "Fix the module load"]),
    ("Library/Mobile Documents/com~apple~CloudDocs/Course/notes", False, [3], ["Outline the lecture"]),
    ("Library/Mobile Documents/com~apple~CloudDocs/Course/paper", True, [6], ["Rewrite the abstract"]),
    ("Documents/scratch-2025", False, [190], ["Try out the parser"]),
]
CODEX_FOLDERS = [("Projects/notes-site", [2.0]), ("Projects/thesis-code", [9, 12]), ("Projects/api-gateway", [20])]

AGENT_STUBS = {
    "claude": """#!/bin/sh
case "$1" in
  --version) echo "2.1.284 (Claude Code)" ;;
  auth)
    case "$2" in
      login) rm -f "$HOME/.claude-signed-out"; echo "Login successful" ;;
      *) if [ -f "$HOME/.claude-signed-out" ]; then echo '{"loggedIn": false}'; else echo '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}'; fi ;;
    esac ;;
  *) echo "fixture claude" ;;
esac
""",
    "codex": """#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.158.0" ;;
  login) echo "Logged in using ChatGPT" ;;
  *) echo "fixture codex" ;;
esac
""",
    "opencode": """#!/bin/sh
case "$1" in
  --version) echo "1.18.32" ;;
  *) echo "fixture opencode" ;;
esac
""",
    # agents Dispatch only detects (it cannot start sessions with them yet)
    "gemini": """#!/bin/sh
case "$1" in
  --version) echo "0.62.0" ;;
  *) echo "fixture gemini" ;;
esac
""",
    "aider": """#!/bin/sh
case "$1" in
  --version) echo "aider 0.86.2" ;;
  *) echo "fixture aider" ;;
esac
""",
    "kiro-cli": """#!/bin/sh
case "$1" in
  --version) echo "kiro-cli 1.20.0" ;;
  *) echo "fixture kiro" ;;
esac
""",
}


def sh(args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


def make_folder(home, rel, git):
    path = os.path.join(home, rel)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "README.md"), "w", encoding="utf-8") as f:
        f.write(f"# {os.path.basename(rel)}\n\nFixture folder.\n")
    if git and not os.path.isdir(os.path.join(path, ".git")):
        sh(["git", "init", "-q"], cwd=path)
        sh(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "add", "README.md"], cwd=path)
        sh(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "docs: readme"], cwd=path)
    return path


def claude_session(home, cwd, title, age_days, now):
    sid = str(uuid.uuid4())
    folder = os.path.join(home, ".claude", "projects", "".join(c if c.isalnum() else "-" for c in cwd))
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.fromtimestamp(now - age_days * DAY, datetime.timezone.utc).isoformat()
    user = {"type": "user", "sessionId": sid, "cwd": cwd, "entrypoint": "cli", "timestamp": stamp, "uuid": str(uuid.uuid4()), "parentUuid": None,
            "isSidechain": False, "version": "2.1.284", "message": {"role": "user", "content": title}}
    asst = {**user, "type": "assistant", "uuid": str(uuid.uuid4()), "parentUuid": user["uuid"],
            "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixture response."}], "id": "fixture", "model": "fixture",
                        "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": 0}}}
    path = os.path.join(folder, sid + ".jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(json.dumps(r, separators=(",", ":")) for r in (user, asst, {"type": "custom-title", "sessionId": sid, "customTitle": title})) + "\n")
    t = now - age_days * DAY
    os.utime(path, (t, t))
    return path


def codex_session(home, cwd, age_days, now, title):
    sid = str(uuid.uuid4())
    when = datetime.datetime.fromtimestamp(now - age_days * DAY, datetime.timezone.utc)
    folder = os.path.join(home, ".codex", "sessions", when.strftime("%Y"), when.strftime("%m"), when.strftime("%d"))
    os.makedirs(folder, exist_ok=True)
    stamp = when.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    rows = [{"timestamp": stamp, "type": "session_meta", "payload": {"id": sid, "session_id": sid, "timestamp": stamp, "cwd": cwd, "originator": "codex-tui", "cli_version": "0.158.0", "source": "cli"}},
            {"timestamp": stamp, "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": title}]}},
            {"timestamp": stamp, "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Fixture response."}]}}]
    path = os.path.join(folder, f"rollout-{when.strftime('%Y-%m-%dT%H-%M-%S')}-{sid}.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n")
    t = now - age_days * DAY
    os.utime(path, (t, t))
    return path


CLAUDE_MD = """# My Claude Code rules

- Always answer in the language I write in.
- Prefer small commits with a message like `<type>: <what changed>`.
- Never add Co-Authored-By lines to commits.
- The build script lives in scripts/build.sh
- Keep explanations short and lead with the result.
- Don't reformat files you were not asked to touch.
"""
AGENTS_MD = """# Codex rules

- Do not run destructive git commands without asking.
- Use pytest for Python tests, not unittest.
- The repos live under ~/Projects
"""
MEMORY_FEEDBACK = """---
name: {name}
description: {desc}
type: feedback
---
{desc}
"""
CODEX_MEMORY = """# Memory summary

## User preferences
- Explain a change with the smallest example that shows it.
- Never open a pull request unless asked.
"""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def vscode(home):
    user = os.path.join(home, "Library", "Application Support", "Code", "User")
    write(os.path.join(user, "settings.json"), """{
  // fixture
  "workbench.colorTheme": "Light Modern",
  "editor.fontSize": 14,
  "editor.formatOnSave": true,
  "files.autoSave": "afterDelay",
  "terminal.integrated.defaultProfile.osx": "zsh",
  "chat.viewSessions.orientation": "stacked",
  "python.analysis.typeCheckingMode": "basic",
  "rainbow_csv.enable_tooltip": true,
}
""")
    write(os.path.join(user, "keybindings.json"), '[\n  { "key": "cmd+k cmd+t", "command": "workbench.action.terminal.toggleTerminal" }\n]\n')
    exts = os.path.join(home, ".vscode", "extensions")
    rows = []
    for ident, version, props, cats in (
        ("mechatroner.rainbow-csv", "3.24.1", {"rainbow_csv.enable_tooltip": {"type": "boolean"}}, ["Programming Languages"]),
        ("ms-python.python", "2026.4.0", {"python.defaultInterpreterPath": {"type": "string"}}, ["Programming Languages"]),
        ("akamud.vscode-theme-onelight", "2.3.0", {}, ["Themes"]),
        ("anthropic.claude-code", "2.1.283", {}, ["Other"]),
        ("ms-vscode.cpptools", "1.34.4", {}, ["Programming Languages"]),
    ):
        loc = os.path.join(exts, f"{ident}-{version}")
        pkg = {"name": ident.split(".", 1)[1], "displayName": ident.split(".", 1)[1].replace("-", " ").title(), "version": version, "categories": cats, "contributes": {}}
        if props:
            pkg["contributes"]["configuration"] = {"properties": props}
        if "Themes" in cats:
            pkg["contributes"]["themes"] = [{"label": "One Light", "uiTheme": "vs", "path": "./themes/x.json"}]
        write(os.path.join(loc, "package.json"), json.dumps(pkg))
        rows.append({"identifier": {"id": ident}, "version": version, "location": {"path": loc, "scheme": "file"}})
    write(os.path.join(exts, "extensions.json"), json.dumps(rows))


def build(home, kind="terminal", real_agents=False, now=None, with_vscode=True):
    now = now or time.time()
    os.makedirs(home, exist_ok=True)
    bin_dir = os.path.join(home, ".local", "bin")
    os.makedirs(bin_dir, exist_ok=True)
    for name, body in AGENT_STUBS.items():
        target = os.path.join(bin_dir, name)
        real = shutil.which(name) if real_agents else None
        if real:
            if os.path.lexists(target):
                os.remove(target)
            os.symlink(real, target)
        else:
            write(target, body)
            os.chmod(target, 0o755)
    for d in (".claude", ".codex", os.path.join(".config", "opencode")):
        os.makedirs(os.path.join(home, d), exist_ok=True)
    if os.environ.get("DISPATCH_FIXTURE_CLAUDE_SIGNED_OUT"):  # Claude Code starts signed out; its `auth login` signs it in
        write(os.path.join(home, ".claude-signed-out"), "")
    write(os.path.join(home, ".gemini", "settings.json"), json.dumps({"security": {"auth": {"selectedType": "oauth-personal"}}}))
    if kind == "fresh":
        return {"home": home, "bin": bin_dir}
    made = []
    for rel, git, ages, titles in FOLDERS:
        cwd = make_folder(home, rel, git)
        for age, title in zip(ages, titles):
            claude_session(home, cwd, title, age, now)
        made.append(cwd)
    for rel, ages in CODEX_FOLDERS:
        cwd = os.path.join(home, rel)
        for k, age in enumerate(ages):
            codex_session(home, cwd, age, now, f"Fixture codex question {k + 1}")
    # a folder that only holds another folder (both have sessions)
    mono = make_folder(home, "Projects/monorepo", False)
    claude_session(home, mono, "Compare the two packages", 8, now)
    web = make_folder(home, "Projects/monorepo/web", True)
    claude_session(home, web, "Check the bundle size", 7, now)
    write(os.path.join(home, ".claude", "CLAUDE.md"), CLAUDE_MD)
    write(os.path.join(home, ".codex", "AGENTS.md"), AGENTS_MD)
    write(os.path.join(home, ".codex", "memories", "memory_summary.md"), CODEX_MEMORY)
    mem = os.path.join(home, ".claude", "projects", "".join(c if c.isalnum() else "-" for c in os.path.join(home, "Projects/notes-site")), "memory")
    write(os.path.join(mem, "feedback_short.md"), MEMORY_FEEDBACK.format(name="feedback-short", desc="Keep answers short and lead with the result; no closing menu of offers."))
    write(os.path.join(mem, "feedback_tests.md"), MEMORY_FEEDBACK.format(name="feedback-tests", desc="Run the tests before saying a change is done; never say it works without running it."))
    write(os.path.join(mem, "project_site.md"), "---\nname: site\ndescription: The site is built with Hugo and deployed from main.\ntype: project\n---\nHugo.\n")
    if with_vscode:
        vscode(home)
    return {"home": home, "bin": bin_dir, "folders": made}


def env_for(home, base=None):
    """The environment a Dispatch process should run in for this HOME."""
    env = dict(base or os.environ)
    env["HOME"] = home
    env["PATH"] = os.path.join(home, ".local", "bin") + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    env["DISPATCH_DIR"] = os.path.join(home, "tasks", ".dispatch")
    env["BEADS_DIR"] = os.path.join(home, "tasks", ".beads")
    env["DISPATCH_HOME"] = os.path.join(home, ".dispatch")
    env.pop("DISPATCH_SESSION_ROOT", None)
    env.pop("CODEX_HOME", None)
    return env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--kind", choices=["terminal", "fresh"], default="terminal")
    ap.add_argument("--real-agents", action="store_true")
    a = ap.parse_args()
    print(json.dumps(build(a.home, a.kind, a.real_agents)))


if __name__ == "__main__":
    sys.exit(main())

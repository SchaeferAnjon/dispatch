# -*- coding: utf-8 -*-
"""The coding agents Dispatch recognizes but has no adapter file for, and the order every list of agents follows.

Each row is a plain `Engine` (engines/base.py): its name, one plain sentence about it, its command names, how to
install it, and for names other tools use too (`amp`, `goose`, `pi`, `cn`) a check that the file is the agent:
`real_match` must match its real path, `reject_real` and `reject_output` must not match its path / its `--version`
text, `verify` means a short or common name that only counts when `--version` answers with a version.
An agent that gets an adapter file (engines/<id>.py) leaves this list; the adapter carries its row.

The list of agents (names, command names and aliases, home pages) follows the agent catalog of Orca
(https://github.com/stablyai/orca, src/shared/tui-agent-config.ts and src/renderer/src/lib/agent-catalog.tsx),
which is under the MIT License:

    MIT License

    Copyright (c) 2026 Lovecast Inc.

    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
    associated documentation files (the "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included in all copies or substantial
    portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
    LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
    EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
    IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    USE OR OTHER DEALINGS IN THE SOFTWARE.
"""

# Where each agent sits in every list (the session pickers, the terminal's agent menu, first-run setup). An agent with
# an adapter file that is not named here goes after all of these.
ORDER = ("claude", "codex", "opencode", "gemini", "copilot", "cursor", "aider", "amp", "goose", "qwen", "kiro", "crush", "droid",
         "cline", "auggie", "kimi", "kilo", "vibe", "grok", "continue", "openhands", "pi", "hermes", "openclaude", "mimo", "ante",
         "trae", "muse", "dsh", "qoder", "zcode", "omp", "prime-agent", "antigravity", "autohand", "codebuff", "freebuff",
         "command-code", "rovo", "devin", "openclaw", "codebuddy")

AGENTS = [
    {"id": "cursor", "about": "Cursor's coding assistant. Needs a Cursor account.", "name": "Cursor Agent", "bins": ("cursor-agent",), "install_hint": "curl https://cursor.com/install -fsS | bash", "short_name": "Cursor", "aliases": ("cursor-agent",)},
    {"id": "aider", "about": "A free, open-source assistant that edits the files in your project. You bring your own AI service key.", "name": "Aider", "bins": ("aider",), "install_hint": "brew install aider"},
    {"id": "amp", "about": "Sourcegraph's coding assistant. Needs an Amp account.", "name": "Amp", "bins": ("amp",), "install_hint": "npm i -g @sourcegraph/amp", "reject_real": "/Cellar/amp/",
     "signin_files": (".local/share/amp/secrets.json",)},
    {"id": "kiro", "about": "Amazon's coding assistant from Kiro. Needs a Kiro account.", "name": "Kiro CLI", "bins": ("kiro-cli",), "install_hint": "curl -fsSL https://cli.kiro.dev/install | bash", "terminal_args": "chat --tui"},
    {"id": "crush", "about": "A free, open-source assistant from Charm. You bring your own AI service key.", "name": "Crush", "bins": ("crush",), "install_hint": "brew install charmbracelet/tap/crush"},
    {"id": "droid", "about": "Factory's coding assistant. Needs a Factory account.", "name": "Droid", "bins": ("droid",), "install_hint": "curl -fsSL https://app.factory.ai/cli | sh",
     "signin_files": (".factory/auth.json", ".factory/auth.encrypted")},
    {"id": "cline", "about": "A free, open-source assistant. You bring your own AI service key.", "name": "Cline", "bins": ("cline",), "install_hint": "npm i -g cline"},
    {"id": "auggie", "about": "Augment's coding assistant. Needs an Augment account.", "name": "Auggie", "bins": ("auggie",), "install_hint": "npm i -g @augmentcode/auggie"},
    {"id": "kimi", "about": "Moonshot AI's coding assistant. Sign in with a Kimi account or use your own key.", "name": "Kimi Code", "bins": ("kimi", "kimi-code"), "install_hint": "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"},
    {"id": "kilo", "about": "The open-source assistant from Kilo Code. Use its account or your own key.", "name": "Kilo Code", "bins": ("kilo", "kilocode"), "install_hint": "npm i -g @kilocode/cli"},
    {"id": "vibe", "about": "Mistral's coding assistant. Needs a Mistral account or key.", "name": "Mistral Vibe", "bins": ("vibe",), "install_hint": "uv tool install mistral-vibe"},
    {"id": "grok", "about": "xAI's coding assistant. Needs a Grok account.", "name": "Grok", "bins": ("grok",), "install_hint": "npm i -g @xai-official/grok"},
    {"id": "continue", "about": "Continue's open-source assistant. You bring your own AI service key.", "name": "Continue", "bins": ("cn",), "install_hint": "npm i -g @continuedev/cli", "real_match": "continue"},
    {"id": "openhands", "about": "A free, open-source assistant that works through tasks on its own. You bring your own AI service key.", "name": "OpenHands", "bins": ("openhands",), "install_hint": "uv tool install openhands --python 3.12"},
    # ported from Orca's catalog: only detected, never started by Dispatch
    {"id": "openclaude", "name": "OpenClaude", "about": "An open-source coding assistant that works with many AI services. You bring your own key.", "bins": ("openclaude",), "url": "https://openclaude.gitlawb.com/"},
    {"id": "mimo", "name": "MiMo Code", "about": "Xiaomi's coding assistant. Needs a MiMo account or key.", "bins": ("mimo",), "verify": True, "url": "https://mimo.xiaomi.com/coder"},
    {"id": "ante", "name": "Ante", "about": "A coding assistant from Antigma Labs. You bring your own AI service key.", "bins": ("ante",), "verify": True, "url": "https://github.com/AntigmaLabs/ante-preview"},
    {"id": "trae", "name": "Trae", "about": "ByteDance's coding assistant. Needs a Trae account.", "bins": ("traecli",), "url": "https://docs.trae.cn/cli_get-started-with-trae-cli"},
    {"id": "muse", "name": "Muse", "about": "Meta's coding assistant. Needs a Meta account.", "bins": ("muse",), "verify": True, "url": "https://dev.meta.ai/docs/muse-code", "terminal_args": "--trust-workspace"},
    {"id": "dsh", "name": "DeepSeek Harness", "about": "An open-source coding assistant built around DeepSeek models. You bring your own key.", "bins": ("dsh-tui", "dst"), "verify": True, "url": "https://deepseek-harness.github.io/deepseek-harness/"},
    {"id": "qoder", "name": "Qoder", "about": "Qoder's coding assistant. Needs a Qoder account.", "bins": ("qodercli",), "url": "https://docs.qoder.com/cli/overview"},
    {"id": "omp", "name": "OMP", "about": "An open-source coding assistant. You bring your own AI service key.", "bins": ("omp",), "verify": True, "url": "https://omp.sh"},
    {"id": "prime-agent", "name": "Prime Agent", "about": "A coding assistant from Prime Intellect. You bring your own AI service key.", "bins": ("prime-agent",), "url": "https://github.com/PrimeIntellect-ai/prime-agent"},
    {"id": "antigravity", "name": "Antigravity", "about": "Google's Antigravity coding assistant. Sign in with a Google account.", "bins": ("agy",), "verify": True, "url": "https://antigravity.google/docs/cli-overview"},
    {"id": "autohand", "name": "Autohand Code", "about": "A coding assistant from Autohand. You bring your own AI service key.", "bins": ("autohand",), "url": "https://github.com/autohandai/code-cli"},
    {"id": "codebuff", "name": "Codebuff", "about": "Codebuff's coding assistant. Needs a Codebuff account.", "bins": ("codebuff",), "url": "https://www.codebuff.com/docs/help/quick-start"},
    {"id": "freebuff", "name": "Freebuff", "about": "A coding assistant from Freebuff.", "bins": ("freebuff",), "url": "https://freebuff.com/cli"},
    {"id": "command-code", "name": "Command Code", "about": "Command Code's coding assistant. Needs a Command Code account.", "bins": ("command-code",), "url": "https://commandcode.ai/docs/quickstart", "terminal_args": "--trust"},
    {"id": "rovo", "name": "Rovo Dev", "about": "Atlassian's coding assistant. Needs an Atlassian account.", "bins": ("rovo",), "verify": True, "url": "https://www.atlassian.com/rovo-dev"},
    {"id": "devin", "name": "Devin", "about": "Cognition's coding assistant. Needs a Devin account.", "bins": ("devin",), "verify": True, "url": "https://devin.ai/cli"},
    {"id": "openclaw", "name": "OpenClaw", "about": "An open-source personal assistant that can also write code. You bring your own AI service key.", "bins": ("openclaw",), "url": "https://github.com/openclaw/openclaw"},
    {"id": "codebuddy", "name": "CodeBuddy", "about": "Tencent's coding assistant. Needs a CodeBuddy account.", "bins": ("codebuddy", "cbc"), "url": "https://www.codebuddy.ai/cli"},
]

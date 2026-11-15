# Environment variables / API keys (`dispatch env`)

Keys are all kept in `~/.config/dispatch/env` (0600), never on the board, in the wiki or in a commit. `dispatch prime` lists only names and uses; `dispatch env get NAME` when one is needed; when the person gives a new key, `dispatch env set NAME VALUE --note "what for"` (or `--stdin`); `dispatch env list`; in a shell `eval "$(dispatch env export)"` (new fish terminals load it by themselves).

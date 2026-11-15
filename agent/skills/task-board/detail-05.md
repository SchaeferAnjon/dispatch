# Handing work to other agents (`dispatch agent`, conversations in the app)

```bash
dispatch agent list [--host <machine>]                               # which agents are open in Dispatch on this Mac / another computer (machine names: dispatch hosts)
dispatch agent start codex --cwd ~/Projects/x --task <id> -p "Fix the tests, then dispatch log"   # starts an agent in Dispatch, claims the task, sends the first message, waits for it to finish and reads the answer back
dispatch agent start claude --host <machine> --model claude-sonnet-5 -p "…"              # across machines: starts it in Dispatch on another computer
dispatch agent ask <session ID|label|task ID> "Now fill in the docs"          # sends one sentence to an existing session; by default waits for it to finish and reads the answer back
dispatch agent read <target> --lines 80 / wait <target> / close <target>
```
Only claude and codex can be started; the agent runs in a conversation in Dispatch on that computer, which must have Dispatch open (otherwise it fails at once). `--extra "--effort high"` sets the reasoning effort; `--resume <session ID>` carries on an existing conversation. `start --task` claims the task under the matching identity (claude → claude-code, codex), leaves a comment saying who handed it to whom, and runs with permissions skipped (`--auto` the same). When the state comes back blocked, the other agent is stopped at a confirmation and the person has to click Allow or Deny in Dispatch. The other agent runs `dispatch done` as usual when finished; you gather and check the results.

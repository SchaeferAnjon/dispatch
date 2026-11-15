"""A temporary HOME for the keys scenario (scenarios/keys.mjs declares it: meta.instance.fixture "keys-home"), so
Settings › Keys and `dispatch env` in the instance's terminal read and write <instance>/keys-home/.config/dispatch/env,
never the person's own key store. Two keys are there from the start, both with made-up values: one for every project,
one for the demo project. Two more made-up values wait in files, one for the terminal step and one for the agent in
keys-agent.mjs, so neither is typed on a command line, said in a chat or shown on screen.
"""
import os
import shutil

SEED = (
    ("FAKE_SEED_SEARCH_KEY", "fake-e2e-seed-search-0001", "Search API for the e2e test", ""),
    ("FAKE_SEED_DEMO_KEY", "fake-e2e-seed-demo-0002", "Demo project's own service", "demo"),
)
TERM_VALUE = "fake-e2e-terminal-0003"
AGENT_VALUE = "fake-e2e-agent-0007"


def make_home(home):
    shutil.rmtree(home, ignore_errors=True)
    store = os.path.join(home, ".config", "dispatch")
    os.makedirs(store, mode=0o700)
    body = "# made-up keys for the e2e test\n\n"
    for name, value, note, project in SEED:
        body += (f"# project: {project}\n" if project else "") + f"# {note}\n{name}={value}\n\n"
    fd = os.open(os.path.join(store, "env"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(body)
    for file, value in (("fake-term-value.txt", TERM_VALUE), ("fake-agent-value.txt", AGENT_VALUE)):
        fd = os.open(os.path.join(home, file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value + "\n")


def prepare(rec):
    """`instance start --fixture keys-home`: the app, its CLI and its terminals get this HOME."""
    home = os.path.join(rec["root"], "keys-home")
    make_home(home)
    # the values stay out of the instance's record: the scenario has its own copy, and checks the record holds none
    return {"env": {"HOME": home}, "record": {"keys_home": home}}

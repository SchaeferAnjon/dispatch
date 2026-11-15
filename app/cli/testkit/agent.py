# -*- coding: utf-8 -*-
"""Body of the agent stand-ins testkit puts in front of every agent command (`agent.py <name> args…`): refused,
recorded with the test's name, never handed over to the real agent."""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from testkit import guard, shim  # noqa: E402

VERSION_ASKS = (["--version"], ["-v"], ["-V"], ["version"])

if __name__ == "__main__":
    name = sys.argv.pop(1)
    if sys.argv[1:] in VERSION_ASKS:
        sys.exit(1)  # a version probe gets no version: the same answer on every machine, nothing recorded
    shim.run(name, guard.agent_verdict(name))

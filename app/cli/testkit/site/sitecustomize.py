# Loaded by every Python the test suite starts (PYTHONPATH): the same filesystem guard as in the test process.
import os
if os.environ.get("TESTKIT_SESSION"):
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("testkit_fsguard", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fsguard.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.install()
    except Exception:
        pass

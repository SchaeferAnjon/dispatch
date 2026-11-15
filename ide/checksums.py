#!/usr/bin/env python3
"""Recompute product.json's checksums for the built app (the integrity check that says "installation
appears to be corrupt" compares them): run after anything edits files inside the app bundle."""
import base64, hashlib, json, os, sys

app = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "VSCode-darwin-arm64/Dispatch IDE.app")
res = os.path.join(app, "Contents/Resources/app")
p = os.path.join(res, "product.json")
prod = json.load(open(p))
changed = 0
for rel in list((prod.get("checksums") or {}).keys()):
    f = os.path.join(res, "out", rel)
    if not os.path.exists(f):
        continue
    h = base64.b64encode(hashlib.sha256(open(f, "rb").read()).digest()).decode().rstrip("=")
    if prod["checksums"][rel] != h:
        prod["checksums"][rel] = h
        changed += 1
if changed:
    json.dump(prod, open(p, "w"), indent="\t", ensure_ascii=False)
print(f"checksums: {changed} updated")

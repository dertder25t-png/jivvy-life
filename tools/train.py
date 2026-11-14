#!/usr/bin/env python3
"""Retrains extension/model/weights.json for the Hub router.

Usage:
  python3 tools/train.py                              # seed examples only
  python3 tools/train.py ~/Downloads/hub-corrections.jsonl   # plus your corrections

Each input line is JSON: {"text": "...", "cls": "search" | "ask" | "deep" | "code"}.
Your corrections count three times as much as the seed examples.
Plain Python, no libraries. features() must match extension/core/classifier.js.
"""
import json
import math
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "tools" / "seed.jsonl"
OUT = ROOT / "extension" / "model" / "weights.json"
CLASSES = ["search", "ask", "deep", "code"]


def features(text):
    t = text.lower().strip()
    words = re.findall(r"[a-z0-9_']+", t)
    f = set("w:" + w for w in words)
    s = " " + " ".join(words) + " "
    for i in range(len(s) - 2):
        f.add("c:" + s[i:i + 3])
    n = len(words)
    f.add("len:s" if n <= 3 else "len:m" if n <= 12 else "len:l")
    if re.search(r"\?\s*$", t):
        f.add("end:?")
    if re.search(r"[{};=<>]|=>|\(\)", t):
        f.add("sym:code")
    if n:
        f.add("f:" + words[0])
    return f


def load(path, weight):
    out = []
    for line in Path(path).expanduser().read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        ex = json.loads(line)
        if ex.get("cls") in CLASSES and ex.get("text"):
            out += [(features(ex["text"]), ex["cls"])] * weight
    return out


def train(data, epochs=40, lr=0.2, l2=1e-4):
    w, b = {}, {c: 0.0 for c in CLASSES}
    rnd = random.Random(0)
    for _ in range(epochs):
        rnd.shuffle(data)
        for feats, label in data:
            scores = {c: b[c] + sum(w.get(f, {}).get(c, 0.0) for f in feats) for c in CLASSES}
            m = max(scores.values())
            exp = {c: math.exp(scores[c] - m) for c in CLASSES}
            z = sum(exp.values())
            for c in CLASSES:
                g = exp[c] / z - (1.0 if c == label else 0.0)
                b[c] -= lr * g
                for f in feats:
                    row = w.setdefault(f, {})
                    row[c] = row.get(c, 0.0) - lr * (g + l2 * row.get(c, 0.0))
    return w, b


def accuracy(w, b, data):
    ok = 0
    for feats, label in data:
        scores = {c: b[c] + sum(w.get(f, {}).get(c, 0.0) for f in feats) for c in CLASSES}
        ok += max(scores, key=scores.get) == label
    return ok / max(1, len(data))


def main():
    data = load(SEED, 1)
    for extra in sys.argv[1:]:
        data += load(extra, 3)
    w, b = train(data)
    pruned = {}
    for f, row in w.items():
        row = {c: round(v, 3) for c, v in row.items() if abs(v) >= 0.02}
        if row:
            pruned[f] = row
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"version": 1, "classes": CLASSES,
                               "bias": {c: round(v, 3) for c, v in b.items()}, "w": pruned},
                              separators=(",", ":")))
    print(f"{len(data)} examples, training accuracy {accuracy(w, b, data):.0%}, "
          f"{len(pruned)} features, {OUT.stat().st_size // 1024} KB -> {OUT}")


if __name__ == "__main__":
    main()

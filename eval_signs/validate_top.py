"""Download a few ASL Citizen pose clips per candidate sign and measure SignBart on them.

    python eval_signs/validate_top.py candidates.txt INDEX.json CLIPDIR OUT.json [--per 4]

candidates.txt: one gloss per line (ASL-LEX / ASL Citizen spelling, e.g. THANK YOU, WANT 1).
Caveat: SignBart was trained on ASL Citizen, so these clips may be in its training set. This measures
whether the model knows the sign and whether our preprocessing is right, not accuracy on new signers.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import sys
import urllib.parse
import urllib.request

import re

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "fingertip", "server"))
sys.path.insert(0, os.path.join(ROOT, "fingertip", "model"))
from app.signs.models import SignBartModel, gloss_of  # noqa: E402  (Fingertip, by Shruti)
from validate_aslcitizen import frames_from_pose  # noqa: E402

key = lambda s: re.sub(r"[^A-Z]", "", gloss_of(s.upper()))   # 'GO AHEAD' == 'GOAHEAD' == 'GO-AHEAD'

BASE = "https://huggingface.co/datasets/SorensenAI/asl-citizen-poses/resolve/main/"


def fetch(rel: str, clipdir: str) -> str | None:
    dest = os.path.join(clipdir, os.path.basename(rel))
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    try:
        with urllib.request.urlopen(BASE + urllib.parse.quote(rel), timeout=60) as r, open(dest, "wb") as f:
            f.write(r.read())
        return dest
    except Exception as e:
        print("download failed", rel, e)
        return None


def main() -> None:
    cand_path, index_path, clipdir, out = sys.argv[1:5]
    per = int(sys.argv[sys.argv.index("--per") + 1]) if "--per" in sys.argv else 4
    cands = [l.strip().upper() for l in open(cand_path) if l.strip() and not l.startswith("#")]
    index = json.load(open(index_path))
    by_gloss: dict[str, list[str]] = {}
    for name, paths in index.items():
        by_gloss.setdefault(key(name), []).extend(paths)
    model = SignBartModel()
    model_glosses = {key(l) for l in model.labels}

    jobs, plan = [], {}
    for c in cands:
        g = key(c)
        clips = sorted(by_gloss.get(g, []))[:per]
        plan[c] = (g, clips)
        jobs += clips
    os.makedirs(clipdir, exist_ok=True)
    with cf.ThreadPoolExecutor(16) as ex:
        local = dict(zip(jobs, ex.map(lambda r: fetch(r, clipdir), jobs)))

    allowed = {gloss_of(l) for l in model.labels if key(l) in {g for g, _ in plan.values()}}
    results = {}
    for c, (g, clips) in plan.items():
        row = {"gloss": g, "in_model": g in model_glosses, "clips": 0, "top1": 0, "top5": 0, "in_set_top1": 0,
               "confusions": {}, "in_set_confusions": {}}
        for rel in clips:
            p = local.get(rel)
            if not p:
                continue
            try:
                frames = frames_from_pose(p)
            except Exception as e:
                print("bad pose", rel, e)
                continue
            swapped = [{**f, "lh": f.get("rh"), "rh": f.get("lh")} for f in frames]
            guesses = max((model.predict(frames, k=5), model.predict(swapped, k=5)), key=lambda x: x[0].p)
            g_in = max((model.predict(frames, k=3, allowed=allowed), model.predict(swapped, k=3, allowed=allowed)),
                       key=lambda x: x[0].p)
            row["in_set_top1"] += key(g_in[0].sign) == g
            if key(g_in[0].sign) != g:
                row["in_set_confusions"][g_in[0].sign] = row["in_set_confusions"].get(g_in[0].sign, 0) + 1
            row["clips"] += 1
            top = [key(x.sign) for x in guesses]
            row["top1"] += top[0] == g
            row["top5"] += g in top
            if top[0] != g:
                row["confusions"][top[0]] = row["confusions"].get(top[0], 0) + 1
        results[c] = row
        print(f"{c:20s} model={row['in_model']!s:5s} clips={row['clips']} top1={row['top1']} top5={row['top5']} in_set={row['in_set_top1']}")
    json.dump(results, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()

"""Merge the three research lists into one scored candidate list, mapped to SignBart's labels.

score = 0.45 * ASL-LEX frequency (deaf raters, 1-7 rescaled) + 0.30 * core-list consensus (of 6 lists, capped at 4)
      + 0.25 * phone-call priority (tier 1 = 1.0, numbers/scheduling = 0.8, service/places = 0.6, extras = 0.4)
"""
import csv, json, re, sys, os
NOTES = sys.argv[1]; OUT = sys.argv[2]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
labels = json.load(open(os.path.join(ROOT, "fingertip/model/signbart/labels.json")))
sys.path.insert(0, os.path.join(ROOT, "fingertip/server"))
from app.signs.models import gloss_of
key = lambda s: re.sub(r"[^A-Z]", "", gloss_of(s.upper()))
model = {}
for l in labels: model.setdefault(key(l), gloss_of(l))
ALIAS = {"OKAY": "OK", "TELEPHONE": "PHONE", "IM": "ME", "I": "ME", "MYMINE": "MY", "IME": "ME", "ALLDONE": "FINISH",
         "FINISHED": "FINISH", "THANKS": "THANKYOU", "GOODBYE": "BYE", "WHATS": "WHAT", "MOVIES": "MOVIE", "EXCUSEME": "EXCUSE", "STORE": "SHOP", "NUMBER": "NUMBERS",
         "MOM": "MOTHER", "DAD": "FATHER", "EVENING": "NIGHT", "LOOK": "LOOKAT", "CARD": "CARDS", "PHARMACY": "PHARMACIST",
         "POLICE": "POLICEMAN", "THING": "THINGS", "CALLBACK": "CALL", "FORGET": "FORGETFUL"}

c = {}
def add(word, **kw):
    k = key(word); k = ALIAS.get(k, k)
    if not k: return
    r = c.setdefault(k, {"word": word.upper(), "freq": None, "lists": 0, "phone": 0.0, "sources": []})
    for a, v in kw.items():
        if a == "freq": r["freq"] = max(r["freq"] or 0, v)
        elif a == "lists": r["lists"] = max(r["lists"], v)
        elif a == "phone": r["phone"] = max(r["phone"], v)
    r["sources"].append(next(iter(kw)))

for row in csv.DictReader(open(os.path.join(NOTES, "data/aslex_top_frequency.csv"))):
    add(row["gloss"] or row.get("candidate_label_if_unmapped") or row["entry_id"], freq=float(row["frequency"]))

text = open(os.path.join(NOTES, "core_vocabulary_lists.md")).read()
for m in re.finditer(r"^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*(\d)\s*\|", text, re.M):
    for w in re.split(r"\s*[/(]\s*", m.group(1))[:1]:
        add(w, lists=int(m.group(2)))

tier_w = 1.0
for line in open(os.path.join(NOTES, "phone_call_vocabulary.md")):
    if line.startswith("**Tier"):
        t = line.split("—")[0]
        tier_w = 1.0 if "Tier 1 " in t or t.strip().endswith("Tier 1") else 0.8 if ("1b" in t or "Tier 2 " in t) else 0.6 if ("2b" in t or "2c" in t) else 0.4
        continue
    for m in re.finditer(r"(?:^|\s)\d+\.\s+([A-Z][A-Z'\-/]*(?: [A-Z][A-Z'\-]+)?)", line):
        add(m.group(1).split("/")[0], phone=tier_w)

rows = []
for k, r in c.items():
    f = ((r["freq"] - 1) / 6) if r["freq"] else 0.0
    r["score"] = round(0.45 * f + 0.30 * min(r["lists"], 4) / 4 + 0.25 * r["phone"], 4)
    r["key"] = k
    r["model_gloss"] = model.get(k)
    rows.append(r)
rows.sort(key=lambda r: -r["score"])
json.dump(rows, open(OUT, "w"), indent=1)
inm = [r for r in rows if r["model_gloss"]]
print(len(rows), "candidates;", len(inm), "map to a model label;", "not in model (top 40 by score):",
      [r["word"] for r in rows if not r["model_gloss"]][:40])

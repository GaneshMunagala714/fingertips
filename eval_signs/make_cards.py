"""Printable sign cards for the top-200 list: a drawing traced from a real ASL Citizen signer + a QR to a video.

    python eval_signs/make_cards.py INDEX.json CLIPDIR REPORT.md OUT.html

For each sign, pick the clip the model recognizes most confidently, then draw the signer's upper body and
hands at the start (faint), middle and end (solid) of the sign, the dominant wrist's path as an arrow, and
an enlarged handshape. Drawn as seen when facing the signer.
"""
from __future__ import annotations

import html
import io
import json
import os
import re
import sys

import numpy as np
import qrcode
import qrcode.image.svg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "fingertip", "server"))
sys.path.insert(0, os.path.join(ROOT, "fingertip", "model"))
from app.signs.models import SignBartModel, gloss_of  # noqa: E402  (Fingertip, by Shruti)
from validate_aslcitizen import frames_from_pose  # noqa: E402

key = lambda s: re.sub(r"[^A-Z]", "", gloss_of(s.upper()))
HAND = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
        (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
BODY = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16)]


def pick_clip(model, allowed, gloss, paths, clipdir):
    best = None
    for rel in paths:
        p = os.path.join(clipdir, os.path.basename(rel))
        if not os.path.exists(p):
            continue
        try:
            fr = frames_from_pose(p)
        except Exception:
            continue
        sw = [{**f, "lh": f.get("rh"), "rh": f.get("lh")} for f in fr]
        g = max((model.predict(fr, k=1, allowed=allowed), model.predict(sw, k=1, allowed=allowed)), key=lambda x: x[0].p)[0]
        hands = sum(1 for f in fr if f.get("lh") or f.get("rh"))
        score = (key(g.sign) == gloss, g.p, hands)
        if best is None or score > best[0]:
            best = (score, fr)
    return best[1] if best else None


def arr(f, k, n):
    v = f.get(k)
    return np.asarray(v, dtype=float)[:, :2] if v else None


def draw(frames, W=230, H=210):
    hf = [i for i, f in enumerate(frames) if f.get("lh") or f.get("rh")]
    if not hf:
        return "<svg/>", ""
    a, b = hf[0], hf[-1]
    keys = [a + int((b - a) * t) for t in (0.08, 0.5, 0.92)]
    # dominant hand = the one that moves most
    def wrist(f, k):
        h = arr(f, k, 21)
        return h[0] if h is not None else None
    move = {}
    for k in ("lh", "rh"):
        pts = [wrist(frames[i], k) for i in hf]
        pts = [p for p in pts if p is not None]
        move[k] = sum(np.linalg.norm(np.diff(pts, axis=0), axis=1)) if len(pts) > 2 else 0
    dom = max(move, key=move.get)

    # crop box: head + shoulders + all hand points in the sign
    pts = []
    for i in range(a, b + 1):
        for k in ("lh", "rh"):
            h = arr(frames[i], k, 21)
            if h is not None:
                pts.append(h)
        po = arr(frames[i], "pose", 33)
        if po is not None:
            head_r = np.linalg.norm(po[7] - po[8]) * 0.75
            pts.append(np.vstack([po[[0, 7, 8, 11, 12]], po[0] - [0, head_r * 1.15]]))   # include the top of the head
    P = np.concatenate(pts)
    P = P[np.isfinite(P).all(1)]
    lo, hi = np.percentile(P, 1, axis=0), np.percentile(P, 99, axis=0)
    c, span = (lo + hi) / 2, max(hi - lo) * 1.08 + 1e-6
    sx = lambda p: ((p[0] - c[0]) / span + 0.5) * W
    sy = lambda p: ((p[1] - c[1]) / span + 0.5) * H + 4
    out = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg">']

    def line(p, q, col, w, op):
        if np.isfinite(p).all() and np.isfinite(q).all():
            out.append(f'<line x1="{sx(p):.1f}" y1="{sy(p):.1f}" x2="{sx(q):.1f}" y2="{sy(q):.1f}" stroke="{col}" stroke-width="{w}" stroke-linecap="round" opacity="{op}"/>')

    styles = [("#9aa3ad", 0.55), ("#5b6470", 0.75), ("#111", 1.0)]
    for (i, (col, op)) in zip(keys, styles):
        f = frames[i]
        po = arr(f, "pose", 33)
        if po is not None:
            if i == keys[-1]:   # head once, from the last frame
                nose, le, re_ = po[0], po[7], po[8]
                r = max(np.linalg.norm(le - re_) / span * W * 0.62, 8)
                out.append(f'<circle cx="{sx(nose):.1f}" cy="{sy(nose):.1f}" r="{r:.1f}" fill="#fafafa" stroke="#111" stroke-width="2"/>')
                for e in (2, 5):   # eyes
                    out.append(f'<circle cx="{sx(po[e]):.1f}" cy="{sy(po[e]):.1f}" r="1.8" fill="#111"/>')
                out.append(f'<line x1="{sx(po[9]):.1f}" y1="{sy(po[9]):.1f}" x2="{sx(po[10]):.1f}" y2="{sy(po[10]):.1f}" stroke="#111" stroke-width="1.6" stroke-linecap="round"/>')
            for p, q in BODY:
                line(po[p], po[q], col, 3 if i == keys[-1] else 2.2, op)
        for k in ("lh", "rh"):
            h = arr(f, k, 21)
            if h is not None and i != keys[1]:   # hands at start (faint) and end (solid) only
                hc = ("#c2410c" if k == dom else "#1d4ed8") if i == keys[-1] else col
                for p, q in HAND:
                    line(h[p], h[q], hc, 1.8 if i == keys[-1] else 1.3, op)
    # dominant wrist path with arrowhead
    path = [wrist(frames[i], dom) for i in range(a, b + 1)]
    path = [p for p in path if p is not None and np.isfinite(p).all()]
    if len(path) > 3 and move[dom] > 0.04:
        path = path[:: max(1, len(path) // 24)]
        d = " ".join(f"{'M' if j == 0 else 'L'}{sx(p):.1f},{sy(p):.1f}" for j, p in enumerate(path))
        out.append('<defs><marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">'
                   '<path d="M0,0 L10,5 L0,10 z" fill="#c2410c"/></marker></defs>')
        out.append(f'<path d="{d}" fill="none" stroke="#c2410c" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#ah)" opacity="0.9"/>')
    out.append("</svg>")

    # enlarged handshape of the dominant hand at the middle frame
    h = None
    for i in [keys[1], keys[2], keys[0]] + hf:
        h = arr(frames[i], dom, 21)
        if h is None:
            h = arr(frames[i], "rh" if dom == "lh" else "lh", 21)
        if h is not None and np.isfinite(h).all():
            break
    inset = ""
    if h is not None and np.isfinite(h).all():
        lo2, hi2 = h.min(0), h.max(0)
        c2, s2 = (lo2 + hi2) / 2, max(hi2 - lo2) * 1.25 + 1e-6
        fx = lambda p: ((p[0] - c2[0]) / s2 + 0.5) * 70
        fy = lambda p: ((p[1] - c2[1]) / s2 + 0.5) * 70
        seg = "".join(f'<line x1="{fx(h[p]):.1f}" y1="{fy(h[p]):.1f}" x2="{fx(h[q]):.1f}" y2="{fy(h[q]):.1f}" stroke="#c2410c" stroke-width="2.2" stroke-linecap="round"/>' for p, q in HAND)
        tips = "".join(f'<circle cx="{fx(h[t]):.1f}" cy="{fy(h[t]):.1f}" r="2.6" fill="#c2410c"/>' for t in (4, 8, 12, 16, 20))
        inset = f'<svg viewBox="0 0 70 70" xmlns="http://www.w3.org/2000/svg">{seg}{tips}</svg>'
    return "".join(out), inset


def qr_svg(url):
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=4, border=1)
    buf = io.BytesIO()
    img.save(buf)
    s = buf.getvalue().decode()
    return s[s.index("<svg"):]


def main():
    index_path, clipdir, report, out = sys.argv[1:5]
    data = json.load(open(os.path.join(ROOT, "server", "data", "asl_top200.json")))
    signs = {s["gloss"]: s for s in data["signs"]}
    # categories from the report's tables
    cats, cur = [], None
    for line in open(report):
        m = re.match(r"^### (.+?) \(", line)
        if m:
            cur = (m.group(1), []); cats.append(cur); continue
        m = re.match(r"^\|\s*\d+\s*\|[^|]*\|\s*([^|]+?)\s*\|", line)
        if m and cur and m.group(1) in signs:
            cur[1].append(m.group(1))
    placed = {g for _, gs in cats for g in gs}
    rest = [g for g in signs if g not in placed]
    if rest:
        cats.append(("Other", rest))

    index = json.load(open(index_path))
    by = {}
    for name, paths in index.items():
        by.setdefault(key(name), []).extend(paths)
    model = SignBartModel()
    allowed = {gloss_of(l) for l in model.labels if key(l) in {key(g) for g in signs}}

    cards = []
    for cat, gs in cats:
        cards.append(f'<h2 class="cat">{html.escape(cat)} <span>({len(gs)})</span></h2><div class="grid">')
        for g in gs:
            s = signs[g]
            fr = pick_clip(model, allowed, key(g), sorted(by.get(key(g), []))[:8], clipdir)
            body, inset = draw(fr) if fr else ("<div class='nodraw'>no drawing</div>", "")
            word = s["word"]
            url = "https://www.signingsavvy.com/search/" + re.sub(r"[^a-z]+", "%20", word.lower().replace("'", "")).strip("%20")
            acc = s["correct_within_200"]
            cards.append(f'''<div class="card"><div class="top"><b>{html.escape(word)}</b><span class="acc" title="recognized on {acc} of 8 test signers">{acc}/8</span></div>
<div class="fig">{body}</div>
<div class="bot"><div class="qr">{qr_svg(url)}</div><div class="inset" title="main handshape">{inset}</div><div class="gl">{html.escape(g)}<br><span>scan for video</span></div></div></div>''')
        cards.append("</div>")
    m = data["measured"]
    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TalkBridge ASL Top 200</title><style>
@page {{ size: letter; margin: 0.4in; }}
* {{ box-sizing: border-box; }}
body {{ font: 11px/1.3 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }}
.cover {{ page-break-after: always; padding: 0.3in 0.2in; }}
.cover h1 {{ font-size: 30px; margin: 0 0 6px; letter-spacing: -0.02em; }}
.cover p, .cover li {{ font-size: 13px; max-width: 7in; }}
.legend {{ display: flex; gap: 18px; align-items: center; margin: 14px 0; font-size: 12px; }}
.sw {{ display: inline-block; width: 22px; height: 4px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }}
h2.cat {{ font-size: 15px; margin: 10px 0 6px; break-after: avoid; }} h2.cat span {{ color: #777; font-weight: 400; }}
.grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }}
.card {{ border: 1px solid #bbb; border-radius: 8px; padding: 5px 6px 4px; break-inside: avoid; height: 2.05in; display: flex; flex-direction: column; }}
.top {{ display: flex; justify-content: space-between; align-items: baseline; }}
.top b {{ font-size: 15px; letter-spacing: -0.01em; }}
.acc {{ font-size: 9px; color: #555; border: 1px solid #ccc; border-radius: 6px; padding: 0 4px; }}
.fig {{ position: relative; flex: 1; min-height: 0; }}
.fig > svg {{ width: 100%; height: 100%; }}
.inset {{ width: 0.5in; height: 0.5in; border: 1px solid #e3b9a4; border-radius: 6px; background: #fff; flex: none; }}
.inset svg {{ width: 100%; height: 100%; }}
.bot {{ display: flex; gap: 6px; align-items: center; }}
.qr svg {{ width: 0.5in; height: 0.5in; display: block; }}
.gl {{ font-size: 8px; color: #666; line-height: 1.25; }} .gl span {{ color: #999; }}
</style></head><body>
<section class="cover">
<h1>TalkBridge: 200 ASL signs you can use on a call</h1>
<p>Call the TalkBridge number, and when the call connects, sign one word at a time with a short pause between signs.
Each recognized sign is added to the reply; drop your hands and TalkBridge turns the words into a sentence that is spoken to the caller after one tap.</p>
<div class="legend"><span><i class="sw" style="background:#9aa3ad"></i>start</span><span><i class="sw" style="background:#5b6470"></i>middle</span>
<span><i class="sw" style="background:#111"></i>end (body)</span><span><i class="sw" style="background:#c2410c"></i>main hand + its path</span><span><i class="sw" style="background:#1d4ed8"></i>other hand</span></div>
<ul>
<li>Each drawing is traced from a real Deaf signer in the ASL Citizen dataset, as you see them when facing them: faint = where the hands start, solid = where they end, dashed arrow = the path of the main hand. The small box next to the QR code shows the main handshape enlarged.</li>
<li>Drawings are stick figures and can't show everything (palm direction, facial expression). Scan the QR code for a video of the sign.</li>
<li>The number on each card is how many of 8 test signers the model recognized it for ({m["correct_within_200"]} of {m["clips"]} clips overall, {round(100*m["accuracy_within_200"])}%). Those clips may overlap the model's training data, so live accuracy will be lower.</li>
<li>Numbers you can sign: zero, one, three, six, seven, eight, nine, eleven, hundred. For two, four, five, ten and other numbers, type them in the reply box.</li>
</ul>
<p style="color:#555">Signs chosen from ASL-LEX 2.0 frequency ratings, six published core-vocabulary lists and phone-call vocabulary research.
Recognition model: SignBart-ASL-2730 (trained on ASL Citizen), with preprocessing from Fingertip by Shruti. Drawings: ASL Citizen poses (Microsoft Research). Videos: Signing Savvy.</p>
</section>
{"".join(cards)}
</body></html>'''
    open(out, "w").write(page)
    print("wrote", out)


if __name__ == "__main__":
    main()

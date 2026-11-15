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


PALM = [0, 1, 5, 9, 13, 17]
FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]
DOM, OTHER = "#c2410c", "#1d4ed8"


def _wrist(f, k):
    h = arr(f, k, 21)
    return h[0] if h is not None and np.isfinite(h[0]).all() else None


def describe(frames, hf, dom, move, sw):
    """One plain line from the signer's own motion: hands, where, how it moves."""
    other = "lh" if dom == "rh" else "rh"
    both = sum(1 for i in hf if arr(frames[i], other, 21) is not None) > 0.5 * len(hf) and move[other] > 0.25 * sw
    mid = hf[len(hf) // 2]
    po, w = arr(frames[mid], "pose", 33), _wrist(frames[mid], dom)
    where = ""
    if po is not None and w is not None:
        nose_y, sh_y = po[0][1], (po[11][1] + po[12][1]) / 2
        hand = arr(frames[mid], dom, 21)
        y = np.nanmean(hand[:, 1]) if hand is not None else w[1]
        where = ("by the forehead" if y < nose_y - 0.35 * sw else "by the face" if y < nose_y + 0.2 * sw
                 else "at the chin / neck" if y < sh_y else "at the chest" if y < sh_y + 0.75 * sw else "low, at the waist")
    path = [p for p in (_wrist(frames[i], dom) for i in hf) if p is not None]
    how = "hold it still"
    if len(path) > 3:
        net = path[-1] - path[0]
        total = float(np.sum(np.linalg.norm(np.diff(path, axis=0), axis=1)))
        n = float(np.linalg.norm(net))
        if total < 0.25 * sw:
            how = "hold it still"
        elif n < 0.3 * total:
            P = np.asarray(path); ext = P.max(0) - P.min(0)
            how = "small circles" if min(ext) > 0.45 * max(ext) else "repeat the movement (tap / shake)"
        else:
            dx, dy = net
            how = ("move up" if dy < 0 else "move down") if abs(dy) > 1.6 * abs(dx) else "move sideways" if abs(dx) > 1.6 * abs(dy) \
                else ("move up and sideways" if dy < 0 else "move down and sideways")
    # movement words (`how`) are left out: the clip includes the hands rising and dropping, which made them unreliable;
    # the three panels show the movement instead
    hands = "Two hands" if both else "One hand"
    return f"{hands}, {where}." if where else f"{hands}."


def draw(frames, PW=120, H=130):
    """Three panels, Start -> Move -> End, from one real signer. Returns (svg, description)."""
    hf = [i for i, f in enumerate(frames) if f.get("lh") or f.get("rh")]
    if not hf:
        return "<svg/>", ""
    a, b = hf[0], hf[-1]
    move = {}
    for k in ("lh", "rh"):
        pts = [p for p in (_wrist(frames[i], k) for i in hf) if p is not None]
        move[k] = float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1))) if len(pts) > 2 else 0.0
    dom = max(move, key=move.get)
    # start / end: first and last frames where the main hand is up; middle halfway
    dh = [i for i in hf if arr(frames[i], dom, 21) is not None] or hf
    keys = [dh[min(len(dh) - 1, int(len(dh) * 0.1))], dh[len(dh) // 2], dh[max(0, int(len(dh) * 0.9) - 1)]]

    pts, sws = [], []
    for i in range(a, b + 1):
        for k in ("lh", "rh"):
            h = arr(frames[i], k, 21)
            if h is not None:
                pts.append(h)
        po = arr(frames[i], "pose", 33)
        if po is not None:
            sw = np.linalg.norm(po[11] - po[12]); sws.append(sw)
            pts.append(np.vstack([po[[0, 11, 12]], po[0] - [0, sw * 0.45], (po[11] + po[12]) / 2 + [0, sw * 0.5]]))
    P = np.concatenate(pts); P = P[np.isfinite(P).all(1)]
    sw = float(np.median(sws)) if sws else 0.2
    lo, hi = np.percentile(P, 1, axis=0), np.percentile(P, 99, axis=0)
    c = (lo + hi) / 2
    span = max((hi - lo)[0] * H / PW, (hi - lo)[1]) * 1.1 + 1e-6
    W = PW * 3 + 2 * 22
    out = [f'<svg viewBox="0 0 {W} {H + 16}" xmlns="http://www.w3.org/2000/svg">',
           f'<defs><marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{DOM}"/></marker></defs>']

    def panel(j, i, label):
        ox = j * (PW + 22)
        X = lambda p: ox + ((p[0] - c[0]) / span) * H + PW / 2
        Y = lambda p: ((p[1] - c[1]) / span + 0.5) * H
        ok = lambda p: p is not None and np.isfinite(p).all()
        L = lambda p, q, col, w, op=1: out.append(f'<line x1="{X(p):.1f}" y1="{Y(p):.1f}" x2="{X(q):.1f}" y2="{Y(q):.1f}" stroke="{col}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" opacity="{op}"/>') if ok(p) and ok(q) else None
        out.append(f'<rect x="{ox + 0.5}" y="0.5" width="{PW - 1}" height="{H - 1}" rx="8" fill="#f6f6f4" stroke="#ddd"/>')
        out.append(f'<clipPath id="c{j}"><rect x="{ox}" y="0" width="{PW}" height="{H}" rx="8"/></clipPath><g clip-path="url(#c{j})">')
        f = frames[i]
        po = arr(f, "pose", 33)
        if po is not None:
            r = max(sw / span * H * 0.42, 9)
            out.append(f'<circle cx="{X(po[0]):.1f}" cy="{Y(po[0]):.1f}" r="{r:.1f}" fill="#fff" stroke="#9aa0a6" stroke-width="2"/>')
            for e in (2, 5):
                out.append(f'<circle cx="{X(po[e]):.1f}" cy="{Y(po[e]):.1f}" r="1.6" fill="#666"/>')
            L(po[11], po[12], "#9aa0a6", 5)
            for p, q in ((11, 13), (13, 15), (12, 14), (14, 16)):
                L(po[p], po[q], "#b5bac0", 5)
        if j == 1:   # the main hand's whole path, on the middle panel
            path = [p for p in (_wrist(frames[t], dom) for t in range(a, b + 1)) if p is not None]
            if len(path) > 3 and move[dom] > 0.25 * sw:
                path = path[:: max(1, len(path) // 24)]
                d = " ".join(f"{'M' if n == 0 else 'L'}{X(p):.1f},{Y(p):.1f}" for n, p in enumerate(path))
                out.append(f'<path d="{d}" fill="none" stroke="{DOM}" stroke-width="2.4" stroke-dasharray="5 3" marker-end="url(#ah)" opacity="0.85"/>')
        for k in (("rh", "lh") if dom == "lh" else ("lh", "rh")):   # main hand drawn last, on top
            h = arr(f, k, 21)
            if h is None or not np.isfinite(h).all():
                continue
            col = DOM if k == dom else OTHER
            poly = " ".join(f"{X(h[t]):.1f},{Y(h[t]):.1f}" for t in PALM)
            out.append(f'<polygon points="{poly}" fill="{col}" fill-opacity="0.28" stroke="{col}" stroke-width="2" stroke-linejoin="round"/>')
            for fg in FINGERS:
                pts_ = [h[t] for t in fg]
                d = " ".join(f"{'M' if n == 0 else 'L'}{X(p):.1f},{Y(p):.1f}" for n, p in enumerate(pts_))
                out.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>')
        out.append("</g>")
        out.append(f'<text x="{ox + PW / 2}" y="{H + 12}" text-anchor="middle" font-size="10" fill="#555" font-family="-apple-system,Helvetica,Arial">{label}</text>')
        if j < 2:
            ax = ox + PW + 4
            out.append(f'<path d="M{ax},{H / 2} L{ax + 13},{H / 2}" stroke="#888" stroke-width="2" marker-end="url(#ar)"/>')

    out.append('<defs><marker id="ar" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#888"/></marker></defs>')
    for j, (i, label) in enumerate(zip(keys, ("1  Start", "2  Move", "3  End"))):
        panel(j, i, label)
    out.append("</svg>")
    return "".join(out), describe(frames, hf, dom, move, sw)


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
            body, desc = draw(fr) if fr else ("<div class='nodraw'>no drawing</div>", "")
            word = s["word"]
            url = "https://www.signingsavvy.com/search/" + re.sub(r"[^a-z]+", "%20", word.lower().replace("'", "")).strip("%20")
            acc = s["correct_within_200"]
            cards.append(f'''<div class="card"><div class="fig">{body}</div>
<div class="bot"><div class="txt"><div class="top"><b>{html.escape(word)}</b><span class="acc" title="recognized on {acc} of 8 test signers">recognized {acc}/8</span></div>
<div class="desc">{html.escape(desc)}</div></div><div class="qr">{qr_svg(url)}<span>video</span></div></div></div>''')
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
.grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }}
.card {{ border: 1px solid #ccc; border-radius: 10px; padding: 7px 8px 6px; break-inside: avoid; display: flex; flex-direction: column; gap: 4px; }}
.fig > svg {{ width: 100%; height: auto; display: block; }}
.bot {{ display: flex; gap: 8px; align-items: center; }}
.txt {{ flex: 1; min-width: 0; }}
.top {{ display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }}
.top b {{ font-size: 17px; letter-spacing: -0.01em; }}
.acc {{ font-size: 8.5px; color: #666; white-space: nowrap; }}
.desc {{ font-size: 11px; color: #333; margin-top: 2px; }}
.qr {{ text-align: center; font-size: 7.5px; color: #888; }}
.qr svg {{ width: 0.55in; height: 0.55in; display: block; }}
</style></head><body>
<section class="cover">
<h1>TalkBridge: 200 ASL signs you can use on a call</h1>
<p>Call the TalkBridge number, and when the call connects, sign one word at a time with a short pause between signs.
Each recognized sign is added to the reply; drop your hands and TalkBridge turns the words into a sentence that is spoken to the caller after one tap.</p>
<h3 style="margin:18px 0 6px">How to read a card</h3>
<ul>
<li><b>Read left to right: 1 Start &rarr; 2 Move &rarr; 3 End.</b> Each card shows one real Deaf signer from the ASL Citizen dataset at three moments of the sign.</li>
<li><b style="color:#c2410c">Orange hand</b> = the main hand (the one that moves). <b style="color:#1d4ed8">Blue hand</b> = the other hand, if the sign uses two. The dashed orange arrow in the middle picture is the path the main hand takes.</li>
<li>You are looking <b>at</b> the signer, like on a video call, so their right hand is on your left. Copy them as if they were a mirror.</li>
<li>The line under the word (one or two hands, where) is measured from the signer's motion. It is a hint: drawings can't show palm direction or facial expression. <b>Scan the QR code to watch the sign.</b></li>
<li>"Recognized 7/8" = TalkBridge recognized this sign for 7 of 8 test signers ({m["correct_within_200"]} of {m["clips"]} clips overall, {round(100*m["accuracy_within_200"])}%). Those clips may overlap the model's training data, so live accuracy will be lower.</li>
<li>Numbers you can sign: zero, one, three, six, seven, eight, nine, eleven, hundred. Type other numbers in the reply box.</li>
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

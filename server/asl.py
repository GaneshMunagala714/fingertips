"""ASL word recognition for TalkBridge calls.

The model and its exact preprocessing come from Fingertip by Shruti (fingertip/server/app/signs/models.py,
used with permission): SignBart-ASL-2730, trained on ASL Citizen, 2,730 isolated ASL signs.
The browser sends one sign at a time (MediaPipe pose + hand landmarks); this returns the top guesses.

vocab="everyday": the 59 signs Fingertip measured on real signers (fingertip/model/vocab.json), most accurate.
vocab="all": all 2,730 signs, lower accuracy, so more answers come back "unsure" with choices.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "fingertip" / "server"))

log = logging.getLogger("talkbridge.asl")
router = APIRouter()

UNSURE_P = {"everyday": 0.45, "top200": 0.40, "all": 0.30}
TOP200_FILE = ROOT / "server" / "data" / "asl_top200.json"   # eval_signs/: research + measured on ASL Citizen clips
UNSURE_MARGIN = 0.12
MAX_FRAMES = 240
DEBUG_DIR = ROOT / "logs" / "asl"      # every sign the browser sends + what the model said (for tuning)

_model = None
_everyday: set[str] = set()
_top200: list[dict] = []
_error = ""
_lock = threading.Lock()


def load() -> None:
    global _model, _everyday, _top200, _error
    if _model or _error:
        return
    try:
        from app.signs.models import MODEL_DIR, SignBartModel  # Fingertip (Shruti)
        _model = SignBartModel()
        _everyday = set(json.load(open(Path(MODEL_DIR) / "vocab.json"))["active"])
        if TOP200_FILE.exists():
            _top200 = json.load(open(TOP200_FILE))["signs"]
        log.info("ASL model ready: %s, %d signs (%d everyday)", _model.name, len(_model.labels), len(_everyday))
    except Exception as e:  # calls still work by typing and quick replies
        _error = f"ASL model not loaded: {e}"
        log.warning(_error)


def word(gloss: str) -> str:
    """'THANK-YOU' -> 'thank you', 'W.H.A.T' -> 'what', 'DONTKNOW' -> "don't know" (top-200 list spells phrases out)."""
    for s in _top200:
        if s["gloss"] == gloss:
            return s["word"]
    return gloss.replace(".", "").replace("-", " ").lower()


def classify(frames: list[dict], vocab: str = "all") -> dict:
    load()
    if not _model:
        return {"ok": False, "reason": _error or "ASL model unavailable"}
    if len(frames) < 6:
        return {"ok": False, "reason": "too short"}
    allowed = _everyday if vocab == "everyday" else {s["gloss"] for s in _top200} if vocab == "top200" and _top200 else None
    t0 = time.perf_counter()
    swapped = [{**f, "lh": f.get("rh"), "rh": f.get("lh")} for f in frames]
    with _lock:   # signer's dominant hand unknown: try both hand orders, keep the more confident
        guesses = max((_model.predict(frames, k=5, allowed=allowed), _model.predict(swapped, k=5, allowed=allowed)),
                      key=lambda g: g[0].p)
    top = guesses[0]
    second = guesses[1] if len(guesses) > 1 else None
    unsure = top.p < UNSURE_P.get(vocab, 0.3) or (second is not None and top.p - second.p < UNSURE_MARGIN)
    return {"ok": True, "sign": top.sign, "word": word(top.sign), "p": round(top.p, 3), "unsure": unsure,
            "choices": [{"sign": g.sign, "word": word(g.sign), "p": round(g.p, 3)} for g in guesses[:3]],
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


class ClassifyIn(BaseModel):
    frames: list[dict] = Field(default_factory=list)
    vocab: str = "all"
    why: str = ""
    fps: float = 0
    handFrames: int = 0


def _debug_save(body: ClassifyIn, out: dict) -> None:
    try:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        name = time.strftime("%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}-{out.get('sign', 'none')}"
        (DEBUG_DIR / f"{name}.json").write_text(json.dumps({"meta": body.model_dump(exclude={"frames"}), "out": out, "frames": body.frames}))
    except Exception as e:
        log.warning("asl debug save failed: %s", e)


@router.post("/api/asl/classify")
async def asl_classify(body: ClassifyIn) -> dict:
    if body.vocab not in ("all", "everyday", "top200"):
        raise HTTPException(400, "vocab must be 'all', 'top200' or 'everyday'")
    out = await asyncio.to_thread(classify, body.frames[:MAX_FRAMES], body.vocab)
    log.info("asl sign: %s frames (%s with hands, %s fps, end=%s) -> %s", len(body.frames), body.handFrames, body.fps, body.why,
             " | ".join(f"{c['word']} {c['p']:.2f}" for c in out.get("choices", [])) or out.get("reason"))
    _debug_save(body, out)
    return out


@router.get("/api/asl/info")
async def asl_info() -> dict:
    await asyncio.to_thread(load)
    return {"ready": _model is not None, "error": _error, "model": getattr(_model, "name", None),
            "signs": len(_model.labels) if _model else 0, "everyday": sorted(_everyday), "top200": [s["gloss"] for s in _top200],
            "credit": "SignBart-ASL-2730 (ASL Citizen) via Fingertip by Shruti"}

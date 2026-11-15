"""Signing outside phone calls: Fingertips video calls (/v/<room>) and the Google Meet extension.

Both turn signed (or typed) words into a sentence, then into speech that the other side hears:
  * /api/sentence  words -> sentence options (Gemini, with the same rules fallback as calls)
  * /api/tts       sentence -> WAV (Gemini speech). The video page / Meet extension mixes it into your mic.
  * /v/<room>      no-install 1:1 video call; WebSocket signaling relay + captions both ways
  * /sign          the signing window the Meet extension opens

Room signaling is adapted from Fingertip by Shruti (fingertip/server/app/rooms.py), used with permission.
"""
from __future__ import annotations

import base64
import os
import secrets
import time
from collections import OrderedDict, deque
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import ai

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
router = APIRouter()

TTS_MODEL = os.getenv("GEMINI_TTS_MODEL", "gemini-3.8-flash-lite-tts")
TTS_VOICE = os.getenv("GEMINI_TTS_VOICE", "Kore")
_tts_cache: OrderedDict[str, bytes] = OrderedDict()
_tts_hits: deque[float] = deque()
TTS_PER_MIN = 40


def public_url(request: Request) -> str:
    return os.getenv("PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip("/")


# ---------------------------------------------------------------- sentence + speech

class SentenceIn(BaseModel):
    words: str
    heard: str = ""          # what the other person last said, for context


@router.post("/api/sentence")
async def sentence(body: SentenceIn) -> dict:
    return await ai.suggest(body.heard[:300], body.words[:200], [])


class TtsIn(BaseModel):
    text: str


@router.post("/api/tts")
async def tts(body: TtsIn) -> Response:
    """Sentence -> WAV. Used where Twilio isn't there to speak: video calls and Google Meet."""
    text = body.text.strip()[:400]
    if not text:
        raise HTTPException(400, "empty text")
    if text in _tts_cache:
        _tts_cache.move_to_end(text)
        return Response(_tts_cache[text], media_type="audio/wav")
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        raise HTTPException(503, "Voice needs GEMINI_API_KEY on the server")
    now = time.time()
    while _tts_hits and now - _tts_hits[0] > 60:
        _tts_hits.popleft()
    if len(_tts_hits) >= TTS_PER_MIN:
        raise HTTPException(429, "Too many voice requests, wait a moment")
    _tts_hits.append(now)
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            r = await client.post(
                "https://generativelanguage.googleapis.com/v1beta/interactions",
                headers={"x-goog-api-key": key},
                json={"model": TTS_MODEL, "input": [{"type": "user_input", "content": [{"type": "text", "text": text}]}],
                      "response_format": {"type": "audio"},
                      "generation_config": {"speech_config": [{"voice": TTS_VOICE}]}})
            r.raise_for_status()
        parts = [c for st in r.json().get("steps", []) if st.get("type") == "model_output"
                 for c in st.get("content", []) if c.get("type") == "audio"]
        audio = base64.b64decode(parts[-1]["data"])
    except Exception as e:
        raise HTTPException(502, f"Voice failed: {e}") from e
    _tts_cache[text] = audio
    while len(_tts_cache) > 64:
        _tts_cache.popitem(last=False)
    return Response(audio, media_type="audio/wav")


# ---------------------------------------------------------------- pages

@router.get("/talkbridge-meet.zip")
async def extension_zip() -> Response:
    """The Google Meet extension, zipped from extension/ (load it unpacked in chrome://extensions)."""
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((ROOT / "extension").iterdir()):
            if f.is_file():
                z.write(f, f"talkbridge-meet/{f.name}")
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="talkbridge-meet.zip"'})


@router.get("/sign")
async def sign_page() -> FileResponse:
    return FileResponse(WEB / "sign" / "index.html", headers={"Cache-Control": "no-cache"})


@router.get("/v/{room}")
async def room_page(room: str) -> FileResponse:
    return FileResponse(WEB / "video" / "index.html", headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------- video rooms (signaling relay)

MAX_PEERS = 2
_rooms: dict[str, list[WebSocket]] = {}
_cid: dict[int, str] = {}
_replaced: set[int] = set()


@router.post("/api/rooms")
async def create_room(request: Request) -> dict:
    room = secrets.token_urlsafe(6)
    base = public_url(request)
    return {"room": room, "join_url": f"{base}/v/{room}", "host_url": f"/v/{room}?host=1"}


@router.get("/api/rooms/ice")
async def ice_servers() -> list[dict]:
    servers: list[dict] = [{"urls": "stun:stun.l.google.com:19302"}]
    if os.getenv("TURN_URL"):
        servers.append({"urls": os.environ["TURN_URL"], "username": os.getenv("TURN_USERNAME", ""),
                        "credential": os.getenv("TURN_CREDENTIAL", "")})
    return servers


ALLOWED = {"offer", "answer", "candidate", "caption", "state", "bye"}


@router.websocket("/ws/room/{room}")
async def room_ws(ws: WebSocket, room: str, cid: str = "") -> None:
    await ws.accept()
    room = room[:32]
    peers = _rooms.setdefault(room, [])
    cid = cid[:64]
    if cid:   # the same tab reconnecting replaces its stale socket
        for old in [o for o in peers if _cid.get(id(o)) == cid]:
            peers.remove(old); _replaced.add(id(old))
            try:
                await old.close()
            except Exception:
                pass
    if len(peers) >= MAX_PEERS:
        await ws.send_json({"type": "full"})
        await ws.close()
        return
    others = list(peers)
    peers.append(ws)
    if cid:
        _cid[id(ws)] = cid
    await ws.send_json({"type": "joined", "polite": bool(others)})
    for o in others:
        try:
            await o.send_json({"type": "peer-joined"})
        except Exception:
            pass
    sent: deque[float] = deque()
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict) or msg.get("type") not in ALLOWED:
                continue
            now = time.time()
            while sent and now - sent[0] > 1:
                sent.popleft()
            if len(sent) > 50:
                continue
            sent.append(now)
            if msg["type"] == "caption":
                msg = {"type": "caption", "text": str(msg.get("text", ""))[:400], "final": bool(msg.get("final", True)),
                       "from": "host" if msg.get("from") == "host" else "guest", "src": str(msg.get("src", ""))[:10]}
            for o in list(_rooms.get(room, [])):
                if o is not ws:
                    try:
                        await o.send_json(msg)
                    except Exception:
                        pass
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        _cid.pop(id(ws), None)
        if id(ws) in _replaced:
            _replaced.discard(id(ws))
        else:
            lst = _rooms.get(room, [])
            if ws in lst:
                lst.remove(ws)
            for o in list(lst):
                try:
                    await o.send_json({"type": "peer-left"})
                except Exception:
                    pass
            if not lst:
                _rooms.pop(room, None)

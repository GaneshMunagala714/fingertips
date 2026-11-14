"""JAM rooms: relay validated musical events between players. No audio or video goes through here,
only small structured events; each browser synthesizes the sound locally."""
from __future__ import annotations

import json
import math
import re
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

ROOM_RE = re.compile(r"^[a-z0-9]{4,12}$")
SLOTS = ("p1", "p2", "p3", "p4")
MAX_MSG = 2048
RATE = 60.0          # sustained messages / second per player
BURST = 120.0
EVENT_TYPES = {"chord", "chordOff", "noteOn", "noteOff", "drum", "expr", "allOff"}
INSTRUMENTS = {"piano", "strings", "bells", "pad", "drums"}
DRUMS = {"kick", "snare", "hat"}
CHORD_NAME = re.compile(r"^[A-G][#b]?[a-z0-9°]{0,6}$")
DEFAULT_ROLE = {"p1": ("Harmony", "pad"), "p2": ("Melody", "bells"), "p3": ("Rhythm", "drums"), "p4": ("Melody", "piano")}


def now_ms() -> float:
    return time.time() * 1000.0


class Player:
    def __init__(self, ws: WebSocket, slot: str) -> None:
        self.ws = ws
        self.slot = slot
        self.role, self.instrument = DEFAULT_ROLE[slot]
        self.tokens = BURST
        self.last = time.monotonic()
        self.dropped = 0

    def allow(self) -> bool:
        t = time.monotonic()
        self.tokens = min(BURST, self.tokens + (t - self.last) * RATE)
        self.last = t
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        self.dropped += 1
        return False

    def info(self) -> dict:
        return {"id": self.slot, "role": self.role, "instrument": self.instrument}


class Room:
    def __init__(self, code: str) -> None:
        self.code = code
        self.players: dict[str, Player] = {}
        self.transport = {"playing": False, "tempo": 96, "startAt": 0.0}

    def free_slot(self, want: str | None) -> str | None:
        if want in SLOTS and want not in self.players:
            return want
        return next((s for s in SLOTS if s not in self.players), None)

    async def send(self, p: Player, msg: dict) -> None:
        try:
            await p.ws.send_text(json.dumps(msg))
        except Exception:
            pass

    async def broadcast(self, msg: dict, skip: str | None = None) -> None:
        for slot, p in list(self.players.items()):
            if slot != skip:
                await self.send(p, msg)


rooms: dict[str, Room] = {}


def _num(v: Any, lo: float, hi: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError("bad number")
    if v < lo or v > hi:
        raise ValueError("out of range")
    return float(v)


def _midi(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 127:
        raise ValueError("bad midi")
    return v


def clean_event(ev: Any) -> dict:
    """Whitelist fields and check ranges. Raises ValueError on anything unexpected."""
    if not isinstance(ev, dict):
        raise ValueError("event must be an object")
    t = ev.get("type")
    if t not in EVENT_TYPES:
        raise ValueError("unknown event type")
    out: dict[str, Any] = {"type": t}
    eid = ev.get("id")
    if not isinstance(eid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", eid):
        raise ValueError("bad id")
    out["id"] = eid
    out["t"] = _num(ev.get("t"), 0, 1e14)
    inst = ev.get("instrument", "piano")
    if inst not in INSTRUMENTS:
        raise ValueError("bad instrument")
    out["instrument"] = inst
    if "velocity" in ev:
        out["velocity"] = _num(ev["velocity"], 0, 1)
    if t == "chord":
        notes = ev.get("notes")
        if not isinstance(notes, list) or not 1 <= len(notes) <= 6:
            raise ValueError("bad notes")
        out["notes"] = [_midi(n) for n in notes]
        name = ev.get("chord")
        if not isinstance(name, str) or not CHORD_NAME.match(name):
            raise ValueError("bad chord name")
        out["chord"] = name
        if "degree" in ev:
            out["degree"] = int(_num(ev["degree"], 1, 7))
    elif t in ("noteOn", "noteOff"):
        out["midi"] = _midi(ev.get("midi"))
    elif t == "drum":
        if ev.get("drum") not in DRUMS:
            raise ValueError("bad drum")
        out["drum"] = ev["drum"]
    elif t == "expr":
        for k in ("volume", "filter"):
            if k in ev:
                out[k] = _num(ev[k], 0, 1)
    if "dur" in ev:
        out["dur"] = _num(ev["dur"], 0, 30000)
    return out


@router.websocket("/jam/ws/{code}")
async def jam_ws(ws: WebSocket, code: str) -> None:
    code = code.lower()
    await ws.accept()
    if not ROOM_RE.match(code):
        await ws.send_text(json.dumps({"type": "error", "error": "bad room code"}))
        await ws.close(code=4400)
        return
    room = rooms.setdefault(code, Room(code))
    slot = room.free_slot(ws.query_params.get("slot"))
    if slot is None:
        await ws.send_text(json.dumps({"type": "error", "error": "room is full"}))
        await ws.close(code=4409)
        return
    me = Player(ws, slot)
    room.players[slot] = me
    await room.send(me, {"type": "welcome", "you": slot, "room": code, "serverTime": now_ms(),
                         "players": [p.info() for p in room.players.values()], "transport": room.transport})
    await room.broadcast({"type": "join", "player": me.info()}, skip=slot)
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_MSG:
                await room.send(me, {"type": "error", "error": "message too large"})
                continue
            if not me.allow():
                if me.dropped % 50 == 1:
                    await room.send(me, {"type": "error", "error": "rate limited"})
                continue
            try:
                msg = json.loads(raw)
                kind = msg.get("type")
            except Exception:
                await room.send(me, {"type": "error", "error": "bad json"})
                continue
            if kind == "ping":
                await room.send(me, {"type": "pong", "c": msg.get("c"), "s": now_ms()})
            elif kind == "ev":
                try:
                    ev = clean_event(msg.get("ev"))
                except (ValueError, TypeError) as e:
                    await room.send(me, {"type": "error", "error": f"rejected event: {e}"})
                    continue
                ev["playerId"] = slot
                ev["st"] = now_ms()
                await room.broadcast({"type": "ev", "ev": ev}, skip=slot)
            elif kind == "transport":
                try:
                    tempo = int(_num(msg.get("tempo", room.transport["tempo"]), 40, 200))
                except ValueError:
                    continue
                playing = bool(msg.get("playing"))
                # start slightly in the future so every client can line up on the same downbeat
                room.transport = {"playing": playing, "tempo": tempo, "startAt": now_ms() + 300 if playing else 0.0}
                await room.broadcast({"type": "transport", "transport": room.transport, "by": slot})
            elif kind == "role":
                inst = msg.get("instrument")
                role = msg.get("role")
                if inst in INSTRUMENTS:
                    me.instrument = inst
                if role in ("Harmony", "Melody", "Rhythm"):
                    me.role = role
                await room.broadcast({"type": "role", "player": me.info()})
    except WebSocketDisconnect:
        pass
    finally:
        if room.players.get(slot) is me:
            del room.players[slot]
        await room.broadcast({"type": "leave", "id": slot})
        if not room.players:
            rooms.pop(code, None)

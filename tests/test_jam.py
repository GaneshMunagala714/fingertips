"""JAM room relay: real WebSocket round trips through the FastAPI app (in-process, no network)."""
import importlib
import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def c(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    import server.main as m
    importlib.reload(m)
    m.jam.rooms.clear()
    return TestClient(m.app)


def recv(ws):
    return json.loads(ws.receive_text())


CHORD = {"type": "chord", "id": "e1", "t": 1.7e12, "instrument": "pad", "notes": [60, 64, 67],
         "chord": "C", "velocity": 0.8, "degree": 1}


def test_jam_page_served(c):
    r = c.get("/jam")
    assert r.status_code == 200 and "JAM" in r.text


def test_two_players_share_events(c):
    with c.websocket_connect("/jam/ws/room42") as a:
        wa = recv(a)
        assert wa["type"] == "welcome" and wa["you"] == "p1"
        with c.websocket_connect("/jam/ws/room42") as b:
            wb = recv(b)
            assert wb["you"] == "p2" and len(wb["players"]) == 2
            assert recv(a) == {"type": "join", "player": {"id": "p2", "role": "Melody", "instrument": "bells"}}
            a.send_text(json.dumps({"type": "ev", "ev": CHORD}))
            got = recv(b)
            assert got["type"] == "ev"
            ev = got["ev"]
            assert ev["playerId"] == "p1" and ev["notes"] == [60, 64, 67] and ev["chord"] == "C"
            assert "st" in ev
            # and back the other way
            b.send_text(json.dumps({"type": "ev", "ev": {"type": "noteOn", "id": "n1", "t": 1.7e12,
                                                         "instrument": "bells", "midi": 72, "velocity": 0.5}}))
            ev2 = recv(a)["ev"]
            assert ev2["playerId"] == "p2" and ev2["midi"] == 72
        assert recv(a) == {"type": "leave", "id": "p2"}


def test_player_cannot_spoof_id_and_bad_events_rejected(c):
    with c.websocket_connect("/jam/ws/abcd") as a, c.websocket_connect("/jam/ws/abcd") as b:
        recv(a); recv(b); recv(a)  # welcome, welcome, join
        a.send_text(json.dumps({"type": "ev", "ev": {**CHORD, "playerId": "p2", "evil": "<script>"}}))
        ev = recv(b)["ev"]
        assert ev["playerId"] == "p1" and "evil" not in ev
        for bad in ({**CHORD, "notes": [60, 999]}, {**CHORD, "type": "explode"},
                    {**CHORD, "velocity": 5}, {**CHORD, "instrument": "kazoo"}, "nope"):
            a.send_text(json.dumps({"type": "ev", "ev": bad}))
            err = recv(a)
            assert err["type"] == "error" and "rejected" in err["error"]


def test_transport_is_shared_and_ping(c):
    with c.websocket_connect("/jam/ws/beat1") as a, c.websocket_connect("/jam/ws/beat1") as b:
        recv(a); recv(b); recv(a)
        b.send_text(json.dumps({"type": "transport", "playing": True, "tempo": 110}))
        ta, tb = recv(a), recv(b)
        assert ta == tb and ta["transport"]["tempo"] == 110 and ta["transport"]["startAt"] > 0
        a.send_text(json.dumps({"type": "ping", "c": 5}))
        pong = recv(a)
        assert pong["type"] == "pong" and pong["c"] == 5


def test_room_full_and_bad_code(c):
    socks = [c.websocket_connect("/jam/ws/full1") for _ in range(4)]
    opened = [s.__enter__() for s in socks]
    try:
        with c.websocket_connect("/jam/ws/full1") as x:
            assert recv(x)["error"] == "room is full"
    finally:
        for s in socks:
            s.__exit__(None, None, None)
    with c.websocket_connect("/jam/ws/BAD!!") as x:
        assert recv(x)["error"] == "bad room code"


def test_rate_limit(c):
    with c.websocket_connect("/jam/ws/flood") as a:
        recv(a)
        for i in range(200):
            a.send_text(json.dumps({"type": "ev", "ev": {**CHORD, "id": f"x{i}"}}))
        a.send_text(json.dumps({"type": "ping", "c": 1}))
        # no peers, so the only replies are the rate-limit warning(s) — and possibly the ping if tokens refilled
        msg = recv(a)
        assert msg["type"] == "error" and msg["error"] == "rate limited"

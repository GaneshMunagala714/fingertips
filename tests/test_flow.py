"""End-to-end through the server with a fake Twilio relay socket (no network, no real call)."""
import importlib
import json
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("VALIDATE_TWILIO_SIGNATURE", "false")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("PUBLIC_URL", "https://example.test")
    import server.main as m
    importlib.reload(m)
    m.call.reset()
    return TestClient(m.app), m


def test_relay_captions_and_reply(client):
    c, m = client
    with c.websocket_connect("/ws") as browser:
        assert json.loads(browser.receive_text())["type"] == "snapshot"
        with c.websocket_connect("/twilio/relay") as relay:
            relay.send_text(json.dumps({"type": "setup", "callSid": "CA1"}))
            ev = json.loads(browser.receive_text())
            assert ev["type"] == "relay" and ev["connected"] is True
            relay.send_text(json.dumps({"type": "prompt", "voicePrompt": "Are you coming at", "last": False}))
            assert json.loads(browser.receive_text())["text"] == "Are you coming at"
            relay.send_text(json.dumps({"type": "prompt", "voicePrompt": "Are you coming at 8?", "last": True}))
            turn = json.loads(browser.receive_text())["turn"]
            assert turn == {**turn, "who": "them", "text": "Are you coming at 8?"}

            # suggestions (rules, no Gemini key) for the caller's yes/no question
            s = c.post("/api/suggest", json={"hint": ""}).json()
            assert s["source"] == "rules" and "Yes." in s["replies"]

            # typed reply goes to Twilio exactly once, even if the tap is retried
            r1 = c.post("/api/say", json={"text": "Yes, I'll be there at 8.", "request_id": "r1"}).json()
            r2 = c.post("/api/say", json={"text": "Yes, I'll be there at 8.", "request_id": "r1"}).json()
            assert r1 == r2 == {"ok": True}
            sent = json.loads(relay.receive_text())
            assert sent == {"type": "text", "token": "Yes, I'll be there at 8.", "last": True}
            assert sum(1 for t in m.call.turns if t["who"] == "me") == 1

            # money needs a confirmation tap
            r = c.post("/api/say", json={"text": "Okay, charge my card.", "request_id": "r2"}).json()
            assert r["needs_confirm"] is True
            r = c.post("/api/say", json={"text": "Okay, charge my card.", "request_id": "r2", "confirmed": True}).json()
            assert r == {"ok": True}
            assert json.loads(relay.receive_text())["token"] == "Okay, charge my card."

            # caller talks over us
            relay.send_text(json.dumps({"type": "interrupt", "utteranceUntilInterrupt": "Okay"}))
            msgs = [json.loads(browser.receive_text())["type"] for _ in range(3)]
            assert msgs == ["turn", "turn", "interrupted"]


def test_dial_rejects_bad_number(client):
    c, _ = client
    assert c.post("/api/call", json={"to": "12345"}).status_code == 400


def test_twiml_uses_conversation_relay(client):
    c, _ = client
    x = c.post("/twilio/twiml", data={"CallSid": "CA1"}).text
    assert "<ConversationRelay" in x and 'url="wss://example.test/twilio/relay"' in x and 'partialPrompts="true"' in x


def test_asl_classify(client):
    c, m = client
    info = c.get("/api/asl/info").json()
    assert info["ready"] and info["signs"] == 2730 and "YES" in info["everyday"]
    frame = {"pose": [[0.5, 0.5, 0.0]] * 33, "rh": [[0.45, 0.6, 0.0]] * 21, "lh": None}
    r = c.post("/api/asl/classify", json={"frames": [frame] * 20, "vocab": "everyday"}).json()
    assert r["ok"] and r["sign"] in info["everyday"] and len(r["choices"]) == 3
    assert c.post("/api/asl/classify", json={"frames": [frame] * 2}).json()["ok"] is False


def test_asl_top200(client):
    c, m = client
    info = c.get("/api/asl/info").json()
    assert len(info["top200"]) == 200 and "PHONE" in info["top200"] and "GOOD" not in info["top200"]
    frame = {"pose": [[0.5, 0.5, 0.0]] * 33, "rh": [[0.45, 0.6, 0.0]] * 21, "lh": None}
    r = c.post("/api/asl/classify", json={"frames": [frame] * 20, "vocab": "top200"}).json()
    assert r["ok"] and r["sign"] in info["top200"]

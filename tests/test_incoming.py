"""Incoming calls: ring the browser, answer hands the call to ConversationRelay, decline/timeout hang up politely."""
import importlib
import json

import pytest
from fastapi.testclient import TestClient


class FakeCall:
    def __init__(self, log, sid):
        self.log, self.sid = log, sid

    def update(self, **kw):
        self.log.append((self.sid, kw))


class FakeClient:
    def __init__(self):
        self.log = []

    def calls(self, sid):
        return FakeCall(self.log, sid)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("VALIDATE_TWILIO_SIGNATURE", "false")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("PUBLIC_URL", "https://example.test")
    import server.main as m
    importlib.reload(m)
    m.call.reset()
    fake = FakeClient()
    monkeypatch.setattr(m, "twilio_client", lambda: fake)
    return TestClient(m.app), m, fake


def ring(c):
    return c.post("/twilio/incoming", data={"CallSid": "CAin", "From": "+14135550101"})


def test_incoming_rings_browser_and_answer_connects(client):
    c, m, fake = client
    with c.websocket_connect("/ws") as browser:
        browser.receive_text()
        r = ring(c)
        assert r.status_code == 200 and "<Play loop=\"0\">https://example.test/static/ringback.wav</Play>" in r.text
        ev = json.loads(browser.receive_text())
        assert ev == {**ev, "type": "status", "status": "incoming", "to": "+14135550101", "direction": "inbound"}
        assert c.post("/api/answer").json() == {"ok": True}
        assert fake.log == [("CAin", {"url": "https://example.test/twilio/twiml", "method": "POST"})]
        ev = json.loads(browser.receive_text())
        assert ev["status"] == "in-progress" and ev["started"]
        # a late Twilio "in-progress" doesn't reset anything; "completed" ends the call
        c.post("/twilio/status", data={"CallSid": "CAin", "CallStatus": "in-progress"})
        c.post("/twilio/status", data={"CallSid": "CAin", "CallStatus": "completed"})
        assert json.loads(browser.receive_text())["status"] == "completed"
    assert m.call.status == "completed"


def test_decline_and_missed(client):
    c, m, fake = client
    ring(c)
    assert c.post("/api/decline").json() == {"ok": True}
    assert m.call.status == "declined" and "<Hangup" in fake.log[0][1]["twiml"]
    c.post("/twilio/status", data={"CallSid": "CAin", "CallStatus": "completed"})
    assert m.call.status == "declined"
    # caller gives up before anyone answers -> missed
    ring(c)
    c.post("/twilio/status", data={"CallSid": "CAin", "CallStatus": "completed"})
    assert m.call.status == "missed"
    assert c.post("/api/answer").status_code == 409


def test_second_caller_gets_busy_message(client):
    c, m, _ = client
    ring(c)
    r = c.post("/twilio/incoming", data={"CallSid": "CAother", "From": "+14135550199"})
    assert "on another call" in r.text and m.call.sid == "CAin"
    assert c.post("/api/call", json={"to": "+14135550123"}).status_code == 409

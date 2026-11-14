# TalkBridge

**Your hands. Your voice.** A Deaf, hard-of-hearing or nonspeaking person makes a real phone call from the
browser. The other person uses an ordinary phone and installs nothing.

- The caller's speech appears as live captions (partial, then final).
- You answer with one-tap quick replies, AI suggestions, or a few typed words ("yes 8 works") that become a
  natural sentence. **Nothing is spoken until you tap.**
- Safety guards sit between the AI and the call: suggestions that invent numbers, times or days are dropped,
  a "no" can't become a "yes", and anything about money, orders or bookings needs a confirm tap.
- A retried tap is never spoken twice. If the caller talks over your reply, it's marked "cut off" with
  "Say it again".

Built solo by Ganesh Munagala at HackUMass XIV (Nov 13–15, 2026).

## What's in this repo

| Folder | What | Author |
|---|---|---|
| `server/`, `web/`, `tests/` | TalkBridge call app (this README) | Ganesh Munagala, written at HackUMass XIV |
| `server/jam.py`, `web/jam/`, `tests/jam/`, `tests/test_jam.py` | **JAM**: gesture music & art playground (below) | Ganesh Munagala, written at HackUMass XIV |
| `fingertip/` | **Fingertip**: signing recognition, call controller with guards, Show it (Gemini video), Meet extension, desktop bridge, Gesture Synth. See [fingertip/README.md](fingertip/README.md) |

## JAM: music you can see (`/jam`)

A gesture-controlled instrument where every note is also drawn on screen, so a Deaf player can create and
follow the music without hearing it, a hearing player needs no sign language, and nobody has to speak.

- **Hands → music** (MediaPipe Hand Landmarker, runs in the browser; video never leaves the device).
  Chords: left-hand fingers 1–5 = C, Dm, Em, F, G; right hand height = volume, tilt = tone, pinch = hold.
  Melody: slide left/right along a scale, pinch to play. Rhythm: pinch in kick / snare / hi-hat zones.
  Gestures must hold steady before they count, pinch has hysteresis, and a lost hand releases its notes. One-hand mode.
- **Music → visuals**, from the same events that drive the synth: pitch = height (labelled), loudness =
  ribbon width/glow (computed from the real ADSR envelope × channel volume; background glow is the measured output),
  chords = connected labelled nodes with interval names, rhythm = scrolling beat lines + metronome + 16-step grid,
  timbre = per-instrument marks. Three styles: Aurora, Constellation, Pulse Garden. Muting keeps all of it.
- **Jam together**: invite link → shared room over WebSocket. Only small validated events travel (server
  whitelists fields, enforces ranges and rate limits, stamps the sender); each browser synthesizes locally.
  Shared clock (ping/pong), shared tempo/downbeat, 80 ms jitter buffer, reconnect, notes released when a player leaves.
- **Record → replay → export** JSON, PNG artwork, WAV (rendered offline by the same synth).
- **Without a camera**: keyboard (1–7 chords, A–L melody, Z/X/C drums) and touch/mouse pads.
- Accessibility: labels, reduced motion, simplified and high-contrast modes, no strobing, large targets,
  screen-reader announcements, point-and-hold mode switching. Beat haptics only where the device can vibrate.

Credits: the finger-count → chord idea comes from [Gesture Synth](https://github.com/ericwei97-cloud/gesture-synth)
by Eric Wei (non-commercial use with credit). JAM's code is new; none of Gesture Synth's source is copied.
Hand tracking: Google MediaPipe Tasks Vision 0.10.14 (loaded from jsDelivr).

```bash
node --test tests/jam/logic.test.mjs        # theory, envelopes, gesture mapping (simulated hands)
python -m pytest -q tests/test_jam.py        # room relay: two clients, validation, rate limit
node tests/jam/smoke.mjs http://localhost:8000   # real Chrome via Playwright (fake camera, two browsers)
```

## How it works

```
Browser ──/ws, /api──► FastAPI server ──REST──► Twilio Voice (dials the number)
                              ▲
                              └──/twilio/relay WebSocket── Twilio ConversationRelay ◄──► phone
```
Twilio ConversationRelay does speech-to-text (captions) and text-to-speech (your approved replies).
Gemini (optional) turns a few words into a sentence and suggests replies; without a key, simple rules are used.
All keys stay on the server.

## Run it

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r server/requirements.txt
cp .env.example .env          # fill in Twilio + Gemini
cloudflared tunnel --url http://localhost:8000   # copy the https URL into PUBLIC_URL in .env
uvicorn server.main:app --port 8000
```
Open http://localhost:8000. In the Twilio console, accept the Voice "Predictive and Generative AI/ML
Features Addendum" (required for ConversationRelay). Trial accounts can only call verified numbers.

## Tests

```bash
python -m pytest -q tests     # guards + an end-to-end flow with a fake Twilio relay socket
```

## Status (honest)

| Feature | Status |
|---|---|
| Captions, quick replies, typed replies, guards, confirm sheet, retry-safe send, cut-off marking | Tested with a fake Twilio relay |
| Real phone call through Twilio | Not yet run (needs keys) |
| Gemini suggestions | Not yet run (needs key); rules fallback tested |

# TalkBridge

**Your hands. Your voice.** Real phone calls for Deaf, hard-of-hearing and nonspeaking people.
The caller's words show up as live captions; you answer in **ASL**, by tapping or by typing, and TalkBridge
speaks your reply. The person on the other end uses an ordinary phone and installs nothing.

| | |
|---|---|
| **Live app** | **https://66-135-26-183.sslip.io** (open in Chrome on a laptop) |
| **Call it** | **+1 (878) 877-6285**: rings the open app, answer in the browser |
| **JAM (music you can see)** | https://66-135-26-183.sslip.io/jam |
| **ASL sign cards (PDF)** | [print/asl-top200-cards.pdf](print/asl-top200-cards.pdf) |

Built by Ganesh Munagala at **HackUMass XIV** (Nov 13–15, 2026). Sign recognition uses the model and
preprocessing from [Fingertip by Shruti](https://github.com/Shrutibrahma/HackUMass-26) (used with permission),
SignBart-ASL-2730 trained on ASL Citizen, and Google MediaPipe. JAM's finger-count → chord idea is from
[Gesture Synth](https://github.com/ericwei97-cloud/gesture-synth) by Eric Wei.

---

## Contents

1. [What it does](#what-it-does)
2. [Try it in 2 minutes](#try-it-in-2-minutes)
3. [Answering in ASL](#answering-in-asl)
4. [Safety guards](#safety-guards)
5. [JAM: music you can see](#jam-music-you-can-see)
6. [How it works](#how-it-works)
7. [Repository layout](#repository-layout)
8. [Run it yourself](#run-it-yourself)
9. [Deploy (Vultr)](#deploy-vultr)
10. [Tests](#tests)
11. [How the 200 signs were chosen and measured](#how-the-200-signs-were-chosen-and-measured)
12. [Limits (honest)](#limits-honest)

---

## What it does

| | |
|---|---|
| 📞 **Make and take real calls** | Phone-style app: Keypad, Contacts, Recents. Dial any US number, or have people call the TalkBridge number; incoming calls ring in the browser with **Accept / Decline**. |
| 💬 **Live captions** | Everything the caller says appears as text, first as a draft, then final. Caption size is adjustable. |
| 🤟 **Answer in ASL** | The camera turns on when the call connects. Sign one word at a time; drop your hands and TalkBridge makes a sentence, counts down 3 seconds, and speaks it. |
| ⌨️ **Or tap / type** | One-tap quick replies, AI reply suggestions, or a few typed words ("yes 8 works") that become a full sentence. |
| 🛡️ **Safety guards** | The AI can't invent numbers or times, can't turn "no" into "yes", and money / booking replies need a confirm tap. |
| 🖨️ **Sign cards** | A printable PDF of the 200 supported signs: numbered steps, pictures from real Deaf signers, QR code to a video. |
| 🎶 **JAM** | A gesture instrument where every note is also drawn on screen; play together by invite link. |

The caller first hears: *"Hi, this is Ganesh's interpreter. How are you?"* (set with `USER_NAME` or `GREETING` in `.env`).

## Try it in 2 minutes

1. Open **https://66-135-26-183.sslip.io** in Chrome on a laptop and allow the camera when asked.
2. **Receive a call:** from any phone, call **+1 (878) 877-6285**. The app rings; click **Accept**.
   **Or make one:** type a number on the Keypad and press Call.
3. Read the caller's words as captions.
4. Reply: sign a few words from the [sign cards](print/asl-top200-cards.pdf) (try **HELLO, YES, THANK-YOU, HELP, LATER**),
   then drop your hands. Or tap a suggestion, or type.

## Answering in ASL

```
camera ──► MediaPipe (in your browser) ──► landmarks only ──► server: SignBart model ──► word
                                                                                          │
   caller hears it ◄── Twilio voice ◄── 3-second countdown ◄── Gemini makes a sentence ◄──┘
```

- **One sign at a time.** A sign starts when your hand comes up and moves; it ends when your hands drop
  or hold still. Each recognized word is added to your reply.
- **Not sure?** If the model isn't confident, it shows its top guesses as buttons: tap the right one.
- **Sentence and auto-send.** Keep your hands down for about 1.5 s: Gemini turns the words into a sentence
  and shows **"Sending … in 3, 2, 1"**. Tap **Cancel sending**, sign again, type, or tap another suggestion to stop it.
  Auto-send can be turned off in Settings.
- **Sign sets** (Settings → Sign recognition):
  - **Top 200** (default): everyday and phone-call signs, most accurate. See the [sign cards](print/asl-top200-cards.pdf).
  - **All 2,730** ASL Citizen signs: more words, more mistakes.
  - **59 everyday** signs measured by Fingertip on real signers.
  - **7 quick hand signs** (thumb up = "Yes.", flat palm = "One moment", fist = say the top suggestion, …): instant, no model.
- **Privacy:** video never leaves your device. Only hand and body landmark coordinates are sent, one sign at a time.
- **Speed:** the model takes about 12 ms per sign on the server's CPU.

## Safety guards

An AI that "helpfully" changes what you meant is worse than no AI on a live call. `server/guards.py`:

- Drops suggestions that **invent numbers, times, dates or days** that you or the caller didn't say.
- **Polarity lock:** a "no" can't become a "yes" and the other way round.
- **Confirm sheet** for anything about money, payments, orders or bookings.
- **Retry-safe send:** every reply has an ID; a double tap or network retry is never spoken twice.
- **Barge-in:** if the caller talks over your reply, it's marked "cut off" with a "Say it again" button.
- Twilio webhook **signatures are verified** (`VALIDATE_TWILIO_SIGNATURE=true`).

## JAM: music you can see

At **/jam**. A gesture-controlled instrument where every note is also drawn, so a Deaf player can make and
follow the music without hearing it.

- **Hands → music:** left-hand fingers 1–5 pick chords (C, Dm, Em, F, G); right hand height = volume, tilt = tone, pinch = hold.
  Melody and drum modes. Keyboard and touch work without a camera.
- **Music → visuals:** pitch = height, loudness = width/glow, chords = connected labelled nodes, rhythm = beat lines and a 16-step grid. Three styles.
- **Haptics:** a vibration pattern per event (kick, snare, chord, melody) on devices that support it.
- **Play together:** invite link → shared room over WebSocket with a shared clock and tempo.
- **Record → replay → export** JSON, PNG artwork, WAV.

## How it works

```
                    ┌─────────────────────────────── your browser ───────────────────────────────┐
                    │  phone UI (web/)   captions   replies   MediaPipe hand + pose (web/asl.js)  │
                    └──────────┬───────────────────────────────────────────────────▲─────────────┘
                               │ /api, /ws  (HTTPS via Caddy)                       │ captions, call state
                    ┌──────────▼──────────────────── FastAPI (server/) ────────────┴──────────────┐
                    │  main.py: calls, incoming, relay   asl.py: SignBart (ONNX)   ai.py: Gemini   │
                    │  guards.py: safety checks          jam.py: JAM rooms                         │
                    └──────────┬──────────────────────────────────────────────────▲─────────────┘
                     REST: dial, answer           WebSocket /twilio/relay: text in / text out
                    ┌──────────▼──────────────────────────────────────────────────┴─────────────┐
                    │  Twilio Voice + ConversationRelay (speech-to-text, text-to-speech)         │
                    └──────────────────────────────────┬────────────────────────────────────────┘
                                                       │ ordinary phone call
                                                    📱 caller
```

- **Twilio ConversationRelay** turns the caller's speech into text (captions) and your approved text into speech.
- **Incoming calls:** Twilio hits `/twilio/incoming`, which plays a ringback tone until you press Accept in
  the browser (`/api/answer`), then connects the relay. No answer in 30 s = missed call.
- **Gemini** (optional) turns signed or typed words into sentences and suggests replies. Without a key,
  simple rules are used. All keys stay on the server.

## Repository layout

```
talkbridge/
├── server/                  FastAPI backend
│   ├── main.py              calls, incoming calls, Twilio relay socket, web routes
│   ├── asl.py               /api/asl/classify: SignBart ASL model, top-200 filter, sign logging
│   ├── ai.py                Gemini sentence + reply suggestions (rules fallback)
│   ├── guards.py            safety checks on every reply
│   ├── jam.py               JAM multiplayer rooms
│   ├── setup_inbound.py     points the Twilio number at this server
│   ├── popup.py             Mac only: brings the tab forward on an incoming call
│   └── data/asl_top200.json the 200 signs + measured accuracy
├── web/                     browser app, plain HTML/CSS/JS, no build step
│   ├── index.html, app.js, style.css   phone UI, call screen, settings
│   ├── asl.js               camera → MediaPipe → one sign at a time
│   ├── signs.js             7 quick hand signs
│   └── jam/                 JAM instrument
├── deploy/                  docker-compose.yml + Caddyfile (HTTPS) for a cloud server
├── Dockerfile
├── tests/                   pytest (guards, call flow, incoming calls, JAM) + JAM browser tests
├── eval_signs/              how the 200 signs were picked, measured, and turned into cards
├── print/                   asl-top200-cards.pdf
└── fingertip/               Fingertip by Shruti (sign model + preprocessing), used with permission
```

## Run it yourself

You need: Python 3.12+, a Twilio account with a phone number, a public HTTPS address
(a free `cloudflared` tunnel works), and optionally a Gemini API key.

```bash
git clone https://github.com/GaneshMunagala714/talkbridge && cd talkbridge
python3 -m venv .venv && . .venv/bin/activate
pip install -r server/requirements.txt
cp .env.example .env                               # fill in the values below
cloudflared tunnel --url http://localhost:8000     # copy the https URL into PUBLIC_URL
uvicorn server.main:app --port 8000
python -m server.setup_inbound                     # route calls to your number to this server
```

Open http://localhost:8000.

| `.env` | What |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER` | Twilio credentials and your Twilio number |
| `PUBLIC_URL` | public https address of this server (tunnel or domain) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | optional, for sentences and suggestions |
| `USER_NAME` / `GREETING` | what the caller hears first (default: "Hi, this is Ganesh's interpreter. How are you?") |
| `VALIDATE_TWILIO_SIGNATURE` | keep `true` |

In the Twilio console, accept the Voice "Predictive and Generative AI/ML Features Addendum" (required for
ConversationRelay). Trial accounts can only call verified numbers.

## Deploy (Vultr)

Runs on a small shared-CPU server (2 vCPU / 4 GB, Ubuntu 24.04). No GPU needed: hand tracking runs in
the browser and the sign model runs in about 12 ms on CPU.

```bash
# on the server, with the repo and .env in /srv/talkbridge
curl -fsSL https://get.docker.com | sh
ufw allow 80/tcp && ufw allow 443/tcp
cd /srv/talkbridge/deploy
echo DOMAIN=<your-ip-with-dashes>.sslip.io > .env
docker compose up -d --build
# then on your machine:
PUBLIC_URL=https://<your-ip-with-dashes>.sslip.io python -m server.setup_inbound
```

Caddy gets the HTTPS certificate automatically. `sslip.io` gives a hostname for any IP, so no domain is needed.

## Tests

```bash
python -m pytest -q tests                        # guards, call flow with a fake Twilio relay, incoming calls, JAM rooms
node --test tests/jam/logic.test.mjs             # JAM music theory and gesture mapping
node tests/jam/smoke.mjs http://localhost:8000   # JAM in real Chrome (Playwright, fake camera)
```

## How the 200 signs were chosen and measured

1. **Candidates:** ASL-LEX 2.0 frequency ratings + six published core-vocabulary lists + phone-call vocabulary.
2. **Measured:** each candidate was run through our pipeline on 8 real signers' clips from ASL Citizen;
   signs the model confuses were dropped.
3. **Result:** **88.9% (1,422 / 1,600 clips)** recognized correctly within the 200-sign set (68.1% if all 2,730 signs are allowed).
   Those clips may overlap the model's training data, so accuracy on new signers will be lower.
4. **A fix found by measuring:** the first real-hand test was poor. Replaying 600 clips showed that sending only
   the frames with hands visible cut accuracy from 89.5% to 77.1%; the browser now sends the whole sign plus half a second before it.

Scripts are in `eval_signs/`; the sign cards are built by `eval_signs/make_cards.py` from `eval_signs/howto.json`.

## Limits (honest)

- Recognizes **isolated ASL signs**, one at a time: not continuous ASL sentences, fingerspelling, or other sign languages.
- Some numbers have no sign in the model (two, four, five, ten, …): type them.
- Tested by us with real hands and real calls, not yet with Deaf users. That's the next step.
- The incoming-call screen works while the app is open in a tab (no push notifications yet).


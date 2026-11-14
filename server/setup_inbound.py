"""Point the Twilio number's incoming-call webhook at this TalkBridge server.

Run after PUBLIC_URL changes (new tunnel, or the Vultr deploy):
    .venv/bin/python -m server.setup_inbound
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def main() -> int:
    sid, token, number = os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"), os.getenv("TWILIO_NUMBER")
    base = os.getenv("PUBLIC_URL", "").rstrip("/")
    if not (sid and token and number and base.startswith("https://")):
        print("Need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER and an https PUBLIC_URL in .env")
        return 1
    client = Client(sid, token)
    found = client.incoming_phone_numbers.list(phone_number=number, limit=1)
    if not found:
        print(f"{number} isn't on this Twilio account")
        return 1
    n = found[0]
    print(f"before: voice_url={n.voice_url} status_callback={n.status_callback}")
    n = n.update(voice_url=f"{base}/twilio/incoming", voice_method="POST",
                 status_callback=f"{base}/twilio/status", status_callback_method="POST")
    print(f"after:  voice_url={n.voice_url} status_callback={n.status_callback}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

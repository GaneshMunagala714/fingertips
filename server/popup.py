"""On a Mac running the server locally: bring the Fingertips window to the front when a call comes in.

A web page can't raise its own window, but the server runs on the same Mac, so it asks macOS to.
Chrome first (finds the existing Fingertips tab, else opens one); any other browser gets `open <url>`.
Off when MAC_POPUP=off or not on macOS (e.g. the Docker/Vultr deploy).
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys

log = logging.getLogger("talkbridge.popup")

LOCAL_URL = os.getenv("LOCAL_URL", "http://localhost:8000").rstrip("/")
ENABLED = sys.platform == "darwin" and os.getenv("MAC_POPUP", "on").lower() != "off" and bool(shutil.which("osascript"))

CHROME = """
set target to "{host}"
tell application "System Events" to set chromeRunning to (exists process "Google Chrome")
if not chromeRunning then return "no-chrome"
tell application "Google Chrome"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if (URL of t) contains target then
        set active tab index of w to i
        set index of w to 1
        if minimized of w then set minimized of w to false
        activate
        return "raised"
      end if
    end repeat
  end repeat
  open location "{url}/"
  activate
  return "opened"
end tell
"""


async def _run(*args: str) -> str:
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(p.communicate(), timeout=8)
    if p.returncode:
        raise RuntimeError(err.decode().strip()[:200])
    return out.decode().strip()


async def bring_to_front() -> str:
    if not ENABLED:
        return "disabled"
    host = LOCAL_URL.split("://", 1)[-1]
    try:
        res = await _run("osascript", "-e", CHROME.format(host=host, url=LOCAL_URL))
        if res == "no-chrome":
            await _run("open", f"{LOCAL_URL}/")
            res = "opened-default"
        log.info("pop-up: %s", res)
        return res
    except Exception as e:  # a missing Automation permission lands here; the in-page ring still works
        log.warning("pop-up failed: %s", e)
        return f"failed: {e}"

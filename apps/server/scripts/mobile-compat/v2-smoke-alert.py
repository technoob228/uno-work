#!/usr/bin/env python3
"""Red T3 v2 smoke → Telegram (ALERT_CMD of v2-smoke-cloud.sh / v2-smoke-daily.sh).

Reads the alert text on stdin and sends it with the machine's alert bot: the
same env file and call as the Pult keeper on 395 (tracker/bin/keeper, tg_cfg):
~/.config/uno/pult-telegram.env with PULT_TG_BOT_TOKEN and PULT_TG_CHAT_ID
(override the path with T3V2_ALERT_ENV). Prints nothing secret; exit 0 even
when Telegram is unreachable (the log keeps the result).
"""
import html
import json
import os
import sys
import urllib.parse
import urllib.request

path = os.environ.get("T3V2_ALERT_ENV") or os.path.expanduser("~/.config/uno/pult-telegram.env")
cfg = {}
if os.path.exists(path):
    for line in open(path, encoding="utf-8"):
        key, _, value = line.strip().partition("=")
        if key in ("PULT_TG_BOT_TOKEN", "PULT_TG_CHAT_ID"):
            cfg[key] = value.strip().strip("'\"")
text = sys.stdin.read().strip() or "T3 v2 smoke RED (no details)"
if len(cfg) != 2:
    print(f"alert: no bot config in {path}; text was:\n{text}")
    sys.exit(0)
body = "🔴 <b>T3 phone app ↔ Uno Work: smoke RED</b>\n<pre>" + html.escape(text[:3500]) + "</pre>"
data = urllib.parse.urlencode(
    {"chat_id": cfg["PULT_TG_CHAT_ID"], "text": body, "parse_mode": "HTML", "disable_web_page_preview": "true"}
).encode()
try:
    ok = json.load(
        urllib.request.urlopen(f"https://api.telegram.org/bot{cfg['PULT_TG_BOT_TOKEN']}/sendMessage", data, timeout=20)
    ).get("ok")
    print(f"alert: telegram {'ok' if ok else 'rejected'}")
except Exception as error:  # no details: the URL holds the token
    print(f"alert: telegram failed ({type(error).__name__})")

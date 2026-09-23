# uno-app — the AI of this Uno computer, for any app on it

One stdlib-only file (`uno_app.py`, Python ≥ 3.9) for the local **Uno App API**
served by the Uno Work daemon (contract: `docs/app-sdk.md`). On every Uno
computer the same file is already at `~/.uno/sdk/python/uno_app.py`; copy it
into your app or `pip install uno-app` (not published yet).

Ask for AI in your manifest `~/.uno/apps/<id>.json`:
`"ai": {"chat": true, "tasks": false, "limitUsd": 5}` — the daemon writes the
app's token to `~/.uno/app-keys/<id>/` within seconds.

```python
import sys, os; sys.path.insert(0, os.path.expanduser("~/.uno/sdk/python"))
import uno_app

print(uno_app.ask("Translate to English: привет", system="Answer briefly"))

for chunk in uno_app.stream("Tell a story"):
    print(chunk, end="", flush=True)

text = uno_app.transcribe("meeting.ogg", language="en")

t = uno_app.task("Summarise ~/Inbox into ~/Inbox/summary.md", cwd="~/Inbox", tools="edit")
for e in t.events():
    if e["event"] == "message":
        print(e["data"]["delta"], end="")
print(t.wait()["result"])

c = uno_app.Client(url="http://127.0.0.1:3779", token="uno_app_…")  # explicit config
```

Also: `chat(body)` (raw OpenAI-compatible call), `transcribe_json(...)`
(whole JSON, e.g. `response_format="verbose_json"`), `whoami()`, `models()`,
`get_task(id)`, `tasks()`, `find_config()` (no waiting; `None` when the app
has no token).

**Config**, first match wins: `Client(url, token, app_id)` → env
`UNO_APP_API_URL` + `UNO_APP_TOKEN` → folder in env `UNO_APP_KEY_DIR` →
`/run/uno-app/` (docker: mount only your own key folder there, plus
`extra_hosts: ["host.docker.internal:host-gateway"]`) →
`~/.uno/app-keys/<app_id or UNO_APP_ID>/`. In a container the `dockerUrl`
from `api.json` is used. A missing token file is re-read for up to 15 s.

**Errors**: `UnoAppError` with `.status`, `.code`, `.message` —
`invalid_app_token` 401, `ai_not_allowed` 403, `app_limit_reached` 402 (the
person raises the limit in Uno Work → Settings → Apps), `ai_not_connected`
503, `no_app_token` / `unreachable` (status 0).

Tests: `python3 -m unittest discover -s tests`.

## Cloud storage

With `"storage": true` in the manifest the app gets its own folder in the
account's cloud — keep the person's files there, not on the computer's disk:

```python
st = uno_app.storage                      # or uno_app.Client(app_id="notes").storage
st.upload("/tmp/upload.jpg", "photos/cat.jpg")
st.put("notes/today.md", "# Today")
link = st.url("photos/cat.jpg")          # temporary https link for a browser (<= 1 h)
st.get_text("notes/today.md"); st.list("photos/"); st.delete("photos/cat.jpg")
```

# Uno App SDK — "the AI of this computer" for any app on it

Any app on an Uno computer — ours (Notetaker), the customer's, or one an AI
builder just wrote — can use the machine's AI without knowing which harness
or model is installed. The Work daemon exposes a small **local App API**; the
person decides in **Settings → Apps** which apps may use it and how much they
may spend.

```
app ──HTTP──▶ Work daemon (App API, 127.0.0.1:3779 + docker0)
                 ├── /v1/chat/completions ─▶ the app's provider (Settings → Apps):
                 │                            Uno AI gateway (default, metered per app)
                 │                            | AI on this computer (Ollama, LM Studio, vLLM…)
                 │                            | Personal AI (the account's GPU) | the person's own key
                 ├── /v1/audio/transcriptions ─▶ Uno AI gateway
                 ├── /v1/tasks ─▶ a Work chat (thread) on the harness the person chose
                 ├── /v1/storage/* ─▶ the app's folder in the account's cloud (S3)
                 └── /v1/notify ─▶ the person's Inbox in Uno Work (+ system notification)
```

**Where an app keeps data.** A computer has two kinds of storage:

- the **working disk** — fast, small, paid for by the gigabyte: the place
  where programs run. Databases, caches, indexes, temporary files and the
  app's own code belong here;
- the **cloud** (the account's Uno cloud storage, S3) — cheap and roomy: the
  place for things the person keeps. Photos, documents, uploads, attachments,
  recordings, exports, backups and archives belong here, through
  `storage` below.

The rule for every app (ours and the ones agents build): **files the person
keeps go to the cloud; the working disk keeps only what the app needs to
run.** A database row stores the cloud key (`photos/2026/cat.jpg`), not the
bytes.

## 1. Access: the manifest

An app asks for AI in its manifest `~/.uno/apps/<id>.json`:

```json
{
  "name": "Translator",
  "icon": "🌍",
  "port": 8601,
  "command": "node server.mjs",
  "cwd": "~/apps/translator",
  "ai": { "chat": true, "tasks": false, "limitUsd": 5 }
}
```

- `ai.chat` — may call `/v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/models`.
- `ai.tasks` — may start agent tasks (`/v1/tasks`).
- `ai.limitUsd` — the app's Uno AI spending cap **per month** (UTC; it starts
  over on the 1st), **at most $10** from the manifest (default $10). Only the
  person can raise it (Settings → Apps). What the app spent before stays in its
  lifetime total (`whoami().ai.lifetimeSpentUsd`).
- `"ai": true` is short for `{ "chat": true }`.
- No `ai` in the manifest → no AI (403 `ai_not_allowed`).
- `"storage": {"limitGb": 5}` (or `"storage": true`, 5 GB) — the app gets its
  own folder in the account's cloud, `Cloud storage → apps/<id>/`. A manifest
  may ask for at most 20 GB; the person can give more in Settings → Apps.
- `"notify": true` — the app may put notifications into the person's Inbox
  (`POST /v1/notify`, below).
- `"widget": {"path": "/widget", "size": "small"|"medium"|"wide", "title": "…"}` — a
  Home widget (0.0.82): Home shows the app's page at `path` in a sandboxed frame
  (scripts and the app's own origin; never Uno Work's origin, no top navigation),
  reloaded when the window gets focus. `path` must start with `/` (no scheme, no
  `//host`) or the manifest is skipped. The page must work at ~300×200 px. Needs
  no token; the person adds it in Home → Add widget.
- None of `ai`, `storage`, `notify` → no token, every call is 401.

When the daemon sees a manifest with `ai`, `storage` or `notify` it issues the app its own token
(`uno_app_…`, only a hash is stored) and writes:

```
~/.uno/app-keys/<id>/          (0700)
    token                      (0600) the bearer token
    api.json                   (0600) {"appId","url","dockerUrl","token"}
    env                        (0600) UNO_APP_ID=… UNO_APP_API_URL=… UNO_APP_TOKEN=…
```

An app started by the manifest `command` also gets `UNO_APP_ID`,
`UNO_APP_API_URL` and `UNO_APP_TOKEN` in its environment.

A docker app mounts only its own folder and reaches the host through the
docker gateway:

```yaml
services:
  app:
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes:
      - /home/unowork/.uno/app-keys/myapp:/run/uno-app:ro
```

The token is removed when the manifest (or its `ai` block) is removed, and
when the person presses **Revoke**; "Turn AI back on" issues a new one. The
folder itself stays (only its files go), so a container's bind mount keeps
pointing at the right place and sees the new token without a restart.
The App API binds 127.0.0.1 and the docker0 address even while the bridge
has no containers (`ip -4 addr show docker0`), so the first container finds
it already there.

## 2. The HTTP API

Base URL: `UNO_APP_API_URL` (default `http://127.0.0.1:3779`; from a
container `http://host.docker.internal:3779`). Every call:
`Authorization: Bearer <token>`. Errors are OpenAI-shaped:
`{"error":{"type","code","message"}}`.

| Status | `code`                                 | Meaning                                                                                                        |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 401    | `invalid_app_token`                    | unknown / revoked / rotated token                                                                              |
| 403    | `ai_not_allowed`                       | the manifest does not ask for this (chat or tasks)                                                             |
| 402    | `app_limit_reached`                    | the app spent this month's limit — it starts over on the 1st (UTC), or the person raises it in Settings → Apps |
| 503    | `ai_not_connected`                     | this computer has no Uno AI key (not linked)                                                                   |
| 400    | `invalid_request` / `cwd_outside_home` | bad input                                                                                                      |
| 403    | `storage_not_allowed`                  | the manifest does not ask for `storage`                                                                        |
| 507    | `app_storage_full`                     | the app filled its cloud limit — the person raises it in Settings                                              |
| 402    | `cloud_full`                           | the whole account's cloud is full (plan quota)                                                                 |
| 404    | `file_not_found`                       | no such file in the app's folder                                                                               |
| 400    | `invalid_key`                          | a key with `..`, a leading `/`, empty segments, > 512 chars                                                    |
| 503    | `storage_not_connected`                | this computer is not linked to an Uno account                                                                  |
| 403    | `notify_not_allowed`                   | the manifest does not ask for `"notify": true`                                                                 |
| 429    | `notify_rate_limited`                  | too many notifications; wait `Retry-After` seconds                                                             |

### `GET /v1/whoami`

```json
{
  "app": { "id": "translator", "name": "Translator" },
  "ai": {
    "chat": true,
    "tasks": false,
    "limitUsd": 5,
    "spentUsd": 0.012,
    "chatSpentUsd": 0.012,
    "tasksSpentUsd": 0,
    "remainingUsd": 4.988
  },
  "defaults": { "chatModel": "deepseek/deepseek-v3.2", "taskHarness": "uno" },
  "home": "/home/unowork"
}
```

### `POST /v1/chat/completions` (OpenAI-compatible, `stream: true` supported)

`model` is optional: omitted or `"default"` → the model the person picked for
this app in Settings → Apps (for Uno AI: "Model for answers"; for a local
server or an own key without a model: the first model it lists). Any model id
of the app's provider works too (`GET /v1/models` lists them). Streaming is
Server-Sent Events exactly like OpenAI.

Where the call goes is the person's choice per app — see §2a. The app sends
the same request whatever it is.

### `POST /v1/audio/transcriptions` (OpenAI-compatible multipart)

Same as OpenAI: `file`, optional `model`, `language`, `response_format`.
Goes to the person's own key when the app uses one; otherwise to Uno AI
(metered) — local servers and Personal AI rarely do speech-to-text.

## 2a. Providers: where an app's answers come from

The person picks one per app in **Settings → Apps → "Answers from"** (the
default is Uno AI). The app's code, token and SDK calls don't change.

| Provider                | What it is                                                                                                                                                                                                                                           | Limit (`limitUsd`) | Who pays                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------- |
| **Uno AI** (default)    | the Uno AI gateway with the machine's key                                                                                                                                                                                                            | yes                | the account's Uno AI credits |
| **AI on this computer** | an OpenAI-compatible server here: found on :11434 Ollama, :1234 LM Studio, :8000 vLLM, :8080 llama.cpp, :1337 Jan, :5000 text-generation-webui, :30000 SGLang (loopback, answers `/v1/models` in the OpenAI shape) — or any address the person types | no                 | nobody (the computer's own)  |
| **Personal AI**         | a model on the account's own GPU (`gpu.uno4.dev`, machine key), when the account has one                                                                                                                                                             | no                 | the GPU hour, while it's on  |
| **Your own key**        | a key from Settings → Agents → AI provider keys: xAI, OpenRouter, OpenAI or a custom OpenAI-compatible base URL                                                                                                                                      | no                 | that provider                |

- The limit is Uno AI's budget for the app; the other providers don't count
  against it (answers still count as `requests` and `lastUsedAt`).
- A key never leaves the daemon: the app has only its `uno_app_` token; an
  error from a provider holding the person's key comes back as
  `provider_error` with our own words, never its body.
- `GET /v1/whoami` → `"provider": {"kind","label","model","metered"}`.
- Errors: 502 `provider_unreachable` (the local server is off), 503 `no_model`
  (it has no model loaded), 503 `provider_not_configured` (the chosen key was
  removed / no address).
- Tasks (`/v1/tasks`) are not affected: they run on the agent chosen for jobs.
- What is on the computer right now is written for agents to
  `~/.uno/ai-providers.md` (rewritten every minute; names keys, never shows them).

### `POST /v1/tasks` — give the AI a job

```json
{
  "prompt": "Summarise every file in ~/Inbox into ~/Inbox/summary.md",
  "cwd": "~/Inbox",
  "title": "Daily Inbox summary",
  "harness": "default",
  "tools": "edit"
}
```

- `cwd` — must be inside the home folder (default: the app's `cwd`, else home).
- `harness` — `"default"` (what the person chose in Settings → Apps) or a
  harness id (`uno`, `codex`, `claudeAgent`, `opencode`, …) if installed.
- `tools` — how much the agent may do on its own:
  - `"read"` — plan mode: reads and answers, changes nothing;
  - `"ask"` (default) — every edit and command waits for the person in Work;
  - `"edit"` — edits files by itself, commands wait for the person;
  - `"full"` — does everything by itself.
    The app gets at most what the person allowed it in Settings → Apps
    (default: `"edit"`); asking for more is quietly narrowed and reported in
    `tools` of the response.

Response `202`:

```json
{ "id": "task_…", "threadId": "…", "status": "running", "tools": "edit", "harness": "uno" }
```

The task is a normal Work chat titled `[Translator] …`, so the person sees
it, can watch, answer approvals and stop it.

**Tasks and the app's limit.** What a task spends on the Uno AI gateway
counts against the app's `limitUsd`, together with its chat. The daemon marks
every gateway call of the task's chat with the app's id — and only the daemon
does; the app can't set it — and the gateway reports the billed sum per app
for the machine's key (`GET /v1/usage/apps`):

| Harness                              | How the label travels                                                    | Counted                 |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------- |
| Uno (built in, OpenCode engine)      | `X-Uno-App` header on the Uno providers of the session                   | yes                     |
| Hermes                               | base URL `…/v1/apps/<id>` (its OpenAI SDK takes no env headers)          | yes                     |
| Claude Code, Codex, Cursor, OpenCode | — they don't use the Uno gateway (the person's subscription or own keys) | no, Uno charges nothing |

The daemon asks the gateway at most every 20 s, so the limit can be overshot
by what a running task spends meanwhile; once over it, `POST /v1/tasks` (and
chat) answer `402 app_limit_reached`. A task already running is not stopped.
The chat stays the app's: if the person keeps talking in it, that counts too.
Settings → Apps shows the split ("answers $…, jobs $…").

### `GET /v1/tasks/:id`

```json
{
  "id": "task_…",
  "threadId": "…",
  "status": "running|waiting|done|error|stopped",
  "result": { "text": "last answer of the agent" },
  "changedFiles": ["summary.md"],
  "waitingFor": null
}
```

`waitingFor` is `"approval"` / `"input"` when the agent waits for the person.
`changedFiles` comes from Work's checkpoints in a git folder, otherwise from
files modified under `cwd` since the task started.

How strictly a harness asks is its own: the built-in Uno agent (OpenCode
engine) asks before reading and writing files even in `"edit"`, so an
unattended job needs `"full"` from the person, or the person answers the
approvals in the chat.
`?waitMs=30000` long-polls until the task is no longer running (max 60 s).

### `GET /v1/tasks/:id/events` — SSE progress

```
event: status   data: {"status":"running"}
event: message  data: {"delta":"Reading 4 files…"}
event: activity data: {"kind":"tool","summary":"Read ~/Inbox/a.txt"}
event: done     data: {"status":"done","result":{"text":"…"},"changedFiles":[…]}
```

### `GET /v1/tasks`, `POST /v1/tasks/:id/stop`

List the app's own tasks; stop a running one.

### Cloud storage — the app's own folder (`"storage"` in the manifest)

Keys are relative to the app's folder: `photos/2026/cat.jpg`. Folders are
implicit (like S3). One file is at most 256 MB for now.

| Call                                       | What it does                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `PUT /v1/storage/files/<key>`              | save the request body (needs `Content-Length`; `Content-Type` is kept) → `201 {"key","size"}`              |
| `GET /v1/storage/files/<key>`              | the file, streamed; `Range` works (video/audio seeking); `HEAD` for "exists"                               |
| `DELETE /v1/storage/files/<key>`           | delete a file; `?folder=1` deletes the whole folder `<key>/`                                               |
| `GET /v1/storage/list?prefix=photos/`      | one level: `{"prefix","folders":["photos/2026/"],"files":[{"key","name","size","modifiedAt"}]}`            |
| `POST /v1/storage/url {"key","expiresIn"}` | a temporary https link (default 15 min, max 1 h) to hand to a browser: `<img src>`, `<a href>`, a redirect |
| `GET /v1/storage`                          | `{"folder","usedBytes","files","limitBytes","remainingBytes"}`                                             |

Show files in a web page by redirecting to (or embedding) `url(key)` — the
browser then downloads straight from the cloud, not through the app. Serve
through `GET /v1/storage/files/…` only when the page can't take a redirect.

**How it is kept safe.** The app holds only its `uno_app_` token. The daemon
checks the key, puts it under the app's folder (`apps/<id>/`), checks the app's limit, then asks
the Uno console for a presigned URL with the computer's own token and moves
the bytes. The app never sees an S3 key, the computer's token, the rest of the
account's cloud or another app's folder; a link from `url()` opens exactly one
file for at most an hour. The account's plan quota is enforced by the console
(402 `cloud_full`), the app's own limit by the daemon (507).

The person sees everything an app stored in Files → Cloud storage → `apps` →
`<id>`, and how much each app uses in Settings → Apps.

**One folder for all computers, or one per computer.** By default the folder
`apps/<id>/` is shared by every computer of the account that has an app with
the same id. In Settings → Apps the person can switch an app to "Only this
computer": the folder becomes `apps/<id>@computer-<box id>/` (off Uno
computers `apps/<id>@local-<random id>/`). The two folders are siblings, so
neither lists, counts nor deletes the other's files, and the app's limit counts
the folder it uses now. Switching moves nothing — the app just starts seeing
the other folder; the API and the app's keys stay the same, the app is not
told.

**Removing an app.** Its cloud files stay unless the person ticks "Also delete
its files in the cloud" in the Remove dialog (App Store apps; shown with the
folder's size, and a warning when the folder is shared with other
computers). The daemon deletes the app's current folder after the app is gone
(`appAiUpdate {deleteCloudFiles: true}`, allowed once the manifest is gone).

### `POST /v1/notify` — tell the person something (`"notify": true`)

```json
{
  "title": "Boris commented on report.docx",
  "body": "Can we add October numbers once the month closes?",
  "open": { "file": "~/Documents/report.docx" },
  "group": "report-comments"
}
```

→ `201 {"ok": true, "id": "inb_…"}`. The item appears in the **Inbox** of Uno
Work (the bell / "Inbox" row in the sidebar, the Inbox icon of the rail) on
every window connected to this computer, with the app's name and icon, and —
if the person turned it on — as a system notification of the browser or the
desktop app. It is kept by the daemon (survives restarts) until the person
reads, snoozes or dismisses it.

- `title` — required, ≤ 140 characters, plain words ("Backup finished").
- `body` (or `text`) — optional second line, ≤ 500 characters.
- `open` — where "Open" leads:
  - `{"file": "~/…"}` or an absolute path — a file **inside home**; Word,
    Excel and PowerPoint files open in Office, the rest in Files;
  - `{"app": true, "path": "/notes/42"}` — this app, inside Uno (never another app);
  - `{"url": "https://…"}` — an http(s) address, opened inside Uno;
  - a string is short for a url (`https://…`) or a file (`~/…`, `/…`).
- `group` — ≤ 100 characters. While an item of the same group is unread, a new
  notification **updates** it (text, time, a "×3" counter) instead of adding
  one. Use it for anything that repeats (autosaves, polling, progress).

Rate limit per app: a burst of 10, then one every 10 s (6 a minute), at most
200 a day → `429 notify_rate_limited` with `Retry-After`. Text is cleaned of
control and bidi characters.

Built-in parts of Uno post into the same Inbox: agents (finished, waits for an
approval or an answer, stopped with an error) and **Office** — a save through
a "Can comment" / "Can edit" share link becomes "Boris commented on
report.docx" (the name the visitor typed; repeats of one visitor fold into one
item) with Open → the document.

## 3. SDKs

Zero-dependency single files; the daemon keeps a copy on every machine:

|                        | On the machine                          | Package (not published yet)      |
| ---------------------- | --------------------------------------- | -------------------------------- |
| JS/TS (Node ≥ 18, Bun) | `~/.uno/sdk/js/uno-app.mjs` (+ `.d.ts`) | `@uno4/app` — `packages/app-sdk` |
| Python ≥ 3.9           | `~/.uno/sdk/python/uno_app.py`          | `uno-app` — `sdk/python`         |

```js
import { ask, stream, task, whoami } from "/home/unowork/.uno/sdk/js/uno-app.mjs";
const text = await ask("Translate to English: привет");
for await (const chunk of stream("Tell a story")) process.stdout.write(chunk);
const t = await task({ prompt: "Summarise ~/Inbox", cwd: "~/Inbox", tools: "edit" });
const done = await t.wait();
```

```python
import sys, os; sys.path.insert(0, os.path.expanduser("~/.uno/sdk/python"))
import uno_app
print(uno_app.ask("Translate to English: привет"))
```

Notifications (manifest `"notify": true`):

```js
import { notify } from "/home/unowork/.uno/sdk/js/uno-app.mjs";
await notify("Backup finished", {
  body: "12 files, 1.2 GB",
  open: { app: true, path: "/backups" },
});
await notify({
  title: "Anna commented on plan.docx",
  open: { file: "~/Documents/plan.docx" },
  group: "plan",
});
```

```python
uno_app.notify("Backup finished", body="12 files", open={"app": True, "path": "/backups"})
```

Cloud storage (manifest `"storage": true`):

```js
import { createClient } from "/home/unowork/.uno/sdk/js/uno-app.mjs";
const uno = createClient({ appId: "album" });
await uno.storage.put(`photos/${id}.jpg`, buffer, { contentType: "image/jpeg" });
await uno.storage.upload("/tmp/upload-123", `photos/${id}.jpg`); // streamed from disk
const link = await uno.storage.url(`photos/${id}.jpg`); // → <img src={link}>, or res.redirect(link)
const bytes = await uno.storage.get("notes/attachments/a.pdf");
const { folders, files } = await uno.storage.list("photos/");
await uno.storage.delete(`photos/${id}.jpg`);
const { usedBytes, limitBytes } = await uno.storage.usage();
```

```python
st = uno_app.Client(app_id="album").storage
st.upload("/tmp/upload-123", f"photos/{pid}.jpg")
link = st.url(f"photos/{pid}.jpg")          # redirect the browser here
data = st.get("notes/attachments/a.pdf")
st.delete(f"photos/{pid}.jpg")
```

Config comes from the environment (`UNO_APP_API_URL`, `UNO_APP_TOKEN`), then
from `/run/uno-app/` (docker), then from `~/.uno/app-keys/<UNO_APP_ID or appId>/`.

## 3a. `<uno-chat>` — a chat in the app's page in one tag

A zero-dependency web component (streaming, light markdown, light/dark, Stop,
Enter to send) that any app page can drop in. **The browser never gets the
app token**: the component talks to the app's own backend, which the SDK
turns into a chat endpoint; the backend calls the App API with the token.

```js
// server.mjs — Node ≥ 18, Express (plain node:http works the same way)
import express from "express";
import { createClient } from "/home/unowork/.uno/sdk/js/uno-app.mjs";
const ai = createClient({ appId: "notes" });
const app = express();
app.use("/uno/chat", ai.chatHandler({ system: "You help with this person's notes." }));
app.get("/", (_req, res) =>
  res.send(`<script type="module" src="/uno/chat/uno-chat.js"></script>
  <uno-chat endpoint="/uno/chat" heading="Notes assistant" greeting="Ask about your notes"></uno-chat>`),
);
app.listen(process.env.PORT ?? 8601, "0.0.0.0");
```

- `chatHandler(opts)` — `GET …/uno-chat.js` serves the component,
  `POST …` takes `{"messages":[{role,content}]}` and answers SSE
  (`data: {"delta":"…"}` …, `data: {"error":{"message"}}`, `data: [DONE]`).
  Options: `system` (yours — a `system` turn from the page is dropped),
  `model`, `temperature`, `maxTokens`, `maxMessages` (20), `maxChars` (8000),
  `allow(req)` (your own login check; false → 403).
- Without the tag: `UnoChat.mount(element, {endpoint, greeting, heading, placeholder})`.
  Style it with CSS variables (`--uno-chat-accent`, `--uno-chat-bg`, …) or `::part(box)`.
- Python: `ai.chat_sse(body, system=…)` yields the same SSE bytes (FastAPI:
  `StreamingResponse(ai.chat_sse(await request.json(), system="…"), media_type="text/event-stream")`),
  `uno_app.chat_component_js()` is the script to serve at `/uno/chat/uno-chat.js`,
  `uno_app.handle_chat_request(self, system="…")` does both for `http.server`.
- The endpoint is as public as the app: anyone who can open the page can
  spend its AI (up to its monthly limit on Uno AI). **Always set `allow`**
  (Python: guard the route, `chat_sse(..., guarded=True)` /
  `handle_chat_request(..., allow=…)`) when the app is on the internet. The
  SDK tells the daemon on each chat call whether the endpoint is guarded
  (`X-Uno-Chat-Widget` / `X-Uno-Chat-Guarded`); an unguarded chat of an app
  shown on the internet gets a warning on its tile and in Settings → Apps
  ("Anyone with the link can use this app's AI — add sign-in") with "Ask Uno to
  add sign-in".
- On the machine the component is `~/.uno/sdk/js/uno-chat.js` (also next to
  `uno_app.py`); in the package, `@uno4/app/chat`.

## 4. Routing: gateway vs. subscription

- **Chat / transcription → the provider the person chose for the app** (§2a;
  Uno AI by default, metered per app). Routing an app's arbitrary traffic through a
  person's Claude/ChatGPT subscription (by driving the Claude Code / Codex
  CLI per request) is technically possible but wrong: subscriptions are
  licensed for the person's own interactive use, a background app would burn
  their limits invisibly, each call costs a CLI start (seconds), and none of
  the OpenAI parameters (temperature, JSON mode, tools, streaming format)
  survive the trip.
- **Tasks → the harness the person chose** ("AI for apps" in Settings →
  Apps). If that is Claude Code or Codex with a subscription, the task runs on
  the subscription — legitimately: it is the person's own agent, working in a
  chat they can see and stop.

## 5. Security model

- The App API listens on loopback and the docker bridge only — never on the
  public interface.
- A token is bound to one app id. It opens only: chat for that app, tasks
  started by that app, that app's cloud folder `apps/<id>/` and notifications
  in that app's name (an "Open" link can point at a file inside home, the app
  itself or an http(s) address — never at another app). It is not an account key and not a machine key; it
  cannot read other apps' tasks, settings, files or the account.
- Spending is checked before each call and settled after it; a call that
  would start above the limit gets 402.
- Task `cwd` is resolved and checked inside the home folder (symlinks
  resolved).
- Processes of the same Linux user can read each other's files — the key
  folder protects against other users and containers, not against code the
  person runs as themselves (which could anyway do everything the person can).

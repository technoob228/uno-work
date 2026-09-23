# Uno App SDK — "the AI of this computer" for any app on it

Any app on an Uno computer — ours (Notetaker), the customer's, or one an AI
builder just wrote — can use the machine's AI without knowing which harness
or model is installed. The Work daemon exposes a small **local App API**; the
person decides in **Settings → Apps** which apps may use it and how much they
may spend.

```
app ──HTTP──▶ Work daemon (App API, 127.0.0.1:3779 + docker0)
                 ├── /v1/chat/completions ─▶ Uno AI gateway (machine key, metered per app)
                 ├── /v1/audio/transcriptions ─▶ Uno AI gateway
                 ├── /v1/tasks ─▶ a Work chat (thread) on the harness the person chose
                 └── /v1/storage/* ─▶ the app's folder in the account's cloud (S3)
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
- `ai.limitUsd` — spending cap for the app, **at most $10** from the manifest
  (default $10). Only the person can raise it (Settings → Apps).
- `"ai": true` is short for `{ "chat": true }`.
- No `ai` in the manifest → no AI (403 `ai_not_allowed`).
- `"storage": {"limitGb": 5}` (or `"storage": true`, 5 GB) — the app gets its
  own folder in the account's cloud, `Cloud storage → apps/<id>/`. A manifest
  may ask for at most 20 GB; the person can give more in Settings → Apps.
- Neither `ai` nor `storage` → no token, every call is 401.

When the daemon sees a manifest with `ai` or `storage` it issues the app its own token
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

| Status | `code`                                 | Meaning                                                           |
| ------ | -------------------------------------- | ----------------------------------------------------------------- |
| 401    | `invalid_app_token`                    | unknown / revoked / rotated token                                 |
| 403    | `ai_not_allowed`                       | the manifest does not ask for this (chat or tasks)                |
| 402    | `app_limit_reached`                    | the app spent its limit — the person raises it in Settings → Apps |
| 503    | `ai_not_connected`                     | this computer has no Uno AI key (not linked)                      |
| 400    | `invalid_request` / `cwd_outside_home` | bad input                                                         |
| 403    | `storage_not_allowed`                  | the manifest does not ask for `storage`                           |
| 507    | `app_storage_full`                     | the app filled its cloud limit — the person raises it in Settings |
| 402    | `cloud_full`                           | the whole account's cloud is full (plan quota)                    |
| 404    | `file_not_found`                       | no such file in the app's folder                                  |
| 400    | `invalid_key`                          | a key with `..`, a leading `/`, empty segments, > 512 chars       |
| 503    | `storage_not_connected`                | this computer is not linked to an Uno account                     |

### `GET /v1/whoami`

```json
{
  "app": { "id": "translator", "name": "Translator" },
  "ai": { "chat": true, "tasks": false, "limitUsd": 5, "spentUsd": 0.012, "remainingUsd": 4.988 },
  "defaults": { "chatModel": "deepseek/deepseek-v3.2", "taskHarness": "uno" },
  "home": "/home/unowork"
}
```

### `POST /v1/chat/completions` (OpenAI-compatible, `stream: true` supported)

`model` is optional: omitted or `"default"` → the model the person picked in
Settings → Apps ("AI for apps"). Any gateway model id works too
(`GET /v1/models`). Streaming is Server-Sent Events exactly like OpenAI.

### `POST /v1/audio/transcriptions` (OpenAI-compatible multipart)

Same as OpenAI: `file`, optional `model`, `language`, `response_format`.

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
checks the key, puts it under `apps/<id>/`, checks the app's limit, then asks
the Uno console for a presigned URL with the computer's own token and moves
the bytes. The app never sees an S3 key, the computer's token, the rest of the
account's cloud or another app's folder; a link from `url()` opens exactly one
file for at most an hour. The account's plan quota is enforced by the console
(402 `cloud_full`), the app's own limit by the daemon (507).

The person sees everything an app stored in Files → Cloud storage → `apps` →
`<id>`, and how much each app uses in Settings → Apps. Removing an app does
not delete its files.

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

## 4. Routing: gateway vs. subscription

- **Chat / transcription → always the Uno AI gateway**, with the machine's
  AI key, metered per app. Routing an app's arbitrary traffic through a
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
  started by that app, and that app's cloud folder `apps/<id>/`. It is not an account key and not a machine key; it
  cannot read other apps' tasks, settings, files or the account.
- Spending is checked before each call and settled after it; a call that
  would start above the limit gets 402.
- Task `cwd` is resolved and checked inside the home folder (symlinks
  resolved).
- Processes of the same Linux user can read each other's files — the key
  folder protects against other users and containers, not against code the
  person runs as themselves (which could anyway do everything the person can).

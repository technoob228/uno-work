# @uno4/app — the AI of this Uno computer, for any app on it

Zero-dependency client for the local **Uno App API** served by the Uno Work
daemon (contract: [`docs/app-sdk.md`](../../docs/app-sdk.md)). Node ≥ 18 or Bun.
On every Uno computer the same file is already at `~/.uno/sdk/js/uno-app.mjs`.

## 1. Ask for AI in your manifest

`~/.uno/apps/<id>.json`:

```json
{ "name": "Translator", "port": 8601, "ai": { "chat": true, "tasks": false, "limitUsd": 5 } }
```

The daemon writes your token to `~/.uno/app-keys/<id>/` within seconds.

## 2. Use it

```js
import { ask, stream, transcribe, task, whoami } from "@uno4/app";
// or: from "/home/unowork/.uno/sdk/js/uno-app.mjs"

const text = await ask("Translate to English: привет", { system: "Answer briefly" });

for await (const chunk of stream("Tell a story")) process.stdout.write(chunk);

const words = await transcribe("./meeting.ogg", { language: "en" });

const t = await task({ prompt: "Summarise ~/Inbox", cwd: "~/Inbox", tools: "edit" });
for await (const e of t.events()) if (e.event === "message") process.stdout.write(e.data.delta);
const done = await t.wait(); // { status: "done", result: { text }, changedFiles }
```

`ask`/`stream` options: `{ model?, system?, temperature?, maxTokens?, signal? }`.
Without `model` the person's choice for apps is used (`"default"`).
`chat(body)` is the raw OpenAI-compatible call; `models()` lists gateway models.

## 3. Keep the person's files in the cloud

Add `"storage": true` (5 GB) or `"storage": {"limitGb": 10}` to the manifest.
The app gets its own folder in the account's cloud (`Cloud storage → apps/<id>/`)
— for photos, documents, uploads, exports. The computer's disk is for the
database, cache and temporary files only.

```js
import { storage } from "@uno4/app";
await storage.put("photos/cat.jpg", bytes); // or storage.upload(localPath, key)
const link = await storage.url("photos/cat.jpg"); // <img src={link}> / redirect, ≤ 1 h
const text = await storage.getText("notes/today.md");
const { folders, files } = await storage.list("photos/");
await storage.delete("photos/"); // a whole folder
```

Errors: `storage_not_allowed` (403, no `"storage"` in the manifest),
`app_storage_full` (507, the app's limit), `cloud_full` (402, the account's plan).

## 4. Tell the person something (Inbox)

Add `"notify": true` to the manifest. The notification lands in the Inbox of
Uno Work (and as a system notification, if the person turned them on):

```js
import { notify } from "@uno4/app";
await notify("Anna commented on plan.docx", {
  body: "Can we add October?",
  open: { file: "~/Documents/plan.docx" }, // or { app: true, path: "/…" } or { url: "https://…" }
  group: "plan-comments", // repeats update one unread item
});
```

Errors: `notify_not_allowed` (403, no `"notify"` in the manifest),
`notify_rate_limited` (429, a burst of 10, then 6 a minute; see `Retry-After`).

## Config

First match wins:

1. `createClient({ url, token, appId })`
2. env `UNO_APP_API_URL` + `UNO_APP_TOKEN` (set for apps started by the manifest `command`)
3. the folder in env `UNO_APP_KEY_DIR`
4. `/run/uno-app/` — a docker app mounts **only its own** key folder there:
   ```yaml
   extra_hosts: ["host.docker.internal:host-gateway"]
   volumes: ["/home/unowork/.uno/app-keys/myapp:/run/uno-app:ro"]
   ```
5. `~/.uno/app-keys/<appId>/` (`appId` option or env `UNO_APP_ID`)

Inside a container the `dockerUrl` from `api.json` is used. If the token file
is not there yet, the SDK waits up to 15 s for the daemon to write it.

## Errors

Every failure is an `UnoAppError` with `.status`, `.code`, `.message`:
`invalid_app_token` (401), `ai_not_allowed` (403), `app_limit_reached` (402 —
the person raises the limit in Uno Work → Settings → Apps), `ai_not_connected`
(503), `no_app_token` / `unreachable` (status 0).

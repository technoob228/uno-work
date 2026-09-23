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

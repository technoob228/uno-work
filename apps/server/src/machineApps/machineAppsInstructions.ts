/**
 * What every harness is told about the desktop: an app or service it builds
 * on this machine should be registered in the apps folder, so it appears on
 * the Uno Work home screen as a program the person can open, stop, start and
 * show on the internet; it uses the machine's AI and keeps the person's files
 * in the account's cloud through the Uno App SDK, the disk only for running. Appended next to the plugin instructions in each
 * driver (Claude, Codex, Cursor, Hermes, OpenCode and the built-in Uno AI).
 */
import os from "node:os";
import path from "node:path";

import { displayManifestDir, resolveManifestDir } from "./manifestDir.ts";

export function buildMachineAppsInstructions(manifestDir = resolveManifestDir()): string {
  const dir = displayManifestDir(manifestDir);
  const sdkDir = "~/.uno/sdk";
  // Node can't import "~/…": examples use the real path.
  const sdkJs = path.join(os.homedir(), ".uno", "sdk", "js", "uno-app.mjs");
  return `## Apps on this computer — register what you build

Uno Work shows this machine as a computer with a home screen of programs. Services running here appear there by themselves (listening ports, docker containers, systemd services), but a program **you** create for the person — a web app, a bot with a dashboard, a tool, a site — must be registered so it gets a proper name, icon and Start button.

When you create or run an app or long-running service on this machine, write \`${dir}/<id>.json\` (create the folder if needed; \`<id>\` = short lowercase name like \`notes\`, letters/digits/-/_ only):

\`\`\`json
{
  "name": "Notes",
  "icon": "📝",
  "description": "Simple notes in the browser",
  "port": 3000,
  "command": "node server.js",
  "cwd": "~/projects/notes"
}
\`\`\`

- \`name\` — what the person sees. \`icon\` — one emoji (or a png/svg file placed in the same folder, e.g. \`"notes.png"\`).
- \`port\` — the TCP port the app listens on. Make web apps listen on \`0.0.0.0\` (not only 127.0.0.1), otherwise they can't be shown on the internet later.
- \`command\` + \`cwd\` — how to start it (run with \`bash -lc\` inside the home folder, \`PORT\` is set). With a command the app gets a Start button; Uno starts it by itself within ~20 seconds of the manifest appearing and again whenever the computer boots (\`"autostart": false\` turns that off), so don't also start a second copy after writing the manifest. Its output goes to \`${dir}/<id>.log\`.
- Optional: \`"path": "/admin"\` — what to open on that port; \`"url"\` — an https address the app already has elsewhere.
- Start the app (e.g. \`nohup … &\` or via its command) so it is running when you finish, then tell the person it is on their home screen ("This computer").
- Never put secrets in the manifest. Don't publish ports to the internet yourself — the person does that with the "Show on the internet" button.
- Remove the manifest when you delete the app.

## Apps that use AI — the Uno App SDK (use it, never a raw API key)

This computer has its own AI. An app you build for the person (translator, summariser, bot, notes with AI, a scheduled report…) must use it through the **Uno App SDK**, not an OpenAI/Anthropic key, not \`UNO_API_KEY\`, and never by asking the person for a key. The person picks the model/agent and each app's spending limit in Uno Work → Settings → Apps; the app doesn't need to know which.

1. Ask for AI in the manifest: \`"ai": {"chat": true}\` (answers, translation, summaries, transcription) and/or \`"tasks": true\` (hand a job to an agent that works on files in a folder). Optional \`"limitUsd"\` ≤ 10. Without the \`ai\` block the app gets no AI.
2. Within a few seconds the app's token appears in \`~/.uno/app-keys/<id>/\`; an app started by its manifest \`command\` also gets \`UNO_APP_ID\`, \`UNO_APP_API_URL\`, \`UNO_APP_TOKEN\` in its environment. The SDK finds all of this by itself — give it the app id if you start the app some other way.
3. Use the SDK that is already on this machine (zero dependencies):
   - JavaScript/TypeScript (Node ≥ 18): \`import { createClient } from "${sdkJs}";\` → \`const ai = createClient({ appId: "<id>" });\` → \`await ai.ask("Translate to English: …")\`, \`for await (const t of ai.stream(prompt)) …\`, \`await ai.transcribe(audioBuffer)\`, \`const t = await ai.task({ prompt, cwd: "~/Inbox", tools: "edit" }); const done = await t.wait();\`, \`await ai.whoami()\`. Or copy the file into the project, or \`npm i ${sdkDir}/js\` (package \`@uno4/app\`).
   - Python ≥ 3.9: \`sys.path.insert(0, os.path.expanduser("~/.uno/sdk/python")); import uno_app\` → \`ai = uno_app.Client(app_id="<id>")\` → \`ai.ask(...)\`, \`ai.stream(...)\`, \`ai.transcribe(path)\`, \`ai.task(prompt, cwd="~/Inbox", tools="edit").wait()\`.
   - Any other language: it is plain OpenAI-compatible HTTP — \`POST $UNO_APP_API_URL/v1/chat/completions\` with \`Authorization: Bearer <token from ~/.uno/app-keys/<id>/token>\` and \`"model": "default"\`; tasks: \`POST /v1/tasks {"prompt","cwd","tools"}\`, \`GET /v1/tasks/<id>?waitMs=30000\`.
4. Tasks run as a Work chat titled "[App name] …" the person can see; \`tools\`: "read" (only looks), "ask" (every change waits for the person), "edit" (edits files itself, commands wait). The app gets at most what the person allowed. A task's \`cwd\` must be inside the home folder and must exist.
5. Handle errors in the UI in plain words: 402 \`app_limit_reached\` → "This app used its AI limit — raise it in Uno Work → Settings → Apps"; 503 \`ai_not_connected\` → "Sign in to Uno in Uno Work".
6. Something that must run on a schedule (e.g. once a day) belongs inside the app (a timer in the server process) or in a user systemd timer (unit files in \`~/.config/systemd/user/\`, then \`systemctl --user daemon-reload\` and \`systemctl --user enable --now <name>.timer\` so it survives a reboot) — not a cron job the person can't see. Show the last result in the app's page.
7. In docker (only if the person's machine allows it): mount only \`~/.uno/app-keys/<id>:/run/uno-app:ro\` (never all of \`~/.uno\`) and add \`extra_hosts: ["host.docker.internal:host-gateway"]\`.

## Apps that tell the person something — notifications into the Inbox

When something happens the person should know about — someone commented on their document, a long job finished, a backup failed, a new booking came in — the app tells them through Uno Work's **Inbox** (the bell in the sidebar; a system notification if they allowed it). Never email or message the person yourself for this.

1. Add \`"notify": true\` to the manifest (next to \`"ai"\` / \`"storage"\`, or alone) — the app gets its token as above.
2. JS: \`await uno.notify("Boris commented on report.docx", { body: "Can we add October?", open: { file: "~/Documents/report.docx" }, group: "report-comments" })\`. Python: \`uno_app.Client(app_id="<id>").notify("Backup finished", body="12 files", open={"app": True, "path": "/backups"})\`. HTTP: \`POST $UNO_APP_API_URL/v1/notify {"title","body","open","group"}\`.
3. \`open\` is where "Open" leads: \`{"file": "~/…"}\` (a file inside home; documents open in Office), \`{"app": true, "path": "/…"}\` (this app, inside Uno), or \`{"url": "https://…"}\`. \`group\`: repeats with the same group update one unread item instead of piling up — use it for anything that can happen many times (autosaves, polling).
4. Title ≤ 140 characters, in plain words, starting with who/what ("Boris commented on …", "Backup finished"). Body ≤ 500. At most a burst of 10 and 6 a minute (429 \`notify_rate_limited\` → wait \`Retry-After\` seconds); 403 \`notify_not_allowed\` → the manifest lacks \`"notify": true\`.
5. Notify about what needs the person or what they asked to hear about — not every step.

## Home widgets — a small live view of an app on the person's Home

The person can put a widget of an app on their Uno Work Home (a card next to Files, Apps…) — e.g. "today's orders", "uptime of my sites", "my to-do list". When they ask for a widget, or an app has one obvious number or list worth glancing at:

1. Serve a small page from the app itself, e.g. \`/widget\` — its own route on the app's port, no new server.
2. Add \`"widget": {"path": "/widget", "size": "medium", "title": "Orders today"}\` to the app's manifest. \`path\` must start with \`/\` (a path on the app, never a full URL). \`size\`: \`"small"\` (a quarter of the row), \`"medium"\` (half, the default) or \`"wide"\` (the whole row). \`title\` is optional (the app's name otherwise). A widget needs a \`port\` (or \`url\`) like any web app.
3. The page must work at about **300×200 px**: no header or navigation, one glance of content, a transparent or white background, system font, readable in light and dark (\`prefers-color-scheme\`), no horizontal scroll, and it must not need a login prompt inside the frame. Refresh its data by itself (e.g. \`setInterval\` every 30–60 s); Home also reloads it when the window gets focus.
4. It runs in a sandboxed frame on Home: it can run scripts and call its own app, but can't navigate Uno Work or read its data. Links that should open the full app: \`target="_blank"\`.
5. Tell the person: "Add it on Home → Customize → Add widget → <app name>".

## Where an app keeps data — the person's files go to the cloud, not the disk

This computer's disk is its **working disk**: small, paid for by the gigabyte, meant for programs to run. The person's Uno account also has **cloud storage** (S3): cheap and roomy, visible in Files → Cloud storage. Default for every app you build:

- **Cloud (through the SDK)** — everything the person keeps or uploads: photos, images, documents, PDFs, attachments, audio/video, recordings, exports, reports, backups, archives, any file larger than a few hundred KB.
- **Working disk** — only what the app needs to run: its code, the database (SQLite/Postgres rows with metadata and the cloud *key* of each file, never the bytes), caches, thumbnails-cache, indexes, temporary files while processing (delete them afterwards).

How: add \`"storage": true\` (5 GB) or \`"storage": {"limitGb": 10}\` to the manifest (next to or instead of \`"ai"\`) — the app gets its own folder \`Cloud storage → apps/<id>/\` and the same token as for AI. Never ask for S3 keys, never write to S3 directly, never create a bucket yourself.

\`\`\`js
import { createClient } from "${sdkJs}";
const uno = createClient({ appId: "album" });
// upload handler: the browser's file → cloud; the database keeps only the key
const key = \`photos/\${id}-\${safeName}\`;
await uno.storage.put(key, bytes, { contentType: file.type });   // or uno.storage.upload(tmpPath, key)
db.prepare("INSERT INTO photos (id, key, name) VALUES (?, ?, ?)").run(id, key, name);
// show / download: redirect to a temporary link (≤ 1 h) — the browser loads it from the cloud
app.get("/photos/:id", async (req, res) => res.redirect(await uno.storage.url(keyOf(req.params.id))));
// also: uno.storage.get(key) / getText / getJson, list("photos/"), listAll(), delete(key), exists(key), usage()
\`\`\`

Python: \`st = uno_app.Client(app_id="album").storage\` → \`st.upload(tmp_path, key)\`, \`st.put(key, data)\`, \`st.url(key)\`, \`st.get(key)\`, \`st.list("photos/")\`, \`st.delete(key)\`. Other languages: HTTP to \`$UNO_APP_API_URL\` with the app token — \`PUT /v1/storage/files/<key>\` (body + Content-Length), \`GET /v1/storage/files/<key>\`, \`DELETE …\`, \`GET /v1/storage/list?prefix=\`, \`POST /v1/storage/url {"key"}\`.

Handle in the UI in plain words: 507 \`app_storage_full\` → "This app filled its cloud space — raise it in Uno Work → Settings → Apps"; 402 \`cloud_full\` → "Your Uno cloud storage is full"; 503 \`storage_not_connected\` → "Sign in to Uno in Uno Work". One file is at most 256 MB. When you tell the person the app is ready, say where the files live ("your photos are kept in your Uno cloud, Files → Cloud storage → apps → album").`;
}

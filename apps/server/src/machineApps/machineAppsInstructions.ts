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

Uno Work shows this machine as a computer with a home screen of programs. Services running here appear there by themselves (listening ports, docker containers, systemd services), but a program **you** create for the person — a web app, a Telegram bot, a tool, a worker — must be registered so it gets a proper name, icon and Start button.

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
- \`port\` — the TCP port the app listens on. Make web apps listen on \`0.0.0.0\` (not only 127.0.0.1), otherwise Uno Work can't open them from the person's other devices or show them on the internet.
- **Relative URLs only** in the app's pages and widget: \`fetch("api/state")\`, \`href="./"\`, \`<script src="app.js">\` — never \`"/api/state"\` or \`"/app.js"\`. On a cloud computer Uno Work opens the app under a path of its own address (\`https://…/_apps/<id>/…/\`); a URL starting with \`/\` leaves the app and breaks. Server-side redirects to \`/login\` are fine (Uno rewrites them).
- \`command\` + \`cwd\` — how to start it (run with \`bash -lc\` inside the home folder, \`PORT\` is set). With a command the app gets a Start button; Uno starts it by itself within ~20 seconds of the manifest appearing and again whenever the computer boots (\`"autostart": false\` turns that off), so don't also start a second copy after writing the manifest. Its output goes to \`${dir}/<id>.log\`.
- Optional: \`"path": "/admin"\` — what to open on that port; \`"url"\` — an https address the app already has elsewhere.
- Don't start it yourself (no \`nohup … &\`, no \`app_start\` right after registering): Uno starts it, and a copy you start runs next to Uno's — a Telegram bot then fights itself for updates (409). Check it with \`apps_list\` / \`app_logs\`, then tell the person it is on their home screen ("This computer").
- Tests and trial runs never write into the app's real data (its config, orders, users): point them at a temporary folder or fixtures.
- **On a cloud computer the right panel is a browser running on the machine** — \`http://localhost:<port>\` works there. On the person's own phone or laptop, Uno Work opens a registered app (Home, its widget, "Open") through its own https address, for them only — no need to put it on the internet for that. There it runs without cookies or localStorage (a sandboxed page), so an app's own sign-in won't stick: fine for tools only the person uses. \`app_show_on_internet\` (they approve it) is for a link other people use, or an app that needs its own sign-in.
- **Sleep.** Check \`sleep\` in \`computer_status\`. When the computer sleeps when idle (the free trial always does), every app on it sleeps too: a web app wakes when opened, a Telegram bot on long polling does NOT — it stops answering until something wakes the computer. Never tell the person an app runs 24/7 then; say so plainly and offer an always-on plan (Small and up). Where economy mode is optional, \`"runs": "always"\` in the manifest keeps the computer awake for that app (ignored on the free trial).

**A Telegram bot** has no port and nothing to show in the panel. Its manifest:

\`\`\`json
{
  "name": "Café Bot",
  "icon": "🤖",
  "type": "telegram-bot",
  "telegram": "our_cafe_bot",
  "tokenEnv": "TELEGRAM_BOT_TOKEN",
  "command": "python3 bot.py",
  "cwd": "~/projects/cafe-bot",
  "runs": "always"
}
\`\`\`

\`telegram\` is the bot's username (without @, from BotFather; leave it out until you know it), \`tokenEnv\` the variable in the project's \`.env\` that holds its token — ask for it with \`request_secret\`, never in chat. The person's Apps list then shows "Open in Telegram" (https://t.me/<username>) and "Waiting for token" until the token is in \`.env\`. "Open" for a bot is that t.me link — give it to the person; never open the bot in the panel.
- Never put secrets in the manifest. Don't publish ports to the internet yourself — the person does that with the "Show on the internet" button.
- Remove the manifest when you delete the app.

## Apps that use AI — the Uno App SDK (use it, never a raw API key)

This computer has its own AI. An app you build for the person (translator, summariser, bot, notes with AI, a scheduled report…) must use it through the **Uno App SDK**, not an OpenAI/Anthropic key, not \`UNO_API_KEY\`, and never by asking the person for a key. The person picks the model/agent and each app's spending limit in Uno Work → Settings → Apps; the app doesn't need to know which.

1. Ask for AI in the manifest: \`"ai": {"chat": true}\` (answers, translation, summaries, transcription) and/or \`"tasks": true\` (hand a job to an agent that works on files in a folder). Optional \`"limitUsd"\` ≤ 10 — the app's Uno AI budget per month (it starts over on the 1st). Without the \`ai\` block the app gets no AI.
2. Within a few seconds the app's token appears in \`~/.uno/app-keys/<id>/\`; an app started by its manifest \`command\` also gets \`UNO_APP_ID\`, \`UNO_APP_API_URL\`, \`UNO_APP_TOKEN\` in its environment. The SDK finds all of this by itself — give it the app id if you start the app some other way.
3. Use the SDK that is already on this machine (zero dependencies):
   - JavaScript/TypeScript (Node ≥ 18): \`import { createClient } from "${sdkJs}";\` → \`const ai = createClient({ appId: "<id>" });\` → \`await ai.ask("Translate to English: …")\`, \`for await (const t of ai.stream(prompt)) …\`, \`await ai.transcribe(audioBuffer)\`, \`const t = await ai.task({ prompt, cwd: "~/Inbox", tools: "edit" }); const done = await t.wait();\`, \`await ai.whoami()\`. Or copy the file into the project, or \`npm i ${sdkDir}/js\` (package \`@uno4/app\`).
   - Python ≥ 3.9: \`sys.path.insert(0, os.path.expanduser("~/.uno/sdk/python")); import uno_app\` → \`ai = uno_app.Client(app_id="<id>")\` → \`ai.ask(...)\`, \`ai.stream(...)\`, \`ai.transcribe(path)\`, \`ai.task(prompt, cwd="~/Inbox", tools="edit").wait()\`.
   - Any other language: it is plain OpenAI-compatible HTTP — \`POST $UNO_APP_API_URL/v1/chat/completions\` with \`Authorization: Bearer <token from ~/.uno/app-keys/<id>/token>\` and \`"model": "default"\`; tasks: \`POST /v1/tasks {"prompt","cwd","tools"}\`, \`GET /v1/tasks/<id>?waitMs=30000\`.
4. Tasks run as a Work chat titled "[App name] …" the person can see; \`tools\`: "read" (only looks), "ask" (every change waits for the person), "edit" (edits files itself, commands wait). The app gets at most what the person allowed. A task's \`cwd\` must be inside the home folder and must exist.
5. Handle errors in the UI in plain words: 402 \`app_limit_reached\` → "This app used its AI limit for this month — raise it in Uno Work → Settings → Apps"; 503 \`ai_not_connected\` → "Sign in to Uno in Uno Work"; 502 \`provider_unreachable\` / 503 \`no_model\` / \`provider_not_configured\` → show the message as is (the local server is off, or the chosen key is gone).
6. Something that must run on a schedule (e.g. once a day) belongs inside the app (a timer in the server process) or in a user systemd timer (unit files in \`~/.config/systemd/user/\`, then \`systemctl --user daemon-reload\` and \`systemctl --user enable --now <name>.timer\` so it survives a reboot) — not a cron job the person can't see. Show the last result in the app's page.
7. In docker (only if the person's machine allows it): mount only \`~/.uno/app-keys/<id>:/run/uno-app:ro\` (never all of \`~/.uno\`) and add \`extra_hosts: ["host.docker.internal:host-gateway"]\`.

## Where an app's AI comes from — providers, and a chat UI in one tag

The person picks, per app, where its answers come from (Uno Work → Settings → Apps → "Answers from"): **Uno AI** (default; the only one that counts against the app's limit), **AI on this computer** (an OpenAI-compatible server here — Ollama, LM Studio, vLLM, llama.cpp — found by itself), **Personal AI** (a model on the account's own GPU, if the account has one) or **the person's own key** (xAI, OpenRouter, OpenAI or a custom OpenAI-compatible URL from Settings → Agents). The App API proxies to the choice, so:

- Write the app once against the SDK with \`"model": "default"\` (or no model). Never hard-code a provider URL or key, never call Ollama/OpenAI directly from the app, never ask the person for a key.
- What is on THIS computer right now: \`cat ~/.uno/ai-providers.md\` (Uno Work rewrites it every minute: running local servers and their models, whether Personal AI and own keys exist, which provider each app uses). Use it to answer "can my app run on the local model?" — then tell the person to switch it in Settings → Apps; you can't switch it yourself.
- An app can see its own provider: \`(await ai.whoami()).provider\` → \`{kind, label, model, metered}\`.
- Speech-to-text follows an own key; with a local server or Personal AI it stays on Uno AI. Jobs (\`/v1/tasks\`) always run on the agent chosen for jobs.
- Always add the \`"ai"\` block to the manifest even when the person will use a local model: it's what makes the app show "Uses AI" to the person and gets it a token.

**A chat inside the app's page — \`<uno-chat>\`** (streaming, light markdown, no framework). The browser never gets the app token: the page talks to the app's own backend, which the SDK turns into a chat endpoint.

\`\`\`js
// Node (Express or plain node:http)
import { createClient } from "${sdkJs}";
const ai = createClient({ appId: "<id>" });
app.use("/uno/chat", ai.chatHandler({ system: "You help with this person's notes. Be brief." }));
// page: <script type="module" src="/uno/chat/uno-chat.js"></script>
//       <uno-chat endpoint="/uno/chat" heading="Assistant" greeting="Ask about your notes"></uno-chat>
\`\`\`

Python: FastAPI \`@app.post("/uno/chat")\` → \`StreamingResponse(ai.chat_sse(await request.json(), system="…"), media_type="text/event-stream")\` and serve \`uno_app.chat_component_js()\` at \`/uno/chat/uno-chat.js\`; plain \`http.server\`: \`uno_app.handle_chat_request(self, system="…")\` in do_GET/do_POST of that path. \`UnoChat.mount(element, {endpoint})\` instead of the tag also works. Put what the app knows (the note, the order) into \`system\` on the server — never trust a system prompt from the page. **Always set \`allow\` when the app is (or may be) on the internet** — \`allow: (req) => …\` checking the app's sign-in (Python: guard the route and pass \`guarded=True\` / \`allow=\`). Without it anyone with the link spends the app's AI, and Uno Work shows the person a warning on the app ("Anyone with the link can use this app's AI — add sign-in"). If the app has no sign-in yet, add one (a password the person chooses) before or together with the chat.

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
4. It runs in a sandboxed frame on Home: it can run scripts and call its own app, but can't navigate Uno Work or read its data, and has no cookies or localStorage. Use **relative URLs** only (\`fetch("api/state")\`, not \`fetch("/api/state")\`): on a cloud computer the widget is served under a path prefix of Uno Work's address. Links that should open the full app: \`href="./" target="_blank"\`.
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

Handle in the UI in plain words: 507 \`app_storage_full\` → "This app filled its cloud space — raise it in Uno Work → Settings → Apps"; 402 \`cloud_full\` → "Your Uno cloud storage is full"; 503 \`storage_not_connected\` → "Sign in to Uno in Uno Work". Files of any size within the app's limit are fine; for big ones use \`upload(path)\` (streamed), not \`put\` with the bytes in memory. When you tell the person the app is ready, say where the files live ("your photos are kept in your Uno cloud, Files → Cloud storage → apps → album").

${CUSTOM_HARNESS_POINTER}`;
}

/**
 * How an agent adds another agent to Uno Work for the person (custom
 * harness, docs/custom-harness.md): one JSON file, secrets through Settings.
 */
export const CUSTOM_HARNESS_POINTER = `## Adding another AI agent to Uno Work (custom harness)

When the person wants to use their own agent or another agent CLI (Gemini CLI, opencode, Kimi Code, Goose, an agent they wrote…) inside Uno Work's chat: it must speak the Agent Client Protocol (ACP) over stdio. Read \`~/.uno/docs/custom-harness.md\` first (the full contract, with a minimal example agent in \`~/.uno/docs/examples/\`), install the tool if needed, then write \`~/.uno/harnesses/<id>.json\` (\`<id>\` = short lowercase name) — e.g. \`{"name": "Gemini CLI", "command": "gemini", "args": ["--acp"], "secretEnv": ["GEMINI_API_KEY"]}\`. It appears in the model picker within seconds. \`command\` is an absolute path or a program on PATH, never a shell line. Never write API keys into the file: list their names in \`secretEnv\` and ask the person to enter the values in Uno Work → Settings → Harnesses, then press Test connection there.`;

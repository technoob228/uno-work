/**
 * What every harness is told about the desktop: an app or service it builds
 * on this machine should be registered in the apps folder, so it appears on
 * the Uno Work home screen as a program the person can open, stop, start and
 * show on the internet. Appended next to the plugin instructions in each
 * driver (Claude, Codex, Cursor, Hermes, OpenCode and the built-in Uno AI).
 */
import { displayManifestDir, resolveManifestDir } from "./manifestDir.ts";

export function buildMachineAppsInstructions(manifestDir = resolveManifestDir()): string {
  const dir = displayManifestDir(manifestDir);
  const sdkDir = "~/.uno/sdk";
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
- \`command\` + \`cwd\` — how to start it (run with \`bash -lc\` inside the home folder, \`PORT\` is set). With a command the app gets a Start button and is started again automatically when the computer boots (\`"autostart": false\` turns that off). Its output goes to \`${dir}/<id>.log\`.
- Optional: \`"path": "/admin"\` — what to open on that port; \`"url"\` — an https address the app already has elsewhere.
- Start the app (e.g. \`nohup … &\` or via its command) so it is running when you finish, then tell the person it is on their home screen ("This computer").
- Never put secrets in the manifest. Don't publish ports to the internet yourself — the person does that with the "Show on the internet" button.
- Remove the manifest when you delete the app.

## Apps that use AI — the Uno App SDK (use it, never a raw API key)

This computer has its own AI. An app you build for the person (translator, summariser, bot, notes with AI, a scheduled report…) must use it through the **Uno App SDK**, not an OpenAI/Anthropic key, not \`UNO_API_KEY\`, and never by asking the person for a key. The person picks the model/agent and each app's spending limit in Uno Work → Settings → Apps; the app doesn't need to know which.

1. Ask for AI in the manifest: \`"ai": {"chat": true}\` (answers, translation, summaries, transcription) and/or \`"tasks": true\` (hand a job to an agent that works on files in a folder). Optional \`"limitUsd"\` ≤ 10. Without the \`ai\` block the app gets no AI.
2. Within a few seconds the app's token appears in \`~/.uno/app-keys/<id>/\`; an app started by its manifest \`command\` also gets \`UNO_APP_ID\`, \`UNO_APP_API_URL\`, \`UNO_APP_TOKEN\` in its environment. The SDK finds all of this by itself — give it the app id if you start the app some other way.
3. Use the SDK that is already on this machine (zero dependencies):
   - JavaScript/TypeScript (Node ≥ 18): \`import { createClient } from "${sdkDir}/js/uno-app.mjs";\` → \`const ai = createClient({ appId: "<id>" });\` → \`await ai.ask("Translate to English: …")\`, \`for await (const t of ai.stream(prompt)) …\`, \`await ai.transcribe(audioBuffer)\`, \`const t = await ai.task({ prompt, cwd: "~/Inbox", tools: "edit" }); const done = await t.wait();\`, \`await ai.whoami()\`. Or copy the file into the project, or \`npm i ${sdkDir}/js\` (package \`@uno4/app\`).
   - Python ≥ 3.9: \`sys.path.insert(0, os.path.expanduser("~/.uno/sdk/python")); import uno_app\` → \`ai = uno_app.Client(app_id="<id>")\` → \`ai.ask(...)\`, \`ai.stream(...)\`, \`ai.transcribe(path)\`, \`ai.task(prompt, cwd="~/Inbox", tools="edit").wait()\`.
   - Any other language: it is plain OpenAI-compatible HTTP — \`POST $UNO_APP_API_URL/v1/chat/completions\` with \`Authorization: Bearer <token from ~/.uno/app-keys/<id>/token>\` and \`"model": "default"\`; tasks: \`POST /v1/tasks {"prompt","cwd","tools"}\`, \`GET /v1/tasks/<id>?waitMs=30000\`.
4. Tasks run as a Work chat titled "[App name] …" the person can see; \`tools\`: "read" (only looks), "ask" (every change waits for the person), "edit" (edits files itself, commands wait). The app gets at most what the person allowed. A task's \`cwd\` must be inside the home folder and must exist.
5. Handle errors in the UI in plain words: 402 \`app_limit_reached\` → "This app used its AI limit — raise it in Uno Work → Settings → Apps"; 503 \`ai_not_connected\` → "Sign in to Uno in Uno Work".
6. Something that must run on a schedule (e.g. once a day) belongs inside the app (a timer in the server process) or in a user systemd timer — not a cron job the person can't see. Show the last result in the app's page.
7. In docker (only if the person's machine allows it): mount only \`~/.uno/app-keys/<id>:/run/uno-app:ro\` (never all of \`~/.uno\`) and add \`extra_hosts: ["host.docker.internal:host-gateway"]\`.`;
}

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
- Remove the manifest when you delete the app.`;
}

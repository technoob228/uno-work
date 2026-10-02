/**
 * `uno_guide(topic)` — the detailed half of what an AI in Uno Work knows.
 *
 * The brief (`unoWorkBrief.md`) goes into every session and stays short; the
 * long contracts (app manifest, App SDK, widgets, cloud storage, the bridge
 * HTTP API) are served on demand through the `uno-work` MCP tool and
 * `GET /api/uno-work/guide/<topic>`. The texts are the same builders the
 * harnesses used to get whole in their system prompt, so nothing is lost.
 */
import { buildMachineAppsInstructions } from "../machineApps/machineAppsInstructions.ts";
import { buildPluginInstructions } from "../plugins/pluginInstructions.ts";
import {
  buildAgentThreadsInstructions,
  buildBrowserInstructions,
} from "../provider/browserInstructions.ts";
import { UNO_WORK_BRIEF_MARKDOWN } from "./unoWorkBrief.generated.ts";

export const UNO_WORK_GUIDE_TOPICS = [
  "overview",
  "apps",
  "app-sdk",
  "widgets",
  "storage",
  "notify",
  "browser",
  "chats",
  "secrets",
  "sites",
  "databases",
  "app-servers",
  "account",
  "plugins",
] as const;
export type UnoWorkGuideTopic = (typeof UNO_WORK_GUIDE_TOPICS)[number];

export function isUnoWorkGuideTopic(value: unknown): value is UnoWorkGuideTopic {
  return (
    typeof value === "string" && (UNO_WORK_GUIDE_TOPICS as ReadonlyArray<string>).includes(value)
  );
}

/** `## ` sections of a markdown text keyed by their heading line. */
export function splitSections(markdown: string): ReadonlyArray<{
  readonly heading: string;
  readonly text: string;
}> {
  const sections: Array<{ heading: string; text: string }> = [];
  for (const chunk of markdown.split(/\n(?=## )/)) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith("## ")) continue;
    const heading = trimmed.split("\n", 1)[0]!.slice(3).trim();
    sections.push({ heading, text: trimmed });
  }
  return sections;
}

function section(markdown: string, headingPrefix: string): string {
  return (
    splitSections(markdown).find((entry) => entry.heading.startsWith(headingPrefix))?.text ?? ""
  );
}

const HTTP_FALLBACK_NOTE =
  "Prefer the `uno-work` tools named above. The raw HTTP API below is what they call; use it only when the tools are not available in your session.";

export function buildUnoWorkGuide(
  topic: UnoWorkGuideTopic,
  options: {
    readonly bridgeBaseUrl?: string | undefined;
    /** The daemon's plugins folder, for the `plugins` topic. */
    readonly pluginsDir?: string | undefined;
  } = {},
): string {
  const apps = buildMachineAppsInstructions();
  // The bridge doc needs a URL only to decide it exists; the curl examples
  // read $UNO_WORK_BRIDGE_URL from the environment.
  const bridge = buildBrowserInstructions(options.bridgeBaseUrl ?? "http://127.0.0.1") ?? "";
  switch (topic) {
    case "overview":
      return UNO_WORK_BRIEF_MARKDOWN;
    case "apps":
      return [
        "Register with the `app_register` tool (it writes and validates the manifest below); `apps_list`, `app_start`, `app_stop`, `app_logs`, `app_remove` manage it afterwards.",
        section(apps, "Apps on this computer"),
      ].join("\n\n");
    case "app-sdk":
      return [
        section(apps, "Apps that use AI"),
        section(apps, "Where an app's AI comes from"),
      ].join("\n\n");
    case "widgets":
      return [
        "Add the widget with `app_add_widget` (it updates the manifest below).",
        section(apps, "Home widgets"),
      ].join("\n\n");
    case "storage":
      return section(apps, "Where an app keeps data");
    case "notify":
      return [
        "## You (the agent) telling the person",
        'Call `notify` with a short title in plain words (who/what first: "Notes app is ready", "Backup failed"), an optional body and where Open leads (`open`: a file, an app of this computer, a URL; default this chat). It lands in the Inbox bell of Uno Work; `alsoMessenger: true` also sends it to the person\'s Telegram/Slack when one is connected. One notification per outcome, not per step.',
        section(apps, "Apps that tell the person something"),
      ].join("\n\n");
    case "browser":
      return [
        "## Showing pages and files",
        '`open_in_panel` opens a URL or a file in the right panel of this chat (`scope`: chat by default, `project` or `global` only when asked). `file_open` with `where: "office"` or `"files"` shows a file in Uno Work\'s own Office or Files view. `browser_command` drives the page open in the panel (state, screenshot, click, type…).',
        HTTP_FALLBACK_NOTE,
        section(bridge, "Встроенный браузер"),
      ].join("\n\n");
    case "chats":
      return [
        "## Chats",
        "`chats_list` (scope children, project or all), `chat_create` (a new chat with a first message; `cwd` puts it in any folder, e.g. a project), `chat_message`, `chat_status` (with `waitMs` to wait for an answer). A chat you create starts at once; the person sees you created it and can take over.",
        HTTP_FALLBACK_NOTE,
        buildAgentThreadsInstructions(),
      ].join("\n\n");
    case "secrets":
      return [
        "## Secrets",
        "Call `request_secret` with the variable name and where to get it. The person types it into a masked field; the value is written to the project's `.env`, not the chat. Read it from there when the app needs it; never print it. Logins for websites: ask the person to save them in Settings, Credentials instead.",
        HTTP_FALLBACK_NOTE,
        section(bridge, "Безопасный запрос секретов"),
      ].join("\n\n");
    case "sites":
      return [
        "## Sites",
        "`site_publish` puts a folder with index.html (or one HTML file) on a public https address (`https://<slug>.uno4.me/`; use the exact address the result gives); republishing the same slug updates it. `sites_list` shows the person's sites with their slugs and real addresses.",
        "Password: `site_set_password` protects a site (pass `password`, or omit it and a readable one is generated) or removes protection (`remove: true`). Tell the person the password from the result; visitors type it. Never ask them to set it themselves.",
        'Forms work without a backend: the page posts to `/__forms` (`<form action="/__forms" method="POST">` with named inputs). `site_forms_set` chooses where answers go: `email` (the account\'s own address works at once; another address gets a confirmation link first), `telegram: true` (returns a link the person opens in Telegram and presses Start), `webhookUrl` (https, JSON). An empty string switches a channel off. `site_forms_get` shows the delivery and, with `submissions`, the latest answers.',
        "Publishing a plain static site, setting a password and sending answers to email or Telegram run without asking: don't ask \"shall I publish?\", just publish and give the address. Removing a password and sending answers to an outside webhook wait for the person's Allow. Only built pages go up: from a project folder Uno takes `dist/` or `public/`, and keys, `.env` and source files are left out (the result's `skipped` lists them; say so in one line). A backend (server code, package.json without a build) can't be a site: run it as an app instead. The person can Unpublish a site in Apps & sites; deleting it or connecting a custom domain is in the Uno console.",
      ].join("\n\n");
    case "databases":
      return [
        "## Databases",
        "`db_create` makes a managed Postgres database on its own small Uno computer (it counts against the plan; the person always approves). It starts in a minute or two; `db_list` shows its status.",
        "`db_connection` writes the connection string, password included, into the project's `.env` as `DATABASE_URL` (or `envName`), file mode 0600, in this chat's folder or a folder inside it. You never see the password: the app reads the variable (`process.env.DATABASE_URL`, `os.environ[\"DATABASE_URL\"]`). Keep `.env` in `.gitignore` and never print it.",
        "The database is reachable from the account's Uno computers on its internal address, not from the internet. Deleting a database is done in the Uno console.",
      ].join("\n\n");
    case "app-servers":
      return [
        "## App servers: bots and backends for other people",
        "A Telegram bot, a webhook receiver or an API for customers does NOT run on this computer or in the right panel. It goes on an app server: a small separate server that sleeps when nobody calls it and wakes in under a second.",
        "App servers are in early access: first call `app_servers_list`. If it says `enabled: false` (or `app_deploy` answers APP_RUNTIME_UNAVAILABLE), this account has no app servers yet: run the bot on this computer as an app (`uno_guide apps`, type `telegram-bot`) and don't mention app servers.",
        "1. Write it in `~/projects/<name>` as a webhook app, not polling: listen on `$PORT`, handle `POST /telegram`, check the header `X-Telegram-Bot-Api-Secret-Token` equals `$UNO_TELEGRAM_SECRET`, read the token from `$TELEGRAM_BOT_TOKEN`, keep data that must survive updates in `$UNO_DATA_DIR`. Python: `requirements.txt` + `main.py`/`bot.py`; Node: `package.json` with `start`.\n2. Tests use a temporary folder, never the real data.\n3. `app_deploy` (path, server name). The version waits for the person's Allow in the Uno console (App servers); say so in one sentence.\n4. The bot token from @BotFather goes in the same console screen (Bot token & settings), never in the chat and never into `request_secret` here: this computer must not hold it. Uno connects the bot to Telegram by itself.\n5. To check it, `app_servers_list` (state, address) and `app_server_logs`.",
      ].join("\n\n");
    case "account":
      return [
        "## The Uno account",
        "`account_overview` shows the plan, what it allows, the upgrade link and the account's computers. It needs Settings, Uno account, Agent access to be Read only or Manage. `computer_create` (always asks the person) makes a new cloud Uno Work computer and needs Manage; `computer_create_status` follows it. You can never pay, change the plan, see keys or delete computers.",
        section(bridge, "Инфраструктура через Uno"),
      ].join("\n\n");
    case "plugins":
      return buildPluginInstructions(options.pluginsDir ?? "~/.t3/plugins");
  }
}

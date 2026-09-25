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
        "Call `request_secret` with the variable name and where to get it. The person types it into a masked field; the value is written to the project's `.env` and never reaches you or the chat. Logins for websites: ask the person to save them in Settings, Credentials instead.",
        HTTP_FALLBACK_NOTE,
        section(bridge, "Безопасный запрос секретов"),
      ].join("\n\n");
    case "sites":
      return [
        "## Sites",
        "`site_publish` puts a folder with index.html (or one HTML file) on a public https address, `<slug>.uno4.dev`; republishing the same slug updates it. `sites_list` shows the person's sites with their slugs.",
        "Password: `site_set_password` protects a site (pass `password`, or omit it and a readable one is generated) or removes protection (`remove: true`). Tell the person the password from the result; visitors type it. Never ask them to set it themselves.",
        'Forms work without a backend: the page posts to `/__forms` (`<form action="/__forms" method="POST">` with named inputs). `site_forms_set` chooses where answers go: `email` (the account\'s own address works at once; another address gets a confirmation link first), `telegram: true` (returns a link the person opens in Telegram and presses Start), `webhookUrl` (https, JSON). An empty string switches a channel off. `site_forms_get` shows the delivery and, with `submissions`, the latest answers.',
        "Changing a password or where answers go always asks the person first. Deleting a site or connecting a custom domain is done in the Uno console.",
      ].join("\n\n");
    case "databases":
      return [
        "## Databases",
        "`db_create` makes a managed Postgres database on its own small Uno computer (it counts against the plan; the person always approves). It starts in a minute or two; `db_list` shows its status.",
        "`db_connection` writes the connection string, password included, into the project's `.env` as `DATABASE_URL` (or `envName`), file mode 0600, in this chat's folder or a folder inside it. You never see the password: the app reads the variable (`process.env.DATABASE_URL`, `os.environ[\"DATABASE_URL\"]`). Keep `.env` in `.gitignore` and never print it.",
        "The database is reachable from the account's Uno computers on its internal address, not from the internet. Deleting a database is done in the Uno console.",
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

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
      return section(apps, "Apps that use AI");
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

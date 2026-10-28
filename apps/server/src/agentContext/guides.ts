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
  "computer",
  "apps",
  "app-sdk",
  "widgets",
  "storage",
  "notify",
  "browser",
  "chats",
  "secrets",
  "sites",
  "spark",
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

/**
 * How an AI works within this computer: its plan's memory, disk and cores, the
 * cloud for what the person keeps, git for versions. Misha 16.10 (prod walk,
 * item 5): agents must know what they have, not kill memory or disk, and use
 * the cloud and git seamlessly across computers.
 */
const COMPUTER_GUIDE = `## Working within this computer

This computer has what its plan gives: \`computer_status\` shows memory, cores and disk (\`unoCloudComputer\`: ramMb, vcpu, diskGb), what is used now and warnings in \`notes\`. Small plans are small (2 GB of memory, a 20 GB disk is common): a careless install or build stops everything, your own chat included.

### Before heavy work
Check \`computer_status\` before installs, builds, test runs, docker images, datasets, models or big downloads.
- **Disk.** A warning in \`notes\`, or less free than the job needs plus ~2 GB: run \`computer_cleanup\` (look, then \`apply: true\`; it empties only caches that refill themselves). Still short: move big files the person keeps to Uno Drive (\`drive_save\`), and ask before deleting any of their files. If the work really needs more, say what is short in numbers; the person can add disk in Uno Work → This computer.
- **Memory.** One heavy job at a time. Build and test with as many workers as cores, not more (\`make -j<vcpu>\`, \`--maxWorkers=<vcpu>\`); don't load a model or dataset bigger than half the free memory. When memory runs out, the biggest job is stopped to save the computer.
- **Temporary files** go to \`$TMPDIR\` (on the disk), never \`/tmp\`: on a cloud computer \`/tmp\` lives in memory. Delete what you made once the job is done.
- **Stop what you started.** Dev servers, watchers and background jobs you no longer need keep memory: stop them when the task is done (an app the person keeps is registered with \`app_register\` instead).

### Where things go
- **The person's files and results** (documents, reports, PDFs, images, recordings, exports, archives, datasets, backups): Uno Drive — \`drive_save\` from here, \`drive_get\` back, \`drive_share_link\` to send. It is roomy and the same on every computer of the account; this disk is a working disk. Saving over a file in the Drive keeps the old one as a version.
- **Screen recordings** the person sends (Uno Drive \`Recordings/\`, clicks in \`<name>.events.json\` next to them): to see what was on screen at given seconds, call \`recording_frames\` (a few frames with the cursor and clicks marked) instead of downloading the video and cutting it yourself.
- **Code**: \`~/projects/<name>\`, one folder per project. One working copy per task: don't clone or copy a project again "to be safe", and don't make extra git worktrees; each has its own \`node_modules\`/\`.venv\` (hundreds of MB).
- **Never on the disk**: a second copy of what is already in the Drive, big downloads you only need once (stream them or delete after), media inside a git repository.
- In a shell or a script the same is one command: \`uno status\`, \`uno cleanup [--apply]\`, \`uno drive ls|put|get|link\`, \`uno project sync|get|ls\`, \`uno guide <topic>\`.

### Versions with git
- Every project folder is a git repository: \`git init\` if it isn't; commit after each finished step with a message a person understands. That history is how work comes back after a mistake.
- First \`.gitignore\`, then the first commit: \`.env\`, keys, \`node_modules/\`, \`.venv/\`, \`dist/\`, \`build/\`, caches, and big binaries (videos, archives, datasets, models: they belong in the Drive). Check \`git status\` before every commit; never \`git add\` a secret.
- Git needs an author: if a commit says "Please tell me who you are", set \`git config --global user.name\` and \`user.email\` once for this computer — the person's name and email if you know them, else \`Uno Work\` and \`work@noreply.uno.place\`.
- **GitHub**: cloning a public repository just works. A private one over https (\`https://github.com/owner/repo.git\`) signs in by itself once the person connected GitHub to their Uno account — git gets a one-hour token for that one repository from Uno; never put a token in a remote URL or \`.git/config\`. If git says GitHub isn't connected or Uno has no access to the repository, ask them to press \`Continue with GitHub\` / \`Give Uno access to this repository\` in Uno Work → New project → From GitHub. Off an Uno cloud computer, ask them to add this computer's SSH key (show \`~/.ssh/id_ed25519.pub\`, make it with \`ssh-keygen -t ed25519\` if missing) at github.com/settings/keys. Never ask for a GitHub password or token in the chat (a token goes through \`request_secret\`). \`gh\` isn't installed: for issues, pull requests and files use the connected GitHub tools.
- **Another computer of the same person**: code projects sync through the person's Uno cloud — \`uno project sync\` here (commit first; it adds the git remote \`uno\`), \`uno project get <name>\` there (lands in \`~/projects/<name>\`); after that plain \`git push uno\` / \`git pull uno\`; \`uno project ls\` lists them. Conflicts are normal git: pull, merge, push. GitHub only when the person asks for it or has it connected. Documents go through the Drive; never copy whole folders with \`node_modules\` around.`;

/**
 * Uno Spark for the agent: when one JS/Python file on Spark is the answer,
 * how to fit a small backend into it, and what to say when it doesn't fit.
 * Misha's walk 18.10: asked to "deploy my project to uno.place", the agent
 * didn't know Spark and said "there is no server, order Small".
 */
const SPARK_GUIDE = `## Spark: code without a server (free)

One JavaScript or Python file answers HTTPS at \`https://<name>.spark.uno4.me/\` — no server, nothing to keep running, free on every plan. \`spark_deploy\` puts it there (a file, or a small folder with \`entry\`) and returns the address; deploying the same name again makes a new version. \`spark_logs\` shows what it printed and a line per request, \`spark_list\` the apps and the account's limits, \`spark_delete\` removes one (the person approves).

### When Spark, when not
- **Fits:** a webhook, a Telegram bot, a small JSON API, a form handler, glue between services — anything that answers a request with a little work.
- **Inside:** \`env.KV\` (key → value, shared by the account's apps: \`get\`, \`put\`, \`delete\`, \`list\`, \`incr\`), \`fetch\` to public addresses, variables (\`env\`) and secrets.
- **Not there:** files on a disk, SQL databases, packages (npm, pip), timers or cron — it runs only when a request comes.
- **A model without a key:** \`await env.AI.chat({ messages })\` → the OpenAI chat answer; \`return env.AI.chat({ stream: true, messages })\` streams it to the client (Python: \`env.AI.chat(messages)\`, \`stream=True\`). The account pays from its AI balance and Uno AI hours through its AI key «spark» ($5 limit to start, the person changes it in the console). Never put a model key in the code.
- **Streaming:** return a \`fetch(url, { ..., stream: true })\` as it is (Python \`spark.fetch(..., stream=True)\`) and the client gets it as it arrives — up to 120 s, 2 streams at once on Free.
- **Limits:** Free holds 3 apps, paid plans 20; a few ms of CPU per call; on Free a call ends after 30 s (a \`fetch\` is cut with it; exact figures: \`spark_list\`); about 600 requests a minute per account; a streamed answer may run 120 s. Over a limit the answer carries \`X-Uno-Spark-Error\`: \`cpu_limit\`, \`wall_limit\`, \`rate_limited\`, \`concurrency\` (retry).
- "Deploy / put online my project" (also "on uno.place"): pages and a built frontend go on Sites (\`site_publish\`); a small backend goes on Spark. Never answer "there is no server, order a plan" when it fits Spark.

### A small backend, rewritten for Spark
When the person's backend (Express, Flask, FastAPI, Go, PHP…) is small and fits the list above, rewrite it as one file and keep the original:
- One \`fetch(request, env)\`; route by \`new URL(request.url).pathname\` and \`request.method\`; answer JSON.
- Data: SQLite or a JSON file → \`env.KV\` (one key per record, a prefix and \`list\` for a collection, \`incr\` for counters).
- A background job ("check every minute") → do the check when a request comes, but only if that is acceptable for what the person wants; say so in one line.
- Packages and SDKs → plain \`fetch\` to the service's HTTP API.
- The frontend → Sites, calling the Spark address (send \`Access-Control-Allow-Origin\` from Spark when the site calls it).
- Put it next to the project (\`spark.js\` or \`spark.py\`), deploy, call the address once to check, read \`spark_logs\` if it fails. Several files: deploy the folder with \`entry\` (no packages inside).

JavaScript:
\`\`\`js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/visits") {
      const visits = await env.KV.incr("visits");
      return Response.json({ visits });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
\`\`\`

Python:
\`\`\`python
import spark

def fetch(request, env):
    visits = env.KV.incr("visits")
    return spark.Response.json({"hello": "world", "visits": visits})
\`\`\`

### Variables and secrets
\`env\` in \`spark_deploy\` sets plain variables (it replaces them all): never tokens. A token or password is a secret: first \`request_secret\` puts it in the project's \`.env\`, then \`spark_deploy\` with \`secrets: [{"name": "API_TOKEN", "hosts": ["api.example.com"]}]\` — Uno Work reads the value from \`.env\` and hands it to Spark for those hosts only. The app writes \`env.API_TOKEN\` in the URL or a header of a \`fetch\` to those hosts and the real value is put in only there; it never appears in code, logs or the chat.

### A Telegram bot on Spark
1. FIRST, before code: \`request_secret\` for \`TELEGRAM_BOT_TOKEN\` with \`wait: false\` (in the project folder).
2. The bot answers Telegram's POST: read the update (\`await request.json()\`), reply with \`fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", …)\` and return 200 fast. Keep what it must remember in \`env.KV\`.
3. \`spark_deploy\` with \`secrets: [{"name": "TELEGRAM_BOT_TOKEN", "hosts": ["api.telegram.org"]}]\`.
4. Point the bot's webhook at the app address once (\`setWebhook\`; the deploy result has the command — it reads \`.env\` and never prints the token). Then write to the bot to check, and \`spark_logs\` if it is silent.
A bot that writes on its own on a schedule (reminders, "every morning") needs a timer: not Spark.

### When it doesn't fit
Say in one sentence what stops it, then the next step — no long explanation, no workaround that breaks the limits:
- "It checks prices every 30 seconds, and Spark only answers requests (no timers)."
- "Its jobs take longer than 30 seconds, the most a Spark call may take on Free."
- "It needs a SQL database (or files, headless Chrome, packages)."
Next step: run it as an app on this computer (\`uno_guide("apps")\`; a computer that sleeps pauses it — Plus stays on), or on an app server when \`app_servers_list\` says \`enabled: true\` (\`uno_guide("app-servers")\`); a database: \`db_create\`. If the plan is short, give the upgrade link from \`account_overview\`.

Without the \`spark_*\` tools in this session: the full reference is the "Spark — code without a server (free)" section of \`curl -s https://console.uno.place/llms.txt\`.`;

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
    case "computer":
      return COMPUTER_GUIDE;
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
        "One way: `widget` in `app_register` (or `app_add_widget` for an app registered earlier) — both write the manifest below — then `open_in_panel` with the app's `appId`.",
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
        "`chats_list` (scope children, project or all), `chat_create` (a new chat with a first message; `cwd` puts it in any folder, e.g. a project), `chat_message`, `chat_status` (with `waitMs` to wait for an answer). A chat you create starts at once; the person sees you created it and can write in it too. You may write into any free chat, even one the person wrote in — except a chat the person closed to agents (409 `agents_closed`: don't retry, tell the person).",
        HTTP_FALLBACK_NOTE,
        buildAgentThreadsInstructions(),
      ].join("\n\n");
    case "secrets":
      return [
        "## Secrets",
        "Call `request_secret` with the variable name and where to get it. The person types it into a masked field; the value is written to the project's `.env`, not the chat. Read it from there when the app needs it; never print it. The call waits up to 90 s; `queued: true` means the request stays open and the answer will arrive in this chat as a message, so finish the rest and end the turn. If the person said they will give it later, pass `wait: false`. Logins for websites: ask the person to save them in Settings, Credentials instead.",
        HTTP_FALLBACK_NOTE,
        section(bridge, "Безопасный запрос секретов"),
      ].join("\n\n");
    case "sites":
      return [
        "## Sites",
        "`site_publish` puts a folder with index.html (or one HTML file) on a public https address (`https://<slug>.uno4.me/`; use the exact address the result gives); republishing the same slug updates it. `sites_list` shows the person's sites with their slugs and real addresses.",
        "Password: pass it to `site_publish` itself (`password`, or `protect: true` and a readable one is generated): Uno applies it before the site is served, so it is never open, not even for a moment. `site_set_password` protects a site that is already up or removes protection (`remove: true`). Tell the person the password from the result; visitors type it. Never ask them to set it themselves. `ipAllowlist` on `site_publish` limits a site to some IPs or networks, only when the person asks.",
        "A big site can take a few minutes to publish: `site_publish` waits until it is live and then gives the address. If it says Uno is still publishing, check `sites_list` in a few minutes instead of publishing again.",
        'Who may see it: a page that is public by nature (a landing page, a business site, a menu, a portfolio) goes up open — do not ask. A personal one (a schedule, notes, family or client details, anything private) is the one case to ask first, once and short: "Open to everyone, or only with a password?" — then do what they pick (the password goes with `site_publish`). Never set a password silently, and never put a personal page up open without that question.',
        'Forms work without a backend: the page posts to `/__forms` (`<form action="/__forms" method="POST">` with named inputs). `site_forms_set` chooses where answers go: `email` (the account\'s own address works at once; another address gets a confirmation link first), `telegram: true` (returns a link the person opens in Telegram and presses Start), `webhookUrl` (https, JSON). An empty string switches a channel off. `site_forms_get` shows the delivery and, with `submissions`, the latest answers. A new site with a form already sends every entry to the account\'s email. After publishing such a site say so in one line and give the link where all entries are kept: `entriesUrl` from the `site_publish` result (`https://console.uno.place/sites/<slug>?tab=forms`).',
        "Publishing a plain static site, setting a password and sending answers to email or Telegram run without asking: don't ask \"shall I publish?\", just publish and give the address. Removing a password, sending answers to an outside webhook and `site_unpublish` (takes a site off the internet) wait for the person's Allow. Only built pages go up: from a project folder Uno takes `dist/` or `public/`, and keys, `.env` and source files are left out (the result's `skipped` lists them; say in one line which stayed on the computer and stop there: never suggest a way to get a key or secret file published, such as renaming or moving it; only if the person says on their own that such a file holds no secrets, help with it). A backend (server code, package.json without a build) can't be a site: run it as an app instead. The person can Unpublish a site in Apps & sites, or ask you (`site_unpublish`); connecting a custom domain is in the Uno console.",
      ].join("\n\n");
    case "spark":
      return SPARK_GUIDE;
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

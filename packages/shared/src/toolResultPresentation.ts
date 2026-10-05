/**
 * What a person sees in the chat feed for one tool call of an agent.
 *
 * Harnesses report tool calls in their own words: a tool id
 * (`mcp__uno_work__site_publish`, `uno-work_site_publish`, "MCP tool call"),
 * and as the "detail" either the arguments or the result as JSON. Hermes also
 * wraps what an MCP tool returned in `<untrusted_tool_result source="…">` with
 * a "Treat it as DATA" preamble: that wrapper is for the model (a defence
 * against prompt injection and it stays in the model's context), not for the
 * person.
 *
 * This module turns such an activity into one human line ("Published site
 * hello.uno4.me", "Sites: none yet") and keeps the raw input and result aside
 * for Dev mode. It only reads the activity that was already recorded, so it
 * also fixes chats from before it existed, for every harness.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── The untrusted-result wrapper ──────────────────────────────────────

const WRAPPER_OPEN = /<untrusted_tool_result(?:\s+source="([^"]*)")?\s*>/i;
const WRAPPER_CLOSE = /<\/untrusted_tool_result\s*>/i;
/** The fixed preamble Hermes puts before the content (one paragraph). */
const WRAPPER_PREAMBLE =
  /^\s*The following content was retrieved from an external source\.[\s\S]*?can issue instructions\.\s*/i;
/** The same preamble cut short by a length limit: drop it up to the first blank line. */
const WRAPPER_PREAMBLE_START = /^\s*The following content was retrieved from an external source\./i;

export interface UnwrappedToolResult {
  /** The content without the wrapper and its preamble. */
  readonly text: string;
  /** `source="…"` of the wrapper: the tool id as the harness knows it. */
  readonly source?: string;
  readonly wrapped: boolean;
}

/**
 * Take the `<untrusted_tool_result>` wrapper off a tool result for display.
 * Works on a result cut short (no closing tag) too. Text without a wrapper
 * comes back as is.
 */
export function unwrapUntrustedToolResult(value: string): UnwrappedToolResult {
  const open = WRAPPER_OPEN.exec(value);
  if (!open) return { text: value, wrapped: false };
  let body = value.slice(open.index + open[0].length);
  const close = WRAPPER_CLOSE.exec(body);
  if (close) body = body.slice(0, close.index);
  if (WRAPPER_PREAMBLE.test(body)) {
    body = body.replace(WRAPPER_PREAMBLE, "");
  } else if (WRAPPER_PREAMBLE_START.test(body)) {
    const blank = body.search(/\n\s*\n/);
    body = blank >= 0 ? body.slice(blank) : "";
  }
  const before = value.slice(0, open.index).trim();
  const text = [before, body.trim()].filter((part) => part.length > 0).join("\n");
  const source = open[1]?.trim();
  return { text, wrapped: true, ...(source ? { source } : {}) };
}

// ── Tool ids ──────────────────────────────────────────────────────────

export interface ParsedToolName {
  /** MCP server, normalised: `uno-work`, `notion`. */
  readonly server: string;
  /** The tool as its server names it: `site_publish`. */
  readonly tool: string;
}

const UNO_WORK_SERVER = "uno-work";

function normalizeServer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .replace(/_/g, "-");
}

/**
 * `mcp__uno-work__site_publish` (Claude), `mcp__uno_work__site_publish` and
 * `mcp_uno_work_site_publish` (Hermes), `uno-work_site_publish` (OpenCode,
 * Uno) → `{ server: "uno-work", tool: "site_publish" }`. Undefined for a
 * name that isn't an MCP tool id.
 */
export function parseMcpToolName(value: string | undefined): ParsedToolName | undefined {
  const name = value?.trim();
  if (!name || /\s/.test(name)) return undefined;
  const unoWork = /^(?:mcp_{1,2})?uno[-_]work_{1,2}([A-Za-z0-9_]+)$/i.exec(name);
  if (unoWork) return { server: UNO_WORK_SERVER, tool: unoWork[1]!.toLowerCase() };
  const doubled = /^mcp__(.+?)__([A-Za-z0-9_.-]+)$/i.exec(name);
  if (doubled) return { server: normalizeServer(doubled[1]!), tool: doubled[2]! };
  const single = /^mcp_([A-Za-z0-9]+)_([A-Za-z0-9_]+)$/i.exec(name);
  if (single) return { server: normalizeServer(single[1]!), tool: single[2]! };
  return undefined;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// ── Reading the result ────────────────────────────────────────────────

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Hermes reports a short JSON result as lines: `- **url:** https://…`. */
function parseKeyValueLines(value: string): Record<string, unknown> | undefined {
  const record: Record<string, unknown> = {};
  let found = false;
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?\*\*([A-Za-z0-9_ .-]+):\*\*\s*(.*)$/.exec(line);
    if (!match) continue;
    found = true;
    const raw = match[2]!.trim();
    record[match[1]!.trim()] = parseJson(raw) ?? raw;
  }
  return found ? record : undefined;
}

/**
 * The tool's own result as data. Hermes hands an MCP result over as
 * `{"result": "<text>"}`; the text is the JSON our server answered with.
 */
function parseResultData(text: string | undefined): unknown {
  if (!text) return undefined;
  let data: unknown = parseJson(text) ?? parseKeyValueLines(text);
  for (let depth = 0; depth < 2; depth += 1) {
    const record = asRecord(data);
    if (!record) break;
    const keys = Object.keys(record).filter((key) => key !== "structuredContent");
    if (keys.length !== 1 || keys[0] !== "result") break;
    const inner = record.result;
    data = typeof inner === "string" ? (parseJson(inner) ?? inner) : inner;
  }
  return data;
}

/** Text of an MCP `content` array or an ACP tool-call content list. */
function textOfContent(value: unknown): string | undefined {
  if (typeof value === "string") return asText(value);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const nested = asRecord(record.content);
    const text = asText(record.text) ?? asText(nested?.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

interface ToolCallFacts {
  readonly name?: ParsedToolName;
  readonly args?: Record<string, unknown>;
  readonly resultText?: string;
  readonly failed: boolean;
  readonly finished: boolean;
}

function firstDefined<T>(...values: ReadonlyArray<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

/** `✅ x completed`, `x result`, `x failed: …`, `x: 3 items` — Hermes' own headings. */
function toolNameFromHermesHeading(text: string | undefined): string | undefined {
  const first = text?.split(/\r?\n/, 1)[0]?.trim();
  if (!first) return undefined;
  const match =
    /^(?:✅\s*)?([A-Za-z0-9_.-]+) (?:completed|result)$/.exec(first) ??
    /^([A-Za-z0-9_.-]+) failed: /.exec(first) ??
    /^([A-Za-z0-9_.-]+): \d+ items?$/.exec(first);
  return match?.[1];
}

function collectFacts(input: ToolActivityInput): ToolCallFacts {
  const payload = input.payload ?? {};
  const data = asRecord(payload.data) ?? {};
  const state = asRecord(data.state);
  const item = asRecord(data.item);
  const claudeResult = asRecord(data.result);
  const detail = asText(payload.detail);
  const title = asText(payload.title) ?? asText(input.summary);

  const resultCandidate = firstDefined(
    asText(state?.output),
    asText(state?.error),
    textOfContent(claudeResult?.content),
    textOfContent(asRecord(item?.result)?.content),
    asText(asRecord(item?.error)?.message),
    typeof data.rawOutput === "string" ? asText(data.rawOutput) : undefined,
    asRecord(data.rawOutput) ? JSON.stringify(data.rawOutput) : undefined,
  );
  // ACP: `content` is the arguments while the call runs and the result once
  // it finished; the `detail` of the other harnesses is one or the other too.
  const acpContent = textOfContent(data.content);
  const status = asText(payload.status) ?? asText(state?.status) ?? asText(item?.status);
  const finished =
    input.kind === "tool.completed" ||
    status === "completed" ||
    status === "failed" ||
    status === "error" ||
    resultCandidate !== undefined;

  const detailUnwrapped = detail ? unwrapUntrustedToolResult(detail) : undefined;
  const contentUnwrapped = acpContent ? unwrapUntrustedToolResult(acpContent) : undefined;
  const resultUnwrapped = resultCandidate ? unwrapUntrustedToolResult(resultCandidate) : undefined;

  // Claude's detail is `<tool id>: <arguments as JSON>`.
  const detailPrefix = detail ? /^([A-Za-z0-9_.-]+): [{[]/.exec(detail)?.[1] : undefined;
  const codexName =
    asText(item?.server) && asText(item?.tool)
      ? `mcp__${asText(item?.server)}__${asText(item?.tool)}`
      : undefined;
  const name = firstDefined(
    parseMcpToolName(asText(data.tool)),
    parseMcpToolName(asText(data.toolName)),
    parseMcpToolName(codexName),
    parseMcpToolName(resultUnwrapped?.source),
    parseMcpToolName(contentUnwrapped?.source),
    parseMcpToolName(detailUnwrapped?.source),
    parseMcpToolName(title),
    parseMcpToolName(detailPrefix),
    parseMcpToolName(toolNameFromHermesHeading(contentUnwrapped?.text)),
    parseMcpToolName(toolNameFromHermesHeading(detailUnwrapped?.text)),
  );

  const args = firstDefined(
    asRecord(state?.input),
    asRecord(data.input),
    asRecord(item?.arguments),
    asRecord(data.rawInput),
    detailPrefix ? asRecord(parseJson(detail!.slice(detailPrefix.length + 2))) : undefined,
  );

  const detailIsInput = detailPrefix !== undefined;
  const resultText = firstDefined(
    resultUnwrapped?.text,
    finished ? contentUnwrapped?.text : undefined,
    finished && !detailIsInput ? detailUnwrapped?.text : undefined,
  );

  // A call that left something open for the person (`queued: true`) or says
  // `ok: true` did what it could: that is not a failure, whatever the harness
  // made of an `ok: false` beside it.
  const resultRecord = resultText !== undefined ? asRecord(parseResultData(resultText)) : undefined;
  const settled = resultRecord?.queued === true || resultRecord?.ok === true;
  const failed =
    !settled &&
    (status === "failed" ||
      status === "error" ||
      claudeResult?.is_error === true ||
      (resultText !== undefined &&
        (/^[A-Za-z0-9_.-]+ failed: /.test(resultText) ||
          resultText.startsWith("Error executing tool ") ||
          (resultRecord !== undefined && asText(resultRecord.error) !== undefined))));

  return {
    ...(name ? { name } : {}),
    ...(args ? { args } : {}),
    ...(resultText ? { resultText } : {}),
    failed,
    finished,
  };
}

// ── Human lines for the uno-work tools ────────────────────────────────

interface LabelContext {
  readonly args: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}

type DoneLabel = string | ((context: LabelContext) => string);

/** [while it runs, when it is done, when it failed]. */
type ToolLabels = readonly [running: string, done: DoneLabel, failed: string];

function text(record: Record<string, unknown>, ...keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url);
  return match?.[1] ?? url;
}

function baseName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path;
}

function countOf(
  context: LabelContext,
  key: string,
  noun: string,
  nameKeys: ReadonlyArray<string> = ["name", "slug", "title", "id"],
): string {
  const title = capitalize(noun);
  const list = context.result[key];
  if (!Array.isArray(list)) return `Looked at your ${noun}`;
  if (list.length === 0) return `${title}: none yet`;
  const names = list
    .map((entry) => (typeof entry === "string" ? entry : text(asRecord(entry) ?? {}, ...nameKeys)))
    .filter((entry): entry is string => entry !== undefined);
  if (names.length === list.length && names.length <= 3) return `${title}: ${names.join(", ")}`;
  return `${title}: ${list.length}`;
}

/** How many left-out files a feed line names before it says "and N more". */
const LEFT_OUT_NAMES_SHOWN = 3;

/**
 * ".env, service-account.json and 2 more" from the publisher's `skipped`
 * list ("service-account.json (key file)"): the person sees which files stayed
 * on the computer, not only how many. Undefined when the list has no names.
 */
function leftOutNames(skipped: unknown, total: number): string | undefined {
  if (!Array.isArray(skipped)) return undefined;
  const names = skipped
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/\s*\([^()]*\)\s*$/, "").trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return undefined;
  const shown = names.slice(0, LEFT_OUT_NAMES_SHOWN);
  const more = Math.max(total, names.length) - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function named(prefix: string, name: string | undefined, fallback: string): string {
  return name ? `${prefix} ${name}` : fallback;
}

const appName = (context: LabelContext) =>
  text(context.result, "name") ?? text(context.args, "name", "appId", "id");
const siteName = (context: LabelContext) =>
  hostOf(text(context.result, "url")) ?? text(context.args, "slug") ?? text(context.result, "slug");

const UNO_WORK_TOOL_LABELS: Readonly<Record<string, ToolLabels>> = {
  computer_status: [
    "Checking this computer…",
    "Checked this computer",
    "Couldn't check this computer",
  ],
  apps_list: ["Looking at your apps…", (c) => countOf(c, "apps", "apps"), "Couldn't read the apps"],
  app_start: [
    "Starting the app…",
    (c) => named("Started app", appName(c), "Started the app"),
    "Couldn't start the app",
  ],
  app_stop: [
    "Stopping the app…",
    (c) => named("Stopped app", appName(c), "Stopped the app"),
    "Couldn't stop the app",
  ],
  app_logs: [
    "Reading the app's log…",
    (c) => named("Read the log of", appName(c), "Read the app's log"),
    "Couldn't read the app's log",
  ],
  app_show_on_internet: [
    "Opening the app to the internet…",
    (c) =>
      named(
        "Opened to the internet:",
        hostOf(text(c.result, "url")) ?? appName(c),
        "Opened the app to the internet",
      ),
    "The app wasn't opened to the internet",
  ],
  app_hide_from_internet: [
    "Closing the app from the internet…",
    (c) => named("Closed from the internet:", appName(c), "Closed the app from the internet"),
    "Couldn't close the app from the internet",
  ],
  app_remove: [
    "Removing the app…",
    (c) => named("Removed app", appName(c), "Removed the app"),
    "The app wasn't removed",
  ],
  app_register: [
    "Adding the app to Home…",
    (c) => named("Added to Home:", appName(c), "Added the app to Home"),
    "Couldn't add the app to Home",
  ],
  app_add_widget: [
    "Adding a widget…",
    (c) => named("Added widget", text(c.args, "title") ?? appName(c), "Added a widget"),
    "Couldn't add the widget",
  ],
  files_list: [
    "Looking at files…",
    (c) => named("Looked at files in", text(c.args, "path"), "Looked at your files"),
    "Couldn't read the files",
  ],
  cloud_list: [
    "Looking at cloud storage…",
    "Looked at cloud storage",
    "Couldn't read cloud storage",
  ],
  drive_find: [
    "Searching Uno Drive…",
    (c) => named("Searched Uno Drive for", text(c.args, "query"), "Looked at Uno Drive"),
    "Couldn't search Uno Drive",
  ],
  drive_save: ["Saving to Uno Drive…", "Saved to Uno Drive", "Couldn't save to Uno Drive"],
  drive_share_link: ["Making a share link…", "Made a share link", "The share link wasn't made"],
  file_open: [
    "Opening the file…",
    (c) => named("Opened", baseName(text(c.args, "path")), "Opened the file"),
    "Couldn't open the file",
  ],
  file_share_link: [
    "Making a share link…",
    (c) => named("Made a share link for", baseName(text(c.args, "path")), "Made a share link"),
    "The share link wasn't made",
  ],
  chats_list: [
    "Looking at chats…",
    (c) => countOf(c, "chats", "chats", ["title"]),
    "Couldn't read the chats",
  ],
  chat_create: [
    "Starting a chat…",
    (c) =>
      named("Started chat", text(c.args, "title") ?? text(c.result, "title"), "Started a chat"),
    "Couldn't start the chat",
  ],
  chat_message: [
    "Writing to another chat…",
    "Wrote to another chat",
    "Couldn't write to the other chat",
  ],
  chat_status: ["Checking another chat…", "Checked another chat", "Couldn't check the other chat"],
  notify: [
    "Sending you a note…",
    (c) => named("Sent you a note:", text(c.args, "title"), "Sent you a note"),
    "Couldn't send the note",
  ],
  open_in_panel: [
    "Opening it in the panel…",
    (c) =>
      // `opened: null` — there was nothing to show yet (a bot without its link).
      "opened" in c.result && !c.result.opened
        ? "Nothing to open in the panel yet"
        : named(
            "Opened in the panel:",
            hostOf(text(c.args, "url")) ??
              baseName(text(c.args, "path", "file")) ??
              text(c.args, "appId"),
            "Opened it in the panel",
          ),
    "Couldn't open it in the panel",
  ],
  image_generate: ["Making an image…", "Made an image", "Couldn't make the image"],
  browser_command: [
    "Using the browser…",
    (c) =>
      named("Browser:", hostOf(text(c.args, "url")) ?? text(c.args, "command"), "Used the browser"),
    "The browser step didn't work",
  ],
  assistant_connect: [
    "Checking your assistant…",
    (c) =>
      c.result.telegram && (c.result.telegram as { windowOpened?: unknown }).windowOpened === true
        ? "Opened Connect Telegram"
        : "Checked your assistant",
    "Couldn't reach your assistant",
  ],
  request_secret: [
    "Waiting for you to paste it…",
    (c) => {
      const name = text(c.args, "name") ?? text(c.result, "name");
      if (c.result.queued === true) return named("Asked you for", name, "Asked you for a secret");
      if (c.result.ok === false) return named("Not given:", name, "The secret wasn't given");
      return named("Saved", name, "Saved the secret");
    },
    "The secret wasn't given",
  ],
  site_publish: [
    "Publishing the site…",
    (c) => {
      const published = named("Published site", siteName(c), "Published the site");
      const left = typeof c.result.skippedCount === "number" ? c.result.skippedCount : 0;
      if (left <= 0) return published;
      const names = leftOutNames(c.result.skipped, left);
      return names
        ? `${published} · left out: ${names}`
        : `${published} · ${left} file${left === 1 ? "" : "s"} left out`;
    },
    "The site wasn't published",
  ],
  site_unpublish: [
    "Taking the site down…",
    (c) => named("Unpublished site", text(c.args, "slug"), "Unpublished the site"),
    "The site wasn't unpublished",
  ],
  sites_list: [
    "Looking at your sites…",
    (c) => countOf(c, "sites", "sites", ["slug", "name"]),
    "Couldn't read the sites",
  ],
  site_set_password: [
    "Changing the site password…",
    (c) =>
      named(
        c.args.remove === true ? "Removed the password from site" : "Set a password on site",
        text(c.args, "slug"),
        "Changed the site password",
      ),
    "The site password wasn't changed",
  ],
  site_forms_get: [
    "Checking the site's forms…",
    (c) => named("Checked the forms of site", text(c.args, "slug"), "Checked the site's forms"),
    "Couldn't read the site's forms",
  ],
  site_forms_set: [
    "Setting up the site's forms…",
    (c) => named("Set up the forms of site", text(c.args, "slug"), "Set up the site's forms"),
    "The site's forms weren't changed",
  ],
  db_list: [
    "Looking at your databases…",
    (c) => countOf(c, "databases", "databases"),
    "Couldn't read the databases",
  ],
  db_create: [
    "Creating a database…",
    (c) =>
      named(
        "Created database",
        text(c.args, "name") ?? text(c.result, "name"),
        "Created a database",
      ),
    "The database wasn't created",
  ],
  db_connection: [
    "Connecting the database…",
    "Connected the database",
    "Couldn't connect the database",
  ],
  account_overview: [
    "Checking your Uno account…",
    "Checked your Uno account",
    "Couldn't read the Uno account",
  ],
  computer_create: [
    "Creating a computer…",
    (c) => named("Started creating computer", text(c.args, "name"), "Started creating a computer"),
    "The computer wasn't created",
  ],
  computer_create_status: [
    "Checking the new computer…",
    "Checked the new computer",
    "Couldn't check the new computer",
  ],
  settings_read: ["Reading the settings…", "Read the settings", "Couldn't read the settings"],
  uno_guide: [
    "Reading the Uno guide…",
    (c) => named("Read the Uno guide:", text(c.args, "topic"), "Read the Uno guide"),
    "Couldn't read the Uno guide",
  ],
  app_servers_list: ["Checking app servers…", "Checked app servers", "Couldn't check app servers"],
  app_deploy: [
    "Deploying to an app server…",
    (c) => named("Deployed to", text(c.args, "server"), "Deployed to an app server"),
    "The deploy didn't work",
  ],
  app_server_logs: [
    "Reading the server's log…",
    "Read the server's log",
    "Couldn't read the server's log",
  ],
};

// ── The activity as a person reads it ─────────────────────────────────

export interface ToolActivityInput {
  /** `summary` of the recorded activity. */
  readonly summary: string;
  /** `tool.updated` | `tool.completed` | … */
  readonly kind?: string | undefined;
  readonly payload: Record<string, unknown> | null | undefined;
}

export interface HumanToolActivity {
  /** One line for the feed. */
  readonly label: string;
  /** One tool keeps one row from "running" to "done": `uno-work:site_publish`. */
  readonly callKey: string;
  /** The arguments, as JSON. Dev mode only. */
  readonly rawInput?: string;
  /** What the tool returned, without the model-facing wrapper. Dev mode only. */
  readonly rawResult?: string;
  readonly failed: boolean;
}

const RAW_LIMIT = 6_000;

function clip(value: string): string {
  return value.length > RAW_LIMIT ? `${value.slice(0, RAW_LIMIT)}\n… (cut)` : value;
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * The human line of a tool call that came through an MCP server, or
 * undefined when the activity isn't one (a command, a file edit, a search:
 * those already read well).
 */
export function describeToolActivity(input: ToolActivityInput): HumanToolActivity | undefined {
  const facts = collectFacts(input);
  if (!facts.name) return undefined;
  const { server, tool } = facts.name;
  const args = facts.args ?? {};
  const data = facts.finished ? parseResultData(facts.resultText) : undefined;
  const result = asRecord(data) ?? {};

  let label: string;
  const labels = server === UNO_WORK_SERVER ? UNO_WORK_TOOL_LABELS[tool] : undefined;
  if (labels) {
    const [running, done, failedLabel] = labels;
    label = !facts.finished
      ? running
      : facts.failed
        ? failedLabel
        : typeof done === "string"
          ? done
          : done({ args, result });
  } else {
    const action = capitalize(humanizeIdentifier(tool));
    const owner = server === UNO_WORK_SERVER ? "" : `${capitalize(humanizeIdentifier(server))}: `;
    label = `${owner}${owner ? action.toLowerCase() : action}${facts.finished ? (facts.failed ? " didn't work" : "") : "…"}`;
  }

  const rawInput = Object.keys(args).length > 0 ? stableJson(args) : undefined;
  return {
    label,
    callKey: `${server}:${tool}`,
    ...(rawInput ? { rawInput: clip(rawInput) } : {}),
    ...(facts.resultText ? { rawResult: clip(facts.resultText) } : {}),
    failed: facts.finished && facts.failed,
  };
}

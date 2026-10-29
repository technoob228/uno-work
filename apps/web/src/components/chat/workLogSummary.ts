/**
 * The agent's steps told in one phrase (T3 Code port, 29.10).
 *
 * A run of tool calls reads as "Read 3 files and ran 2 commands" instead of
 * a stack of technical rows (upstream 4a9edff4c1 #7152, `summarizeToolGroup`
 * of `packages/client-runtime/src/work-log/presentation.ts`); the live wait
 * line shows the agent's latest thought instead of a bare "Thinking"
 * (upstream 95ccbf4066, `liveThoughtLine`). Pure, unit-tested in
 * workLogSummary.test.ts.
 *
 * Our rows are `WorkLogEntry` (session-logic.ts): the harness's own tool name
 * (`Read`, `grep`, `bash`) sits in `toolName`, an MCP call told in plain
 * words (`describeToolActivity`) has its whole line in `label`.
 */
import { type WorkLogEntry } from "../../session-logic";

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "browse"
  | "delegate"
  | "other";

type SummaryEntry = Pick<
  WorkLogEntry,
  | "label"
  | "tone"
  | "detail"
  | "command"
  | "changedFiles"
  | "toolTitle"
  | "itemType"
  | "requestKind"
  | "toolName"
>;

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/** A reasoning row ("Thinking it through - …"), not a tool. */
export function workEntryIsThought(entry: Pick<WorkLogEntry, "tone">): boolean {
  return entry.tone === "thinking";
}

/** The harness's name of the tool, lowercase: `toolName`, else `Read: {…}` of a Claude detail. */
function harnessToolName(entry: SummaryEntry): string {
  if (entry.toolName) return entry.toolName.toLowerCase();
  const fromDetail = /^([A-Za-z][\w-]{1,40}):\s/.exec(entry.detail ?? "")?.[1];
  if (fromDetail) return fromDetail.toLowerCase();
  return normalizeCompactToolLabel(entry.toolTitle ?? entry.label).toLowerCase();
}

const READ_TOOL = /^(?:read|read[ _-]?file|view|ls|list|cat)$/;
const CODE_SEARCH_TOOL = /(?:^|[^a-z])(?:grep|glob|codesearch|search[ _-]?files|find)(?:$|[^a-z])/;
const FETCH_TOOL = /(?:^|[^a-z])(?:webfetch|fetch|browse|open[ _-]?url)(?:$|[^a-z])/;

export function toolGroupAction(entry: SummaryEntry): ToolGroupAction {
  const name = harnessToolName(entry);
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    READ_TOOL.test(name)
  ) {
    return "read";
  }
  if (entry.itemType !== "mcp_tool_call" && CODE_SEARCH_TOOL.test(name)) return "code-search";
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (entry.itemType === "web_search") return FETCH_TOOL.test(name) ? "browse" : "search";
  if (entry.itemType === "collab_agent_tool_call") return "delegate";
  return "other";
}

function toolGroupActionCount(action: ToolGroupAction, entries: ReadonlyArray<SummaryEntry>) {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${plural(count, "file", "files")}`;
    case "edit":
      return `Changed ${plural(count, "file", "files")}`;
    case "command":
      return `Ran ${plural(count, "command", "commands")}`;
    case "code-search":
      return count === 1 ? "Searched files" : `Searched files ${count} times`;
    case "search":
      return count === 1 ? "Searched the web" : `Searched the web ${count} times`;
    case "browse":
      return `Opened ${plural(count, "web page", "web pages")}`;
    case "delegate":
      return `Started ${plural(count, "helper", "helpers")}`;
    case "other":
      return `Used ${plural(count, "tool", "tools")}`;
  }
}

/**
 * An MCP call told in plain words ("Published the site"): alone in its group
 * it says more than "Used 1 tool".
 */
function humanToolLine(entry: SummaryEntry): string | null {
  if (entry.itemType !== "mcp_tool_call" || entry.toolTitle) return null;
  const label = entry.label.trim();
  return label.length > 0 ? label : null;
}

/** At most this many phrases; the rest is "and N other steps". */
const MAX_SUMMARY_PHRASES = 3;

/**
 * "Read 3 files and ran 2 commands" for a run of the agent's steps, in the
 * order the kinds first appear. Reasoning rows are not steps: a run of only
 * them is "Thought". `hasFailure` — a step failed (the line gets a mark).
 */
export function summarizeToolGroup(entries: ReadonlyArray<SummaryEntry>): {
  summary: string;
  hasFailure: boolean;
} {
  const toolEntries = entries.filter((entry) => !workEntryIsThought(entry));
  if (entries.length > 0 && toolEntries.length === 0) {
    return { summary: "Thought", hasFailure: false };
  }
  const groups = new Map<ToolGroupAction, SummaryEntry[]>();
  for (const entry of toolEntries) {
    const action = toolGroupAction(entry);
    const group = groups.get(action);
    if (group) group.push(entry);
    else groups.set(action, [entry]);
  }
  const labels = [...groups].map(([action, group]) => {
    const only = group.length === 1 && action === "other" ? humanToolLine(group[0]!) : null;
    return only ?? toolGroupActionLabel(action, toolGroupActionCount(action, group));
  });
  const shown = labels.slice(0, MAX_SUMMARY_PHRASES);
  const restSteps = [...groups.values()]
    .slice(MAX_SUMMARY_PHRASES)
    .reduce((count, group) => count + group.length, 0);
  if (restSteps > 0) shown.push(`${plural(restSteps, "other step", "other steps")}`);
  const sentence = shown.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    sentence.length < 3
      ? sentence.join(" and ")
      : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
  return {
    summary,
    hasFailure: toolEntries.some((entry) => entry.tone === "error"),
  };
}

/**
 * The first sentence of a thought, or its bold opening line, as one plain
 * line (upstream 95ccbf4066, verbatim).
 */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

/** Shorter than this, a thought says nothing ("Ok.", "Hmm"). */
const MIN_THOUGHT_CHARS = 12;

/**
 * The live line from our reasoning row. The server sends the END of the
 * reasoning ("…of the form. Now I check the mail settings.", see
 * apps/server/src/orchestration/reasoningProgress.ts), so the line is its
 * last whole sentence, not the first; a tail with no sentence end yet is
 * shown from its first whole word.
 */
export function liveThoughtFromReasoningTail(tail: string): string {
  const text = tail
    .replace(/^\s*…\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return "";
  const startsMidSentence = /^\s*…/.test(tail);
  const sentences = text.match(/[^.?!]+(?:[.?!]+["'”’)]?(?=\s|$)|$)/g) ?? [text];
  const whole = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence, index) => sentence.length > 0 && !(index === 0 && startsMidSentence));
  const ended = whole.filter((sentence) => /[.?!]["'”’)]?$/.test(sentence));
  const pick =
    ended.findLast((sentence) => sentence.length >= MIN_THOUGHT_CHARS) ??
    whole.findLast((sentence) => sentence.length >= MIN_THOUGHT_CHARS) ??
    text;
  return liveThoughtLine(pick);
}

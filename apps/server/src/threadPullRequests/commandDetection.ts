/**
 * What an agent's shell command did to pull requests: `gh pr create` printed a
 * new one, `gh pr merge` finished one. Host CLIs send no notification, so the
 * thread reads it from the command and its output. Ported from upstream's
 * PullRequestSyncReactor (`changeRequestsCreatedBy`), without the orchestration
 * v2 layers.
 *
 * @module threadPullRequests/commandDetection
 */
import { parseChangeRequestUrl, type ParsedChangeRequestUrl } from "@t3tools/shared/sourceControl";

const CREATE_COMMANDS = [
  { provider: "github", command: /\bgh\s+pr\s+create\b/u },
  { provider: "gitlab", command: /\bglab\s+mr\s+create\b/u },
] as const;
const CLOSE_COMMAND = /\b(?:gh\s+(?:pr\s+(?:merge|close)|stack\s+merge)|glab\s+mr\s+(?:merge|close))\b/u;

// Where a shell starts a command, past `NAME=value` assignments and wrappers like `timeout 60`.
// A create command anywhere else, as in `echo "gh pr create"`, is text, not a command that runs.
const COMMAND_START =
  "(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*";
// The subcommand must end its shell word: `gh pr create#x` runs another one.
const CREATE_RUNS = CREATE_COMMANDS.map(({ provider, command }) => ({
  provider,
  run: new RegExp(`${COMMAND_START}${command.source}(?=$|[\\s;&|)])`, "gu"),
}));
const createCommandCount = (code: string) =>
  CREATE_RUNS.reduce((count, { run }) => count + [...code.matchAll(run)].length, 0);

// Codex runs each command as `/bin/zsh -lc <script>`, quoting the script in pieces such as
// `"a "'`b`'" c"`.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?=["'])([\s\S]*)$/u;
const SHELL_WORD_PIECE = /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)/gu;
// Heredoc bodies, quoted strings and comments are text a command carries, not commands it runs.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu;
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*/gmu;
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u;
// Commands that print other change requests' URLs, so output beside them proves nothing.
const LISTS_CHANGE_REQUESTS =
  /\b(?:gh\s+(?:pr\s+(?:list|status)|search\s+prs|api)|glab\s+(?:mr\s+list|api))\b/u;
const URL_LINE = /^[ \t]*(https?:\/\/\S+)[ \t]*$/gmu;

/** The script a shell input runs, unwrapped from Codex's `sh -lc`. */
function shellScript(input: string): string {
  const [, wrapped] = SHELL_WRAPPER.exec(input) ?? [];
  return wrapped === undefined
    ? input
    : Array.from(
        wrapped.matchAll(SHELL_WORD_PIECE),
        ([, double, single, escaped, bare]) =>
          double?.replace(/\\(["\\$`])/gu, "$1") ?? single ?? escaped ?? bare,
      ).join("");
}

/** A script split at command separators that sit outside quotes. */
function shellSegments(script: string): ReadonlyArray<string> {
  const segments: Array<string> = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? "";
    if (quote !== null) {
      current += char;
      if (char === "\\" && quote === '"') current += script[++index] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === "\\") {
      current += char + (script[++index] ?? "");
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || char === ";" || char === "|" || char === "\n") {
      segments.push(current);
      current = "";
      if (pair === "&&" || pair === "||") index++;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** The commands a script runs, without the text it carries. */
const shellCode = (script: string) =>
  script.replace(HEREDOC_BODY, "<<").replace(QUOTED_OR_COMMENT, "''");

/**
 * The change requests a shell command opened: URLs on lines of their own in the
 * output of a command that runs a host's create command. One the command also
 * names, as `gh pr view 12` does, existed before it ran. More URLs than create
 * commands means something else printed some, such as `gh pr list`, so none are
 * taken.
 */
export function changeRequestsCreatedBy(
  input: string,
  output: string,
): ReadonlyArray<ParsedChangeRequestUrl> {
  if (!CREATE_COMMANDS.some(({ command }) => command.test(input))) return [];
  const script = shellScript(input);
  const code = shellCode(script);
  const creates = createCommandCount(code);
  if (creates === 0) return [];
  const otherCommands = code
    .split(COMMAND_SEPARATOR)
    .filter((part) => createCommandCount(part) === 0)
    .join("\n");
  if (LISTS_CHANGE_REQUESTS.test(otherCommands)) return [];
  const otherScript = shellSegments(script)
    .filter((segment) => createCommandCount(shellCode(segment)) === 0)
    .join("\n");
  const creators = new Set(
    CREATE_RUNS.filter(({ run }) => [...code.matchAll(run)].length > 0).map(
      ({ provider }) => provider,
    ),
  );
  const created = new Map<string, ParsedChangeRequestUrl>();
  for (const [, url = ""] of output.matchAll(URL_LINE)) {
    const parsed = parseChangeRequestUrl(url);
    // Only the host whose create command ran can have printed a new change request.
    if (parsed === null || !creators.has(parsed.provider)) continue;
    const named = new RegExp(`(?:^|(?<=[\\s#/=("']))${parsed.number}(?=$|[\\s);&|/"'])`, "u");
    // Quoted text in the other commands counts, as in `printf '.../pull/12'`.
    if (named.test(otherScript)) continue;
    created.set(`${parsed.host}/${parsed.repository}#${parsed.number}`, parsed);
  }
  return created.size > creates ? [] : [...created.values()];
}

/** `gh pr merge`, `gh pr close`, `glab mr merge`: read the thread's PRs right after. */
export function closesChangeRequest(input: string): boolean {
  return CLOSE_COMMAND.test(input);
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function joinContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) => {
    const text = asText(asRecord(block)?.text);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export interface ShellCall {
  readonly command: string;
  readonly output: string;
}

/**
 * A finished shell tool call as harnesses report it: Claude Code's
 * `{ input: { command }, result }`, Codex's `{ item: { command, aggregatedOutput } }`,
 * and the plain `{ command, output }` of the others.
 */
export function shellCallOf(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): ShellCall | null {
  if (activity.kind !== "tool.completed") return null;
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "command_execution") return null;
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const input = asRecord(data?.input);
  const rawInput = asRecord(data?.rawInput);
  const result = asRecord(data?.result);
  const command =
    asText(input?.command) ??
    asText(item?.command) ??
    asText(data?.command) ??
    asText(rawInput?.command);
  if (command === undefined) return null;
  const output =
    joinContent(result?.content) ??
    asText(result?.stdout) ??
    asText(result?.output) ??
    asText(item?.aggregatedOutput) ??
    asText(item?.output) ??
    asText(data?.output) ??
    asText(data?.rawOutput) ??
    "";
  return { command, output };
}

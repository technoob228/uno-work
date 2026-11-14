/**
 * "Brain in the cloud" (computers lifecycle, CONTRACT.md §3, §7.5): a chat
 * whose project is a folder on the person's own computer runs its agent here,
 * on the cloud computer, and these tools do its work THERE — shell, reading,
 * writing, editing, listing, finding files, searching — through the
 * uno-connect tunnel. The harness's own shell and file tools are switched off
 * for such a chat (`computerWorkspaceHarness.ts`), so these are its hands.
 *
 * They are `uno-work` tools (one MCP server, one per-thread token), listed
 * only to a chat that has a computer workspace. Each call is judged by trust
 * tier there, like `my_computer_*` (`trust/`): the chat's project folder
 * counts as an allowed folder for that chat.
 *
 * The computer asleep or offline: a call waits for it (up to 25 minutes) and
 * the chat shows "Waiting for <name>…" (`thread.computerWait`) instead of
 * failing; reads are retried once the computer is back, a command or a write
 * that was cut off is not (it may have run) — the agent hears what happened.
 *
 * Search runs as ONE command on the computer (`rg`, else `grep`/`git ls-files`):
 * reading files one by one over a home connection would take minutes.
 *
 * @module myComputer/workspaceTools
 */
import path from "node:path";

import type { MyComputer } from "@t3tools/contracts";
import { Data, Effect } from "effect";

import type {
  ComputerTrustGate,
  UnoWorkTool,
  UnoWorkToolDeps,
  UnoWorkToolError,
} from "../unoWork/tools.ts";
import { summarize } from "./activitySummary.ts";
import type { MyComputerCore } from "./myComputerCore.ts";
import { MyComputerFailure } from "./myComputerCore.ts";
import { ChannelFailure } from "./channel.ts";
import { computerTrustGate } from "./trust/gate.ts";
import type { TrustOperation } from "./trust/judge.ts";

import type { ComputerWorkspacePlan } from "../provider/Services/ComputerWorkspacePolicy.ts";

/** A call to the person's computer that threw: what it threw, as is. */
class ComputerCallFailed extends Data.TaggedError("ComputerCallFailed")<{
  readonly cause: unknown;
}> {}

export type { ComputerWorkspacePlan };

export interface ComputerWaitMark {
  readonly computerId: string;
  readonly computerName: string;
  readonly since: string;
}

/** What the tools need beyond the common uno-work deps (bound to the calling chat). */
export interface WorkspaceToolDeps {
  /** The chat's computer workspace, or null: it's a chat of this computer. */
  readonly computerWorkspace?: Effect.Effect<ComputerWorkspacePlan | null>;
  /** Show or clear "Waiting for <name>…" on the chat. */
  readonly setComputerWait?: (wait: ComputerWaitMark | null) => Effect.Effect<void>;
}

export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace_bash",
  "workspace_read",
  "workspace_write",
  "workspace_edit",
  "workspace_ls",
  "workspace_glob",
  "workspace_grep",
]);

/** How long a call waits for an asleep computer before it gives up. */
export const COMPUTER_WAIT_MAX_MS = 25 * 60_000;
const COMPUTER_POLL_MS = 3_000;
/** A list of the computers this fresh is good enough for a tool call. */
const STATUS_FRESH_MS = 3_000;

const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 1_800_000;
const BASH_OUTPUT_BYTES = 30_000;
const READ_MAX_BYTES = 4 * 1024 * 1024;
const READ_DEFAULT_LINES = 2_000;
const READ_LINE_CHARS = 2_000;
const EDIT_MAX_BYTES = 10 * 1024 * 1024;
const WRITE_MAX_CHARS = 5 * 1024 * 1024;
const LIST_LIMIT = 1_000;
const GLOB_LIMIT = 1_000;
const GLOB_SCAN_LIMIT = 100_000;
const GREP_DEFAULT_LINES = 400;
const SEARCH_OUTPUT_BYTES = 200_000;

export interface WorkspaceToolKit {
  readonly fail: (message: string) => UnoWorkToolError;
  readonly requireAccess: (deps: UnoWorkToolDeps) => Effect.Effect<void, UnoWorkToolError>;
}

// ── Small helpers ──────────────────────────────────────────────────────

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === "number" ? (args[key] as number) : undefined;
const bool = (args: Record<string, unknown>, key: string): boolean => args[key] === true;

/** POSIX single quotes: safe for any string in `sh -c`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single quotes. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const isWindowsPath = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");

/**
 * A path the agent gave, on the computer: absolute stays, `~` stays (the
 * helper expands it), anything else is inside the project folder.
 */
export function resolveOnComputer(plan: ComputerWorkspacePlan, raw: string | undefined): string {
  const given = (raw ?? "").trim();
  const windows = isWindowsPath(plan.path);
  const flavor = windows ? path.win32 : path.posix;
  if (given === "" || given === ".") return plan.path;
  if (given === "~" || given.startsWith("~/")) return given;
  if (windows ? isWindowsPath(given) : given.startsWith("/")) return given;
  return flavor.join(plan.path, given);
}

/** `cat -n` style, as the agents' own Read tool shows a file. */
export function numberLines(
  text: string,
  offsetLine: number,
  limit: number,
): { readonly body: string; readonly shown: number; readonly total: number } {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(0, offsetLine - 1);
  const slice = lines.slice(start, start + limit);
  const body = slice
    .map((line, index) => {
      const clipped = line.length > READ_LINE_CHARS ? `${line.slice(0, READ_LINE_CHARS)}…` : line;
      return `${String(start + index + 1).padStart(6, " ")}\t${clipped}`;
    })
    .join("\n");
  return { body, shown: slice.length, total: lines.length };
}

/** Occurrences of `needle` in `haystack` (non-overlapping). */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * A glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) as a RegExp over `/`-separated
 * relative paths. A pattern without `/` matches the file name at any depth,
 * as agents expect from `*.ts`.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.includes("/") ? pattern.replace(/^\.\//, "") : `**/${pattern}`;
  let out = "";
  let inGroup = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "*") {
      if (source[index + 1] === "*") {
        const slashAfter = source[index + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        index += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      inGroup += 1;
      out += "(?:";
    } else if (char === "}" && inGroup > 0) {
      inGroup -= 1;
      out += ")";
    } else if (char === "," && inGroup > 0) {
      out += "|";
    } else if (char === "[") {
      const close = source.indexOf("]", index + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        const body = source
          .slice(index + 1, close)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        out += `[${body}]`;
        index = close;
      }
    } else {
      out += char.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

// ── Commands run on the computer ───────────────────────────────────────

/** Files under `dir`, one per line, relative: git's list when it's a repository. */
export function listFilesCommand(dir: string, windows: boolean): string {
  if (windows) {
    const d = psQuote(dir);
    return [
      `Set-Location -LiteralPath ${d}`,
      `if ((Get-Command git -ErrorAction SilentlyContinue) -and (git rev-parse --is-inside-work-tree 2>$null)) { git ls-files -co --exclude-standard | Select-Object -First ${GLOB_SCAN_LIMIT} }`,
      `else { Get-ChildItem -Recurse -File -Name -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '(^|\\\\)(\\.git|node_modules)(\\\\|$)' } | Select-Object -First ${GLOB_SCAN_LIMIT} | ForEach-Object { $_ -replace '\\\\','/' } }`,
    ].join("; ");
  }
  const d = shQuote(dir);
  return [
    `cd ${d} || exit 2`,
    `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard`,
    `else find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sed 's|^\\./||'; fi | head -n ${GLOB_SCAN_LIMIT}`,
  ].join("; ");
}

export interface GrepOptions {
  readonly pattern: string;
  readonly dir: string;
  readonly glob?: string | undefined;
  readonly ignoreCase: boolean;
  readonly mode: "content" | "files_with_matches" | "count";
  readonly context?: number | undefined;
  readonly after?: number | undefined;
  readonly before?: number | undefined;
  /** A file type as rg knows it (ts, py…); grep reads it as an extension. */
  readonly type?: string | undefined;
  readonly multiline?: boolean | undefined;
  /** Lines of the answer to skip first. */
  readonly offset?: number | undefined;
  readonly headLimit: number;
}

function contextArgs(options: GrepOptions): Array<string> {
  if (options.mode !== "content") return [];
  return [
    ...(options.context ? ["-C", String(options.context)] : []),
    ...(options.after ? ["-A", String(options.after)] : []),
    ...(options.before ? ["-B", String(options.before)] : []),
  ];
}

/** One search on the computer: ripgrep when it's there, else grep. */
export function grepCommand(options: GrepOptions, windows: boolean): string {
  const rgArgs = [
    "rg",
    "--no-heading",
    "--color",
    "never",
    "--line-number",
    ...(options.ignoreCase ? ["-i"] : []),
    ...(options.mode === "files_with_matches" ? ["-l"] : options.mode === "count" ? ["-c"] : []),
    ...contextArgs(options),
    ...(options.multiline ? ["-U", "--multiline-dotall"] : []),
    ...(options.type ? ["--type", options.type] : []),
    // Outside a git repository rg has no .gitignore to skip these by.
    "--glob",
    "!node_modules",
    "--glob",
    "!.git",
    ...(options.glob ? ["--glob", options.glob] : []),
    "-e",
    options.pattern,
    "--",
    options.dir,
  ];
  if (windows) {
    const rg = rgArgs.map((arg, index) => (index === 0 ? arg : psQuote(arg))).join(" ");
    const select = [
      `Get-ChildItem -LiteralPath ${psQuote(options.dir)} -Recurse -File -ErrorAction SilentlyContinue`,
      ...(options.glob ? [`| Where-Object { $_.Name -like ${psQuote(options.glob)} }`] : []),
      `| Where-Object { $_.FullName -notmatch '\\\\(\\.git|node_modules)\\\\' }`,
      `| Select-String -Pattern ${psQuote(options.pattern)}${options.ignoreCase ? "" : " -CaseSensitive"}`,
      options.mode === "files_with_matches"
        ? "| Select-Object -ExpandProperty Path -Unique"
        : options.mode === "count"
          ? '| Group-Object Path | ForEach-Object { "$($_.Name):$($_.Count)" }'
          : '| ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }',
    ].join(" ");
    const take = `Select-Object${options.offset ? ` -Skip ${options.offset}` : ""} -First ${options.headLimit}`;
    return `if (Get-Command rg -ErrorAction SilentlyContinue) { ${rg} | ${take} } else { ${select} | ${take} }`;
  }
  const rg = rgArgs.map((arg, index) => (index === 0 ? arg : shQuote(arg))).join(" ");
  const grepArgs = [
    "grep",
    "-rnE",
    "-I",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    ...(options.ignoreCase ? ["-i"] : []),
    ...(options.mode === "files_with_matches" ? ["-l"] : options.mode === "count" ? ["-c"] : []),
    ...contextArgs(options),
    ...(options.glob ? [`--include=${options.glob}`] : []),
    ...(options.type ? [`--include=*.${options.type}`] : []),
    "-e",
    options.pattern,
    "--",
    options.dir,
  ];
  const grep = grepArgs.map((arg, index) => (index === 0 ? arg : shQuote(arg))).join(" ");
  // grep -c lists every file, matches or not: keep the ones with matches.
  const countFilter = options.mode === "count" ? " | grep -v ':0$'" : "";
  const skip = options.offset ? ` | tail -n +${options.offset + 1}` : "";
  return `if command -v rg >/dev/null 2>&1; then ${rg}; else ${grep}${countFilter}; fi${skip} | head -n ${options.headLimit}`;
}

// ── Waiting for the computer ───────────────────────────────────────────

/** A failure that means "the computer went away", not "it said no". */
export function meansComputerGone(cause: unknown): boolean {
  if (cause instanceof ChannelFailure) return cause.kind === "offline" || cause.kind === "closed";
  if (cause instanceof MyComputerFailure) {
    return (
      cause.kind === "timeout" ||
      (cause.kind === "remote" &&
        /asleep|offline|stopped answering|can't be reached/i.test(cause.message))
    );
  }
  return false;
}

const gaveUpMessage = (name: string) =>
  `“${name}” has been offline for 25 minutes, so nothing ran there. Tell the person: they can open it and send a message to go on, or press “Continue in the cloud”.`;

const removedMessage = (name: string) =>
  `“${name}” isn't one of the person's computers any more, so this chat can't work there. Tell them they can continue it in the cloud.`;

// ── The tools ──────────────────────────────────────────────────────────

export function workspaceTools(kit: WorkspaceToolKit): ReadonlyArray<UnoWorkTool> {
  type Deps = UnoWorkToolDeps & WorkspaceToolDeps;

  const coreOf = (deps: Deps): Effect.Effect<MyComputerCore, UnoWorkToolError> =>
    deps.myComputer
      ? Effect.succeed(deps.myComputer.core)
      : Effect.fail(kit.fail("This Uno Work can't reach the person's own computers."));

  const planOf = (deps: Deps): Effect.Effect<ComputerWorkspacePlan, UnoWorkToolError> =>
    Effect.gen(function* () {
      const plan = deps.computerWorkspace ? yield* deps.computerWorkspace : null;
      if (plan === null) {
        return yield* kit.fail(
          "This chat's project is on this cloud computer: use your own shell and file tools.",
        );
      }
      return plan;
    });

  const promise = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new ComputerCallFailed({ cause }) });

  /** The computer, online: waits for it while it sleeps (interruptible). */
  const waitOnline = (
    deps: Deps,
    core: MyComputerCore,
    plan: ComputerWorkspacePlan,
  ): Effect.Effect<MyComputer, UnoWorkToolError> => {
    let marked = false;
    const mark = (wait: ComputerWaitMark | null) =>
      deps.setComputerWait ? deps.setComputerWait(wait) : Effect.void;
    const loop = Effect.gen(function* () {
      const started = Date.now();
      for (;;) {
        const status = yield* promise(() => core.cachedStatus(STATUS_FRESH_MS)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (status !== null) {
          const computer = status.computers.find((entry) => entry.id === plan.computerId);
          if (!status.enabled || computer === undefined) {
            return yield* kit.fail(removedMessage(plan.computerName));
          }
          if (computer.online) return computer;
        }
        if (!marked) {
          marked = true;
          yield* mark({
            computerId: plan.computerId,
            computerName: plan.computerName,
            since: new Date(started).toISOString(),
          });
        }
        if (Date.now() - started >= COMPUTER_WAIT_MAX_MS) {
          return yield* kit.fail(gaveUpMessage(plan.computerName));
        }
        yield* Effect.sleep(COMPUTER_POLL_MS);
      }
    });
    return loop.pipe(Effect.ensuring(Effect.suspend(() => (marked ? mark(null) : Effect.void))));
  };

  /**
   * Run `op` on the chat's computer: checks, waits while it sleeps, and for
   * `retry` operations (reads) goes again once when the computer dropped
   * mid-way and came back.
   */
  const onComputer = <A>(
    deps: Deps,
    retry: boolean,
    op: (core: MyComputerCore, plan: ComputerWorkspacePlan, signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<{ readonly value: A; readonly plan: ComputerWorkspacePlan }, UnoWorkToolError> =>
    Effect.gen(function* () {
      yield* kit.requireAccess(deps);
      if (deps.caller.boundary) {
        return yield* kit.fail(
          `${deps.caller.boundary.name} is held to selected projects, and the person's own computer is outside them.`,
        );
      }
      const core = yield* coreOf(deps);
      const plan = yield* planOf(deps);
      for (let attempt = 0; ; attempt++) {
        yield* waitOnline(deps, core, plan);
        const outcome = yield* promise((signal) => op(core, plan, signal)).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
        );
        if (outcome.ok) return { value: outcome.value, plan };
        const cause = outcome.cause.cause;
        if (retry && attempt === 0 && meansComputerGone(cause)) continue;
        const message = cause instanceof Error ? cause.message : String(cause);
        return yield* kit.fail(message);
      }
    });

  const windowsOf = (plan: ComputerWorkspacePlan) => isWindowsPath(plan.path);

  /** The `trust` hook: judged on the chat's computer once it is online. */
  const judged =
    (
      describe: (
        plan: ComputerWorkspacePlan,
        args: Record<string, unknown>,
      ) => {
        readonly operation: TrustOperation;
        readonly kind: "run" | "read" | "write" | "list";
        readonly summary: string;
      },
    ) =>
    (
      deps: Deps,
      args: Record<string, unknown>,
      context: { readonly cautious: boolean; readonly outsideText: boolean },
    ): Effect.Effect<ComputerTrustGate, UnoWorkToolError> =>
      Effect.gen(function* () {
        yield* kit.requireAccess(deps);
        if (deps.caller.boundary) {
          return yield* kit.fail(
            `${deps.caller.boundary.name} is held to selected projects, and the person's own computer is outside them.`,
          );
        }
        const core = yield* coreOf(deps);
        const plan = yield* planOf(deps);
        const computer = yield* waitOnline(deps, core, plan);
        const { operation, kind, summary } = describe(plan, args);
        return yield* computerTrustGate({
          deps,
          api: deps.myComputer!,
          computer,
          operation,
          journal: { kind, summary },
          extraAllowed: windowsOf(plan) ? [] : [plan.path],
          context,
          fail: kit.fail,
        });
      });
  const pathOp = (kind: "read" | "write", key: string, journal: "read" | "write" | "list" = kind) =>
    judged((plan, args) => {
      const target = resolveOnComputer(plan, str(args, key));
      return { operation: { kind, path: target }, kind: journal, summary: target };
    });

  /** Run a search command; its output, clipped. */
  const search = (
    deps: Deps,
    build: (plan: ComputerWorkspacePlan) => string,
    timeoutMs = 120_000,
  ) =>
    onComputer(deps, true, (core, plan, signal) =>
      core.exec(
        {
          computerId: plan.computerId,
          cmd: build(plan),
          cwd: plan.path,
          timeoutMs,
          threadId: deps.caller.threadId,
          maxOutputBytes: SEARCH_OUTPUT_BYTES,
          trust: deps.callTrust,
        },
        signal,
      ),
    );

  const pathArg = (description: string) => ({
    type: "string" as const,
    description,
    minLength: 1,
    maxLength: 4096,
  });

  return [
    {
      name: "workspace_bash",
      group: "my-computer",
      description: `Run a shell command in this chat's project folder on the person's computer (where the project lives; not this cloud computer). Login shell, so their tools are on PATH. Use it for builds, tests, git and anything else a terminal does. The answer has the exit code and up to ${BASH_OUTPUT_BYTES / 1000} KB of output (start and end). timeout in milliseconds: 120000 by default, 1800000 at most. Prefer workspace_grep / workspace_glob / workspace_read for searching and reading.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: 20_000 },
          description: { type: "string", maxLength: 300 },
          timeout: { type: "integer", minimum: 1, maximum: BASH_MAX_TIMEOUT_MS },
          // Fields Claude's own Bash sends (the tool stands in for it).
          run_in_background: {
            type: "boolean",
            description: "Not available on the person's computer: start it with nohup … & instead.",
          },
          dangerouslyDisableSandbox: { type: "boolean" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      level: "command",
      trust: judged((plan, args) => ({
        operation: { kind: "run", command: str(args, "command")!, cwd: plan.path },
        kind: "run",
        summary: str(args, "command")!,
      })),
      approvalTitle: (args) =>
        `Run on your computer: ${summarize(str(args, "command") ?? "", 120)}`,
      approvalDetail: (args) => {
        const command = str(args, "command") ?? "";
        return command.length > 120 ? summarize(command, 600) : undefined;
      },
      run: (deps, args) =>
        Effect.gen(function* () {
          if (bool(args, "run_in_background")) {
            return yield* kit.fail(
              "Background commands aren't available on the person's computer. Run it in the foreground with a timeout, or start it detached there: nohup <command> > /tmp/<name>.log 2>&1 & — then read the log.",
            );
          }
          const { value: result, plan } = yield* onComputer(deps, false, (core, plan, signal) =>
            core.exec(
              {
                computerId: plan.computerId,
                cmd: str(args, "command")!,
                cwd: plan.path,
                timeoutMs: Math.min(
                  num(args, "timeout") ?? BASH_DEFAULT_TIMEOUT_MS,
                  BASH_MAX_TIMEOUT_MS,
                ),
                threadId: deps.caller.threadId,
                maxOutputBytes: BASH_OUTPUT_BYTES,
                trust: deps.callTrust,
              },
              signal,
            ),
          );
          return {
            computer: plan.computerName,
            exitCode: result.exitCode,
            ...(result.signal ? { signal: result.signal } : {}),
            ...(result.timedOut
              ? {
                  timedOut: true,
                  note: "It ran out of time and was stopped. Give it a longer timeout or run it in the background.",
                }
              : {}),
            output: result.text,
            ...(result.cutBytes > 0 ? { outputCutBytes: result.cutBytes } : {}),
          };
        }),
    },
    {
      name: "workspace_read",
      group: "my-computer",
      description: `Read a text file on the person's computer, in this chat's project (relative paths) or anywhere there (absolute or ~/…). Lines come numbered like \`cat -n\`; ${READ_DEFAULT_LINES} lines by default from \`offset\` (1-based line); read on with a larger offset.`,
      inputSchema: {
        type: "object",
        properties: {
          file_path: pathArg("The file: relative to the project folder, absolute, or ~/…"),
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 20_000 },
          // Sent by Claude's own Read; text files have no pages.
          pages: { type: "string", maxLength: 100 },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
      level: "safe",
      trust: pathOp("read", "file_path"),
      run: (deps, args) =>
        Effect.gen(function* () {
          const { value: read, plan } = yield* onComputer(deps, true, (core, plan, signal) =>
            core.read(
              {
                computerId: plan.computerId,
                path: resolveOnComputer(plan, str(args, "file_path")),
                maxBytes: READ_MAX_BYTES,
                threadId: deps.caller.threadId,
                trust: deps.callTrust,
              },
              signal,
            ),
          );
          if (read.data.subarray(0, 8192).includes(0)) {
            return yield* kit.fail(
              `${str(args, "file_path")} isn't a text file. To work with it, copy it here with my_computer_read_file and saveTo.`,
            );
          }
          const numbered = numberLines(
            read.data.toString("utf8"),
            num(args, "offset") ?? 1,
            num(args, "limit") ?? READ_DEFAULT_LINES,
          );
          const lastShown = (num(args, "offset") ?? 1) - 1 + numbered.shown;
          const notes = [
            numbered.total === 0 ? "The file is empty." : null,
            lastShown < numbered.total
              ? `Lines ${num(args, "offset") ?? 1}–${lastShown} of ${numbered.total}: read on with offset ${lastShown + 1}.`
              : null,
            read.eof
              ? null
              : `Only the first ${READ_MAX_BYTES / 1024 / 1024} MB of the file were read.`,
          ].filter(Boolean);
          return `${numbered.body}${notes.length > 0 ? `\n\n(${notes.join(" ")} On ${plan.computerName}.)` : ""}`;
        }),
    },
    {
      name: "workspace_write",
      group: "my-computer",
      description:
        "Write a file on the person's computer (relative to this chat's project folder, absolute, or ~/…), replacing it if it exists; folders on the way are created. For changing part of a file use workspace_edit.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: pathArg("The file: relative to the project folder, absolute, or ~/…"),
          content: { type: "string", maxLength: WRITE_MAX_CHARS },
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
      level: "change",
      trust: pathOp("write", "file_path"),
      approvalTitle: (args) =>
        `Write ${summarize(str(args, "file_path") ?? "", 120)} on your computer`,
      run: (deps, args) =>
        Effect.gen(function* () {
          const content = Buffer.from(str(args, "content") ?? "", "utf8");
          const { value: written, plan } = yield* onComputer(deps, false, (core, plan, signal) =>
            core.write(
              {
                computerId: plan.computerId,
                path: resolveOnComputer(plan, str(args, "file_path")),
                data: content,
                mkdirs: true,
                threadId: deps.caller.threadId,
                trust: deps.callTrust,
              },
              signal,
            ),
          );
          return {
            computer: plan.computerName,
            path: str(args, "file_path")!,
            bytes: written.bytes,
          };
        }),
    },
    {
      name: "workspace_edit",
      group: "my-computer",
      description:
        "Replace text in a file on the person's computer: `old_string` must appear exactly once (or set `replace_all`). Give enough surrounding lines to make it unique; keep the indentation exactly as the file has it.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: pathArg("The file: relative to the project folder, absolute, or ~/…"),
          old_string: { type: "string", minLength: 1, maxLength: WRITE_MAX_CHARS },
          new_string: { type: "string", maxLength: WRITE_MAX_CHARS },
          replace_all: { type: "boolean" },
        },
        required: ["file_path", "old_string", "new_string"],
        additionalProperties: false,
      },
      level: "change",
      trust: pathOp("write", "file_path"),
      approvalTitle: (args) =>
        `Edit ${summarize(str(args, "file_path") ?? "", 120)} on your computer`,
      run: (deps, args) =>
        Effect.gen(function* () {
          const oldString = str(args, "old_string")!;
          const newString = str(args, "new_string") ?? "";
          if (oldString === newString)
            return yield* kit.fail("old_string and new_string are the same.");
          const file = (plan: ComputerWorkspacePlan) =>
            resolveOnComputer(plan, str(args, "file_path"));
          const { value: read } = yield* onComputer(deps, true, (core, plan, signal) =>
            core.read(
              {
                computerId: plan.computerId,
                path: file(plan),
                maxBytes: EDIT_MAX_BYTES + 1,
                threadId: deps.caller.threadId,
                quiet: true,
              },
              signal,
            ),
          );
          if (read.data.length > EDIT_MAX_BYTES) {
            return yield* kit.fail(
              "The file is over 10 MB: edit it with workspace_bash (sed, a script) instead.",
            );
          }
          const text = read.data.toString("utf8");
          const found = countOccurrences(text, oldString);
          if (found === 0) {
            return yield* kit.fail(
              "old_string isn't in the file. Read the file again (workspace_read) and copy the text exactly, indentation included.",
            );
          }
          if (found > 1 && !bool(args, "replace_all")) {
            return yield* kit.fail(
              `old_string is in the file ${found} times. Add surrounding lines to make it unique, or set replace_all.`,
            );
          }
          const next = bool(args, "replace_all")
            ? text.split(oldString).join(newString)
            : text.replace(oldString, () => newString);
          const { plan } = yield* onComputer(deps, false, (core, plan, signal) =>
            core.write(
              {
                computerId: plan.computerId,
                path: file(plan),
                data: Buffer.from(next, "utf8"),
                threadId: deps.caller.threadId,
                trust: deps.callTrust,
              },
              signal,
            ),
          );
          return {
            computer: plan.computerName,
            path: str(args, "file_path")!,
            replaced: bool(args, "replace_all") ? found : 1,
          };
        }),
    },
    {
      name: "workspace_ls",
      group: "my-computer",
      description:
        "List a folder on the person's computer: the project folder by default, or a path relative to it, absolute or ~/…",
      inputSchema: {
        type: "object",
        properties: {
          path: pathArg("The folder. Default: the project folder."),
          ignore: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 300 },
            description: "Names to leave out (globs, e.g. node_modules, *.log).",
          },
        },
        additionalProperties: false,
      },
      level: "safe",
      trust: pathOp("read", "path", "list"),
      run: (deps, args) =>
        Effect.gen(function* () {
          const { value: answer, plan } = yield* onComputer(deps, true, (core, plan, signal) =>
            core.list(
              {
                computerId: plan.computerId,
                path: resolveOnComputer(plan, str(args, "path")),
                threadId: deps.caller.threadId,
                trust: deps.callTrust,
              },
              signal,
            ),
          );
          const ignore = (Array.isArray(args["ignore"]) ? args["ignore"] : [])
            .filter((item): item is string => typeof item === "string")
            .map((item) => globToRegExp(item.replace(/\/+$/, "")));
          const entries = (Array.isArray(answer["entries"]) ? answer["entries"] : []).filter(
            (entry: unknown) => {
              const name =
                entry !== null && typeof entry === "object" && "name" in entry
                  ? String((entry as { name: unknown }).name)
                  : typeof entry === "string"
                    ? entry
                    : "";
              return !ignore.some((pattern) => pattern.test(name));
            },
          );
          return {
            computer: plan.computerName,
            path: resolveOnComputer(plan, str(args, "path")),
            entries: entries.slice(0, LIST_LIMIT),
            ...(entries.length > LIST_LIMIT
              ? { note: `Showing ${LIST_LIMIT} of ${entries.length}.` }
              : {}),
          };
        }),
    },
    {
      name: "workspace_glob",
      group: "my-computer",
      description:
        "Find files by name pattern in this chat's project on the person's computer (`**/*.ts`, `src/**/test_*.py`, `*.{json,yaml}`). Respects .gitignore in a git project. One quick command there, not a file-by-file walk.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1, maxLength: 500 },
          path: pathArg("Search under this folder instead of the project folder."),
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      level: "safe",
      trust: pathOp("read", "path", "list"),
      run: (deps, args) =>
        Effect.gen(function* () {
          const matcher = globToRegExp(str(args, "pattern")!);
          const { value: result, plan } = yield* search(deps, (plan) =>
            listFilesCommand(resolveOnComputer(plan, str(args, "path")), windowsOf(plan)),
          );
          if (result.exitCode !== 0 && result.text.trim() === "") {
            return yield* kit.fail(`Couldn't list the files there (exit ${result.exitCode}).`);
          }
          const files = result.text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && matcher.test(line));
          return {
            computer: plan.computerName,
            files: files.slice(0, GLOB_LIMIT),
            ...(files.length > GLOB_LIMIT
              ? { note: `${files.length} files match; showing ${GLOB_LIMIT}. Narrow the pattern.` }
              : files.length === 0
                ? { note: "No files match." }
                : {}),
          };
        }),
    },
    {
      name: "workspace_grep",
      group: "my-computer",
      description:
        "Search file contents in this chat's project on the person's computer with a regular expression (ripgrep there when installed, else grep). output_mode: `content` (matching lines with file:line, the default), `files_with_matches`, or `count`. One command there, fast even on big repositories.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1, maxLength: 2_000 },
          path: pathArg("Search under this folder or file instead of the project folder."),
          glob: {
            type: "string",
            maxLength: 300,
            description: "Only files matching this, e.g. *.ts",
          },
          output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
          "-i": { type: "boolean", description: "Ignore case." },
          context: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description: "Lines around each match.",
          },
          head_limit: { type: "integer", minimum: 1, maximum: 5_000 },
          // Fields Claude's own Grep sends (the tool stands in for it).
          "-A": { type: "integer", minimum: 0, maximum: 20, description: "Lines after a match." },
          "-B": { type: "integer", minimum: 0, maximum: 20, description: "Lines before a match." },
          "-C": { type: "integer", minimum: 0, maximum: 20, description: "Lines around a match." },
          "-n": { type: "boolean", description: "Line numbers (always on)." },
          type: {
            type: "string",
            pattern: "^[A-Za-z0-9_+-]{1,20}$",
            description: "File type, e.g. ts, py, go.",
          },
          multiline: { type: "boolean", description: "Let . and patterns span lines." },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: 100_000,
            description: "Skip this many lines first.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      level: "safe",
      trust: judged((plan, args) => {
        const target = resolveOnComputer(plan, str(args, "path"));
        return {
          operation: { kind: "read", path: target, recursive: true },
          kind: "read",
          summary: `search ${str(args, "pattern") ?? ""} in ${target}`,
        };
      }),
      run: (deps, args) =>
        Effect.gen(function* () {
          const mode = (str(args, "output_mode") ?? "content") as GrepOptions["mode"];
          const headLimit = num(args, "head_limit") ?? GREP_DEFAULT_LINES;
          const { value: result, plan } = yield* search(deps, (plan) =>
            grepCommand(
              {
                pattern: str(args, "pattern")!,
                dir: resolveOnComputer(plan, str(args, "path")),
                glob: str(args, "glob"),
                ignoreCase: bool(args, "-i"),
                mode,
                context: num(args, "context") ?? num(args, "-C"),
                after: num(args, "-A"),
                before: num(args, "-B"),
                type: str(args, "type"),
                multiline: bool(args, "multiline"),
                offset: num(args, "offset"),
                headLimit,
              },
              windowsOf(plan),
            ),
          );
          const text = result.text.trimEnd();
          // grep and rg answer 1 for "nothing found"; 2 is a real error.
          if (text === "" && (result.exitCode ?? 0) > 1) {
            return yield* kit.fail(
              `The search failed there (exit ${result.exitCode}). Check the pattern.`,
            );
          }
          const lines = text === "" ? 0 : text.split("\n").length;
          return `${text === "" ? "No matches." : text}${lines >= headLimit ? `\n\n(Stopped at ${headLimit} lines: narrow the search or raise head_limit.)` : ""}\n(On ${plan.computerName}.)`;
        }),
    },
  ];
}

/**
 * What the agent of such a chat reads in its instructions: where it works
 * and with which tools.
 */
export function workspacePromptNote(plan: ComputerWorkspacePlan, toolPrefix: string): string {
  const t = (name: string) => `${toolPrefix}${name}`;
  return [
    `This chat's project is the folder ${plan.path} on the person's own computer “${plan.computerName}”, not on the cloud computer you run on.`,
    `Your built-in shell and file tools are switched off. Do all work in the project with these tools, which run on “${plan.computerName}”: ${t("workspace_bash")} (shell, in the project folder), ${t("workspace_read")}, ${t("workspace_write")}, ${t("workspace_edit")}, ${t("workspace_ls")}, ${t("workspace_glob")} (find files) and ${t("workspace_grep")} (search contents).`,
    "Relative paths are inside the project folder. If the computer is asleep a call waits for it; the person sees that.",
  ].join(" ");
}

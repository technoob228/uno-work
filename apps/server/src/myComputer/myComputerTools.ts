/**
 * The agent's hands on the person's own computer (`my_computer_*`). They go
 * through the same gate as every `uno-work` tool:
 * - listing and reading run;
 * - writing is a `change` (asks in Ask mode), a command is a `command` (asks
 *   unless the chat has full access);
 * - a Cautious assistant asks before both (`my-computer` in `assistantPreset`);
 * - an assistant held to selected projects doesn't reach the computer at all:
 *   the laptop is outside every boundary it was given.
 *
 * Interrupting a call (the person stopped the turn) stops the command there.
 * What agents do lands in the journal (`myComputer.activity`).
 *
 * @module myComputer/myComputerTools
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { MyComputer } from "@t3tools/contracts";
import { Effect } from "effect";

import type { UnoWorkTool, UnoWorkToolDeps, UnoWorkToolError } from "../unoWork/tools.ts";
import { summarize } from "./activitySummary.ts";
import type { MyComputerShape } from "./MyComputerService.ts";
import { MAX_FILE_BYTES, MyComputerFailure, pickComputer } from "./myComputerCore.ts";
import { OUTPUT_LIMIT_BYTES } from "./outputCollector.ts";

type Deps = UnoWorkToolDeps;

export const MY_COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "my_computers_list",
  "my_computer_run",
  "my_computer_read_file",
  "my_computer_write_file",
  "my_computer_list_files",
]);

/** What the tools need from tools.ts (passed in: no runtime import cycle). */
export interface MyComputerToolKit {
  readonly resolvePath: (raw: string, deps: Deps) => string;
  readonly displayPath: (absolute: string, home: string) => string;
  /** "Agent access: off" in the person's settings stops these tools too. */
  readonly requireAccess: (deps: Deps) => Effect.Effect<void, UnoWorkToolError>;
  readonly fail: (message: string) => UnoWorkToolError;
}

const NOT_HERE_MESSAGE =
  "This Uno Work can't reach the person's own computers. Tell them; don't try another way.";

const LIST_LIMIT = 500;
const READ_DEFAULT_BYTES = OUTPUT_LIMIT_BYTES;
const READ_MAX_BYTES = 256 * 1024;
const WRITE_TEXT_MAX_CHARS = 1024 * 1024;
const TITLE_COMMAND_CHARS = 120;
const DETAIL_COMMAND_CHARS = 600;

const computerArg = {
  type: "string" as const,
  description:
    "Which computer: its name or id from my_computers_list. Leave it out when the person has only one.",
  minLength: 1,
  maxLength: 200,
};

const pathArg = (description: string) => ({
  type: "string" as const,
  description,
  minLength: 1,
  maxLength: 4096,
});

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === "number" ? (args[key] as number) : undefined;

/** "on your computer" / "on “Work laptop”": a card speaks of the one it means. */
const where = (args: Record<string, unknown>) => {
  const computer = str(args, "computer");
  return computer ? `on “${summarize(computer, 60)}”` : "on your computer";
};

const sizeOf = (answer: Readonly<Record<string, unknown>>): number | null =>
  typeof answer["size"] === "number" ? answer["size"] : null;

/** NUL in the first bytes: it isn't text, and text is all a chat can hold. */
const looksBinary = (data: Uint8Array) => data.subarray(0, 8192).includes(0);

export function myComputerTools(kit: MyComputerToolKit): ReadonlyArray<UnoWorkTool> {
  const service = (deps: Deps): Effect.Effect<MyComputerShape, UnoWorkToolError> =>
    deps.myComputer ? Effect.succeed(deps.myComputer) : Effect.fail(kit.fail(NOT_HERE_MESSAGE));

  /** The checks that don't depend on which computer. */
  const refuseOutOfBounds = (deps: Deps): Effect.Effect<void, UnoWorkToolError> =>
    deps.caller.boundary
      ? Effect.fail(
          kit.fail(
            `${deps.caller.boundary.name} is held to selected projects, and the person's own computer is outside them. Tell the person; they can change that on the assistant's page.`,
          ),
        )
      : kit.requireAccess(deps);

  const asFailure = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => kit.fail(cause.message)));

  /** The computer this call means, fresh from the console. */
  const target = (
    deps: Deps,
    args: Record<string, unknown>,
  ): Effect.Effect<
    { readonly api: MyComputerShape; readonly computer: MyComputer },
    UnoWorkToolError
  > =>
    Effect.gen(function* () {
      yield* refuseOutOfBounds(deps);
      const api = yield* service(deps);
      const status = yield* asFailure(api.status);
      const computer = yield* Effect.try({
        try: () => pickComputer(status, str(args, "computer")),
        catch: (cause) =>
          kit.fail(cause instanceof MyComputerFailure ? cause.message : String(cause)),
      });
      return { api, computer };
    });

  /** No card for a call that can't work: computer unknown, asleep or out of bounds. */
  const prepare = (deps: Deps, args: Record<string, unknown>) =>
    target(deps, args).pipe(Effect.asVoid);

  const readForChat = (deps: Deps, args: Record<string, unknown>, computer: MyComputer) =>
    Effect.gen(function* () {
      const api = yield* service(deps);
      const offset = num(args, "offset") ?? 0;
      const read = yield* asFailure(
        api.read({
          computerId: computer.id,
          path: str(args, "path")!,
          offset,
          maxBytes: num(args, "maxBytes") ?? READ_DEFAULT_BYTES,
          threadId: deps.caller.threadId,
        }),
      );
      const base = {
        computer: computer.name,
        path: str(args, "path")!,
        offset,
        bytes: read.data.length,
      };
      if (looksBinary(read.data)) {
        return {
          ...base,
          binary: true,
          note: "It isn't a text file. To work with it, copy it to this computer with `saveTo`.",
        };
      }
      return {
        ...base,
        complete: read.eof,
        text: read.data.toString("utf8"),
        ...(read.eof
          ? {}
          : {
              note: `More of the file remains: read on with offset ${offset + read.data.length}.`,
            }),
      };
    });

  const saveHere = (deps: Deps, args: Record<string, unknown>, computer: MyComputer) =>
    Effect.gen(function* () {
      const api = yield* service(deps);
      const source = str(args, "path")!;
      const tooBig = (bytes: number) =>
        kit.fail(
          `${source} is ${bytes} bytes; up to ${MAX_FILE_BYTES} bytes (50 MiB) come through at once. Ask the person to put it in their Uno Drive instead.`,
        );
      const destination = kit.resolvePath(str(args, "saveTo")!, deps);
      const stat = yield* asFailure(api.stat({ computerId: computer.id, path: source }));
      const size = sizeOf(stat);
      if (size !== null && size > MAX_FILE_BYTES) return yield* tooBig(size);
      // One byte over the limit tells a big file from one that is exactly it.
      const read = yield* asFailure(
        api.read({
          computerId: computer.id,
          path: source,
          maxBytes: MAX_FILE_BYTES + 1,
          threadId: deps.caller.threadId,
        }),
      );
      if (read.data.length > MAX_FILE_BYTES) return yield* tooBig(read.data.length);
      yield* Effect.tryPromise({
        try: async () => {
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          await fsp.writeFile(destination, read.data);
        },
        catch: (cause) =>
          kit.fail(
            `Couldn't save it on this computer: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });
      return {
        computer: computer.name,
        path: source,
        savedTo: kit.displayPath(destination, deps.home),
        bytes: read.data.length,
      };
    });

  const writeSource = (deps: Deps, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const content = str(args, "content");
      const fromFile = str(args, "fromFile");
      if (fromFile === undefined) return Buffer.from(content ?? "", "utf8");
      const local = kit.resolvePath(fromFile, deps);
      return yield* Effect.tryPromise({
        try: async () => {
          const { size } = await fsp.stat(local);
          if (size > MAX_FILE_BYTES) {
            throw new Error(
              `${fromFile} is ${size} bytes; up to ${MAX_FILE_BYTES} bytes (50 MiB) go through at once.`,
            );
          }
          return fsp.readFile(local);
        },
        catch: (cause) => kit.fail(cause instanceof Error ? cause.message : String(cause)),
      });
    });

  return [
    {
      name: "my_computers_list",
      group: "my-computer",
      description:
        "The person's own computers connected to Uno Work (their laptop or desktop, not this cloud computer): name, system, online or not. `details: true` also asks the online ones about themselves (home folder, shell).",
      inputSchema: {
        type: "object",
        properties: {
          details: { type: "boolean", description: "Also ask each online computer about itself." },
        },
        additionalProperties: false,
      },
      level: "safe",
      run: (deps, args) =>
        Effect.gen(function* () {
          yield* refuseOutOfBounds(deps);
          const api = yield* service(deps);
          const status = yield* asFailure(api.status);
          if (!status.enabled || status.computers.length === 0) {
            return {
              enabled: status.enabled,
              computers: [],
              note: "No computer is connected. The person can connect one in Uno Work (one command in a terminal).",
            };
          }
          const computers = yield* Effect.forEach(
            status.computers,
            (computer) =>
              Effect.gen(function* () {
                const info =
                  args.details === true && computer.online
                    ? yield* api.info(computer.id).pipe(Effect.orElseSucceed(() => null))
                    : null;
                return {
                  id: computer.id,
                  name: computer.name,
                  os: computer.os,
                  arch: computer.arch,
                  online: computer.online,
                  lastSeenAt: computer.lastSeenAt,
                  ...(info ? { info } : {}),
                };
              }),
            { concurrency: 4 },
          );
          return { enabled: true, computers };
        }),
    },
    {
      name: "my_computer_run",
      group: "my-computer",
      description: `Run a shell command on the person's own computer (their laptop or desktop, not this cloud computer), in its login shell. It touches their real files and accounts, and every command shows in a journal they can read. Get their OK in the chat before anything destructive: deleting, overwriting, installing, changing settings. The answer has the exit code and up to ${OUTPUT_LIMIT_BYTES / 1024} KiB of output (start and end). timeoutSeconds: 120 by default, 1800 at most.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: 20_000 },
          cwd: pathArg("Folder on that computer. Default: its home folder."),
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
          computer: computerArg,
        },
        required: ["command"],
        additionalProperties: false,
      },
      level: "command",
      approvalTitle: (args) =>
        `Run ${where(args)}: ${summarize(str(args, "command") ?? "", TITLE_COMMAND_CHARS)}`,
      approvalDetail: (args) => {
        const command = str(args, "command") ?? "";
        const cwd = str(args, "cwd");
        return (
          [
            command.length > TITLE_COMMAND_CHARS ? summarize(command, DETAIL_COMMAND_CHARS) : null,
            cwd ? `In ${summarize(cwd, 200)}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        );
      },
      prepare,
      run: (deps, args) =>
        Effect.gen(function* () {
          const { api, computer } = yield* target(deps, args);
          const seconds = num(args, "timeoutSeconds");
          const result = yield* asFailure(
            api.exec({
              computerId: computer.id,
              cmd: str(args, "command")!,
              cwd: str(args, "cwd"),
              timeoutMs: seconds === undefined ? undefined : seconds * 1000,
              threadId: deps.caller.threadId,
            }),
          );
          return {
            computer: computer.name,
            exitCode: result.exitCode,
            ...(result.signal ? { signal: result.signal } : {}),
            timedOut: result.timedOut,
            output: result.text,
            ...(result.cutBytes > 0 ? { outputCutBytes: result.cutBytes } : {}),
            seconds: Math.round(result.durationMs / 100) / 10,
            ...(result.timedOut
              ? {
                  note: "It ran out of time and was stopped. Give it a longer timeoutSeconds, or run it in the background and check on it.",
                }
              : {}),
          };
        }),
    },
    {
      name: "my_computer_read_file",
      group: "my-computer",
      description: `Read a file on the person's own computer (not this cloud computer); it shows in a journal they can read. Text comes into the chat, ${READ_DEFAULT_BYTES / 1024} KiB by default: read on with \`offset\`. \`saveTo\` copies the whole file to this computer instead, any kind, up to 50 MiB.`,
      inputSchema: {
        type: "object",
        properties: {
          path: pathArg("Path on that computer: absolute, or from its home folder (~/notes.txt)."),
          offset: { type: "integer", minimum: 0 },
          maxBytes: { type: "integer", minimum: 1, maximum: READ_MAX_BYTES },
          saveTo: pathArg("Save it here, a path on this cloud computer, instead of in the chat."),
          computer: computerArg,
        },
        required: ["path"],
        additionalProperties: false,
      },
      // Saving writes to this computer's disk.
      level: (args) => (args.saveTo === undefined ? "safe" : "change"),
      approvalTitle: (args) =>
        `Copy ${summarize(str(args, "path") ?? "", TITLE_COMMAND_CHARS)} from your computer to this one`,
      // Only saving can bring a card; reading checks everything in `run`.
      prepare: (deps, args) => (args.saveTo === undefined ? Effect.void : prepare(deps, args)),
      run: (deps, args) =>
        Effect.gen(function* () {
          const { computer } = yield* target(deps, args);
          return yield* args.saveTo === undefined
            ? readForChat(deps, args, computer)
            : saveHere(deps, args, computer);
        }),
    },
    {
      name: "my_computer_write_file",
      group: "my-computer",
      description:
        "Write a file on the person's own computer (not this cloud computer); it shows in a journal they can read. `content`: text, replaces the file (`append: true` adds to its end). `fromFile`: copies a file of this cloud computer there, any kind, up to 50 MiB. Folders on the way are created. Get their OK in the chat before overwriting something that matters.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathArg("Path on that computer: absolute, or from its home folder (~/notes.txt)."),
          content: { type: "string", maxLength: WRITE_TEXT_MAX_CHARS },
          fromFile: pathArg("Instead of `content`: a file on this cloud computer."),
          append: { type: "boolean" },
          computer: computerArg,
        },
        required: ["path"],
        additionalProperties: false,
      },
      level: "change",
      approvalTitle: (args) =>
        `Write ${summarize(str(args, "path") ?? "", TITLE_COMMAND_CHARS)} ${where(args)}`,
      approvalDetail: (args) => {
        const fromFile = str(args, "fromFile");
        const content = str(args, "content");
        return fromFile
          ? `From ${summarize(fromFile, 200)} on this computer`
          : content === undefined
            ? undefined
            : `${content.length} characters`;
      },
      prepare: (deps, args) =>
        Effect.gen(function* () {
          if ((args.content === undefined) === (args.fromFile === undefined)) {
            return yield* kit.fail("Give either `content` or `fromFile`.");
          }
          yield* prepare(deps, args);
        }),
      run: (deps, args) =>
        Effect.gen(function* () {
          const { api, computer } = yield* target(deps, args);
          const data = yield* writeSource(deps, args);
          const written = yield* asFailure(
            api.write({
              computerId: computer.id,
              path: str(args, "path")!,
              data,
              append: args.append === true,
              mkdirs: true,
              threadId: deps.caller.threadId,
            }),
          );
          return { computer: computer.name, path: str(args, "path")!, bytes: written.bytes };
        }),
    },
    {
      name: "my_computer_list_files",
      group: "my-computer",
      description:
        "List a folder on the person's own computer (not this cloud computer); it shows in a journal they can read.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathArg("Folder on that computer. Default: its home folder (~)."),
          computer: computerArg,
        },
        additionalProperties: false,
      },
      level: "safe",
      run: (deps, args) =>
        Effect.gen(function* () {
          const { api, computer } = yield* target(deps, args);
          const folder = str(args, "path") ?? "~";
          const answer = yield* asFailure(
            api.list({ computerId: computer.id, path: folder, threadId: deps.caller.threadId }),
          );
          const entries = Array.isArray(answer["entries"]) ? answer["entries"] : [];
          return {
            computer: computer.name,
            path: folder,
            entries: entries.slice(0, LIST_LIMIT),
            ...(entries.length > LIST_LIMIT
              ? { note: `Showing the first ${LIST_LIMIT} of ${entries.length}.` }
              : {}),
          };
        }),
    },
  ];
}

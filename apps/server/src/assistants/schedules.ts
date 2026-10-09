/**
 * An assistant's schedules (`schedule_create / schedule_list / schedule_delete`
 * in `uno-manager`): scheduled tasks of the Uno console on the assistant's
 * own computer whose command is `uno-work assistant-turn …`.
 *
 * Why the console and not cron: the computer sleeps between runs — only the
 * console can wake it — and the person sees every schedule on the
 * assistant's card (and in the console) instead of a hidden crontab line.
 *
 * Calls go with this computer's own token (`settings.uno.boxToken`); the
 * console decides what that token may do and pins it to this box. The daemon
 * still sends only its own `box_id`, lists only its own box's assistant
 * commands and deletes only those — defence in depth, not the boundary.
 *
 * @module assistants/schedules
 */
import {
  ASSISTANT_SCHEDULE_DEFAULT_MINUTES,
  ManagerScheduleCreateInput,
  ManagerScheduleDeleteInput,
  assistantTokenLabel,
  isAssistantProjectId,
  type ManagerSchedule,
  type ManagerScheduleDeleteResult,
  type ManagerScheduleListResult,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ASSISTANT_COMPUTER_ROLE, makeOwnComputerRoleReader } from "./computerRole.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import {
  callMachineConsole,
  readWorkMachineIdentity,
  type FetchLike,
  type WorkConsoleResponse,
  type WorkMachineIdentity,
} from "../manager/workConsole.ts";

/** The CLI every assistant schedule runs (on PATH via /usr/local/bin). */
export const ASSISTANT_TURN_COMMAND = "uno-work assistant-turn";
/** Wake + harness start on a sleeping computer, on top of the turn itself. */
export const ASSISTANT_TURN_WAKE_SLACK_SEC = 120;

const SCHEDULED_TASKS_PATH = "/api/v1/scheduled-tasks";

export class AssistantScheduleError extends Data.TaggedError("AssistantScheduleError")<{
  readonly message: string;
}> {}

// ── Command line ───────────────────────────────────────────────────────

/** POSIX single-quoting: safe for any byte but NUL (removed upstream). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One line, no control characters: the console runs the command through a
 * shell as a single line, and a person reads it there.
 */
export function normalizeScheduleText(value: string): string {
  return (
    value
      // oxlint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface AssistantTurnCommandInput {
  readonly workspaceRoot: string;
  readonly name: string;
  readonly prompt: string;
  readonly timeoutSec: number;
}

export function buildAssistantTurnCommand(input: AssistantTurnCommandInput): string {
  return [
    ASSISTANT_TURN_COMMAND,
    "--workspace",
    shellQuote(input.workspaceRoot),
    "--name",
    shellQuote(normalizeScheduleText(input.name)),
    "--timeout-sec",
    String(Math.max(1, Math.floor(input.timeoutSec))),
    "--prompt",
    shellQuote(normalizeScheduleText(input.prompt)),
  ].join(" ");
}

/** Split a shell line into words: single quotes, double quotes, backslashes. */
export function splitShellWords(line: string): ReadonlyArray<string> | null {
  const words: Array<string> = [];
  let current = "";
  let inWord = false;
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) return null;
      current += line.slice(index + 1, end);
      inWord = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === "\\" && index + 1 < line.length) index += 1;
        current += line[index];
        index += 1;
      }
      if (index >= line.length) return null;
      inWord = true;
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < line.length) {
      current += line[index + 1];
      inWord = true;
      index += 2;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      index += 1;
      continue;
    }
    current += char;
    inWord = true;
    index += 1;
  }
  if (inWord) words.push(current);
  return words;
}

export interface ParsedAssistantTurnCommand {
  readonly workspaceRoot: string | null;
  readonly name: string | null;
  readonly prompt: string;
  readonly timeoutSec: number | null;
}

/** Our own `uno-work assistant-turn …` line back into its parts, else null. */
export function parseAssistantTurnCommand(command: string): ParsedAssistantTurnCommand | null {
  const words = splitShellWords(command.trim());
  if (words === null || words.length < 2) return null;
  const binary = words[0]!.split("/").at(-1);
  if (binary !== "uno-work" || words[1] !== "assistant-turn") return null;
  const flags = new Map<string, string>();
  for (let index = 2; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word.startsWith("--")) continue;
    const eq = word.indexOf("=");
    if (eq !== -1) {
      flags.set(word.slice(2, eq), word.slice(eq + 1));
    } else if (index + 1 < words.length) {
      flags.set(word.slice(2), words[index + 1]!);
      index += 1;
    }
  }
  const prompt = flags.get("prompt");
  if (prompt === undefined || prompt.trim().length === 0) return null;
  const timeout = Number(flags.get("timeout-sec"));
  return {
    workspaceRoot: flags.get("workspace") ?? null,
    name: flags.get("name") ?? null,
    prompt,
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
  };
}

// ── Console answers ────────────────────────────────────────────────────

function bodyField(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : null;
}

function bodyText(body: unknown, key: string): string | null {
  const value = bodyField(body, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** What the model reads when the console said no. */
export function scheduleConsoleProblem(response: WorkConsoleResponse): string {
  const code = bodyText(response.body, "code") ?? bodyText(response.body, "error");
  const detail = bodyText(response.body, "detail") ?? bodyText(response.body, "message");
  const said = [code, detail].filter((part): part is string => part !== null).join(": ");
  switch (response.status) {
    case 400:
      return `The Uno console refused the schedule${said ? ` (${said})` : ""}. Check the cron (five fields: minute hour day month weekday) and the time zone.`;
    case 401:
      return "This computer isn't signed in to the Uno console, so it can't keep schedules. Tell the person.";
    case 402:
      return `The person's plan doesn't allow scheduled tasks${said ? ` (${said})` : ""}. Tell them; don't work around it.`;
    case 403:
    case 404:
    case 405:
      return `Schedules for assistants aren't switched on for this computer yet (the Uno console answered ${response.status}${said ? `, ${said}` : ""}). Tell the person what you wanted to schedule; do NOT fall back to cron or a sleep loop.`;
    default:
      return `The Uno console answered ${response.status}${said ? ` (${said})` : ""}. Try again later.`;
  }
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * This assistant's schedules out of `GET /api/v1/scheduled-tasks`: tasks of
 * this box whose command is an assistant turn for this workspace.
 */
export function selectAssistantSchedules(
  body: unknown,
  scope: { readonly boxId: number; readonly workspaceRoot: string },
): ReadonlyArray<ManagerSchedule> {
  const tasks = bodyField(body, "tasks");
  if (!Array.isArray(tasks)) return [];
  const schedules: Array<ManagerSchedule> = [];
  for (const task of tasks as ReadonlyArray<unknown>) {
    const id = numberField(bodyField(task, "id"));
    if (id === null || bodyField(task, "box_id") !== scope.boxId) continue;
    const command = bodyText(task, "command");
    const parsed = command === null ? null : parseAssistantTurnCommand(command);
    if (parsed === null) continue;
    if (parsed.workspaceRoot !== null && parsed.workspaceRoot !== scope.workspaceRoot) continue;
    schedules.push({
      scheduleId: id,
      name: bodyText(task, "name") ?? parsed.name ?? `Schedule ${id}`,
      cron: bodyText(task, "cron_expr") ?? "",
      timezone: nullableText(bodyField(task, "timezone")),
      prompt: parsed.prompt,
      state: nullableText(bodyField(task, "state")),
      nextRunAt: nullableText(bodyField(task, "next_run_at")),
      lastRunAt: nullableText(bodyField(task, "last_run_at")),
    });
  }
  return schedules;
}

// ── Service ────────────────────────────────────────────────────────────

/** The assistant project a manager token belongs to, from its label. */
export function assistantProjectOfCaller(caller: ManagerCaller): ProjectId | null {
  const label = caller.label ?? "";
  const prefix = assistantTokenLabel("");
  if (!label.startsWith(prefix)) return null;
  const projectId = label.slice(prefix.length);
  return isAssistantProjectId(projectId) ? ProjectId.make(projectId) : null;
}

export interface AssistantScheduleCreated {
  readonly created: true;
  /** Null when the console's answer could not be read back (it was created). */
  readonly schedule: ManagerSchedule | null;
  readonly note: string;
}

export interface AssistantSchedulesShape {
  readonly create: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<AssistantScheduleCreated, AssistantScheduleError>;
  readonly list: (
    caller: ManagerCaller,
  ) => Effect.Effect<ManagerScheduleListResult, AssistantScheduleError>;
  readonly remove: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<ManagerScheduleDeleteResult, AssistantScheduleError>;
  /**
   * The person's side (owner session, Work's Uno chat): the schedules of one
   * assistant of this computer — what runs when, with Pause and Remove.
   */
  readonly ownerList: (
    projectId: ProjectId,
  ) => Effect.Effect<ManagerScheduleListResult, AssistantScheduleError>;
  readonly ownerAct: (
    projectId: ProjectId,
    scheduleId: number,
    action: AssistantScheduleOwnerAction,
  ) => Effect.Effect<{ readonly done: boolean }, AssistantScheduleError>;
}

/** What the person can do to a schedule from Work. */
export type AssistantScheduleOwnerAction = "pause" | "resume" | "remove";

export class AssistantSchedules extends Context.Service<
  AssistantSchedules,
  AssistantSchedulesShape
>()("t3/assistants/AssistantSchedules") {}

const fail = (message: string) => Effect.fail(new AssistantScheduleError({ message }));

/**
 * What the console does with the computer after a scheduled run. Only an
 * assistant's own computer goes back to sleep; on a person's computer (an
 * assistant that lives "right here", 0.0.106) the run must never hibernate
 * the machine under them — economy mode puts it to sleep on idle instead.
 */
export function scheduleOnFinish(computerRole: string | null): "hibernate" | "keep" {
  return computerRole === ASSISTANT_COMPUTER_ROLE ? "hibernate" : "keep";
}

export const makeAssistantSchedules = (options?: { readonly fetchImpl?: FetchLike }) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const projections = yield* ProjectionSnapshotQuery;
    const readRole = makeOwnComputerRoleReader(
      options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {},
    );

    /** Who is asking: the machine identity and the assistant's workspace. */
    const resolveScope = (caller: ManagerCaller) =>
      Effect.gen(function* () {
        const projectId = assistantProjectOfCaller(caller);
        if (projectId === null) {
          return yield* fail(
            "Schedules belong to an assistant: this token is not an assistant's own token.",
          );
        }
        return yield* resolveProjectScope(projectId);
      });

    /** The machine identity and the workspace of one assistant of this computer. */
    const resolveProjectScope = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
        const identity = readWorkMachineIdentity(settings?.uno);
        if (identity === null) {
          return yield* fail(
            "Schedules need an Uno cloud computer (this one isn't linked to the Uno console). Tell the person; don't use cron.",
          );
        }
        const project = yield* projections
          .getProjectShellById(projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(project)) {
          return yield* fail(`The assistant ${projectId} has no workspace on this computer.`);
        }
        return { identity, projectId, workspaceRoot: project.value.workspaceRoot };
      });

    const call = (
      identity: WorkMachineIdentity,
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ) =>
      callMachineConsole({
        identity,
        method,
        path,
        ...(body !== undefined ? { body } : {}),
        ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AssistantScheduleError({
              message: `The Uno console didn't answer (${cause.message}). Try again later.`,
            }),
        ),
      );

    const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
      Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
        Effect.mapError(
          (error) => new AssistantScheduleError({ message: `Invalid arguments: ${error.message}` }),
        ),
      );

    const listOwn = (scope: {
      readonly identity: WorkMachineIdentity;
      readonly workspaceRoot: string;
    }) =>
      Effect.gen(function* () {
        const response = yield* call(scope.identity, "GET", SCHEDULED_TASKS_PATH);
        if (response.status !== 200) return yield* fail(scheduleConsoleProblem(response));
        return selectAssistantSchedules(response.body, {
          boxId: scope.identity.boxId,
          workspaceRoot: scope.workspaceRoot,
        });
      });

    const create: AssistantSchedulesShape["create"] = (caller, args) =>
      Effect.gen(function* () {
        const input = yield* decode(ManagerScheduleCreateInput, args);
        const scope = yield* resolveScope(caller);
        const turnTimeoutSec = (input.maxMinutes ?? ASSISTANT_SCHEDULE_DEFAULT_MINUTES) * 60;
        const command = buildAssistantTurnCommand({
          workspaceRoot: scope.workspaceRoot,
          name: input.name,
          prompt: input.prompt,
          timeoutSec: turnTimeoutSec,
        });
        const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
        const role = yield* Effect.promise(() => readRole(settings?.uno));
        const response = yield* call(scope.identity, "POST", SCHEDULED_TASKS_PATH, {
          on_finish: scheduleOnFinish(role),
          name: normalizeScheduleText(input.name),
          box_id: scope.identity.boxId,
          cron_expr: input.cron,
          ...(input.timezone ? { timezone: input.timezone } : {}),
          command,
          timeout_sec: turnTimeoutSec + ASSISTANT_TURN_WAKE_SLACK_SEC,
        });
        if (response.status !== 200 && response.status !== 201) {
          return yield* fail(scheduleConsoleProblem(response));
        }
        const created = selectAssistantSchedules(
          { tasks: [response.body] },
          { boxId: scope.identity.boxId, workspaceRoot: scope.workspaceRoot },
        )[0];
        yield* Effect.logInfo("assistant schedule created").pipe(
          Effect.annotateLogs({
            projectId: scope.projectId,
            scheduleId: created?.scheduleId ?? null,
            cron: input.cron,
          }),
        );
        return {
          created: true,
          schedule: created ?? null,
          note: "The person sees this schedule on your card and can stop it. At run time you get the prompt as a new message; your answer goes to their Telegram/Slack (answer NO_REPLY when there is nothing to tell).",
        };
      });

    const list: AssistantSchedulesShape["list"] = (caller) =>
      resolveScope(caller).pipe(
        Effect.flatMap(listOwn),
        Effect.map((schedules) => ({ schedules })),
      );

    const remove: AssistantSchedulesShape["remove"] = (caller, args) =>
      Effect.gen(function* () {
        const input = yield* decode(ManagerScheduleDeleteInput, args);
        const scope = yield* resolveScope(caller);
        const own = yield* listOwn(scope);
        if (!own.some((schedule) => schedule.scheduleId === input.scheduleId)) {
          return yield* fail(
            `Schedule ${input.scheduleId} is not one of yours. Call schedule_list for your schedules.`,
          );
        }
        const response = yield* call(
          scope.identity,
          "DELETE",
          `${SCHEDULED_TASKS_PATH}/${input.scheduleId}`,
        );
        if (response.status === 404) return { deleted: false };
        if (response.status !== 200 && response.status !== 204) {
          return yield* fail(scheduleConsoleProblem(response));
        }
        yield* Effect.logInfo("assistant schedule deleted").pipe(
          Effect.annotateLogs({ projectId: scope.projectId, scheduleId: input.scheduleId }),
        );
        return { deleted: true };
      });

    const ownerList: AssistantSchedulesShape["ownerList"] = (projectId) =>
      resolveProjectScope(projectId).pipe(
        Effect.flatMap(listOwn),
        Effect.map((schedules) => ({ schedules })),
      );

    const ownerAct: AssistantSchedulesShape["ownerAct"] = (projectId, scheduleId, action) =>
      Effect.gen(function* () {
        const scope = yield* resolveProjectScope(projectId);
        const own = yield* listOwn(scope);
        if (!own.some((schedule) => schedule.scheduleId === scheduleId)) {
          return yield* fail(`Schedule ${scheduleId} is not one of this assistant's.`);
        }
        const response =
          action === "remove"
            ? yield* call(scope.identity, "DELETE", `${SCHEDULED_TASKS_PATH}/${scheduleId}`)
            : yield* call(scope.identity, "PATCH", `${SCHEDULED_TASKS_PATH}/${scheduleId}/${action}`);
        if (response.status === 404) return { done: false };
        if (response.status < 200 || response.status >= 300) {
          return yield* fail(scheduleConsoleProblem(response));
        }
        yield* Effect.logInfo("assistant schedule changed by the person").pipe(
          Effect.annotateLogs({ projectId, scheduleId, action }),
        );
        return { done: true };
      });

    return { create, list, remove, ownerList, ownerAct } satisfies AssistantSchedulesShape;
  });

export const AssistantSchedulesLive = Layer.effect(AssistantSchedules, makeAssistantSchedules());

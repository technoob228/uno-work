/**
 * Automations on this computer: what the web (`/api/manager/automations*`)
 * and the assistants (`automation_*` in `uno-manager`) do with them. The
 * console keeps and runs them (`consoleClient.ts`); the queue of events is
 * pulled by `eventLoop.ts`.
 *
 * Who an automation belongs to: an assistant on THIS computer. The web names
 * it (the person picks it); an assistant's tool call is always its own
 * (the token's label, never the arguments). Its name comes from its profile.
 *
 * @module automations/AutomationsService
 */
import {
  AUTOMATION_NAME_MAX_CHARS,
  AutomationCreateInput,
  AutomationUpdateInput,
  describeAutomationTrigger,
  isAssistantProjectId,
  ProjectId,
  type Automation,
  type AutomationGithubReposResult,
  type AutomationListResult,
  type AutomationRun,
  type AutomationTrigger,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { memberName } from "../assistants/assistantTeam.ts";
import { assistantProjectOfCaller } from "../assistants/schedules.ts";
import { readTeam } from "../assistants/teamStore.ts";
import { ServerConfig } from "../config.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { readWorkMachineIdentity, type FetchLike } from "../manager/workConsole.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  AutomationClientError,
  makeAutomationsClient,
  type AutomationsClient,
} from "./consoleClient.ts";
import { oneLine } from "./prompt.ts";

const invalid = (message: string) =>
  new AutomationClientError({ status: 400, code: "INVALID_REQUEST", message });

/** A name when none was given: the instruction's start, on one line. */
export function defaultAutomationName(instruction: string, trigger: AutomationTrigger): string {
  const first = oneLine(instruction.split(/(?<=[.!?])\s/)[0] ?? instruction, 60);
  if (first.length > 0) return first;
  return oneLine(describeAutomationTrigger(trigger), AUTOMATION_NAME_MAX_CHARS);
}

/** What the assistant tells the person after `automation_create` (one line). */
export function createdTell(automation: Automation): string {
  const when = describeAutomationTrigger(automation.trigger);
  const base = `✓ Automation created: "${automation.name}" — ${when}. It's on the Automations page; the person can pause or change it there.`;
  switch (automation.status) {
    case "needs_github_permission":
      return `${base} Before it can comment, GitHub needs one more permission: tell the person in one line and give them this link${automation.manageUrl ? `: ${automation.manageUrl}` : " (Review on GitHub, on the Automations page)"}.`;
    case "needs_github_repo":
      return `${base} Uno's GitHub app can't see that repository yet: tell the person in one line and give them this link${automation.manageUrl ? `: ${automation.manageUrl}` : " (Add it on GitHub, on the Automations page)"}.`;
    case "github_not_connected":
      return `${base} GitHub isn't connected yet: tell the person in one line (Connect GitHub on the Automations page).`;
    default:
      return base;
  }
}

/** The refusal an assistant reads: the console's line plus what to do with it. */
function forAssistant(error: AutomationClientError): AutomationClientError {
  const link = error.manageUrl ?? error.connectUrl;
  if (link === undefined) return error;
  return new AutomationClientError({
    status: error.status,
    code: error.code,
    message: `${error.message} Tell the person in one line and give them the link; don't work around it.`,
    ...(error.manageUrl ? { manageUrl: error.manageUrl } : {}),
    ...(error.connectUrl ? { connectUrl: error.connectUrl } : {}),
  });
}

export interface AutomationsServiceShape {
  readonly client: AutomationsClient;
  // The web (the person's own session): any assistant of this computer.
  readonly list: Effect.Effect<AutomationListResult>;
  readonly create: (args: unknown) => Effect.Effect<Automation, AutomationClientError>;
  readonly update: (id: number, args: unknown) => Effect.Effect<Automation, AutomationClientError>;
  readonly remove: (
    id: number,
  ) => Effect.Effect<{ readonly deleted: boolean }, AutomationClientError>;
  readonly runNow: (id: number) => Effect.Effect<AutomationRun | null, AutomationClientError>;
  readonly runs: (
    id: number,
  ) => Effect.Effect<{ readonly runs: ReadonlyArray<AutomationRun> }, AutomationClientError>;
  readonly repos: (
    query: string,
  ) => Effect.Effect<AutomationGithubReposResult, AutomationClientError>;
  // An assistant's own tools: only its own automations.
  readonly toolCreate: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<unknown, AutomationClientError>;
  readonly toolList: (caller: ManagerCaller) => Effect.Effect<unknown, AutomationClientError>;
  readonly toolUpdate: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<unknown, AutomationClientError>;
  readonly toolDelete: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<unknown, AutomationClientError>;
  /** Enabled `call.ended` automations of an assistant (for its turn after a call). */
  readonly afterCall: (
    assistant: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly instruction: string }>>;
  /** The assistant's name on this computer, or null when it isn't here. */
  readonly assistantName: (assistant: string) => Effect.Effect<string | null>;
}

export class AutomationsService extends Context.Service<
  AutomationsService,
  AutomationsServiceShape
>()("t3/automations/AutomationsService") {}

const ToolUpdateArgs = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  enabled: Schema.optional(Schema.Boolean),
  name: AutomationUpdateInput.fields.name,
  instruction: AutomationUpdateInput.fields.instruction,
  trigger: AutomationUpdateInput.fields.trigger,
});
const ToolDeleteArgs = Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) });

/** What `automation_list` shows an assistant: enough to change one, in words. */
function toolView(automation: Automation) {
  return {
    id: automation.id,
    name: automation.name,
    when: describeAutomationTrigger(automation.trigger),
    trigger: automation.trigger,
    instruction: automation.instruction,
    enabled: automation.enabled,
    status: automation.status,
    ...(automation.statusDetail ? { statusDetail: automation.statusDetail } : {}),
    ...(automation.manageUrl ? { manageUrl: automation.manageUrl } : {}),
    nextRunAt: automation.nextRunAt,
    lastRun:
      automation.lastRun === null
        ? null
        : {
            state: automation.lastRun.state,
            title: automation.lastRun.title,
            at: automation.lastRun.finishedAt ?? automation.lastRun.createdAt,
            ...(automation.lastRun.reason ? { reason: automation.lastRun.reason } : {}),
          },
  };
}

export const makeAutomationsService = (options?: { readonly fetchImpl?: FetchLike }) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const projections = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;

    const client = makeAutomationsClient({
      identity: settingsService.getSettings.pipe(
        Effect.map((settings) => readWorkMachineIdentity(settings.uno)),
        Effect.orElseSucceed(() => null),
      ),
      ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    const assistantName: AutomationsServiceShape["assistantName"] = (assistant) =>
      Effect.gen(function* () {
        if (!isAssistantProjectId(assistant)) return null;
        const projectId = ProjectId.make(assistant);
        const project = yield* projections
          .getProjectShellById(projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(project)) return null;
        const team = yield* Effect.promise(() => readTeam(config.stateDir, assistant));
        return memberName({ projectId, title: project.value.title, team });
      });

    const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
      Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
        Effect.mapError((error) => invalid(`Invalid arguments: ${error.message}`)),
      );

    const createFor = (assistant: string, input: AutomationCreateInput) =>
      Effect.gen(function* () {
        const name = yield* assistantName(assistant);
        if (name === null) {
          return yield* new AutomationClientError({
            status: 404,
            code: "NOT_FOUND",
            message: "That assistant isn't on this computer.",
          });
        }
        const automation = yield* client.create({
          assistant,
          assistantName: name,
          name: input.name ?? defaultAutomationName(input.instruction, input.trigger),
          instruction: input.instruction,
          trigger: input.trigger,
          enabled: input.enabled,
        });
        yield* Effect.logInfo("automation created").pipe(
          Effect.annotateLogs({
            automationId: automation.id,
            assistant,
            trigger: automation.trigger.kind,
            status: automation.status,
          }),
        );
        return automation;
      });

    /** The caller's assistant, or a refusal for any other token. */
    const callerAssistant = (caller: ManagerCaller) => {
      const projectId = assistantProjectOfCaller(caller);
      return projectId === null
        ? Effect.fail(
            new AutomationClientError({
              status: 403,
              code: "NOT_AN_ASSISTANT",
              message:
                "Automations belong to an assistant: this token is not an assistant's own token.",
            }),
          )
        : Effect.succeed(projectId as string);
    };

    const ownAutomations = (assistant: string) =>
      client.list.pipe(
        Effect.flatMap((result) =>
          result.available
            ? Effect.succeed(result.automations.filter((a) => a.assistant === assistant))
            : Effect.fail(
                new AutomationClientError({
                  status: 409,
                  code:
                    result.reason === "not_cloud_computer"
                      ? "NOT_CLOUD_COMPUTER"
                      : result.reason === "disabled"
                        ? "AUTOMATIONS_DISABLED"
                        : "CONSOLE_UNREACHABLE",
                  message:
                    result.reason === "not_cloud_computer"
                      ? "Automations run on an Uno cloud computer; this one isn't (a laptop sleeps). Tell the person in one line; don't use cron or a sleep loop."
                      : result.reason === "disabled"
                        ? "Automations aren't switched on for this Uno account yet. Tell the person what you wanted to set up; don't use cron or a sleep loop."
                        : "The Uno console didn't answer. Try again in a minute.",
                }),
              ),
        ),
      );

    const ensureOwn = (assistant: string, id: number) =>
      ownAutomations(assistant).pipe(
        Effect.flatMap((own) =>
          own.some((a) => a.id === id)
            ? Effect.void
            : Effect.fail(
                new AutomationClientError({
                  status: 404,
                  code: "NOT_FOUND",
                  message: `Automation ${id} is not one of yours. Call automation_list for yours.`,
                }),
              ),
        ),
      );

    /**
     * The list with each assistant's name as its profile says now: a renamed
     * assistant shows its new name at once, and the console is told in the
     * background (`assistant_name` in PATCH) for its own lists and Inbox.
     */
    const listFresh: Effect.Effect<AutomationListResult> = Effect.gen(function* () {
      const result = yield* client.list;
      if (!result.available) return result;
      const names = new Map<string, string | null>();
      const automations: Automation[] = [];
      for (const automation of result.automations) {
        if (!names.has(automation.assistant)) {
          names.set(automation.assistant, yield* assistantName(automation.assistant));
        }
        const current = names.get(automation.assistant) ?? null;
        if (current === null || current === automation.assistantName) {
          automations.push(automation);
          continue;
        }
        yield* Effect.forkDetach(
          client
            .update(automation.id, { assistantName: current })
            .pipe(Effect.ignoreCause({ log: true })),
        );
        automations.push({ ...automation, assistantName: current });
      }
      return { ...result, automations };
    });

    const service: AutomationsServiceShape = {
      client,
      list: listFresh,
      create: (args) =>
        Effect.gen(function* () {
          const input = yield* decode(AutomationCreateInput, args);
          if (input.assistant === undefined) {
            return yield* invalid("Which assistant? (assistant: its project id)");
          }
          return yield* createFor(input.assistant, input);
        }),
      update: (id, args) =>
        decode(AutomationUpdateInput, args).pipe(
          Effect.flatMap((input) => client.update(id, input)),
        ),
      remove: (id) => client.remove(id),
      runNow: (id) => client.runNow(id),
      runs: (id) => client.runs(id).pipe(Effect.map((runs) => ({ runs }))),
      repos: (query) => client.repos(query),

      toolCreate: (caller, args) =>
        Effect.gen(function* () {
          const assistant = yield* callerAssistant(caller);
          // The assistant is the caller, whatever the arguments say.
          const raw =
            typeof args === "object" && args !== null ? { ...(args as object), assistant } : args;
          const input = yield* decode(AutomationCreateInput, raw);
          const automation = yield* createFor(assistant, input).pipe(Effect.mapError(forAssistant));
          return { created: true, automation, tell: createdTell(automation) };
        }),
      toolList: (caller) =>
        callerAssistant(caller).pipe(
          Effect.flatMap(ownAutomations),
          Effect.map((own) => ({ automations: own.map(toolView) })),
        ),
      toolUpdate: (caller, args) =>
        Effect.gen(function* () {
          const assistant = yield* callerAssistant(caller);
          const { id, ...patch } = yield* decode(ToolUpdateArgs, args);
          yield* ensureOwn(assistant, id);
          const automation = yield* client.update(id, patch).pipe(Effect.mapError(forAssistant));
          return { updated: true, automation: toolView(automation) };
        }),
      toolDelete: (caller, args) =>
        Effect.gen(function* () {
          const assistant = yield* callerAssistant(caller);
          const { id } = yield* decode(ToolDeleteArgs, args);
          yield* ensureOwn(assistant, id);
          return yield* client.remove(id);
        }),
      afterCall: (assistant) =>
        client.list.pipe(
          Effect.map((result) =>
            result.automations
              .filter(
                (a) => a.enabled && a.assistant === assistant && a.trigger.kind === "call.ended",
              )
              .map((a) => ({ name: a.name, instruction: a.instruction })),
          ),
        ),
      assistantName,
    };
    return service;
  });

export const AutomationsServiceLive = Layer.effect(AutomationsService, makeAutomationsService());

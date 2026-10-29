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
  automationExecutorOf,
  automationRunsInChat,
  describeAutomationTrigger,
  isAssistantProjectId,
  ProjectId,
  type Automation,
  type AutomationGithubReposResult,
  type AutomationListResult,
  type AutomationExecutor,
  type AutomationRun,
  type AutomationTrigger,
  ThreadId,
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
  const executor = automationExecutorOf(automation);
  const where =
    executor.kind === "chat"
      ? " It runs in this chat (the clock at the top of the chat shows it); the person can pause or change it there or on the Automations page."
      : executor.kind === "new_chat"
        ? " Each run opens a new chat in this project; the person can pause or change it on the Automations page."
        : " It's on the Automations page; the person can pause or change it there.";
  const base = `✓ Automation created: "${automation.name}" — ${when}.${where}`;
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
  // A chat's own tools (`uno-work` automation_*): the automations it runs.
  readonly chatTools: (caller: AutomationChatCaller) => AutomationChatTools;
}

/** Who calls the `uno-work` automation tools. */
export interface AutomationChatCaller {
  readonly threadId: string;
  /**
   * The assistant whose own conversation this is (its automations are its
   * own), or null. Looked up only when a tool runs.
   */
  readonly assistant: Effect.Effect<string | null>;
}

interface ResolvedChatCaller {
  readonly threadId: string;
  readonly assistant: string | null;
}

export interface AutomationChatTools {
  readonly create: (args: unknown) => Effect.Effect<unknown, AutomationClientError>;
  readonly list: (args: unknown) => Effect.Effect<unknown, AutomationClientError>;
  readonly update: (args: unknown) => Effect.Effect<unknown, AutomationClientError>;
  readonly remove: (args: unknown) => Effect.Effect<unknown, AutomationClientError>;
  readonly runNow: (args: unknown) => Effect.Effect<unknown, AutomationClientError>;
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
const ChatCreateArgs = Schema.Struct({
  name: AutomationCreateInput.fields.name,
  instruction: AutomationCreateInput.fields.instruction,
  trigger: AutomationCreateInput.fields.trigger,
  enabled: AutomationCreateInput.fields.enabled,
  runIn: Schema.optional(Schema.Literals(["this_chat", "new_chat"])),
});
const ChatListArgs = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["this_chat", "all"])),
});

/** What `automation_list` shows an assistant: enough to change one, in words. */
function toolView(automation: Automation) {
  const executor = automationExecutorOf(automation);
  return {
    id: automation.id,
    name: automation.name,
    when: describeAutomationTrigger(automation.trigger),
    runsIn:
      executor.kind === "chat"
        ? `the chat ${executor.threadId}`
        : executor.kind === "new_chat"
          ? `a new chat in project ${executor.projectId}`
          : `the assistant ${automation.assistantName || automation.assistant}`,
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

    const badExecutor = (message: string) =>
      new AutomationClientError({ status: 400, code: "INVALID_EXECUTOR", message });

    /**
     * The executor as it will be stored: the chat / project must be on this
     * computer (the console can't see them); its name goes along for lists.
     */
    const checkExecutor = (executor: AutomationExecutor) =>
      Effect.gen(function* () {
        switch (executor.kind) {
          case "assistant":
            return executor;
          case "chat": {
            const shell = yield* projections
              .getThreadShellById(ThreadId.make(executor.threadId))
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (Option.isNone(shell) || shell.value.archivedAt !== null) {
              return yield* badExecutor("That chat isn't on this computer (or it's archived).");
            }
            return { ...executor, title: oneLine(shell.value.title, 120) };
          }
          case "new_chat": {
            const project = yield* projections
              .getProjectShellById(ProjectId.make(executor.projectId))
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (Option.isNone(project)) {
              return yield* badExecutor("That project isn't on this computer.");
            }
            return { ...executor, title: oneLine(project.value.title, 120) };
          }
        }
      });

    const createWith = (input: AutomationCreateInput) =>
      Effect.gen(function* () {
        const executor = input.executor ?? { kind: "assistant" as const };
        if (executor.kind === "assistant") {
          if (input.assistant === undefined) {
            return yield* invalid("Which assistant? (assistant: its project id)");
          }
          return yield* createFor(input.assistant, input);
        }
        if (input.trigger.kind === "call.ended") {
          return yield* badExecutor(
            "After a call runs for an assistant (its notetaker joins the call), not for a chat.",
          );
        }
        const checked = yield* checkExecutor(executor);
        const automation = yield* client.create({
          assistant: input.assistant ?? "",
          assistantName: "",
          name: input.name ?? defaultAutomationName(input.instruction, input.trigger),
          instruction: input.instruction,
          trigger: input.trigger,
          executor: checked,
          enabled: input.enabled,
        });
        yield* Effect.logInfo("automation created").pipe(
          Effect.annotateLogs({
            automationId: automation.id,
            executor: checked.kind,
            trigger: automation.trigger.kind,
          }),
        );
        return automation;
      });

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
      return { ...result, automations: yield* withCurrentTitles(automations) };
    });

    /** Chats and projects as they are called now (renamed after it was set up). */
    const withCurrentTitles = (automations: ReadonlyArray<Automation>) =>
      Effect.gen(function* () {
        if (!automations.some((a) => automationExecutorOf(a).kind !== "assistant")) {
          return [...automations];
        }
        const snapshot = yield* projections
          .getShellSnapshot()
          .pipe(Effect.orElseSucceed(() => null));
        if (snapshot === null) return [...automations];
        const threads = new Map(snapshot.threads.map((t) => [t.id as string, t.title]));
        const projects = new Map(snapshot.projects.map((p) => [p.id as string, p.title]));
        return automations.map((a): Automation => {
          const executor = automationExecutorOf(a);
          const title =
            executor.kind === "chat"
              ? threads.get(executor.threadId)
              : executor.kind === "new_chat"
                ? projects.get(executor.projectId)
                : undefined;
          return title === undefined || executor.kind === "assistant"
            ? a
            : { ...a, executor: { ...executor, title } };
        });
      });

    /** The automations this chat may see and change (its own; an assistant's conversation: the assistant's). */
    const chatOwns = (caller: ResolvedChatCaller, automation: Automation) =>
      automationRunsInChat(automation, caller.threadId) ||
      (caller.assistant !== null &&
        automation.assistant === caller.assistant &&
        automationExecutorOf(automation).kind === "assistant");

    const listAvailable = client.list.pipe(
      Effect.flatMap((result) =>
        result.available
          ? withCurrentTitles(result.automations)
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
                    ? "Automations run on an Uno cloud computer (Uno wakes it when one is due); this one isn't. Tell the person in one line; don't use cron or a sleep loop."
                    : result.reason === "disabled"
                      ? "Automations aren't switched on for this Uno account yet. Tell the person what you wanted to set up; don't use cron or a sleep loop."
                      : "The Uno console didn't answer. Try again in a minute.",
              }),
            ),
      ),
    );

    const ensureChatOwns = (caller: ResolvedChatCaller, id: number) =>
      listAvailable.pipe(
        Effect.flatMap((all) => {
          const found = all.find((a) => a.id === id);
          return found !== undefined && chatOwns(caller, found)
            ? Effect.succeed(found)
            : Effect.fail(
                new AutomationClientError({
                  status: 404,
                  code: "NOT_FOUND",
                  message: `Automation ${id} isn't one of this chat's. Call automations_list to see them.`,
                }),
              );
        }),
      );

    const resolve = (caller: AutomationChatCaller) =>
      caller.assistant.pipe(
        Effect.map((assistant): ResolvedChatCaller => ({ threadId: caller.threadId, assistant })),
      );

    const chatTools = (who: AutomationChatCaller): AutomationChatTools => ({
      create: (args) =>
        Effect.gen(function* () {
          const caller = yield* resolve(who);
          const input = yield* decode(ChatCreateArgs, args);
          const executor: AutomationExecutor | undefined =
            caller.assistant !== null
              ? undefined
              : input.runIn === "new_chat"
                ? yield* projections.getThreadShellById(ThreadId.make(caller.threadId)).pipe(
                    Effect.orElseSucceed(() => Option.none()),
                    Effect.flatMap((shell) =>
                      Option.isNone(shell)
                        ? Effect.fail(badExecutor("This chat isn't known yet; try again."))
                        : Effect.succeed({
                            kind: "new_chat" as const,
                            projectId: shell.value.projectId as string,
                            fromThreadId: caller.threadId,
                          }),
                    ),
                  )
                : { kind: "chat" as const, threadId: caller.threadId };
          const automation = yield* createWith({
            ...(input.name !== undefined ? { name: input.name } : {}),
            instruction: input.instruction,
            trigger: input.trigger,
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(caller.assistant !== null ? { assistant: caller.assistant } : {}),
            ...(executor !== undefined ? { executor } : {}),
          }).pipe(Effect.mapError(forAssistant));
          return { created: true, automation, tell: createdTell(automation) };
        }),
      list: (args) =>
        Effect.gen(function* () {
          const caller = yield* resolve(who);
          const { scope } = yield* decode(ChatListArgs, args);
          const all = yield* listAvailable;
          const shown = scope === "all" ? all : all.filter((a) => chatOwns(caller, a));
          return { automations: shown.map(toolView) };
        }),
      update: (args) =>
        Effect.gen(function* () {
          const caller = yield* resolve(who);
          const { id, ...patch } = yield* decode(ToolUpdateArgs, args);
          yield* ensureChatOwns(caller, id);
          const automation = yield* client.update(id, patch).pipe(Effect.mapError(forAssistant));
          return { updated: true, automation: toolView(automation) };
        }),
      remove: (args) =>
        Effect.gen(function* () {
          const caller = yield* resolve(who);
          const { id } = yield* decode(ToolDeleteArgs, args);
          yield* ensureChatOwns(caller, id);
          return yield* client.remove(id);
        }),
      runNow: (args) =>
        Effect.gen(function* () {
          const caller = yield* resolve(who);
          const { id } = yield* decode(ToolDeleteArgs, args);
          yield* ensureChatOwns(caller, id);
          const run = yield* client.runNow(id).pipe(Effect.mapError(forAssistant));
          return {
            started: true,
            run,
            note: "It runs in a moment (Uno queues it); the result shows where it runs.",
          };
        }),
    });

    const service: AutomationsServiceShape = {
      client,
      list: listFresh,
      create: (args) =>
        decode(AutomationCreateInput, args).pipe(Effect.flatMap((input) => createWith(input))),
      update: (id, args) =>
        Effect.gen(function* () {
          const input = yield* decode(AutomationUpdateInput, args);
          const executor =
            input.executor === undefined ? undefined : yield* checkExecutor(input.executor);
          return yield* client.update(id, {
            ...input,
            ...(executor !== undefined ? { executor } : {}),
          });
        }),
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
      chatTools,
    };
    return service;
  });

export const AutomationsServiceLive = Layer.effect(AutomationsService, makeAutomationsService());

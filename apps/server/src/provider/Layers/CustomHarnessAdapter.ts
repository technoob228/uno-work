/**
 * CustomHarnessAdapter — any ACP agent (a custom harness) as a Uno Work
 * provider. One agent process + one ACP session per chat thread, on the
 * shared {@link AcpSessionRuntime}; contract in docs/custom-harness.md.
 *
 * What it adds on top of the runtime, all agent-agnostic:
 *   - permission requests → our Approve / Deny cards, mapped onto the
 *     agent's options by standard `kind` (never by id); `full-access` and
 *     `auto-accept-edits` answer without asking;
 *   - model selection from what the agent advertises in `session/new`;
 *   - project-level `.mcp.json` of the session folder → `mcpServers`
 *     (stdio always; http/sse only if the agent supports them);
 *   - prompts serialized per thread (an agent may not accept a second
 *     `session/prompt` while one runs);
 *   - image attachments only when the agent declared `promptCapabilities.image`;
 *   - the agent's stderr kept as a tail and attached to failures.
 *
 * @module CustomHarnessAdapter
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type CustomHarnessSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  CUSTOM_HARNESS_DRIVER_KIND,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  PubSub,
  Random,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";
import { validateHarnessConfig } from "@t3tools/shared/customHarness";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  applyCustomHarnessModel,
  autoApprovedPermissionOption,
  CUSTOM_HARNESS_DEFAULT_MODEL,
  type DiscoveredModels,
  discoverSessionModels,
  makeCustomAcpRuntime,
  makeTextTail,
  resolveHarnessCwd,
  resolveHarnessExecutable,
  selectPermissionOptionForDecision,
} from "../acp/CustomAcpSupport.ts";
import { parseMcpJsonToAcpServers } from "../acp/HermesAcpSupport.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make(CUSTOM_HARNESS_DRIVER_KIND);
const RESUME_VERSION = 1 as const;

export interface CustomHarnessAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

export interface CustomHarnessAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  /** Base environment of the agent process (daemon env is merged underneath). */
  readonly environment: NodeJS.ProcessEnv;
  /** Per-thread overlay (browser bridge token, …). */
  readonly bridgeEnvironment?: (context: {
    readonly threadId?: string;
    readonly cwd?: string;
  }) => Record<string, string>;
  /** Extra MCP servers for every session (e.g. Uno Work's own). */
  readonly extraMcpServers?: (context: {
    readonly threadId: string;
    readonly cwd: string;
  }) => ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * The Uno Work environment brief. ACP has no system-prompt slot, so it
   * rides as a leading text block on the first prompt of a fresh session
   * (like Cursor); a resumed session already has it in its history.
   */
  readonly harnessInstructions?: string;
  /** Called with every session's discovered models (the picker learns them). */
  readonly onModelsDiscovered?: (discovered: DiscoveredModels) => void;
  readonly clientVersion?: string;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly sessionId: string;
  readonly discovered: DiscoveredModels;
  readonly acceptsImages: boolean;
  readonly stderr: ReturnType<typeof makeTextTail>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  /** The brief still owed to this ACP session (see harnessInstructions). */
  pendingHarnessInstructions: string | undefined;
  currentModel: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function withStderr(detail: string, stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-12).join("\n").trim();
  return tail.length > 0 ? `${detail}\n\nAgent stderr (last lines):\n${tail}` : detail;
}

function settleAsCancelled(pending: ReadonlyMap<ApprovalRequestId, PendingApproval>) {
  return Effect.forEach(
    Array.from(pending.values()),
    (entry) => Deferred.succeed(entry.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

export function makeCustomHarnessAdapter(
  settings: CustomHarnessSettings,
  options: CustomHarnessAdapterOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId;
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger = options.nativeEventLogger;

    const sessions = new Map<ThreadId, SessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const promptLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getKeyedSemaphore = (
      locksRef: SynchronizedRef.SynchronizedRef<Map<string, Semaphore.Semaphore>>,
      key: string,
    ) =>
      SynchronizedRef.modifyEffect(locksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(current.get(key));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(key, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getKeyedSemaphore(threadLocksRef, threadId), (semaphore) =>
        semaphore.withPermit(effect),
      );
    const withPromptLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getKeyedSemaphore(promptLocksRef, threadId), (semaphore) =>
        semaphore.withPermit(effect),
      );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: SessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settleAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const applyModel = (ctx: SessionContext, model: string | undefined) =>
      Effect.gen(function* () {
        const target = model?.trim() || undefined;
        if (!target || target === ctx.currentModel) return;
        const applied = yield* applyCustomHarnessModel({
          runtime: ctx.acp,
          sessionId: ctx.sessionId,
          discovered: ctx.discovered,
          model: target,
          mapError: (cause) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_model", cause),
        });
        if (applied || target === CUSTOM_HARNESS_DEFAULT_MODEL) ctx.currentModel = target;
      });

    const startSession: CustomHarnessAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const threadCwd = nodePath.resolve(input.cwd.trim());
          const cwd = resolveHarnessCwd(settings, threadCwd);
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionEnvironment: NodeJS.ProcessEnv = {
            ...options.environment,
            ...options.bridgeEnvironment?.({ threadId: input.threadId, cwd: threadCwd }),
            UNO_WORK: "1",
            UNO_WORK_THREAD_ID: input.threadId,
            UNO_WORK_PROJECT_DIR: threadCwd,
            UNO_WORK_HARNESS_ID: boundInstanceId,
          };
          const valid = validateHarnessConfig(settings);
          if (!valid.ok) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `${options.displayName}: ${valid.reason}`,
            });
          }
          const executable = yield* Effect.promise(() =>
            resolveHarnessExecutable(settings.command, sessionEnvironment),
          );
          if (!executable.ok) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `${options.displayName} cannot start: ${executable.reason} Install it or fix the command in Settings → Harnesses.`,
            });
          }

          const mcpJsonRaw = yield* fileSystem
            .readFileString(nodePath.join(cwd, ".mcp.json"))
            .pipe(Effect.orElseSucceed(() => ""));
          const mcpServers = [
            ...(mcpJsonRaw ? parseMcpJsonToAcpServers(mcpJsonRaw) : []),
            ...(options.extraMcpServers?.({ threadId: input.threadId, cwd }) ?? []),
          ];

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: SessionContext;
          const stderr = makeTextTail();
          const resumeSessionId = parseResume(input.resumeCursor)?.sessionId;

          const acp = yield* makeCustomAcpRuntime({
            childProcessSpawner,
            command: executable.path,
            args: settings.args,
            environment: sessionEnvironment,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
            ...(settings.authMethodId.trim() ? { authMethodId: settings.authMethodId.trim() } : {}),
            onStderr: stderr.append,
            clientInfo: { name: "uno-work", version: options.clientVersion ?? "0.0.0" },
            ...makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: withStderr(cause.message, stderr.get()),
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const runtimeMode = ctx?.session.runtimeMode ?? input.runtimeMode;
                const autoOption = autoApprovedPermissionOption(params, runtimeMode);
                if (autoOption !== undefined) {
                  return { outcome: { outcome: "selected" as const, optionId: autoOption } };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const optionId = selectPermissionOptionForDecision(params, resolved);
                return {
                  outcome:
                    optionId === undefined
                      ? ({ outcome: "cancelled" } as const)
                      : ({ outcome: "selected", optionId } as const),
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) => {
              const mapped = mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error);
              return new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: withStderr(
                  `${options.displayName} did not complete the ACP handshake: ${error.message}`,
                  stderr.get(),
                ),
                cause: mapped,
              });
            }),
          );

          const discovered = discoverSessionModels(started.sessionSetupResult);
          if (discovered.models.length > 0) options.onModelsDiscovered?.(discovered);

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            sessionId: started.sessionId,
            discovered,
            acceptsImages:
              started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
            stderr,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            currentModel: discovered.current,
            activeTurnId: undefined,
            stopped: false,
            pendingHarnessInstructions:
              resumeSessionId !== undefined && started.sessionId === resumeSessionId
                ? undefined
                : options.harnessInstructions,
          };

          yield* applyModel(ctx, modelSelection?.model);

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated": {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(event.payload)}`;
                    if (ctx.lastPlanFingerprint === fingerprint) return;
                    ctx.lastPlanFingerprint = fingerprint;
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: `${options.displayName} ACP session ready` },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CustomHarnessAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: model ?? ctx.currentModel ?? CUSTOM_HARNESS_DEFAULT_MODEL },
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        let skippedImages = 0;
        for (const attachment of input.attachments ?? []) {
          if (attachment.type !== "image") continue;
          if (!ctx.acceptsImages) {
            skippedImages += 1;
            continue;
          }
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          promptParts.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        if (skippedImages > 0) {
          promptParts.push({
            type: "text",
            text: `[${skippedImages} image attachment(s) omitted: this agent does not accept images.]`,
          });
        }
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        return yield* withPromptLock(
          input.threadId,
          Effect.gen(function* () {
            const liveCtx = yield* requireSession(input.threadId);
            yield* applyModel(liveCtx, model);
            liveCtx.activeTurnId = turnId;
            liveCtx.lastPlanFingerprint = undefined;
            liveCtx.session = {
              ...liveCtx.session,
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            const pendingInstructions = liveCtx.pendingHarnessInstructions;
            liveCtx.pendingHarnessInstructions = undefined;
            const result = yield* liveCtx.acp
              .prompt({
                prompt: pendingInstructions
                  ? [
                      {
                        type: "text",
                        text: `<uno-work-instructions>\n${pendingInstructions}\n</uno-work-instructions>`,
                      },
                      ...promptParts,
                    ]
                  : promptParts,
              })
              .pipe(
                Effect.mapError((error) => {
                  const mapped = mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/prompt",
                    error,
                  );
                  return mapped._tag === "ProviderAdapterRequestError"
                    ? new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: withStderr(mapped.detail, liveCtx.stderr.get()),
                        cause: error,
                      })
                    : mapped;
                }),
              );

            liveCtx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
            liveCtx.session = {
              ...liveCtx.session,
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(liveCtx.currentModel ? { model: liveCtx.currentModel } : {}),
            };
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: liveCtx.session.resumeCursor,
            };
          }),
        );
      });

    const interruptTurn: CustomHarnessAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settleAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(ctx.acp.cancel);
      });

    const respondToRequest: CustomHarnessAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    // ACP has no standard "ask the user a question" request (elicitation is
    // not advertised by us), so there are never pending user-input requests.
    const respondToUserInput: CustomHarnessAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user_input",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      });

    const readThread: CustomHarnessAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    const rollbackThread: CustomHarnessAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CustomHarnessAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.flatMap(requireSession(threadId), (ctx) => stopSessionInternal(ctx)),
      );

    const listSessions: CustomHarnessAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CustomHarnessAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CustomHarnessAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies CustomHarnessAdapterShape;
  });
}

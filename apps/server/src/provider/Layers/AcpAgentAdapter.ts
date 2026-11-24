/**
 * AcpAgentAdapter — a standard ACP agent as a Uno Work provider: custom
 * harnesses (docs/custom-harness.md, CustomHarnessAdapter.ts) and the
 * built-in Gemini CLI (GeminiAdapter.ts). One agent process + one ACP
 * session per chat thread, on the shared {@link AcpSessionRuntime}. What is
 * agent-specific — how to launch it, which ACP mode a turn runs in, which
 * permission requests need no card, a check before the process starts —
 * comes in as an {@link AcpAgentProfile}.
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
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Duration,
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
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

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
import { acpPermissionResponse } from "../acp/AcpAdapterSupport.ts";
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  applyCustomHarnessModel,
  autoApprovedPermissionOption,
  CUSTOM_HARNESS_DEFAULT_MODEL,
  type DiscoveredModels,
  discoverSessionModels,
  makeCustomAcpRuntime,
  makeTextTail,
} from "../acp/CustomAcpSupport.ts";
import { parseMcpJsonToAcpServers } from "../acp/HermesAcpSupport.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const RESUME_VERSION = 1 as const;

export interface AcpAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

/** The agent's executable and argv, or why it can't start here. */
export type AcpAgentLaunch =
  | { readonly ok: true; readonly command: string; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string };

/** What a session's ACP mode is picked from (before the first turn and before each one). */
export interface AcpAgentModeInput {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: {
    readonly currentModeId: string;
    readonly availableModeIds: ReadonlyArray<string>;
  };
}

/** Everything that differs between ACP agents. */
export interface AcpAgentProfile {
  readonly provider: ProviderDriverKind;
  /** Folder the session runs in (`session/new.cwd` and the process cwd). */
  readonly resolveCwd: (threadCwd: string) => string;
  /** Executable + argv, resolved against the session's environment. */
  readonly resolveLaunch: (env: NodeJS.ProcessEnv) => Promise<AcpAgentLaunch>;
  /** Appended to "<name> cannot start: <reason>". */
  readonly launchFailureHint: string;
  /**
   * ACP `authenticate` method sent after `initialize`; absent: none. A
   * function picks it from the session's environment (Grok: its API key when
   * one is set, else the stored sign-in).
   */
  readonly authMethodId?: string | ((env: NodeJS.ProcessEnv) => Promise<string | undefined>);
  /** `_meta` of `initialize` (see AcpSessionRuntimeOptions.initializeMeta). */
  readonly initializeMeta?: Record<string, unknown>;
  /** `_meta` of `session/cancel`. */
  readonly cancelMeta?: Record<string, unknown>;
  /** Give up on a `session/load` that doesn't answer and open a new session. */
  readonly sessionLoadTimeoutMs?: number;
  /**
   * Refuse to start before spawning (the agent would hang or fail in a way
   * that says less), e.g. Gemini CLI not signed in. Returns the reason.
   */
  readonly preflight?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  /** The ACP handshake (initialize → session/new or load) must finish within this. */
  readonly startTimeoutMs?: number;
  /** The error when it doesn't. */
  readonly startTimeoutMessage?: string;
  /**
   * The ACP mode the session should be in, or `undefined` to leave it. Sent
   * with `session/set_mode` when it differs from the current one.
   */
  readonly modeFor?: (input: AcpAgentModeInput) => string | undefined;
  /**
   * A permission request answered without a card, whatever the mode (Gemini:
   * the uno-work tools, which ask the person themselves). Returns the option id.
   */
  readonly autoApprove?: (request: EffectAcpSchema.RequestPermissionRequest) => string | undefined;
  /** Agent text chunks that are the agent's bookkeeping, never shown. */
  readonly dropAgentText?: (text: string) => boolean;
  /**
   * A message the agent must not get (Grok: a slash command that would turn
   * its permission prompts off). Returns why, shown as the turn's error.
   */
  readonly refusePrompt?: (text: string) => string | undefined;
}

export interface AcpAgentAdapterOptions {
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
  /** The ACP mode the session is in (agents that advertise `modes`). */
  currentModeId: string | undefined;
  readonly availableModeIds: ReadonlyArray<string>;
  activeTurnId: TurnId | undefined;
  /**
   * Tool calls of the active turn the agent has not finished. A turn that
   * fails or is cancelled leaves them running in the chat forever unless
   * they are closed (upstream T3 Code settles them the same way).
   */
  openToolCalls: Map<string, AcpToolCallState>;
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

/**
 * The words of an agent's JSON-RPC error. The ACP client turns an error
 * answer to `session/prompt` into a defect carrying only its message, and
 * some agents put an API's whole JSON body there — Gemini CLI 0.70 answers a
 * refused key with `{"error":{"message":"{\n \"error\": {\"message\":
 * \"API key not valid…\"…`. Unwraps such JSON down to the innermost message.
 */
export function agentErrorText(defect: unknown): string {
  // Grok CLI answers a refused key with a bare "Internal error" and the
  // words in `data.message` ("API error (status 400 Bad Request): …
  // Incorrect API key provided…", seen live 23.11.2026).
  const data =
    typeof defect === "object" && defect !== null && "data" in defect
      ? (defect as { data: unknown }).data
      : undefined;
  const dataMessage =
    typeof data === "string"
      ? data
      : typeof data === "object" && data !== null && "message" in data
        ? (data as { message: unknown }).message
        : undefined;
  let text =
    typeof dataMessage === "string" && dataMessage.trim()
      ? dataMessage
      : defect instanceof Error
        ? defect.message
        : typeof defect === "object" && defect !== null && "message" in defect
          ? String((defect as { message: unknown }).message)
          : String(defect);
  for (let depth = 0; depth < 4; depth += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      break;
    }
    if (typeof parsed !== "object" || parsed === null) break;
    const record = parsed as { error?: unknown; message?: unknown };
    const inner =
      typeof record.error === "object" && record.error !== null
        ? (record.error as { message?: unknown }).message
        : record.message;
    if (typeof inner !== "string") break;
    text = inner;
  }
  return text.trim() || "The agent failed without a message.";
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

export function makeAcpAgentAdapter(profile: AcpAgentProfile, options: AcpAgentAdapterOptions) {
  const PROVIDER = profile.provider;
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

    /** `session/set_mode` to what the profile wants for this turn, when it differs. */
    const applyMode = (
      ctx: SessionContext,
      input: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode | undefined;
      },
    ) =>
      Effect.gen(function* () {
        if (!profile.modeFor || ctx.availableModeIds.length === 0) return;
        const wanted = profile.modeFor({
          ...input,
          modeState: {
            currentModeId: ctx.currentModeId ?? "",
            availableModeIds: ctx.availableModeIds,
          },
        });
        if (!wanted || wanted === ctx.currentModeId) return;
        if (!ctx.availableModeIds.includes(wanted)) return;
        yield* ctx.acp
          .request("session/set_mode", { sessionId: ctx.sessionId, modeId: wanted })
          .pipe(
            Effect.mapError((cause: EffectAcpErrors.AcpError) =>
              mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_mode", cause),
            ),
          );
        ctx.currentModeId = wanted;
      });

    const startSession: AcpAgentAdapterShape["startSession"] = (input) =>
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
          const cwd = profile.resolveCwd(threadCwd);
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
          const executable = yield* Effect.promise(() => profile.resolveLaunch(sessionEnvironment));
          if (!executable.ok) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `${options.displayName} cannot start: ${executable.reason} ${profile.launchFailureHint}`,
            });
          }
          if (profile.preflight) {
            const refused = yield* Effect.promise(() => profile.preflight!(sessionEnvironment));
            if (refused) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/start",
                detail: refused,
              });
            }
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
          const pickAuthMethod = profile.authMethodId;
          const authMethodId =
            typeof pickAuthMethod === "function"
              ? yield* Effect.promise(() => pickAuthMethod(sessionEnvironment))
              : pickAuthMethod;

          const acp = yield* makeCustomAcpRuntime({
            childProcessSpawner,
            command: executable.command,
            args: executable.args,
            environment: sessionEnvironment,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
            ...(authMethodId ? { authMethodId } : {}),
            ...(profile.initializeMeta ? { initializeMeta: profile.initializeMeta } : {}),
            ...(profile.cancelMeta ? { cancelMeta: profile.cancelMeta } : {}),
            ...(profile.sessionLoadTimeoutMs !== undefined
              ? { sessionLoadTimeoutMs: profile.sessionLoadTimeoutMs }
              : {}),
            onStderr: stderr.append,
            ...(profile.dropAgentText ? { dropAgentText: profile.dropAgentText } : {}),
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
                const autoOption =
                  profile.autoApprove?.(params) ??
                  autoApprovedPermissionOption(params, runtimeMode);
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
                return acpPermissionResponse(params, resolved);
              }),
            );
            const handshake = acp.start();
            if (!profile.startTimeoutMs) return yield* handshake;
            const timed = yield* handshake.pipe(
              Effect.timeoutOption(Duration.millis(profile.startTimeoutMs)),
            );
            if (Option.isNone(timed)) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: withStderr(
                  profile.startTimeoutMessage ??
                    `${options.displayName} did not finish starting in time.`,
                  stderr.get(),
                ),
              });
            }
            return timed.value;
          }).pipe(
            Effect.mapError((error) => {
              if (error._tag === "ProviderAdapterProcessError") return error;
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
          const modeState = started.sessionSetupResult.modes ?? undefined;
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
            currentModeId: modeState?.currentModeId,
            availableModeIds: (modeState?.availableModes ?? []).map((mode) => mode.id),
            activeTurnId: undefined,
            openToolCalls: new Map(),
            stopped: false,
            pendingHarnessInstructions:
              resumeSessionId !== undefined && started.sessionId === resumeSessionId
                ? undefined
                : options.harnessInstructions,
          };

          yield* applyModel(ctx, modelSelection?.model);
          yield* applyMode(ctx, { runtimeMode: input.runtimeMode, interactionMode: undefined });

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
                    if (
                      event.toolCall.status === "completed" ||
                      event.toolCall.status === "failed"
                    ) {
                      ctx.openToolCalls.delete(event.toolCall.toolCallId);
                    } else if (ctx.activeTurnId !== undefined) {
                      ctx.openToolCalls.set(event.toolCall.toolCallId, event.toolCall);
                    }
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
                  case "ReasoningDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    if (ctx.activeTurnId === undefined) return;
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                        streamKind: "reasoning_text",
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            // Tied to the session, not to the fiber that started it: a start run
            // inside a race (the assistant prewarm under Effect.timeout) ends
            // that fiber right away, and a child listener died with it — the
            // harness answered, nobody read it (Uno chat mute on 0.0.94–0.0.100).
            Effect.forkIn(sessionScope),
          );

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

    const sendTurn: AcpAgentAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const refused = profile.refusePrompt?.(input.input ?? "");
        if (refused !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: refused,
          });
        }
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
            yield* applyMode(liveCtx, {
              runtimeMode: liveCtx.session.runtimeMode,
              interactionMode: input.interactionMode,
            });
            liveCtx.activeTurnId = turnId;
            liveCtx.openToolCalls = new Map();
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
                        detail: withStderr(agentErrorText(error), liveCtx.stderr.get()),
                        cause: error,
                      })
                    : mapped;
                }),
                // An error answer of the agent arrives as a defect (see
                // agentErrorText): a failed turn with the agent's own words,
                // not a crash of the chat.
                Effect.catchDefect((defect) =>
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: agentErrorText(defect),
                      cause: defect,
                    }),
                  ),
                ),
                Effect.tapError(() => settleOpenToolCalls(liveCtx, turnId)),
              );
            if (result.stopReason === "cancelled") {
              yield* settleOpenToolCalls(liveCtx, turnId);
            }

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

    /**
     * Close what a failed or cancelled turn left open, as failed. Not on a
     * completed turn: an agent may finish its answer with a tool still
     * running in the background (a dev server), which reports later.
     */
    const settleOpenToolCalls = (ctx: SessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        const open = Array.from(ctx.openToolCalls.values());
        ctx.openToolCalls = new Map();
        for (const toolCall of open) {
          yield* offerRuntimeEvent(
            makeAcpToolCallEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              toolCall: { ...toolCall, status: "failed" },
              rawPayload: { settled: true, toolCallId: toolCall.toolCallId },
            }),
          );
        }
      });

    const interruptTurn: AcpAgentAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settleAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(ctx.acp.cancel);
      });

    const respondToRequest: AcpAgentAdapterShape["respondToRequest"] = (
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
    const respondToUserInput: AcpAgentAdapterShape["respondToUserInput"] = (
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

    const readThread: AcpAgentAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    const rollbackThread: AcpAgentAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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

    const stopSession: AcpAgentAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.flatMap(requireSession(threadId), (ctx) => stopSessionInternal(ctx)),
      );

    const listSessions: AcpAgentAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AcpAgentAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: AcpAgentAdapterShape["stopAll"] = () =>
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
    } satisfies AcpAgentAdapterShape;
  });
}

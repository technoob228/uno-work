/**
 * The Uno chat's harness, started before the first message
 * (reports/day_2026-09-25/work-first-answer).
 *
 * The pinned "Uno" chat runs on Hermes (`hermes acp`, one Python process per
 * chat). Its cold start — interpreter, imports, `session/new` with the MCP
 * servers — took 3.5–4.4 s on a 2-vCPU Work box, and it sat right between
 * "Send" and the request reaching the model. This layer starts that session
 * as soon as it can: after the boot probes, when the chat, Hermes and (on the
 * Uno gateway) the machine's gateway key are there. The first message then
 * finds the process up; the provider command reactor reuses it.
 *
 * - The start goes through the reactor's own queue
 *   (`ProviderCommandReactor.prewarmSession`), the same path a message takes,
 *   so a message sent meanwhile waits for this start instead of racing a
 *   second one.
 * - A Hermes process reads its gateway key once, at spawn. When the key
 *   changes (a clone of a memory snapshot gets its own key after restore)
 *   the idle session is restarted here, in the background — never under a
 *   running turn, never on the message's path.
 * - Without a key Hermes cannot open a session at all ("no API key"), so a
 *   snapshot warmed before provisioning holds no Hermes; the start happens
 *   on the clone the moment the key lands.
 * - Opportunistic: never evicts another chat's harness to make room (live
 *   harness cap on small machines), gives up on a key after a few failed
 *   starts. `UNO_WORK_ASSISTANT_PREWARM=0` turns it off.
 *
 * `settled` feeds `GET /__uno/warm`: a daemon is warm for a memory snapshot
 * once the Uno chat's harness is up, or it is clear it cannot be (no key, no
 * Hermes), or {@link PREWARM_SETTLE_CEILING} has passed.
 */
import * as Crypto from "node:crypto";

import { ASSISTANT_HARNESS_INSTANCE_ID, type ThreadId } from "@t3tools/contracts";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import {
  coerceAssistantModelSelection,
  readAssistantLlmProvider,
} from "@t3tools/shared/assistantLlm";
import { Cause, Context, Deferred, Duration, Effect, Layer, Queue, Stream } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor.ts";
import { awaitUsableBootDefault } from "../provider/awaitUsableBootDefault.ts";
import { currentHarnessBudget } from "../provider/harnessBudget.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKey } from "../unoGatewayKey.ts";

/** How long `/__uno/warm` waits for the Uno chat's harness after the boot probes. */
export const PREWARM_SETTLE_CEILING = Duration.seconds(30);
/** Failed starts on one key before giving up on it (until the key changes). */
const MAX_FAILED_STARTS_PER_KEY = 3;
/** A chat busy with a turn is looked at again after this. */
const BUSY_RETRY_DELAY = Duration.seconds(15);
/** Coalesces bursts of triggers (settings writes, probe refreshes). */
const CHECK_SPACING = Duration.millis(250);

export interface AssistantPrewarmShape {
  /** True once the Uno chat's harness is up, cannot be, or the ceiling passed. */
  readonly settled: Effect.Effect<boolean>;
}

export class AssistantPrewarm extends Context.Service<AssistantPrewarm, AssistantPrewarmShape>()(
  "t3/manager/AssistantPrewarm",
) {}

/** Where a check left the Uno chat. Exported for tests. */
export type AssistantPrewarmState =
  /** Its harness is up on the current key. */
  | "warm"
  /** Waiting for something that will poke again (chat, turn, key change). */
  | "waiting"
  /** Nothing to start: no gateway key, or Hermes is not installed. */
  | "not-applicable";

export function assistantPrewarmDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UNO_WORK_ASSISTANT_PREWARM?.trim() === "0";
}

/** Identifies the key a session was started with without keeping the key. */
function keyStamp(provider: string, key: string): string {
  if (provider !== "uno") return `byok:${provider}`;
  return `uno:${Crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

const makeAssistantPrewarm = Effect.gen(function* () {
  const settledSignal = yield* Deferred.make<void>();
  const settle = Deferred.succeed(settledSignal, undefined).pipe(Effect.asVoid);
  const service: AssistantPrewarmShape = { settled: Deferred.isDone(settledSignal) };

  const reactor = yield* ProviderCommandReactor;
  const prewarmSession = reactor.prewarmSession;
  if (assistantPrewarmDisabled() || prewarmSession === undefined) {
    yield* settle;
    return service;
  }

  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const gatewayKey = yield* UnoGatewayKey;
  const orchestrationEngine = yield* OrchestrationEngineService;

  /** The session we know the key of: its start time and the key's stamp. */
  const known = new Map<ThreadId, { readonly createdAt: string; readonly stamp: string }>();
  const failures = { stamp: "", count: 0 };

  const layerScope = yield* Effect.scope;
  const pokes = yield* Queue.sliding<void>(1);
  const poke = Queue.offer(pokes, undefined).pipe(Effect.asVoid);

  const check: Effect.Effect<AssistantPrewarmState> = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const chat = findMarkedAssistantChat(snapshot.threads);
    if (chat === null) return "waiting";

    const providers = yield* providerRegistry.getProviders;
    const hermes = providers.find(
      (provider) => String(provider.instanceId) === ASSISTANT_HARNESS_INSTANCE_ID,
    );
    if (hermes === undefined) return "waiting";
    if (!hermes.installed) return "not-applicable";

    const llmProvider = readAssistantLlmProvider(
      coerceAssistantModelSelection(chat.modelSelection),
    );
    const key = llmProvider === "uno" ? yield* gatewayKey.harnessKey() : "";
    // Hermes refuses to open a session without a key on the Uno gateway.
    if (llmProvider === "uno" && key.length === 0) return "not-applicable";
    const stamp = keyStamp(llmProvider, key);

    const sessions = yield* providerService.listSessions();
    const live = sessions.find((session) => session.threadId === chat.id);
    if (live !== undefined) {
      const recorded = known.get(chat.id);
      if (recorded === undefined || recorded.createdAt !== live.createdAt) {
        // Started by a message or restarted by the reactor (provider switch):
        // it read the key current at that moment.
        known.set(chat.id, { createdAt: live.createdAt, stamp });
        return "warm";
      }
      if (recorded.stamp === stamp) return "warm";
    } else {
      const maxLive = currentHarnessBudget().maxLiveProcesses;
      if (maxLive !== null && sessions.length >= maxLive) {
        // Starting would evict another chat's idle harness: not worth it.
        return "waiting";
      }
    }

    if (failures.stamp === stamp && failures.count >= MAX_FAILED_STARTS_PER_KEY) {
      return "waiting";
    }
    const restart = live !== undefined;
    yield* Effect.logInfo("assistant prewarm: starting the Uno chat's harness", {
      threadId: chat.id,
      restart,
      llmProvider,
    });
    const outcome = yield* prewarmSession(chat.id, { restart });
    switch (outcome) {
      case "started":
      case "already-running": {
        const started = (yield* providerService.listSessions()).find(
          (session) => session.threadId === chat.id,
        );
        if (started === undefined) return "waiting";
        known.set(chat.id, { createdAt: started.createdAt, stamp });
        failures.stamp = "";
        failures.count = 0;
        return "warm";
      }
      case "busy":
        yield* Effect.sleep(BUSY_RETRY_DELAY).pipe(Effect.andThen(poke), Effect.forkIn(layerScope));
        return "waiting";
      case "failed":
        if (failures.stamp !== stamp) {
          failures.stamp = stamp;
          failures.count = 0;
        }
        failures.count += 1;
        return "waiting";
      case "skipped":
        return "waiting";
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("assistant prewarm: check failed", { cause: Cause.pretty(cause) }).pipe(
        Effect.as("waiting" as const),
      ),
    ),
  );

  const loop = Effect.gen(function* () {
    yield* awaitUsableBootDefault();
    yield* Effect.sleep(PREWARM_SETTLE_CEILING).pipe(Effect.andThen(settle), Effect.forkScoped);

    const pokeOn = <A, E>(stream: Stream.Stream<A, E>) =>
      stream.pipe(
        Stream.runForEach(() => poke),
        Effect.ignoreCause({ log: true }),
        Effect.forkScoped,
      );
    // The gateway key lands in settings.json (often after start on a box).
    yield* pokeOn(serverSettings.streamChanges);
    // Hermes finished installing / probing.
    yield* pokeOn(providerRegistry.streamChanges);
    // The chat appeared or changed engine, or its harness went away.
    yield* pokeOn(
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.created" ||
            event.type === "thread.meta-updated" ||
            event.type === "thread.unarchived" ||
            (event.type === "thread.session-set" &&
              (event.payload.session.status === "stopped" ||
                event.payload.session.status === "error")),
        ),
      ),
    );

    yield* poke;
    yield* Queue.take(pokes).pipe(
      Effect.flatMap(() => check),
      Effect.tap((state) => (state === "waiting" ? Effect.void : settle)),
      Effect.andThen(Effect.sleep(CHECK_SPACING)),
      Effect.forever,
    );
  });

  yield* loop.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("assistant prewarm stopped", { cause: Cause.pretty(cause) }).pipe(
            Effect.andThen(settle),
          ),
    ),
    Effect.forkScoped,
  );
  return service;
});

export const AssistantPrewarmLive = Layer.effect(AssistantPrewarm, makeAssistantPrewarm);

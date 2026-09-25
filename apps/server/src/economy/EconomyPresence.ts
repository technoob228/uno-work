/**
 * EconomyPresence — the daemon's half of economy mode (see economyReport.ts).
 *
 * Every ECONOMY_TICK_MS it looks at what is going on (connected clients,
 * agent turns, apps that asked to stay awake, the next reminder) and reports
 * to the console when something changed or a minute passed. The console's
 * answer (sleeps at …, busy because …) is kept for the clients: the web app
 * asks `uno.economy.presence` so an idle tab knows the computer is about to
 * sleep and does not wake it straight back up.
 *
 * Off an Uno computer (a laptop, a BYO server — no machine token) the loop
 * does nothing and presence answers "off".
 */
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";
import type { UnoEconomyPresence } from "@t3tools/contracts";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { resolveManifestDir } from "../machineApps/manifestDir.ts";
import { callWorkConsole, readWorkMachineIdentity } from "../manager/workConsole.ts";
import { RemindersRepository } from "../persistence/Services/Reminders.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ECONOMY_TICK_MS,
  PRESENCE_OFF,
  buildReportBody,
  detectWake,
  earliestFuture,
  presenceFromConsole,
  probeSignature,
  readKeepAwakeApps,
  shouldReport,
  type EconomyProbe,
} from "./economyReport.ts";

export interface EconomyPresenceShape {
  /** `input: true` — the person just did something in a client. */
  readonly presence: (input: boolean) => Effect.Effect<UnoEconomyPresence>;
}

export class EconomyPresence extends Context.Service<EconomyPresence, EconomyPresenceShape>()(
  "t3/economy/EconomyPresence",
) {}

interface State {
  lastInputAt: number | null;
  inputSinceSent: boolean;
  lastSentAt: number | null;
  lastSignature: string | null;
  lastTickAt: number | null;
  presence: UnoEconomyPresence;
  /** The console has no economy route or the account has no economy: back off. */
  unavailableUntil: number;
}

const UNAVAILABLE_BACKOFF_MS = 30 * 60_000;

export const EconomyPresenceLive = Layer.effect(
  EconomyPresence,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const sessions = yield* SessionCredentialService;
    const providers = yield* ProviderService;
    const reminders = Option.getOrUndefined(yield* Effect.serviceOption(RemindersRepository));
    const manifestDir = resolveManifestDir();

    const state: State = {
      lastInputAt: null,
      inputSinceSent: false,
      lastSentAt: null,
      lastSignature: null,
      lastTickAt: null,
      presence: PRESENCE_OFF,
      unavailableUntil: 0,
    };

    const identity = settings.getSettings.pipe(
      Effect.map((current) => readWorkMachineIdentity(current.uno)),
      Effect.orElseSucceed(() => null),
    );

    const probe: Effect.Effect<EconomyProbe> = Effect.gen(function* () {
      const clients = yield* sessions.listActive().pipe(
        Effect.map((rows) => rows.filter((row) => row.connected).length),
        Effect.orElseSucceed(() => 0),
      );
      const runningTurns = yield* providers.listSessions().pipe(
        Effect.map(
          (list) =>
            list.filter((s) => s.status === "running" || (s.activeTurnId ?? null) !== null).length,
        ),
        Effect.orElseSucceed(() => 0),
      );
      const keepAwake = yield* Effect.promise(() => readKeepAwakeApps(manifestDir));
      const nextWakeAt = reminders
        ? yield* reminders.list({ includeInactive: false }).pipe(
            Effect.map((rows) =>
              earliestFuture(
                rows.map((r) => r.dueAt),
                Date.now(),
              ),
            ),
            Effect.orElseSucceed(() => null),
          )
        : null;
      // Terminals: the terminal manager does not expose "has a running
      // child" yet; the console's CPU check covers long builds meanwhile.
      return { clients, runningTurns, runningTerminals: 0, keepAwake, nextWakeAt };
    });

    const tick = Effect.gen(function* () {
      const now = Date.now();
      const woke = detectWake(state.lastTickAt, now);
      state.lastTickAt = now;
      const id = yield* identity;
      if (id === null) {
        state.presence = PRESENCE_OFF;
        return;
      }
      if (!woke && now < state.unavailableUntil) return;
      const current = yield* probe;
      const signature = probeSignature(current);
      const sleepAfter = state.presence.sleepAfter ? Date.parse(state.presence.sleepAfter) : null;
      if (
        !shouldReport({
          now,
          lastSentAt: state.lastSentAt,
          lastSignature: state.lastSignature,
          signature,
          woke,
          inputSinceSent: state.inputSinceSent,
          sleepAfter: sleepAfter !== null && Number.isFinite(sleepAfter) ? sleepAfter : null,
        })
      ) {
        return;
      }
      const response = yield* callWorkConsole({
        identity: id,
        method: "POST",
        subpath: "activity",
        body: buildReportBody(current, state.lastInputAt),
      }).pipe(Effect.option);
      if (Option.isNone(response)) return; // console unreachable: try next tick
      const { status, body } = response.value;
      if (status === 404 || status === 405 || status === 409) {
        // Older console, or economy is not offered to this account.
        state.presence = PRESENCE_OFF;
        state.unavailableUntil = now + UNAVAILABLE_BACKOFF_MS;
        state.lastSentAt = now;
        return;
      }
      if (status < 200 || status >= 300) return;
      state.lastSentAt = now;
      state.lastSignature = signature;
      state.inputSinceSent = false;
      state.presence = presenceFromConsole(body, now) ?? PRESENCE_OFF;
      if (woke) {
        yield* Effect.logInfo("economy.woke", { state: state.presence.state });
      }
    });

    yield* Effect.forkScoped(
      tick.pipe(
        Effect.catchCause((cause) => Effect.logWarning("economy.tick-failed", { cause })),
        Effect.repeat(Schedule.spaced(Duration.millis(ECONOMY_TICK_MS))),
      ),
    );

    const presence: EconomyPresenceShape["presence"] = (input) =>
      Effect.sync(() => {
        if (input) {
          state.lastInputAt = Date.now();
          state.inputSinceSent = true;
        }
        return state.presence;
      });

    return { presence } satisfies EconomyPresenceShape;
  }),
);

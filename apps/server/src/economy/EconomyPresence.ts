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
 *
 * The same report carries the apps on this computer (`apps`, see
 * economyReport.ts) for the console's "On this computer" list: taken from the
 * last scan (no extra scans), sent when the list changed or every 10 minutes.
 * An account without economy mode still gets its list across: the console
 * keeps the apps before it answers 409, so while backed off the daemon sends a
 * changed list at most once a minute.
 */
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { UnoEconomyPresence } from "@t3tools/contracts";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { MachineAppsService } from "../machineApps/MachineAppsService.ts";
import { resolveManifestDir } from "../machineApps/manifestDir.ts";
import { callWorkConsole, readWorkMachineIdentity } from "../manager/workConsole.ts";
import { RemindersRepository } from "../persistence/Services/Reminders.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ECONOMY_REPORT_INTERVAL_MS,
  ECONOMY_TICK_MS,
  PRESENCE_OFF,
  appsSignature,
  buildReportBody,
  buildReportedApps,
  countRunningTurns,
  detectWake,
  earliestFuture,
  presenceFromConsole,
  probeSignature,
  readKeepAwakeApps,
  shouldReport,
  shouldSendApps,
  type EconomyProbe,
  type ReportedApp,
} from "./economyReport.ts";
import { signalMachineWoke } from "./wakeSignal.ts";

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
  /** The back-off came from a 409: the console is new and keeps the apps list anyway. */
  appsWhileUnavailable: boolean;
  lastAppsSentAt: number | null;
  lastAppsSignature: string | null;
  /** The box the list was last sent for: a clone from a memory snapshot sends its own at once. */
  lastAppsBoxId: number | null;
  /** The console refused a report with apps (an older console, a body too big): leave them out until then. */
  appsRefusedUntil: number;
}

const UNAVAILABLE_BACKOFF_MS = 30 * 60_000;
const APPS_REFUSED_BACKOFF_MS = 30 * 60_000;

export const EconomyPresenceLive = Layer.effect(
  EconomyPresence,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const sessions = yield* SessionCredentialService;
    const providers = yield* ProviderService;
    const reminders = Option.getOrUndefined(yield* Effect.serviceOption(RemindersRepository));
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient.SqlClient));
    const machineApps = Option.getOrUndefined(yield* Effect.serviceOption(MachineAppsService));
    const manifestDir = resolveManifestDir();

    const state: State = {
      lastInputAt: null,
      inputSinceSent: false,
      lastSentAt: null,
      lastSignature: null,
      lastTickAt: null,
      presence: PRESENCE_OFF,
      unavailableUntil: 0,
      appsWhileUnavailable: false,
      lastAppsSentAt: null,
      lastAppsSignature: null,
      lastAppsBoxId: null,
      appsRefusedUntil: 0,
    };

    /** The apps list from the last scan; null — no scan yet (not "no apps"). */
    const reportedApps = (keepAwake: ReadonlyArray<string>) =>
      machineApps
        ? machineApps.lastScanned.pipe(
            Effect.map((apps) => (apps === null ? null : buildReportedApps(apps, keepAwake))),
            Effect.orElseSucceed(() => null),
          )
        : Effect.succeed<ReportedApp[] | null>(null);

    const identity = settings.getSettings.pipe(
      Effect.map((current) => readWorkMachineIdentity(current.uno)),
      Effect.orElseSucceed(() => null),
    );

    const probe: Effect.Effect<EconomyProbe> = Effect.gen(function* () {
      const clients = yield* sessions.listActive().pipe(
        Effect.map((rows) => rows.filter((row) => row.connected).length),
        Effect.orElseSucceed(() => 0),
      );
      // «Идёт ход» — по проекции диалогов (её же видит интерфейс как
      // «Working…»): turn.started → running, turn.completed → ready, одинаково
      // для всех харнессов. Адаптеры ведут activeTurnId по-разному (Hermes не
      // сбрасывал его после хода — машина не засыпала никогда, 26.09).
      // Строки running без живой сессии адаптера (демон перезапустился
      // посреди хода) не считаем — иначе машина не уснёт уже никогда.
      const runningTurns = yield* Effect.gen(function* () {
        const live = yield* providers.listSessions();
        if (!sql) {
          return live.filter((s) => s.status === "running").length;
        }
        const rows = yield* sql<{
          readonly thread_id: string;
        }>`SELECT thread_id FROM projection_thread_sessions WHERE status = 'running'`;
        return countRunningTurns(
          live.map((s) => String(s.threadId)),
          rows.map((r) => r.thread_id),
        );
      }).pipe(Effect.orElseSucceed(() => 0));
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
      // Frozen long-polls (Telegram/Slack relay) are dead after a freeze: drop
      // them now so the message that woke the computer is picked up at once.
      if (woke) signalMachineWoke();
      const id = yield* identity;
      if (id === null) {
        state.presence = PRESENCE_OFF;
        return;
      }
      if (state.lastAppsBoxId !== id.boxId) {
        state.lastAppsSentAt = null;
        state.lastAppsSignature = null;
        state.lastAppsBoxId = id.boxId;
      }
      const backedOff = !woke && now < state.unavailableUntil;
      if (backedOff && !state.appsWhileUnavailable) return;
      const current = yield* probe;
      const apps = now < state.appsRefusedUntil ? null : yield* reportedApps(current.keepAwake);
      const appsSig = apps === null ? null : appsSignature(apps);
      const sendApps =
        apps !== null &&
        appsSig !== null &&
        shouldSendApps({
          now,
          lastAppsSentAt: state.lastAppsSentAt,
          lastAppsSignature: state.lastAppsSignature,
          signature: appsSig,
        });
      const signature = probeSignature(current);
      if (backedOff) {
        // No economy for this account (409): only a changed apps list goes,
        // at most once a minute; the rest waits for the back-off to end.
        const changed = sendApps && appsSig !== state.lastAppsSignature;
        const recent =
          state.lastSentAt !== null && now - state.lastSentAt < ECONOMY_REPORT_INTERVAL_MS;
        if (!changed || recent) return;
      } else {
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
      }
      const response = yield* callWorkConsole({
        identity: id,
        method: "POST",
        subpath: "activity",
        body: buildReportBody(current, state.lastInputAt, sendApps ? apps : null),
      }).pipe(Effect.option);
      if (Option.isNone(response)) return; // console unreachable: try next tick
      const { status, body } = response.value;
      const appsDelivered = () => {
        if (!sendApps) return;
        state.lastAppsSentAt = now;
        state.lastAppsSignature = appsSig;
      };
      if (status === 404 || status === 405 || status === 409) {
        // Older console, or economy is not offered to this account. A 409
        // comes from a console that has kept the apps before answering.
        state.presence = PRESENCE_OFF;
        if (!backedOff) state.unavailableUntil = now + UNAVAILABLE_BACKOFF_MS;
        state.appsWhileUnavailable = status === 409;
        state.lastSentAt = now;
        if (status === 409) appsDelivered();
        return;
      }
      if (status === 400 && sendApps) {
        // A console that can't take the list must not lose the economy
        // reports over it: leave the apps out for a while.
        state.appsRefusedUntil = now + APPS_REFUSED_BACKOFF_MS;
        return;
      }
      if (status < 200 || status >= 300) return;
      appsDelivered();
      state.appsWhileUnavailable = false;
      state.unavailableUntil = 0;
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

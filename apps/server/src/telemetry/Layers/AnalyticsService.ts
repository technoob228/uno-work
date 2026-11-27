/**
 * AnalyticsServiceLive - Uno Work usage events, sent to the Uno console only.
 *
 * Events are buffered in memory and flushed in batches to
 * `<console>/api/v1/work/telemetry` with this computer's Uno token (the same
 * credential the uno-work tools use, `consoleToken`). A computer that is not
 * linked to an Uno account sends nothing: its events are dropped, not kept.
 *
 * What is sent and how to turn it off: TELEMETRY.md at the repository root.
 * Off when any of these is set in the server's environment:
 * `UNO_WORK_TELEMETRY_ENABLED=false`, `DO_NOT_TRACK=1`, or the upstream
 * `T3CODE_TELEMETRY_ENABLED=false`.
 *
 * Upstream T3 Code sent these events to T3's PostHog with a hashed id taken
 * from other tools' credential files. Both are gone; `noThirdPartyTelemetry.test.ts`
 * keeps them from coming back with an upstream merge.
 *
 * @module AnalyticsServiceLive
 */

import { Config, DateTime, Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { consoleToken } from "../../unoWork/consoleClient.ts";
import { controlPlaneBaseUrl } from "../../workspaceRegistry/unoCloudParse.ts";
import { AnalyticsService, type AnalyticsServiceShape } from "../Services/AnalyticsService.ts";
import { getTelemetryInstallId } from "../Identify.ts";
import packageJson from "../../../package.json" with { type: "json" };

/** The console route that stores the events (fishcode `work_telemetry_events`). */
export const TELEMETRY_PATH = "/api/v1/work/telemetry";

/** The console takes at most this many events per request. */
const MAX_BATCH_SIZE = 100;

/** After a failed send, wait this long before the next attempt (no log spam offline). */
const RETRY_AFTER_FAILURE_MS = 60_000;

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

const isOffValue = (value: string) =>
  ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

export const TelemetryEnvConfig = Config.all({
  enabled: Config.boolean("UNO_WORK_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  doNotTrack: Config.string("DO_NOT_TRACK").pipe(Config.withDefault("")),
  upstreamEnabled: Config.boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.number("UNO_WORK_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(50)),
  maxBufferedEvents: Config.number("UNO_WORK_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
});

export interface AnalyticsServiceLayerOptions {
  /** Console base URL; the daemon uses `controlPlaneBaseUrl()`, tests a local server. */
  readonly consoleBaseUrl?: () => string;
}

/** Why a batch did not go out: dropped for good, or kept for a later attempt. */
type SendOutcome = "sent" | "drop" | "retry";

const makeAnalyticsService = (options: AnalyticsServiceLayerOptions) =>
  Effect.gen(function* () {
    const telemetryConfig = yield* TelemetryEnvConfig.asEffect();
    const enabled =
      telemetryConfig.enabled &&
      telemetryConfig.upstreamEnabled &&
      !isOffValue(telemetryConfig.doNotTrack);

    if (!enabled) {
      return {
        record: () => Effect.void,
        flush: Effect.void,
      } satisfies AnalyticsServiceShape;
    }

    const httpClient = yield* HttpClient.HttpClient;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const installId = yield* getTelemetryInstallId;
    const consoleBaseUrl = options.consoleBaseUrl ?? controlPlaneBaseUrl;
    const batchSize = Math.max(1, Math.min(telemetryConfig.flushBatchSize, MAX_BATCH_SIZE));
    const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
    const retryAtRef = yield* Ref.make(0);
    const client = {
      version: packageJson.version,
      platform: process.platform,
      arch: process.arch,
      client_type: serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client",
    };

    const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
      Effect.flatMap(DateTime.now, (now) =>
        Ref.update(bufferRef, (current) => {
          const appended = [
            ...current,
            {
              event,
              ...(properties ? { properties } : {}),
              capturedAt: DateTime.formatIso(now),
            } satisfies BufferedAnalyticsEvent,
          ];
          return appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;
        }),
      );

    const sendBatch = (
      token: string,
      events: ReadonlyArray<BufferedAnalyticsEvent>,
    ): Effect.Effect<SendOutcome> =>
      HttpClientRequest.post(`${consoleBaseUrl()}${TELEMETRY_PATH}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({
          install_id: installId,
          client,
          events: events.map((event) => ({
            event: event.event,
            ts: event.capturedAt,
            properties: event.properties ?? {},
          })),
        }),
        Effect.flatMap(httpClient.execute),
        Effect.map((response): SendOutcome => {
          if (response.status >= 200 && response.status < 300) return "sent";
          // Rate limit or console trouble: try again later. Anything else
          // (401, 404 on an older console, 400): these events will not fit.
          return response.status === 429 || response.status >= 500 ? "retry" : "drop";
        }),
        Effect.catch(() => Effect.succeed<SendOutcome>("retry")),
      );

    const flush: AnalyticsServiceShape["flush"] = Effect.gen(function* () {
      const retryAt = yield* Ref.get(retryAtRef);
      if (Date.now() < retryAt) return;

      const token = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => consoleToken(settings)),
        Effect.orElseSucceed(() => ""),
      );
      if (token.length === 0) {
        // Not linked to an Uno account: nothing is sent, nothing is kept.
        yield* Ref.set(bufferRef, []);
        return;
      }

      while (true) {
        const batch = yield* Ref.modify(bufferRef, (current) => [
          current.slice(0, batchSize),
          current.slice(batchSize),
        ]);
        if (batch.length === 0) return;

        const outcome = yield* sendBatch(token, batch);
        if (outcome === "sent") continue;
        if (outcome === "retry") {
          yield* Ref.update(bufferRef, (current) =>
            [...batch, ...current].slice(-telemetryConfig.maxBufferedEvents),
          );
          yield* Ref.set(retryAtRef, Date.now() + RETRY_AFTER_FAILURE_MS);
        }
        yield* Effect.logDebug("telemetry: batch not sent", { outcome, size: batch.length });
        return;
      }
    });

    const record: AnalyticsServiceShape["record"] = (event, properties) =>
      installId ? enqueueBufferedEvent(event, properties) : Effect.void;

    yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
      disableYield: true,
    }).pipe(Effect.forkScoped);

    yield* Effect.addFinalizer(() => flush);

    return {
      record,
      flush,
    } satisfies AnalyticsServiceShape;
  });

export const makeAnalyticsServiceLayer = (options: AnalyticsServiceLayerOptions = {}) =>
  Layer.effect(AnalyticsService, makeAnalyticsService(options));

export const AnalyticsServiceLayerLive = makeAnalyticsServiceLayer();

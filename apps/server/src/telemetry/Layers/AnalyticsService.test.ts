import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { makeAnalyticsServiceLayer, TELEMETRY_PATH } from "./AnalyticsService.ts";

interface CapturedRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: {
    readonly install_id?: string;
    readonly client?: { readonly version?: string; readonly client_type?: string };
    readonly events?: ReadonlyArray<{
      readonly event?: string;
      readonly ts?: string;
      readonly properties?: { readonly index?: number };
    }>;
  } | null;
}

const runWithTelemetry = (input: {
  readonly env: Record<string, unknown>;
  readonly uno: { readonly boxToken?: string; readonly apiKey?: string };
  readonly events: number;
}) =>
  Effect.gen(function* () {
    const captured: Array<CapturedRequest> = [];
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "uno-telemetry-base-",
    });
    const telemetryLayer = makeAnalyticsServiceLayer({ consoleBaseUrl: () => "" }).pipe(
      Layer.provideMerge(serverConfigLayer),
      Layer.provide(ServerSettingsService.layerTest({ uno: input.uno })),
    );
    const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown(input.env));
    const consoleLayer = HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.map((value) => value as CapturedRequest["body"]),
          Effect.catch(() => Effect.succeed(null)),
        );
        captured.push({ path: request.url, authorization: request.headers.authorization, body });
        return HttpServerResponse.jsonUnsafe(
          { accepted: body?.events?.length ?? 0 },
          { status: 202 },
        );
      }),
    );
    const runtimeLayer = telemetryLayer.pipe(
      Layer.provide(configLayer),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );

    const installIdFile = yield* Effect.gen(function* () {
      yield* Layer.launch(consoleLayer).pipe(Effect.forkScoped);
      const analytics = yield* AnalyticsService;
      for (let index = 0; index < input.events; index += 1) {
        yield* analytics.record("test.flush.drain", { index });
      }
      yield* analytics.flush;
      const { installIdPath } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.readFileString(installIdPath).pipe(Effect.orElseSucceed(() => ""));
    }).pipe(Effect.provide(runtimeLayer));

    return { captured, installIdFile };
  });

it.layer(NodeServices.layer)("AnalyticsService", (it) => {
  it.effect("a linked computer sends every event to the Uno console with its token", () =>
    Effect.gen(function* () {
      const { captured, installIdFile } = yield* runWithTelemetry({
        env: { UNO_WORK_TELEMETRY_FLUSH_BATCH_SIZE: 20 },
        uno: { boxToken: "box-token-1" },
        events: 45,
      });

      assert.equal(captured.length, 3);
      for (const request of captured) {
        assert.equal(request.path, TELEMETRY_PATH);
        assert.equal(request.authorization, "Bearer box-token-1");
        assert.equal(request.body?.install_id, installIdFile.trim());
        assert.equal(request.body?.client?.client_type, "cli-web-client");
        assert.equal(typeof request.body?.client?.version, "string");
        // Nothing PostHog-shaped is left in the payload.
        assert.equal("api_key" in (request.body ?? {}), false);
        assert.equal("batch" in (request.body ?? {}), false);
      }
      assert.match(installIdFile.trim(), /^[0-9a-f-]{36}$/u);

      const indexes = captured
        .flatMap((request) => request.body?.events ?? [])
        .map((event) => event.properties?.index)
        .filter((index): index is number => typeof index === "number")
        .toSorted((a, b) => a - b);
      assert.deepEqual(
        indexes,
        Array.from({ length: 45 }, (_, index) => index),
      );
    }),
  );

  it.effect("a computer not linked to an Uno account sends nothing", () =>
    Effect.gen(function* () {
      const { captured } = yield* runWithTelemetry({
        env: {},
        uno: { apiKey: "" },
        events: 5,
      });
      assert.equal(captured.length, 0);
    }),
  );

  it.effect("the AI key is not a console credential: nothing is sent with it", () =>
    Effect.gen(function* () {
      const { captured } = yield* runWithTelemetry({
        env: {},
        uno: { apiKey: "unollm_test" },
        events: 5,
      });
      assert.equal(captured.length, 0);
    }),
  );

  for (const [name, env] of [
    ["UNO_WORK_TELEMETRY_ENABLED=false", { UNO_WORK_TELEMETRY_ENABLED: "false" }],
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }],
    ["T3CODE_TELEMETRY_ENABLED=false", { T3CODE_TELEMETRY_ENABLED: "false" }],
  ] as const) {
    it.effect(`${name} turns it off, and no install id is made`, () =>
      Effect.gen(function* () {
        const { captured, installIdFile } = yield* runWithTelemetry({
          env,
          uno: { boxToken: "box-token-1" },
          events: 5,
        });
        assert.equal(captured.length, 0);
        assert.equal(installIdFile, "");
      }),
    );
  }
});

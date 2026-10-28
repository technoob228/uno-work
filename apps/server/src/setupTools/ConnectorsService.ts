/**
 * ConnectorsService — the connectors client (`connectors.ts`) bound to this
 * daemon's settings, read on every call (the console may write them after the
 * daemon started): the work-machine token `uno.boxToken` + `uno.boxId` on a
 * cloud computer, else the account key in `uno.apiKey` (a Mac), else none
 * (`connectorCredentialsFrom`).
 *
 * @module setupTools/ConnectorsService
 */
import { Context, Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import {
  ConnectorsError,
  makeConnectorsClient,
  connectorCredentialsFrom,
  type ConnectorCallResult,
  type ConnectorCredentials,
  type ConnectorsClientDeps,
  type ConnectorTool,
  type ManagerConnectorsList,
} from "./connectors.ts";

export interface ConnectorsServiceShape {
  readonly list: (options?: {
    readonly force?: boolean;
  }) => Effect.Effect<ManagerConnectorsList, ConnectorsError>;
  readonly start: (
    provider: string,
  ) => Effect.Effect<{ readonly authorizeUrl: string }, ConnectorsError>;
  readonly remove: (provider: string) => Effect.Effect<void, ConnectorsError>;
  /** Never fails: no tools is the answer without credentials or with the console down. */
  readonly tools: Effect.Effect<ReadonlyArray<ConnectorTool>>;
  readonly call: (input: {
    readonly provider: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Effect.Effect<ConnectorCallResult, ConnectorsError>;
}

export class ConnectorsService extends Context.Service<ConnectorsService, ConnectorsServiceShape>()(
  "t3/setupTools/ConnectorsService",
) {}

const asConnectorsError = (cause: unknown) =>
  cause instanceof ConnectorsError
    ? cause
    : new ConnectorsError(500, "internal", cause instanceof Error ? cause.message : String(cause));

export const makeConnectorsService = (overrides: Partial<ConnectorsClientDeps> = {}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    const credentials = async (): Promise<ConnectorCredentials | null> => {
      const current = await runPromise(settings.getSettings.pipe(Effect.orElseSucceed(() => null)));
      return connectorCredentialsFrom({
        boxToken: current?.uno.boxToken,
        boxId: parseSettingsBoxId(current?.uno.boxId),
        apiKey: current?.uno.apiKey,
      });
    };

    const client = makeConnectorsClient({
      credentials,
      baseUrl: controlPlaneBaseUrl,
      ...overrides,
    });

    const lift = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: asConnectorsError });

    return {
      list: (options) => lift(() => client.list(options)),
      start: (provider) => lift(() => client.start(provider)),
      remove: (provider) => lift(() => client.remove(provider)),
      tools: Effect.promise(() => client.tools().catch(() => [])),
      call: (input) => lift(() => client.call(input)),
    } satisfies ConnectorsServiceShape;
  });

export const ConnectorsServiceLive = Layer.effect(ConnectorsService, makeConnectorsService());

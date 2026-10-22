/**
 * AgentMailService — "Email for your AI" (`agentMail.ts`) bound to this
 * daemon's settings: the console with this computer's work-machine token.
 *
 * @module setupTools/AgentMailService
 */
import { Context, Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import {
  makeAgentMailClient,
  type AgentMailClientDeps,
  type AgentMailListedLetter,
  type AgentMailState,
} from "./agentMail.ts";
import { ConnectorsError } from "./connectors.ts";

export interface AgentMailServiceShape {
  /** Never fails. */
  readonly status: Effect.Effect<AgentMailState>;
  /** The newest letters of the computer's mailbox; [] when mail isn't there. Never fails. */
  readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<AgentMailListedLetter>>;
  readonly changeAddress: (
    local: string,
  ) => Effect.Effect<{ readonly address: string }, ConnectorsError>;
}

export class AgentMailService extends Context.Service<AgentMailService, AgentMailServiceShape>()(
  "t3/setupTools/AgentMailService",
) {}

const asConnectorsError = (cause: unknown) =>
  cause instanceof ConnectorsError
    ? cause
    : new ConnectorsError(500, "internal", cause instanceof Error ? cause.message : String(cause));

export const makeAgentMailService = (overrides: Partial<AgentMailClientDeps> = {}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    const client = makeAgentMailClient({
      token: async () => {
        const current = await runPromise(
          settings.getSettings.pipe(Effect.orElseSucceed(() => null)),
        );
        return current?.uno.boxToken?.trim() || null;
      },
      baseUrl: controlPlaneBaseUrl,
      ...overrides,
    });

    return {
      status: Effect.promise(() => client.status()),
      recent: (limit) => Effect.promise(() => client.recent(limit)),
      changeAddress: (local) =>
        Effect.tryPromise({ try: () => client.changeAddress(local), catch: asConnectorsError }),
    } satisfies AgentMailServiceShape;
  });

export const AgentMailServiceLive = Layer.effect(AgentMailService, makeAgentMailService());

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option, Ref } from "effect";

import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ManagerConnectorRepository,
  type ManagerConnectorKey,
} from "../persistence/Services/ManagerConnectors.ts";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, INITIAL_CONNECTOR_HEALTH } from "./connectorHealth.ts";
import {
  initializeSlackRelayState,
  pollSlackRelayOnce,
  SLACK_RELAY_FINGERPRINT,
  SLACK_RELAY_IDLE_PAUSE_MS,
  slackRelayLoopStep,
  type SlackEventsApiPayload,
} from "./slackRelayEvents.ts";
import type { FetchLike } from "./workConsole.ts";

const SLR = "slr_0123456789abcdef0123456789abcdef";
const key: ManagerConnectorKey = { projectId: ProjectId.make("assistant-home"), kind: "slack" };

const repositoryLayer = ManagerConnectorRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const envelope = (cursor: number, text: string) => ({
  cursor: String(cursor),
  payload: {
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev${cursor}`,
    event: { type: "message", channel: "D1", ts: `${cursor}.0001`, user: "U1", text },
  },
});

/** A console stub: records the `after` of every poll, answers from `batches` in order. */
const makeConsole = (batches: Array<{ status: number; body: unknown }>) => {
  const afters: Array<string | null> = [];
  const urls: Array<string> = [];
  const fetchImpl: FetchLike = async (input) => {
    urls.push(input);
    afters.push(new URL(input).searchParams.get("after"));
    const next = batches.shift() ?? { status: 200, body: { events: [], cursor: null } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetchImpl, afters, urls };
};

const collector = Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<SlackEventsApiPayload>>([]);
  const handle = (payload: SlackEventsApiPayload) => Ref.update(seen, (list) => [...list, payload]);
  return { seen, handle };
});

it.layer(NodeServices.layer)("slack relay event poller", (it) => {
  it.effect("feeds payloads to the handler and persists the cursor across polls", () =>
    Effect.gen(function* () {
      const { seen, handle } = yield* collector;
      yield* initializeSlackRelayState({ key, handle });
      const console = makeConsole([
        { status: 200, body: { events: [envelope(41, "one"), envelope(42, "two")], cursor: "42" } },
        { status: 200, body: { events: [envelope(43, "three")], cursor: "43" } },
      ]);

      expect(
        yield* pollSlackRelayOnce({ key, relayToken: SLR, handle, fetchImpl: console.fetchImpl }),
      ).toBe(2);
      expect(
        yield* pollSlackRelayOnce({ key, relayToken: SLR, handle, fetchImpl: console.fetchImpl }),
      ).toBe(1);

      expect(console.afters).toEqual(["0", "42"]);
      expect(console.urls[0]).toContain(`/api/v1/work-relay/slack/${SLR}/events?after=0&wait=25`);
      expect((yield* Ref.get(seen)).map((payload) => payload.event_id)).toEqual([
        "Ev41",
        "Ev42",
        "Ev43",
      ]);
      const repository = yield* ManagerConnectorRepository;
      const state = yield* repository.getState(key);
      expect(Option.isSome(state) && state.value.offset).toBe(43);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("resumes from the persisted cursor after a restart and never re-handles an event", () =>
    Effect.gen(function* () {
      const { seen, handle } = yield* collector;
      yield* initializeSlackRelayState({ key, handle });
      const first = makeConsole([
        { status: 200, body: { events: [envelope(7, "before restart")], cursor: "7" } },
      ]);
      yield* pollSlackRelayOnce({ key, relayToken: SLR, handle, fetchImpl: first.fetchImpl });

      // "Restart": state is re-bound (same relay fingerprint → kept), and the
      // console re-delivers 7 (its ack was lost) together with a new 8.
      yield* initializeSlackRelayState({ key, handle });
      const second = makeConsole([
        {
          status: 200,
          body: { events: [envelope(7, "before restart"), envelope(8, "after")], cursor: "8" },
        },
      ]);
      yield* pollSlackRelayOnce({
        key,
        relayToken: "slr_rotated_token",
        handle,
        fetchImpl: second.fetchImpl,
      });

      expect(second.afters).toEqual(["7"]);
      expect((yield* Ref.get(seen)).map((payload) => payload.event_id)).toEqual(["Ev7", "Ev8"]);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("starts from zero when the state belonged to Socket Mode / another credential", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      yield* repository.resetState({
        ...key,
        credentialFingerprint: "socket-mode-fingerprint",
        updatedAt: new Date().toISOString(),
      });
      yield* repository.advanceOffset({ ...key, offset: 99, updatedAt: new Date().toISOString() });
      const { handle } = yield* collector;
      yield* initializeSlackRelayState({ key, handle });
      const state = yield* repository.getState(key);
      expect(Option.isSome(state) && state.value.offset).toBe(0);
      expect(Option.isSome(state) && state.value.credentialFingerprint).toBe(
        SLACK_RELAY_FINGERPRINT,
      );
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("backs off exponentially on failures and resets after a success", () =>
    Effect.gen(function* () {
      const { handle } = yield* collector;
      yield* initializeSlackRelayState({ key, handle });
      const console = makeConsole([
        { status: 502, body: { error: "bad gateway" } },
        { status: 502, body: { error: "bad gateway" } },
        { status: 200, body: { events: [], cursor: null } },
        { status: 401, body: { error: "revoked" } },
      ]);
      const nowMs = () => 1_000_000;
      const step = (health: typeof INITIAL_CONNECTOR_HEALTH) =>
        slackRelayLoopStep({
          key,
          relayToken: SLR,
          health,
          handle,
          fetchImpl: console.fetchImpl,
          nowMs,
        });

      const first = yield* step(INITIAL_CONNECTOR_HEALTH);
      expect(first.health.status).toBe("provider_unavailable");
      expect(first.delayMs).toBe(BACKOFF_BASE_MS);
      expect(first.error).toContain("502");

      const second = yield* step(first.health);
      expect(second.delayMs).toBe(BACKOFF_BASE_MS * 2);

      const recovered = yield* step(second.health);
      expect(recovered.health.status).toBe("connected");
      expect(recovered.health.consecutiveFailures).toBe(0);
      expect(recovered.error).toBeNull();
      expect(recovered.delayMs).toBe(SLACK_RELAY_IDLE_PAUSE_MS);

      const revoked = yield* step(recovered.health);
      expect(revoked.health.status).toBe("auth_expired");
      expect(revoked.delayMs).toBe(BACKOFF_MAX_MS);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("treats an unreachable console as a network failure without leaking the token", () =>
    Effect.gen(function* () {
      const { handle } = yield* collector;
      yield* initializeSlackRelayState({ key, handle });
      const fetchImpl: FetchLike = async (input) => {
        throw new Error(`connect ECONNREFUSED while fetching ${input}`);
      };
      const result = yield* slackRelayLoopStep({
        key,
        relayToken: SLR,
        health: INITIAL_CONNECTOR_HEALTH,
        handle,
        fetchImpl,
      });
      expect(result.health.status).toBe("reconnecting");
      expect(result.error).not.toContain(SLR);
    }).pipe(Effect.provide(repositoryLayer)),
  );
});

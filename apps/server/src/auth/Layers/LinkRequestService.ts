import type { AuthLinkRequestStreamEvent } from "@t3tools/contracts";
import { Clock, DateTime, Duration, Effect, Layer, PubSub, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  DEFAULT_LINK_REQUEST_TTL_MS,
  LinkRequestStore,
  toPendingLinkRequest,
  type LinkRequestRecord,
} from "../linkRequests.ts";
import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import {
  LinkRequestError,
  LinkRequestService,
  type LinkRequestServiceShape,
} from "../Services/LinkRequestService.ts";

/** Subject on the minted pairing link, so the audit trail says where it came from. */
export const LINK_REQUEST_PAIRING_SUBJECT = "link-request";

export const makeLinkRequestService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const authControlPlane = yield* AuthControlPlane;
  const clock = yield* Clock.Clock;
  const changes = yield* PubSub.unbounded<AuthLinkRequestStreamEvent>();
  // Same clock the pairing tokens are stamped with, so a request and the
  // credential it produced always agree on "now" (also under the test clock).
  const store = new LinkRequestStore({
    now: () => clock.currentTimeMillisUnsafe(),
    generateId: () => crypto.randomUUID(),
    ttlMs: DEFAULT_LINK_REQUEST_TTL_MS,
  });

  // Only a desktop shell can put a human in front of the request. A headless
  // `t3 serve` (boxes, VMs) keeps the explicit pairing-link flow.
  const isAvailable = config.mode === "desktop";

  const announceExpired = (expired: ReadonlyArray<LinkRequestRecord>) =>
    Effect.forEach(
      expired,
      (record) =>
        PubSub.publish(changes, {
          type: "resolved",
          payload: { requestId: record.id, status: "expired" },
        }),
      { discard: true },
    );

  const create: LinkRequestServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      if (!isAvailable) {
        return yield* new LinkRequestError({
          message: "This machine has no desktop app to approve the request.",
          status: 404,
        });
      }
      const { record, expired } = store.create(input);
      yield* announceExpired(expired);
      const pending = toPendingLinkRequest(record);
      yield* PubSub.publish(changes, { type: "requested", payload: pending });
      return pending;
    });

  const poll: LinkRequestServiceShape["poll"] = (requestId) =>
    Effect.gen(function* () {
      yield* announceExpired(store.sweep());
      const view = store.poll(requestId);
      if (!view) {
        return yield* new LinkRequestError({ message: "Unknown link request.", status: 404 });
      }
      return view;
    });

  const decide: LinkRequestServiceShape["decide"] = (requestId, decision) =>
    Effect.gen(function* () {
      yield* announceExpired(store.sweep());
      if (decision === "deny") {
        const denied = store.deny(requestId);
        if (!denied.ok) {
          return yield* toTransitionError(denied.error);
        }
        yield* PubSub.publish(changes, {
          type: "resolved",
          payload: { requestId, status: "denied" },
        });
        return "denied" as const;
      }

      const current = store.get(requestId);
      if (!current) {
        return yield* new LinkRequestError({ message: "Unknown link request.", status: 404 });
      }
      if (current.status !== "pending") {
        return yield* toTransitionError({ kind: "not-pending", status: current.status });
      }

      // The approval IS a pairing token: same issuer, same one-time semantics
      // as `t3 auth pairing create`, just with a shorter fuse. Owner role so
      // the browser can do on this computer what the desktop can.
      const issued = yield* authControlPlane
        .createPairingLink({
          role: "owner",
          subject: LINK_REQUEST_PAIRING_SUBJECT,
          label: current.label,
          ttl: Duration.millis(store.ttlMs),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LinkRequestError({
                message: "Failed to issue pairing credential for link request.",
                status: 500,
                cause,
              }),
          ),
        );

      const approved = store.approve(requestId, {
        id: issued.id,
        credential: issued.credential,
        ...(issued.label ? { label: issued.label } : {}),
        expiresAtMs: DateTime.toEpochMillis(issued.expiresAt),
      });
      if (!approved.ok) {
        // Lost a race with expiry between the check above and now: do not
        // leave a live owner credential nobody will ever pick up.
        yield* authControlPlane.revokePairingLink(issued.id).pipe(Effect.ignore);
        return yield* toTransitionError(approved.error);
      }
      yield* PubSub.publish(changes, {
        type: "resolved",
        payload: { requestId, status: "approved" },
      });
      return "approved" as const;
    });

  const listPending: LinkRequestServiceShape["listPending"] = () =>
    Effect.sync(() => store.listPending().map(toPendingLinkRequest));

  return {
    isAvailable,
    create,
    poll,
    decide,
    listPending,
    streamChanges: Stream.fromPubSub(changes),
  } satisfies LinkRequestServiceShape;
});

function toTransitionError(
  error: { readonly kind: "not-found" } | { readonly kind: "not-pending"; readonly status: string },
): LinkRequestError {
  if (error.kind === "not-found") {
    return new LinkRequestError({ message: "Unknown link request.", status: 404 });
  }
  return new LinkRequestError({
    message: `Link request is already ${error.status}.`,
    status: 409,
  });
}

export const LinkRequestServiceLive = Layer.effect(LinkRequestService, makeLinkRequestService);

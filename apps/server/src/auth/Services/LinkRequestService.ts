import type {
  AuthLinkRequestDecision,
  AuthLinkRequestPending,
  AuthLinkRequestStatus,
  AuthLinkRequestStreamEvent,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

import type { LinkRequestPollView } from "../linkRequests.ts";

export class LinkRequestError extends Data.TaggedError("LinkRequestError")<{
  readonly message: string;
  readonly status: 400 | 404 | 409 | 500;
  readonly cause?: unknown;
}> {}

export interface LinkRequestServiceShape {
  /** Whether this daemon has anyone to ask (a desktop shell) at all. */
  readonly isAvailable: boolean;
  readonly create: (input: {
    readonly origin: string;
    readonly label: string;
  }) => Effect.Effect<AuthLinkRequestPending, LinkRequestError>;
  readonly poll: (requestId: string) => Effect.Effect<LinkRequestPollView, LinkRequestError>;
  readonly decide: (
    requestId: string,
    decision: AuthLinkRequestDecision,
  ) => Effect.Effect<AuthLinkRequestStatus, LinkRequestError>;
  readonly listPending: () => Effect.Effect<ReadonlyArray<AuthLinkRequestPending>>;
  readonly streamChanges: Stream.Stream<AuthLinkRequestStreamEvent>;
}

export class LinkRequestService extends Context.Service<
  LinkRequestService,
  LinkRequestServiceShape
>()("t3/auth/Services/LinkRequestService") {}

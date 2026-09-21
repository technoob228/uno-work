import { Schema } from "effect";

import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Declares the server's overall authentication posture.
 *
 * This is a high-level policy label that tells clients how the environment is
 * expected to be accessed, not a transport detail and not an exhaustive list
 * of every accepted credential.
 *
 * Typical usage:
 * - rendered in auth/pairing UI so the user understands what kind of
 *   environment they are connecting to
 * - used by clients to decide whether silent desktop bootstrap is expected or
 *   whether an explicit pairing flow should be shown
 *
 * Meanings:
 * - `desktop-managed-local`: local desktop-managed environment with narrow
 *   trusted bootstrap, intended to avoid login prompts on the same machine
 * - `loopback-browser`: standalone local server intended for browser pairing on
 *   the same machine
 * - `remote-reachable`: environment intended to be reached from other devices
 *   or networks, where explicit pairing/auth is expected
 * - `unsafe-no-auth`: intentionally unauthenticated mode; this is an explicit
 *   unsafe escape hatch, not a normal deployment mode
 */
export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

/**
 * A credential type that can be exchanged for a real authenticated session.
 *
 * Bootstrap methods are for establishing trust at the start of a connection or
 * pairing flow. They are not the long-lived credential used for ordinary
 * authenticated HTTP / WebSocket traffic after pairing succeeds.
 *
 * Current methods:
 * - `desktop-bootstrap`: a trusted local desktop handoff, used so the desktop
 *   shell can pair the renderer without a login screen
 * - `one-time-token`: a short-lived pairing token, suitable for manual pairing
 *   flows such as `/pair?token=...`
 */
export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

/**
 * A credential type accepted for steady-state authenticated requests after a
 * client has already paired.
 *
 * These methods are used by the server-wide auth layer for privileged HTTP and
 * WebSocket access. They are distinct from bootstrap methods so clients can
 * reason clearly about "pair first, then use session auth".
 *
 * Current methods:
 * - `browser-session-cookie`: cookie-backed browser session, used by the web
 *   app after bootstrap/pairing
 * - `bearer-session-token`: token-based session suitable for non-cookie or
 *   non-browser clients
 */
export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-session-token",
  // Mobile-compat: апстрим переименовал bearer-session-token →
  // bearer-access-token (коммит a04c09a19). Для апстримных клиентов мы
  // отдаём их литерал; союз расширен, чтобы наши encode/decode его принимали.
  "bearer-access-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthSessionRole = Schema.Literals(["owner", "client"]);
export type AuthSessionRole = typeof AuthSessionRole.Type;

/**
 * Server-advertised auth capabilities for a specific execution environment.
 *
 * Clients should treat this as the authoritative description of how that
 * environment expects to be paired and how authenticated requests should be
 * made afterward.
 *
 * Field meanings:
 * - `policy`: high-level auth posture for the environment
 * - `bootstrapMethods`: pairing/bootstrap methods the server is currently
 *   willing to accept
 * - `sessionMethods`: authenticated request/session methods the server supports
 *   once pairing is complete
 * - `sessionCookieName`: cookie name clients should expect when
 *   `browser-session-cookie` is in use
 *
 * This descriptor is intentionally capability-oriented. It lets clients choose
 * the right UX without embedding server-specific auth logic or assuming a
 * single access method.
 */
/**
 * "Sign in with Uno": the daemon runs on an Uno box and knows which one, so a
 * browser without a session is sent to the console (`<consoleUrl>/work/open`),
 * which checks the box is the signed-in user's and comes back with a one-time
 * pairing token. Only advertised to browsers that are not signed in yet.
 */
export const ServerAuthUnoSignIn = Schema.Struct({
  consoleUrl: TrimmedNonEmptyString,
  boxId: Schema.Number,
});
export type ServerAuthUnoSignIn = typeof ServerAuthUnoSignIn.Type;

export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
  unoSignIn: Schema.optionalKey(ServerAuthUnoSignIn),
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthBootstrapInput = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthBootstrapInput = typeof AuthBootstrapInput.Type;

export const AuthBootstrapResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBootstrapResult = typeof AuthBootstrapResult.Type;

export const AuthBearerBootstrapResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: Schema.Literal("bearer-session-token"),
  expiresAt: Schema.DateTimeUtc,
  sessionToken: TrimmedNonEmptyString,
});
export type AuthBearerBootstrapResult = typeof AuthBearerBootstrapResult.Type;

export const AuthWebSocketTokenResult = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTokenResult = typeof AuthWebSocketTokenResult.Type;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  role: AuthSessionRole,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  role: AuthSessionRole,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthAccessStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = typeof AuthAccessStreamSnapshotEvent.Type;

export const AuthAccessStreamPairingLinkUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent =
  typeof AuthAccessStreamPairingLinkUpsertedEvent.Type;

export const AuthAccessStreamPairingLinkRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkRemoved"),
  payload: Schema.Struct({
    id: TrimmedNonEmptyString,
  }),
});
export type AuthAccessStreamPairingLinkRemovedEvent =
  typeof AuthAccessStreamPairingLinkRemovedEvent.Type;

export const AuthAccessStreamClientUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = typeof AuthAccessStreamClientUpsertedEvent.Type;

export const AuthAccessStreamClientRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientRemoved"),
  payload: Schema.Struct({
    sessionId: AuthSessionId,
  }),
});
export type AuthAccessStreamClientRemovedEvent = typeof AuthAccessStreamClientRemovedEvent.Type;

export const AuthAccessStreamEvent = Schema.Union([
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = typeof AuthAccessStreamEvent.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const AuthCreatePairingCredentialInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  role: Schema.optionalKey(AuthSessionRole),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type AuthSessionState = typeof AuthSessionState.Type;

/* ------------------------------------------------------------------ *
 * Link requests ("Use this computer")
 *
 * A browser tab on an allowed origin (the hosted Uno Work app) asks the
 * local desktop daemon for access. The daemon parks the request, the desktop
 * app shows "<origin> wants to use this computer — Allow / Deny", and on
 * Allow the daemon mints an ordinary one-time pairing credential bound to the
 * request. The browser polls the request until it is approved, then runs the
 * normal bootstrap with that credential. The auth model is not widened: an
 * approval is exactly a pairing token the human never has to copy.
 * ------------------------------------------------------------------ */

export const AuthLinkRequestId = TrimmedNonEmptyString;
export type AuthLinkRequestId = typeof AuthLinkRequestId.Type;

export const AuthLinkRequestCreateInput = Schema.Struct({
  /** Origin the browser claims; the daemon trusts the `Origin` header, not this. */
  origin: TrimmedNonEmptyString,
  /** What the approval prompt and the paired-client list call the browser. */
  label: TrimmedNonEmptyString,
});
export type AuthLinkRequestCreateInput = typeof AuthLinkRequestCreateInput.Type;

export const AuthLinkRequestCreateResult = Schema.Struct({
  requestId: AuthLinkRequestId,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthLinkRequestCreateResult = typeof AuthLinkRequestCreateResult.Type;

export const AuthLinkRequestStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  /** Approved and the credential was already handed out once. */
  "consumed",
]);
export type AuthLinkRequestStatus = typeof AuthLinkRequestStatus.Type;

export const AuthLinkRequestPollResult = Schema.Struct({
  requestId: AuthLinkRequestId,
  status: AuthLinkRequestStatus,
  expiresAt: Schema.DateTimeUtc,
  /** Present exactly once, on the first poll after approval. */
  pairing: Schema.optionalKey(AuthPairingCredentialResult),
});
export type AuthLinkRequestPollResult = typeof AuthLinkRequestPollResult.Type;

export const AuthLinkRequestDecision = Schema.Literals(["allow", "deny"]);
export type AuthLinkRequestDecision = typeof AuthLinkRequestDecision.Type;

export const AuthLinkRequestDecideInput = Schema.Struct({
  requestId: AuthLinkRequestId,
  decision: AuthLinkRequestDecision,
});
export type AuthLinkRequestDecideInput = typeof AuthLinkRequestDecideInput.Type;

export const AuthLinkRequestDecideResult = Schema.Struct({
  requestId: AuthLinkRequestId,
  status: AuthLinkRequestStatus,
});
export type AuthLinkRequestDecideResult = typeof AuthLinkRequestDecideResult.Type;

/** What the desktop prompt shows: who is asking, since when, until when. */
export const AuthLinkRequestPending = Schema.Struct({
  requestId: AuthLinkRequestId,
  origin: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthLinkRequestPending = typeof AuthLinkRequestPending.Type;

export const AuthLinkRequestStreamSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  payload: Schema.Struct({
    pending: Schema.Array(AuthLinkRequestPending),
  }),
});
export type AuthLinkRequestStreamSnapshotEvent = typeof AuthLinkRequestStreamSnapshotEvent.Type;

export const AuthLinkRequestStreamRequestedEvent = Schema.Struct({
  type: Schema.Literal("requested"),
  payload: AuthLinkRequestPending,
});
export type AuthLinkRequestStreamRequestedEvent = typeof AuthLinkRequestStreamRequestedEvent.Type;

export const AuthLinkRequestStreamResolvedEvent = Schema.Struct({
  type: Schema.Literal("resolved"),
  payload: Schema.Struct({
    requestId: AuthLinkRequestId,
    status: AuthLinkRequestStatus,
  }),
});
export type AuthLinkRequestStreamResolvedEvent = typeof AuthLinkRequestStreamResolvedEvent.Type;

export const AuthLinkRequestStreamEvent = Schema.Union([
  AuthLinkRequestStreamSnapshotEvent,
  AuthLinkRequestStreamRequestedEvent,
  AuthLinkRequestStreamResolvedEvent,
]);
export type AuthLinkRequestStreamEvent = typeof AuthLinkRequestStreamEvent.Type;

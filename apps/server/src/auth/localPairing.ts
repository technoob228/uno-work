/**
 * `POST /api/local/pairing-token` — the daemon-side twin of
 * `uno-work auth pairing create --json`, for root on the same machine.
 *
 * The console mints a browser session on a Work box by running that CLI over
 * `exec`: a whole Node process (~2 s on a busy 2 vCPU box) just to write one
 * row. The daemon is already running, so this endpoint issues the same
 * one-time pairing token in-process and answers with the CLI's exact JSON.
 *
 * Who may call it — all three must hold, otherwise 403:
 * - the connection comes from loopback (127.0.0.0/8 or ::1), with no
 *   X-Forwarded-For (i.e. not relayed by a local proxy);
 * - the caller's socket belongs to uid 0 (read from /proc/net/tcp{,6}, see
 *   loopbackPeer.ts). The daemon's own user — which every agent on the
 *   machine also runs as — is refused, so an agent can't mint owner access;
 * - Linux with Node's HTTP server (the Bun server exposes no socket).
 *
 * Body (optional JSON): `{ "role": "owner" | "client", "ttl": "10m",
 * "label": "…", "baseUrl": "https://…" }` — the CLI's flags; defaults as in
 * the CLI (role client, TTL of the credential service).
 */
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { formatIssuedPairingCredential } from "../cliAuthFormat.ts";
import { parseDurationInput } from "../durationInput.ts";
import { AuthControlPlane } from "./Services/AuthControlPlane.ts";
import { type ConnectionEndpoints, readLoopbackPeerUid } from "./loopbackPeer.ts";

export const LOCAL_PAIRING_PATH = "/api/local/pairing-token";

const LocalPairingBody = Schema.Struct({
  role: Schema.optionalKey(Schema.Literals(["owner", "client"])),
  ttl: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
});
type LocalPairingBody = typeof LocalPairingBody.Type;

const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** The Node socket behind a request, when there is one. */
function connectionOf(source: unknown): ConnectionEndpoints | null {
  if (!source || typeof source !== "object") return null;
  const socket = (source as { readonly socket?: ConnectionEndpoints }).socket;
  return socket && typeof socket === "object" ? socket : null;
}

/** Why this request may not mint a token, or null when it may. */
export function localPairingRefusal(input: {
  readonly connection: ConnectionEndpoints | null;
  readonly forwardedFor: string | undefined;
  readonly peerUid: (connection: ConnectionEndpoints) => number | null;
}): string | null {
  if (input.connection === null) return "No socket to check the caller on.";
  if (input.forwardedFor !== undefined) return "Relayed requests are not accepted.";
  const uid = input.peerUid(input.connection);
  if (uid === null) return "Only local connections from root are accepted.";
  if (uid !== 0) return "Only root on this machine may mint a session here.";
  return null;
}

function parseBody(raw: string): LocalPairingBody | string {
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "Body must be JSON.";
  }
  const decoded = Schema.decodeUnknownExit(LocalPairingBody)(parsed);
  return decoded._tag === "Success"
    ? decoded.value
    : 'Expected { "role"?: "owner" | "client", "ttl"?: "10m", "label"?: string, "baseUrl"?: string }.';
}

export const localPairingRouteLayer = HttpRouter.add(
  "POST",
  LOCAL_PAIRING_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const refusal = localPairingRefusal({
      connection: connectionOf(request.source),
      forwardedFor: request.headers["x-forwarded-for"],
      peerUid: (connection) => readLoopbackPeerUid(connection),
    });
    if (refusal !== null) {
      yield* Effect.logWarning("local pairing refused").pipe(
        Effect.annotateLogs({ reason: refusal }),
      );
      return json({ error: refusal }, 403);
    }

    const body = parseBody(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
    if (typeof body === "string") return json({ error: body }, 400);
    const ttl = body.ttl === undefined ? undefined : parseDurationInput(body.ttl);
    if (ttl === null) {
      return json({ error: "Invalid ttl. Use values like 5m, 1h, 30d, or 15 minutes." }, 400);
    }

    const controlPlane = yield* AuthControlPlane;
    return yield* controlPlane
      .createPairingLink({
        role: body.role ?? "client",
        subject: "one-time-token",
        ...(ttl !== undefined ? { ttl } : {}),
        ...(body.label !== undefined && body.label.trim().length > 0
          ? { label: body.label.trim() }
          : {}),
      })
      .pipe(
        Effect.map((issued) =>
          HttpServerResponse.text(
            formatIssuedPairingCredential(issued, {
              json: true,
              ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
            }),
            {
              status: 200,
              contentType: "application/json",
              headers: { "cache-control": "no-store" },
            },
          ),
        ),
        Effect.tap(() =>
          Effect.logInfo("local pairing token issued").pipe(
            Effect.annotateLogs({ role: body.role ?? "client" }),
          ),
        ),
        Effect.catch((error) =>
          Effect.logError("local pairing failed").pipe(
            Effect.annotateLogs({ cause: error.message }),
            Effect.as(json({ error: "Failed to issue a pairing token." }, 500)),
          ),
        ),
      );
  }),
);

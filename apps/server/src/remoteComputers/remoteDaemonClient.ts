/**
 * Talking to the Uno Work daemon of ANOTHER computer of the account, the way
 * the web app connects to a computer (assistants D, 28.10):
 *
 * 1. the console mints a one-time pairing link for that computer
 *    (`POST /api/v1/boxes/{id}/work/session`) — with the account key on a
 *    laptop, with this machine's token on a cloud computer (the console lets
 *    it through with `machines:create`, checking the owner in its database);
 *    a sleeping computer is woken by the console, "still starting" is waited
 *    out (`retryWhileWorkMachineStarts`);
 * 2. the pairing credential is traded for a bearer session at the other
 *    daemon (`POST /api/auth/bootstrap/bearer`), kept in memory until shortly
 *    before it expires; a 401 later re-pairs once;
 * 3. requests go to that daemon with `Authorization: Bearer …`.
 *
 * Tokens and links are never logged or put into error messages.
 *
 * Plain promises (no Effect) so it is tested with fake fetches.
 *
 * @module remoteComputers/remoteDaemonClient
 */
import { Data } from "effect";

import {
  ControlPlaneHttpError,
  controlPlaneErrorStatus,
  isWorkMachineStartingError,
  parseUnoBoxConnection,
  retryWhileWorkMachineStarts,
  WORK_MACHINE_STILL_STARTING_MESSAGE,
} from "@t3tools/shared/unoCloud";

import { pairingTargetFromUrl } from "./target.ts";

/** A session this close to its end is re-paired instead of used. */
const SESSION_REFRESH_MARGIN_MS = 2 * 60_000;
/** When the daemon does not say how long its session lives. */
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
/** One request to the other daemon; an edge that is not routing yet tends to hang. */
const REQUEST_TIMEOUT_MS = 20_000;

export type RemoteComputerErrorCode =
  /** No account key and no machine token on this computer. */
  | "not_linked"
  /** The person didn't allow this computer to connect to others (Settings → Computer access). */
  | "no_permission"
  /** The computer is waking or starting; try again shortly. */
  | "starting"
  /** The computer failed to start. */
  | "failed"
  /** The computer isn't reachable right now. */
  | "unreachable"
  /** The other computer's Uno Work is too old for this route. */
  | "outdated"
  /** The console doesn't know this computer (deleted?) or it is not this account's. */
  | "not_found"
  /** The other daemon refused the request (its answer is in the message). */
  | "refused";

/** Thrown by the promise client and failed with in Effect code alike. */
export class RemoteComputerError extends Data.TaggedError("RemoteComputerError")<{
  readonly code: RemoteComputerErrorCode;
  readonly message: string;
  readonly status: number | null;
}> {}

export const remoteError = (
  code: RemoteComputerErrorCode,
  message: string,
  status: number | null = null,
): RemoteComputerError => new RemoteComputerError({ code, message, status });

export interface RemoteDaemonClientDeps {
  /** One control-plane call with this computer's account-wide key; throws `ControlPlaneHttpError`. */
  readonly controlPlane: ((path: string, init?: RequestInit) => Promise<unknown>) | null;
  /** Which key that is: a machine token gets "Settings → Computer access" on a 403. */
  readonly keyKind: "account" | "machine" | "none";
  /**
   * How this computer names itself in the other computer's list of signed-in
   * clients ("Uno on stage-work"); the console takes it with `work/session`
   * (older consoles ignore it and say "console").
   */
  readonly sessionLabel?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RemoteDaemonReply {
  readonly status: number;
  readonly body: unknown;
}

interface CachedSession {
  readonly baseUrl: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

const COMPUTER_ACCESS_HINT =
  "Allow it in the Uno console: Settings → Computer access (“Connect to other computers”).";

/** Plain words for a failed pairing call to the console. */
export function pairingFailure(
  cause: unknown,
  input: { readonly computerName: string; readonly keyKind: "account" | "machine" | "none" },
): RemoteComputerError {
  const name = input.computerName;
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (raw === WORK_MACHINE_STILL_STARTING_MESSAGE || isWorkMachineStartingError(cause)) {
    return remoteError("starting", `${name} is still waking up. Try again in a minute.`);
  }
  if (raw.includes("WORK_MACHINE_FAILED")) {
    return remoteError(
      "failed",
      `${name} failed to start. The person can restart it from the computer switcher in Uno Work.`,
    );
  }
  const status = controlPlaneErrorStatus(cause);
  if (status === 403) {
    if (input.keyKind === "machine") {
      return remoteError(
        "no_permission",
        `This computer isn't allowed to start chats on ${name}. ${COMPUTER_ACCESS_HINT}`,
        403,
      );
    }
    return remoteError("no_permission", `Uno refused to connect to ${name} with this key.`, 403);
  }
  if (status === 401) {
    return remoteError(
      "not_linked",
      "Uno refused this computer's key. The person can sign in again in Settings → Uno account.",
      401,
    );
  }
  if (status === 404) {
    return remoteError(
      "not_found",
      `Uno doesn't know the computer ${name} — it may have been deleted.`,
      404,
    );
  }
  if (status !== null && status >= 500) {
    return remoteError(
      "unreachable",
      `Uno isn't answering right now, so ${name} can't be reached. Try again in a minute.`,
      status,
    );
  }
  return remoteError(
    "unreachable",
    `Can't connect to ${name} right now. Try again in a minute.`,
    status,
  );
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The other daemon's error text (`{error}` / `{message}`), clipped; never echoes HTML. */
export function remoteErrorText(body: unknown): string | null {
  const record = asRecord(body);
  const text =
    typeof record?.["message"] === "string"
      ? record["message"]
      : typeof record?.["error"] === "string"
        ? record["error"]
        : typeof body === "string"
          ? body
          : null;
  if (text === null || text.trim().length === 0 || /<[a-z!/]/i.test(text)) return null;
  return text.trim().slice(0, 300);
}

export function makeRemoteDaemonClient(deps: RemoteDaemonClientDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sessions = new Map<number, CachedSession>();
  const pairing = new Map<number, Promise<CachedSession>>();

  const pair = async (boxId: number, computerName: string): Promise<CachedSession> => {
    const controlPlane = deps.controlPlane;
    if (controlPlane === null || deps.keyKind === "none") {
      throw remoteError(
        "not_linked",
        "This computer isn't signed in to an Uno account, so it can't reach your other computers.",
      );
    }
    const label = deps.sessionLabel
      ? await deps.sessionLabel().then(
          (name) => `Uno on ${name}`.slice(0, 60),
          () => null,
        )
      : null;
    let raw: unknown;
    try {
      raw = await retryWhileWorkMachineStarts(
        () =>
          controlPlane(`/api/v1/boxes/${boxId}/work/session`, {
            method: "POST",
            body: JSON.stringify(label === null ? {} : { label }),
          }),
        deps.sleep ? { sleep: deps.sleep, now } : { now },
      );
    } catch (cause) {
      throw pairingFailure(cause, { computerName, keyKind: deps.keyKind });
    }
    const connection = parseUnoBoxConnection(raw, boxId);
    const target = connection === null ? null : pairingTargetFromUrl(connection.url);
    if (target === null) {
      throw remoteError(
        "starting",
        `${computerName} isn't ready to take chats yet. Try again in a minute.`,
      );
    }
    const reply = await send(target.httpBaseUrl, "POST", "/api/auth/bootstrap/bearer", null, {
      credential: target.credential,
    });
    const body = asRecord(reply.body);
    const token = typeof body?.["sessionToken"] === "string" ? body["sessionToken"] : "";
    if (reply.status !== 200 || token.length === 0) {
      throw remoteError(
        "refused",
        `${computerName} didn't accept the connection (HTTP ${reply.status}). Try again in a minute.`,
        reply.status,
      );
    }
    const expiresAt =
      typeof body?.["expiresAt"] === "string" ? Date.parse(body["expiresAt"]) : Number.NaN;
    const session: CachedSession = {
      baseUrl: target.httpBaseUrl,
      token,
      expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : now() + DEFAULT_SESSION_TTL_MS,
    };
    sessions.set(boxId, session);
    return session;
  };

  /** One pairing at a time per computer: two chats started at once share it. */
  const sessionFor = (boxId: number, computerName: string): Promise<CachedSession> => {
    const cached = sessions.get(boxId);
    if (cached !== undefined && cached.expiresAtMs - SESSION_REFRESH_MARGIN_MS > now()) {
      return Promise.resolve(cached);
    }
    const inflight = pairing.get(boxId);
    if (inflight !== undefined) return inflight;
    const next = pair(boxId, computerName).finally(() => pairing.delete(boxId));
    pairing.set(boxId, next);
    return next;
  };

  async function send(
    baseUrl: string,
    method: "GET" | "POST",
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<RemoteDaemonReply> {
    let response: Response;
    try {
      response = await doFetch(new URL(path, baseUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { status: 0, body: null };
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // plain-text answer
    }
    return { status: response.status, body: parsed };
  }

  /**
   * One request to the other computer's daemon as its owner. Unreachable
   * (no answer, 502–504) and 401 (a session the daemon forgot — it
   * restarted) are retried once with a fresh pairing.
   */
  const request = async (input: {
    readonly boxId: number;
    readonly computerName: string;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
  }): Promise<RemoteDaemonReply> => {
    for (let attempt = 0; ; attempt += 1) {
      const session = await sessionFor(input.boxId, input.computerName);
      const reply = await send(
        session.baseUrl,
        input.method,
        input.path,
        session.token,
        input.body,
      );
      const retryable = reply.status === 401 || reply.status === 0 || reply.status >= 502;
      if (!retryable || attempt >= 1) {
        if (reply.status === 0 || reply.status >= 502) {
          throw remoteError(
            "unreachable",
            `Can't reach ${input.computerName} right now. It may be waking up — try again in a minute.`,
            reply.status === 0 ? null : reply.status,
          );
        }
        return reply;
      }
      sessions.delete(input.boxId);
    }
  };

  return {
    request,
    /** Drop what is cached for a computer (tests, a deleted computer). */
    forget: (boxId: number) => {
      sessions.delete(boxId);
    },
  };
}

export type RemoteDaemonClient = ReturnType<typeof makeRemoteDaemonClient>;

/** Re-exported for tests that fake the console. */
export { ControlPlaneHttpError };

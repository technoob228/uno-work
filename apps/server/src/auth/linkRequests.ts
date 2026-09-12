/**
 * In-memory state machine for "use this computer" link requests.
 *
 * pending ──allow──▶ approved ──first poll──▶ consumed
 *    │  └──deny───▶ denied
 *    └──ttl elapsed─▶ expired            (approved also expires if never polled)
 *
 * Deliberately free of Effect so the transitions can be unit-tested with a
 * fake clock. The Effect service in `Layers/LinkRequestService.ts` wraps this
 * store, mints the pairing credential on approval, and fans changes out to
 * the desktop prompt.
 *
 * Nothing here is persisted: a request is worth two minutes, and a daemon
 * restart should simply make the browser ask again.
 */
import type { AuthLinkRequestPending, AuthLinkRequestStatus } from "@t3tools/contracts";
import { DateTime } from "effect";

export interface LinkRequestPairing {
  readonly id: string;
  readonly credential: string;
  readonly label?: string;
  readonly expiresAtMs: number;
}

export interface LinkRequestRecord {
  readonly id: string;
  readonly origin: string;
  readonly label: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly status: AuthLinkRequestStatus;
  /** Only set while `status === "approved"`; cleared once handed out. */
  readonly pairing: LinkRequestPairing | null;
}

export interface LinkRequestPollView {
  readonly id: string;
  readonly status: AuthLinkRequestStatus;
  readonly expiresAtMs: number;
  /** Present exactly once: on the poll that moves approved → consumed. */
  readonly pairing: LinkRequestPairing | null;
}

export type LinkRequestTransitionError =
  | { readonly kind: "not-found" }
  | { readonly kind: "not-pending"; readonly status: AuthLinkRequestStatus };

export type LinkRequestTransition =
  | { readonly ok: true; readonly record: LinkRequestRecord }
  | { readonly ok: false; readonly error: LinkRequestTransitionError };

export interface LinkRequestStoreOptions {
  readonly now: () => number;
  readonly generateId: () => string;
  /** How long a request may wait for a human. Default 2 minutes. */
  readonly ttlMs?: number;
  /**
   * Hard cap on live requests. Anything a browser can create without auth
   * needs a ceiling; beyond it the oldest pending request is expired first.
   */
  readonly maxPending?: number;
}

export const DEFAULT_LINK_REQUEST_TTL_MS = 2 * 60_000;
export const DEFAULT_LINK_REQUEST_MAX_PENDING = 8;

const TERMINAL_STATUSES: ReadonlySet<AuthLinkRequestStatus> = new Set([
  "denied",
  "expired",
  "consumed",
]);

export function isTerminalLinkRequestStatus(status: AuthLinkRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function toPendingLinkRequest(record: LinkRequestRecord): AuthLinkRequestPending {
  return {
    requestId: record.id,
    origin: record.origin,
    label: record.label,
    createdAt: DateTime.makeUnsafe(record.createdAtMs),
    expiresAt: DateTime.makeUnsafe(record.expiresAtMs),
  };
}

export class LinkRequestStore {
  readonly #records = new Map<string, LinkRequestRecord>();
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #ttlMs: number;
  readonly #maxPending: number;

  constructor(options: LinkRequestStoreOptions) {
    this.#now = options.now;
    this.#generateId = options.generateId;
    this.#ttlMs = options.ttlMs ?? DEFAULT_LINK_REQUEST_TTL_MS;
    this.#maxPending = options.maxPending ?? DEFAULT_LINK_REQUEST_MAX_PENDING;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Park a new request. A second request from the same origin supersedes the
   * first (the user clicked again; one prompt is enough), and the pending
   * ceiling evicts the oldest so an abusive tab cannot pile prompts up.
   * Returns the superseded/evicted records so callers can announce them.
   */
  create(input: { readonly origin: string; readonly label: string }): {
    readonly record: LinkRequestRecord;
    readonly expired: ReadonlyArray<LinkRequestRecord>;
  } {
    const expired = [...this.sweep()];
    const now = this.#now();

    for (const record of this.#records.values()) {
      if (record.status === "pending" && record.origin === input.origin) {
        expired.push(this.#transition(record, "expired"));
      }
    }

    const pending = this.listPending();
    for (let index = 0; index <= pending.length - this.#maxPending; index += 1) {
      const oldest = pending[index];
      if (oldest) {
        expired.push(this.#transition(oldest, "expired"));
      }
    }

    const record: LinkRequestRecord = {
      id: this.#generateId(),
      origin: input.origin,
      label: input.label,
      createdAtMs: now,
      expiresAtMs: now + this.#ttlMs,
      status: "pending",
      pairing: null,
    };
    this.#records.set(record.id, record);
    return { record, expired };
  }

  /** Read without side effects; expiry is applied lazily. */
  get(id: string): LinkRequestRecord | null {
    const record = this.#records.get(id);
    if (!record) {
      return null;
    }
    return this.#applyExpiry(record);
  }

  listPending(): ReadonlyArray<LinkRequestRecord> {
    this.sweep();
    return [...this.#records.values()]
      .filter((record) => record.status === "pending")
      .toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  }

  approve(id: string, pairing: LinkRequestPairing): LinkRequestTransition {
    return this.#decide(id, "approved", pairing);
  }

  deny(id: string): LinkRequestTransition {
    return this.#decide(id, "denied", null);
  }

  /**
   * What the browser polls. The credential rides along exactly once: the poll
   * that sees `approved` flips the record to `consumed` and drops the pairing,
   * so a second reader (or a replayed request) gets nothing.
   */
  poll(id: string): LinkRequestPollView | null {
    const record = this.get(id);
    if (!record) {
      return null;
    }
    if (record.status !== "approved") {
      return {
        id: record.id,
        status: record.status,
        expiresAtMs: record.expiresAtMs,
        pairing: null,
      };
    }
    const consumed = this.#transition(record, "consumed");
    return {
      id: consumed.id,
      status: "approved",
      expiresAtMs: consumed.expiresAtMs,
      pairing: record.pairing,
    };
  }

  /**
   * Expire what has timed out and forget terminal records older than one TTL,
   * so the map cannot grow with abandoned requests. Returns newly expired ones.
   */
  sweep(): ReadonlyArray<LinkRequestRecord> {
    const now = this.#now();
    const expired: LinkRequestRecord[] = [];
    const forgotten: string[] = [];
    for (const record of this.#records.values()) {
      const next = this.#applyExpiry(record);
      if (next.status === "expired" && record.status !== "expired") {
        expired.push(next);
      }
      if (isTerminalLinkRequestStatus(next.status) && now - next.expiresAtMs > this.#ttlMs) {
        forgotten.push(next.id);
      }
    }
    for (const id of forgotten) {
      this.#records.delete(id);
    }
    return expired;
  }

  #decide(
    id: string,
    status: "approved" | "denied",
    pairing: LinkRequestPairing | null,
  ): LinkRequestTransition {
    const record = this.get(id);
    if (!record) {
      return { ok: false, error: { kind: "not-found" } };
    }
    if (record.status !== "pending") {
      return { ok: false, error: { kind: "not-pending", status: record.status } };
    }
    return { ok: true, record: this.#transition(record, status, pairing) };
  }

  #applyExpiry(record: LinkRequestRecord): LinkRequestRecord {
    if (isTerminalLinkRequestStatus(record.status)) {
      return record;
    }
    const deadline =
      record.status === "approved" && record.pairing
        ? Math.min(record.expiresAtMs, record.pairing.expiresAtMs)
        : record.expiresAtMs;
    if (this.#now() < deadline) {
      return record;
    }
    return this.#transition(record, "expired");
  }

  #transition(
    record: LinkRequestRecord,
    status: AuthLinkRequestStatus,
    pairing: LinkRequestPairing | null = null,
  ): LinkRequestRecord {
    const next: LinkRequestRecord = { ...record, status, pairing };
    this.#records.set(next.id, next);
    return next;
  }
}

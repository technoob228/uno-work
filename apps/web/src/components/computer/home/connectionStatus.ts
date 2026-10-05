/**
 * The connection to this computer, said quietly in the computer chip (Home's
 * header and the chat header) instead of popping a toast on every dropped
 * socket. 05.10: a tab left open reconnects whenever the person comes back —
 * "Disconnected from …" / "Reconnected to …" popped every time and taught
 * nothing.
 *
 * The rule, one place for it:
 *   - a drop shorter than {@link CONNECTION_GRACE_MS} is not news: the chip
 *     says nothing (the menu line is always the truth);
 *   - then "Reconnecting…", after a minute "Offline — retrying" (or "Offline"
 *     when the device itself has no network) — still quiet;
 *   - only what needs the person turns the dot amber and offers the one
 *     action: no connection for {@link CONNECTION_ATTENTION_MS} → "Retry",
 *     a session that needs signing in again → "Sign in";
 *   - an economy computer resting while the person is away is "Asleep"
 *     (any click wakes it; the menu also has "Wake up"), then "Waking…".
 *
 * Pure and clock-free (`now` comes in) so the rule is tested without timers.
 */

export const CONNECTION_GRACE_MS = 5_000;
export const CONNECTION_OFFLINE_MS = 60_000;
export const CONNECTION_ATTENTION_MS = 3 * 60_000;

export interface ConnectionFacts {
  /**
   * `connected` — live; `first` — still making the first connection;
   * `down` — lost it (or the first one failed).
   */
  readonly link: "connected" | "first" | "down";
  /** When the link went down, or the first attempt began (ms); null when unknown. */
  readonly downSince: number | null;
  /** The device's own network (`navigator.onLine`). */
  readonly networkOnline: boolean;
  /** Economy mode holding the reconnect while the person is away. */
  readonly economy: "sleeping" | "waking" | null;
  /** The saved session on this computer needs the person to sign in again. */
  readonly signInNeeded: boolean;
  readonly now: number;
}

export type ConnectionKind =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "no-network"
  | "lost"
  | "asleep"
  | "waking"
  | "sign-in";

export type ConnectionAction = "retry" | "wake" | "sign-in";

export interface ConnectionStatus {
  readonly kind: ConnectionKind;
  /** Words for the chip; null — say nothing there (it shows On/Asleep as before). */
  readonly chip: string | null;
  /** The one line in the computer menu. */
  readonly line: string;
  /** Needs the person: an amber dot, and the chip speaks even when folded. */
  readonly attention: boolean;
  readonly action: ConnectionAction | null;
}

export const CONNECTED: ConnectionStatus = {
  kind: "connected",
  chip: null,
  line: "Connected",
  attention: false,
  action: null,
};

export const CONNECTION_ACTION_LABEL: Record<ConnectionAction, string> = {
  retry: "Retry",
  wake: "Wake up",
  "sign-in": "Sign in",
};

/** "just now", "40s ago", "1 min ago", "2 h ago", "3 d ago". */
export function agoLabel(sinceMs: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - sinceMs) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function describeConnection(facts: ConnectionFacts): ConnectionStatus {
  if (facts.signInNeeded) {
    return {
      kind: "sign-in",
      chip: "Sign in",
      line: "Sign in again to reach this computer",
      attention: true,
      action: "sign-in",
    };
  }
  if (facts.economy === "waking") {
    return {
      kind: "waking",
      chip: "Waking…",
      line: "Waking up — about a second",
      attention: false,
      action: null,
    };
  }
  if (facts.economy === "sleeping") {
    return {
      kind: "asleep",
      chip: "Asleep",
      line: "Asleep while you're away — any click wakes it",
      attention: false,
      action: "wake",
    };
  }
  if (facts.link === "connected") return CONNECTED;

  // Unknown start of the outage: count it from now, i.e. a fresh short drop.
  const since = facts.downSince ?? facts.now;
  const downFor = Math.max(0, facts.now - since);
  const quietChip = downFor < CONNECTION_GRACE_MS;

  if (facts.link === "first" && downFor < CONNECTION_ATTENTION_MS) {
    return {
      kind: "connecting",
      chip: quietChip ? null : "Connecting…",
      line: "Connecting…",
      attention: false,
      action: null,
    };
  }

  const synced = downFor >= CONNECTION_OFFLINE_MS ? ` · synced ${agoLabel(since, facts.now)}` : "";
  if (!facts.networkOnline) {
    return {
      kind: "no-network",
      chip: quietChip ? null : "Offline",
      line: `Offline — waiting for network${synced}`,
      attention: false,
      action: null,
    };
  }
  if (downFor >= CONNECTION_ATTENTION_MS) {
    return {
      kind: "lost",
      chip: "No connection",
      line: `Can't reach this computer${synced}`,
      attention: true,
      action: "retry",
    };
  }
  if (downFor >= CONNECTION_OFFLINE_MS) {
    return {
      kind: "offline",
      chip: "Offline — retrying",
      line: `Offline — retrying${synced}`,
      attention: false,
      action: "retry",
    };
  }
  return {
    kind: "reconnecting",
    chip: quietChip ? null : "Reconnecting…",
    line: "Reconnecting…",
    attention: false,
    action: null,
  };
}

/** The dot next to the computer's name, when the connection has something to say. */
export const CONNECTION_DOT: Partial<Record<ConnectionKind, string>> = {
  connecting: "animate-pulse bg-muted-foreground/60",
  reconnecting: "animate-pulse bg-muted-foreground/60",
  offline: "bg-muted-foreground/50",
  "no-network": "bg-muted-foreground/50",
  lost: "bg-warning",
  "sign-in": "bg-warning",
  asleep: "bg-info",
  waking: "animate-pulse bg-info",
};

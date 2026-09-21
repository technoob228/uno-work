/**
 * Folding the "Authorized clients" list for people.
 *
 * Every sign-in through app.uno4.work makes the Uno control plane mint a new
 * daemon session on the person's behalf, labelled `proxy` (fishcode
 * `work_proxy.go`, `auth pairing create … --label proxy`). Those sessions are
 * the same person's browsers through the same door, so listing them one per
 * row ("proxy · Owner · Desktop · 10.77.0.1" seventeen times) says nothing.
 * They are shown as one group with a single "Sign out all".
 *
 * The session serving this very tab is never folded — it keeps its own row
 * marked "This device", and "Sign out all" leaves it alone.
 *
 * @module components/settings/clientSessionGroups
 */
import type { ServerClientSessionRecord } from "../../environments/primary/auth";

/** Label the control plane gives the sessions it mints for app.uno4.work. */
export const WORK_PROXY_SESSION_LABEL = "proxy";

export function isWorkProxySession(session: ServerClientSessionRecord): boolean {
  return session.client.label === WORK_PROXY_SESSION_LABEL;
}

export interface ClientSessionGroups {
  /** Rows shown one by one. */
  readonly individual: ReadonlyArray<ServerClientSessionRecord>;
  /** Folded app.uno4.work sessions (never the current one). */
  readonly proxy: ReadonlyArray<ServerClientSessionRecord>;
}

export function groupClientSessions(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
): ClientSessionGroups {
  const individual: ServerClientSessionRecord[] = [];
  const proxy: ServerClientSessionRecord[] = [];
  for (const session of sessions) {
    if (!session.current && isWorkProxySession(session)) proxy.push(session);
    else individual.push(session);
  }
  return { individual, proxy };
}

/** "Browser via app.uno4.work · 17 sessions", the row title for the fold. */
export function describeWorkProxyGroup(count: number): string {
  return `Browser via app.uno4.work · ${count} ${count === 1 ? "session" : "sessions"}`;
}

/** Primary label of a single session row: never the bare word "proxy". */
export function clientSessionPrimaryLabel(session: ServerClientSessionRecord): string {
  if (isWorkProxySession(session)) return "Browser via app.uno4.work";
  return (
    session.client.label ??
    ([session.client.os, session.client.browser].filter(Boolean).join(" · ") || session.subject)
  );
}

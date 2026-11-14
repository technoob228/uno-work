/**
 * Deploy-window requests in the Inbox (Misha 13.11: "approvals of deploys
 * come to me in Telegram and in Uno Work, and I can click them in Uno Work").
 *
 * An agent on a cloud computer asks the console's ops gate for a window to
 * production (`ssh contabo-gate request …`). The console sends the approver
 * Telegram buttons, and Uno Work shows the same request as a card: it polls
 * `GET /api/v1/ops-gate/inbox` with the person's own account session (not the
 * computer's daemon — the daemon is the agent's).
 *
 * What a card can do, and why:
 * - Отказать, Закрыть сейчас, Заморозить всё — straight from the card: they
 *   only ever keep agents out of production, so whoever can press them may;
 * - Открыть на N мин — never from here. It opens the gate page the console
 *   serves itself (gate.uno4.work) in the system browser, which asks for
 *   Touch ID (a passkey bound to that address). The page this card lives in
 *   may come from the very computer that asks, so it can't be the one to say
 *   yes. Back-end: fishcode knowledge/ops-gate.md «Из Uno Work».
 *
 * Pure: parsing the console's answer and what each card shows.
 */

export type DeployRequestStatus = "requested" | "approved" | "denied" | "expired" | "closed";

export interface DeployRequest {
  readonly id: number;
  readonly machine: string;
  readonly summary: string;
  readonly minutes: number;
  readonly status: DeployRequestStatus;
  readonly createdAt: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string;
  readonly expiresAt: string | null;
  readonly closedAt: string | null;
  readonly closedReason: string;
  readonly via: string;
  /** The console's own one line about it, the same as in Telegram. */
  readonly statusLine: string;
  /** The Touch ID page for "open" — only while it waits. */
  readonly approveUrl: string | null;
}

export interface DeployApprovals {
  /** The signed-in person approves deploy windows (admin in TEAM_APPROVERS). */
  readonly approver: boolean;
  readonly frozen: boolean;
  /** The console serves the Touch ID page (OPS_GATE_WEB_HOST is set). */
  readonly web: boolean;
  /** Passkeys this person has bound to it. */
  readonly passkeys: number;
  readonly requests: ReadonlyArray<DeployRequest>;
}

export const NOT_AN_APPROVER: DeployApprovals = {
  approver: false,
  frozen: false,
  web: false,
  passkeys: 0,
  requests: [],
};

const STATUSES: ReadonlySet<string> = new Set([
  "requested",
  "approved",
  "denied",
  "expired",
  "closed",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseRequest(raw: unknown): DeployRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  const status = str(r.status);
  if (!STATUSES.has(status)) return null;
  const minutes = typeof r.minutes === "number" && r.minutes > 0 ? Math.round(r.minutes) : 0;
  return {
    id,
    machine: str(r.machine),
    summary: str(r.summary),
    minutes,
    status: status as DeployRequestStatus,
    createdAt: strOrNull(r.created_at),
    decidedAt: strOrNull(r.decided_at),
    decidedBy: str(r.decided_by),
    expiresAt: strOrNull(r.expires_at),
    closedAt: strOrNull(r.closed_at),
    closedReason: str(r.closed_reason),
    via: str(r.via),
    statusLine: str(r.status_line),
    approveUrl: status === "requested" ? safeApproveUrl(r.approve_url) : null,
  };
}

/** The console's `GET /api/v1/ops-gate/inbox` → what the Inbox shows. */
export function parseDeployApprovals(raw: unknown): DeployApprovals {
  if (!raw || typeof raw !== "object") return NOT_AN_APPROVER;
  const r = raw as Record<string, unknown>;
  if (r.approver !== true) return NOT_AN_APPROVER;
  const list = Array.isArray(r.requests) ? r.requests : [];
  const requests = list.map(parseRequest).filter((q): q is DeployRequest => q !== null);
  return {
    approver: true,
    frozen: r.frozen === true,
    web: r.web === true,
    passkeys: typeof r.passkeys === "number" && r.passkeys > 0 ? r.passkeys : 0,
    requests: requests.toSorted((a, b) => b.id - a.id),
  };
}

/**
 * Only an https address of the console's gate page opens from a card
 * (`https://<host>/r/<id>`); anything else is dropped, never opened.
 */
export function safeApproveUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!/^\/r\/\d{1,12}$/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type DeployCardAction = "open" | "deny" | "close";

export interface DeployCardView {
  readonly key: string;
  readonly tone: "waiting" | "open" | "done";
  readonly title: string;
  readonly summary: string;
  readonly meta: string;
  readonly actions: ReadonlyArray<DeployCardAction>;
  /** "Открыть на N мин". */
  readonly openLabel: string;
}

function minutesWord(n: number): string {
  return `${n} мин`;
}

/** Minutes left in an open window, rounded up; 0 — it's over. */
export function minutesLeft(expiresAt: string | null, nowMs: number): number {
  if (!expiresAt) return 0;
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - nowMs) / 60_000));
}

export function isOpenWindow(request: DeployRequest, nowMs: number): boolean {
  return request.status === "approved" && minutesLeft(request.expiresAt, nowMs) > 0;
}

/** One card: what is shipped, by whom, for how long, and what can be pressed. */
export function deployCardView(
  request: DeployRequest,
  nowMs: number,
  gate: Pick<DeployApprovals, "web" | "passkeys" | "frozen">,
): DeployCardView {
  const machine = request.machine || "машина";
  const summary = request.summary || "без описания";
  const base = { key: `ops-gate:${request.id}`, summary, openLabel: "" };
  if (request.status === "requested") {
    const canOpen = gate.web && gate.passkeys > 0 && !gate.frozen && request.approveUrl !== null;
    return {
      ...base,
      tone: "waiting",
      title: `${machine} просит окно в прод`,
      meta: `на ${minutesWord(request.minutes)} · запрос #${request.id}`,
      actions: canOpen ? ["open", "deny"] : ["deny"],
      openLabel: `Открыть на ${minutesWord(request.minutes)}`,
    };
  }
  if (isOpenWindow(request, nowMs)) {
    const left = minutesLeft(request.expiresAt, nowMs);
    const who = request.decidedBy ? ` · открыл ${request.decidedBy}` : "";
    return {
      ...base,
      tone: "open",
      title: `Окно в прод открыто: ${machine}`,
      meta: `осталось ${minutesWord(left)}${who} · запрос #${request.id}`,
      actions: ["close"],
    };
  }
  return {
    ...base,
    tone: "done",
    title: machine,
    meta: request.statusLine || `запрос #${request.id}`,
    actions: [],
  };
}

/** Why "Открыть" is missing from a waiting card, in a sentence; null — it's there. */
export function openUnavailableHint(gate: DeployApprovals): string | null {
  if (!gate.approver) return null;
  if (!gate.requests.some((q) => q.status === "requested")) return null;
  if (gate.frozen) return "Всё заморожено: открыть окно нельзя. Разморозить — пульт в Telegram.";
  if (!gate.web) return "Открыть окно отсюда пока нельзя — только кнопкой в Telegram.";
  if (gate.passkeys === 0) {
    return "Чтобы открывать окна отсюда, привяжите Touch ID: пульт в Telegram → «🔑 Touch ID для Uno Work».";
  }
  return null;
}

/** Requests that wait for a decision (the badge). */
export function waitingCount(gate: DeployApprovals | null): number {
  if (!gate?.approver) return 0;
  return gate.requests.filter((q) => q.status === "requested").length;
}

/** Cards worth showing: waiting, open windows, then the last few decided. */
export function visibleRequests(
  gate: DeployApprovals | null,
  nowMs: number,
  maxDone = 3,
): ReadonlyArray<DeployRequest> {
  if (!gate?.approver) return [];
  const live = gate.requests.filter((q) => q.status === "requested" || isOpenWindow(q, nowMs));
  const done = gate.requests
    .filter((q) => q.status !== "requested" && !isOpenWindow(q, nowMs))
    .slice(0, maxDone);
  return [...live, ...done];
}

/** Requests that started waiting since the last answer (a system notification each). */
export function newlyWaiting(
  previous: DeployApprovals | null,
  next: DeployApprovals,
): ReadonlyArray<DeployRequest> {
  if (!previous?.approver) return [];
  const seen = new Set(previous.requests.filter((q) => q.status === "requested").map((q) => q.id));
  return next.requests.filter((q) => q.status === "requested" && !seen.has(q.id));
}

/** The console's 409 `{ok:false, message}` (someone already decided) → its message. */
export function conflictMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const message = (body as Record<string, unknown>).message;
  return typeof message === "string" && message !== "" ? message : null;
}

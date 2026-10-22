/**
 * "Email for your AI" as Settings → Connectors sees it: a thin client over
 * the console's `/api/v1/work/mail` (spec reports/day_2026-10-20/agent-mail/
 * SPEC.md), called with this computer's work-machine token. The mailbox
 * itself (letters, sending) is the agents' business, through the `uno-work`
 * MCP tools (`unoWork/mailTools.ts`); the interface only shows the address
 * and lets the person rename it.
 *
 * Pure (fetch injected) so it is unit-testable; `AgentMailService.ts` binds
 * it to the settings.
 *
 * @module setupTools/agentMail
 */
import { ConnectorsError, NOT_CLOUD_COMPUTER } from "./connectors.ts";

export const AGENT_MAIL_CONSOLE_PATH = "/api/v1/work/mail";

export type AgentMailUnavailableReason =
  /** The account's `AGENT_MAIL` flag is off. */
  | "not_enabled"
  /** Not an Uno cloud computer: no machine token, no mailbox. */
  | "not_cloud_computer"
  | "console_unreachable"
  /** A console from before agent mail. */
  | "not_configured";

export interface AgentMailbox {
  readonly address: string;
  readonly local: string;
  readonly createdAt: string | null;
  readonly dailyLimit: number | null;
  readonly sentToday: number | null;
}

/** `GET /api/manager/mail`. Hidden in the interface unless `available`. */
export interface AgentMailState {
  readonly available: boolean;
  readonly reason: AgentMailUnavailableReason | null;
  readonly mailbox: AgentMailbox | null;
}

export interface AgentMailClientDeps {
  /** The machine token, or null off a cloud computer. Read on every call. */
  readonly token: () => Promise<string | null>;
  readonly baseUrl: () => string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export interface AgentMailClient {
  /** Never throws: an unreachable console is an answer. */
  readonly status: () => Promise<AgentMailState>;
  /** The new address; a `ConnectorsError` with a sentence the person can read otherwise. */
  readonly changeAddress: (local: string) => Promise<{ readonly address: string }>;
}

const unavailable = (reason: AgentMailUnavailableReason): AgentMailState => ({
  available: false,
  reason,
  mailbox: null,
});

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The console's `{available, reason, mailbox}` → the daemon's answer. */
export function parseAgentMailState(raw: unknown): AgentMailState {
  if (raw === null || typeof raw !== "object") return unavailable("console_unreachable");
  const record = raw as Record<string, unknown>;
  if (record.available !== true) {
    return unavailable(record.reason === "not_enabled" ? "not_enabled" : "not_configured");
  }
  const mailbox =
    record.mailbox !== null && typeof record.mailbox === "object"
      ? (record.mailbox as Record<string, unknown>)
      : null;
  const address = typeof mailbox?.address === "string" ? mailbox.address.trim() : "";
  if (!mailbox || !address.includes("@")) return unavailable("console_unreachable");
  const limits =
    mailbox.limits !== null && typeof mailbox.limits === "object"
      ? (mailbox.limits as Record<string, unknown>)
      : {};
  return {
    available: true,
    reason: null,
    mailbox: {
      address,
      local:
        typeof mailbox.local === "string" && mailbox.local.length > 0
          ? mailbox.local
          : address.slice(0, address.indexOf("@")),
      createdAt: typeof mailbox.created_at === "string" ? mailbox.created_at : null,
      dailyLimit: numberOrNull(limits.daily_per_mailbox),
      sentToday: numberOrNull(limits.sent_today),
    },
  };
}

/** The console's sentence from an error body, if there is one. */
function consoleMessage(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export const ADDRESS_TAKEN_MESSAGE = "This name is taken. Try another one.";

export function makeAgentMailClient(deps: AgentMailClientDeps): AgentMailClient {
  const fetchImpl = deps.fetch ?? fetch;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;

  const request = async (
    token: string,
    method: "GET" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetchImpl(`${deps.baseUrl()}${AGENT_MAIL_CONSOLE_PATH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };

  const currentToken = async () => {
    const token = (await deps.token().catch(() => null))?.trim() ?? "";
    return token.length > 0 ? token : null;
  };

  const status: AgentMailClient["status"] = async () => {
    const token = await currentToken();
    if (token === null) return unavailable(NOT_CLOUD_COMPUTER);
    try {
      const reply = await request(token, "GET", "");
      // 404 = a console from before agent mail: nothing to show.
      if (reply.status === 404) return unavailable("not_configured");
      if (reply.status < 200 || reply.status >= 300) return unavailable("console_unreachable");
      return parseAgentMailState(reply.body);
    } catch {
      return unavailable("console_unreachable");
    }
  };

  const changeAddress: AgentMailClient["changeAddress"] = async (local) => {
    const token = await currentToken();
    if (token === null) {
      throw new ConnectorsError(
        409,
        NOT_CLOUD_COMPUTER,
        "Email for your AI works on an Uno cloud computer.",
      );
    }
    let reply: { status: number; body: unknown };
    try {
      reply = await request(token, "PUT", "/address", { local });
    } catch (cause) {
      throw new ConnectorsError(
        502,
        "console_unreachable",
        `Couldn't reach the Uno console: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const record =
      reply.body !== null && typeof reply.body === "object"
        ? (reply.body as Record<string, unknown>)
        : {};
    if (reply.status >= 200 && reply.status < 300) {
      const address = typeof record.address === "string" ? record.address : "";
      if (!address.includes("@")) {
        throw new ConnectorsError(502, "console_error", "The console didn't return the address.");
      }
      return { address };
    }
    const message = consoleMessage(reply.body);
    if (reply.status === 409 || record.error === "taken") {
      throw new ConnectorsError(409, "taken", ADDRESS_TAKEN_MESSAGE);
    }
    if (reply.status === 422 || record.error === "invalid") {
      throw new ConnectorsError(
        422,
        "invalid",
        message || "This name can't be used. Use 3–40 lowercase letters, digits, dots or dashes.",
      );
    }
    if (reply.status === 429) {
      throw new ConnectorsError(429, "rate_limited", message || "Too many changes. Try later.");
    }
    if (record.error === "not_enabled" || reply.status === 404) {
      throw new ConnectorsError(
        503,
        "not_enabled",
        "Email for your AI isn't switched on for this account yet.",
      );
    }
    throw new ConnectorsError(
      502,
      "console_error",
      message || `The console couldn't change the address (HTTP ${reply.status}).`,
    );
  };

  return { status, changeAddress };
}

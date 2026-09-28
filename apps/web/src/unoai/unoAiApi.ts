/**
 * Uno AI in Uno Work — the chats that don't need a computer (fishcode
 * `back/knowledge/ai-chats.md`, "Uno Work без компьютера").
 *
 * The chat runs on the server: Work sends the person's message
 * (`POST /api/v1/ai/chats/{id}/turn`) and polls the turn's progress
 * (`GET …/live?after=N`) — the same history as the console's /ask, one list.
 * Polling instead of a stream on purpose: the desktop reaches the account API
 * over IPC (no streaming), and a phone browser that goes to the background
 * must not kill the turn — it keeps running on the server.
 */
import { ControlPlaneHttpError } from "@t3tools/shared/unoCloud";

import { accountRequest, accountTransport } from "../account/unoAccount";

export interface AiToolCall {
  readonly id: string;
  readonly type?: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface AiChatMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<AiToolCall>;
  readonly tool_call_id?: string;
}

export interface AiSite {
  readonly slug: string;
  readonly url: string;
  readonly title?: string;
}

export interface AiChatSummary {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly message_count: number;
  readonly updated_at: string;
  readonly sites: ReadonlyArray<AiSite> | null;
}

export interface AiStop {
  /** verify | free_empty | hours_empty | busy | error */
  readonly code: string;
  readonly message: string;
}

export interface AiLive {
  readonly id?: string;
  readonly title?: string;
  readonly running: boolean;
  readonly message_count: number;
  readonly messages: ReadonlyArray<AiChatMessage>;
  readonly live: {
    readonly text: string;
    readonly tool: string;
    readonly chars: number;
    readonly elapsed_s: number;
  } | null;
  readonly stop: AiStop | null;
  readonly sites: ReadonlyArray<AiSite> | null;
}

export interface AiMeter {
  readonly mode: "hours" | "free" | "balance";
  readonly hours: {
    readonly minutes_left: number;
    readonly unlimited: boolean;
    readonly renews_at: string | null;
  } | null;
  readonly free?: {
    readonly minutes_left: number;
    readonly daily_minutes: number;
    readonly verified: boolean;
    readonly messages_until_verify: number;
    readonly busy?: boolean;
  } | null;
  readonly premium: {
    readonly limit: boolean;
    readonly left_usd: number;
    readonly monthly_usd: number;
    readonly exhausted: boolean;
  } | null;
  readonly balance_usd: number;
}

/** The account flag of the Uno AI rollout (fishcode migration 171). */
export const WORK_AI_FEATURE = "work_ai";

/** Uno AI chats are reachable: app.uno4.work or the signed-in desktop app. */
export function unoAiAvailable(): boolean {
  return accountTransport() !== "none";
}

export async function listAiChats(): Promise<{
  chats: ReadonlyArray<AiChatSummary>;
  retentionDays: number | null;
}> {
  const body = (await accountRequest("GET", "/api/v1/ai/chats")) as {
    chats?: AiChatSummary[];
    retention_days?: number | null;
  } | null;
  return { chats: body?.chats ?? [], retentionDays: body?.retention_days ?? null };
}

export async function aiChatLive(id: string, after: number): Promise<AiLive | null> {
  try {
    return (await accountRequest(
      "GET",
      `/api/v1/ai/chats/${encodeURIComponent(id)}/live?after=${Math.max(0, Math.floor(after))}`,
    )) as AiLive;
  } catch (error) {
    if (error instanceof ControlPlaneHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function sendAiTurn(
  id: string,
  input: { message?: string; resume?: boolean },
): Promise<{ running: boolean; message_count: number }> {
  return (await accountRequest("POST", `/api/v1/ai/chats/${encodeURIComponent(id)}/turn`, {
    message: input.message ?? "",
    ...(input.resume ? { resume: true } : {}),
  })) as { running: boolean; message_count: number };
}

export async function fetchAiMeter(): Promise<AiMeter> {
  return (await accountRequest("GET", "/api/v1/ai/meter")) as AiMeter;
}

export async function verifyAiEmail(
  code?: string,
): Promise<{ sent?: boolean; verified?: boolean; email?: string }> {
  return (await accountRequest("POST", "/api/v1/ai/verify-email", code ? { code } : {})) as {
    sent?: boolean;
    verified?: boolean;
    email?: string;
  };
}

export async function redeemComputerTrial(code: string): Promise<unknown> {
  return accountRequest("POST", "/api/v1/ai/computer/trial", { code });
}

/** A chat id, chosen here like the console does (unique within the account). */
export function newAiChatId(now = Date.now(), random = Math.random): string {
  return `w${now.toString(36)}${random().toString(36).slice(2, 6)}`;
}

/**
 * The console's error, readable: `{"error":"CODE","detail":"…"}` inside a
 * ControlPlaneHttpError → { code, detail }.
 */
export function accountErrorInfo(error: unknown): { status: number; code: string; detail: string } {
  if (!(error instanceof ControlPlaneHttpError)) {
    return { status: 0, code: "", detail: error instanceof Error ? error.message : String(error) };
  }
  const raw = error.message.replace(/^\d{3}:\s*/, "");
  try {
    const body = JSON.parse(raw) as { error?: unknown; detail?: unknown; message?: unknown };
    const e = body.error;
    const code =
      typeof e === "string"
        ? e
        : e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
          ? String((e as { code: string }).code)
          : "";
    const detail =
      typeof body.detail === "string"
        ? body.detail
        : typeof body.message === "string"
          ? body.message
          : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string"
            ? String((e as { message: string }).message)
            : "";
    return { status: error.status, code, detail };
  } catch {
    return { status: error.status, code: "", detail: raw };
  }
}

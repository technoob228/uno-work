/**
 * "Chats Ana started" on the assistant page (assistants MVP, 0.0.106): the
 * chats this computer's assistant started, where they run, on which model,
 * how they are doing and what each one cost.
 *
 * Where the numbers come from:
 * - which chats — the projection: `assistantRole: "spawned"` (uno-manager
 *   `create_thread` with the assistant's token) or `spawnedByThreadId` of a
 *   chat in an assistant workspace (`chat_create` from the assistant chat);
 * - cost of a Uno AI chat — the gateway, by the chat label `X-Uno-Thread`
 *   (`GET /v1/usage/threads`, behind the console's ASSISTANTS_MVP; the
 *   session-env plugin / per-chat config adds the header);
 * - a chat on the person's Claude / ChatGPT plan costs Uno nothing: tokens
 *   only, from the chat's own usage reports (`context-window.updated`).
 *
 * @module assistants/assistantChats
 */
import {
  isAssistantProjectId,
  type AssistantChatBilling,
  type AssistantChatStatus,
  type AssistantChatSummary,
  type AssistantChatsResult,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";

/** Newest chats first, at most this many (the page shows a week or so). */
export const ASSISTANT_CHATS_LIMIT = 30;

const GATEWAY_TIMEOUT_MS = 5_000;

/** The assistant started it (see module doc). */
export function isAssistantStartedChat(
  thread: Pick<OrchestrationThreadShell, "assistantRole" | "spawnedByThreadId">,
  projectOfThread: (threadId: string) => string | null,
): boolean {
  if (thread.assistantRole === "spawned") return true;
  const parent = thread.spawnedByThreadId ?? null;
  if (parent === null) return false;
  const parentProject = projectOfThread(parent);
  return parentProject !== null && isAssistantProjectId(parentProject);
}

export function chatStatus(
  thread: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session"
  >,
): AssistantChatStatus {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  const turn = thread.latestTurn?.state ?? null;
  const session = thread.session?.status ?? null;
  if (turn === "running" || session === "running" || session === "starting") return "working";
  if (turn === "error" || turn === "interrupted") return "failed";
  return "done";
}

/** The chat's effort / reasoning option (`effort`, `reasoningEffort`), if set. */
export function chatEffort(selection: ModelSelection): string | null {
  const options = selection.options;
  if (!Array.isArray(options)) return null;
  for (const option of options as ReadonlyArray<{ id?: unknown; value?: unknown }>) {
    if (
      (option.id === "effort" || option.id === "reasoningEffort") &&
      typeof option.value === "string" &&
      option.value.length > 0
    ) {
      return option.value;
    }
  }
  return null;
}

export function billingForDriver(driver: string | null): AssistantChatBilling {
  switch (driver) {
    case "uno":
      return "uno-ai";
    case "hermes":
      return "uno-ai-unlabelled";
    case "claudeAgent":
    case "codex":
    case "cursor":
      return "plan";
    default:
      return "other";
  }
}

/**
 * Tokens a chat processed, from its usage reports: the largest report of
 * each turn (reports accumulate within a turn), summed over turns. An
 * estimate — what the harness told us, not a bill.
 */
export function tokensFromActivities(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly turnId: string | null;
    readonly payload: unknown;
  }>,
): number | null {
  const byTurn = new Map<string, number>();
  for (const activity of activities) {
    if (activity.kind !== "context-window.updated") continue;
    const payload = activity.payload as
      | { totalProcessedTokens?: unknown; usedTokens?: unknown }
      | null
      | undefined;
    const raw = payload?.totalProcessedTokens ?? payload?.usedTokens;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    const key = activity.turnId ?? "";
    byTurn.set(key, Math.max(byTurn.get(key) ?? 0, Math.round(raw)));
  }
  if (byTurn.size === 0) return null;
  let total = 0;
  for (const value of byTurn.values()) total += value;
  return total;
}

export interface GatewayThreadUsage {
  readonly thread: string;
  readonly costUsd: number;
  readonly requests: number;
  readonly aiHoursRequests: number;
  readonly tokens: number;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Rows of `GET /v1/usage/threads`; null when the body isn't that shape. */
export function parseGatewayThreadUsage(body: unknown): ReadonlyArray<GatewayThreadUsage> | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const rows: GatewayThreadUsage[] = [];
  for (const row of data as ReadonlyArray<Record<string, unknown>>) {
    if (typeof row?.["thread"] !== "string") continue;
    rows.push({
      thread: row["thread"],
      costUsd: num(row["cost_usd"]),
      requests: num(row["requests"]),
      aiHoursRequests: num(row["ai_hours_requests"]),
      tokens: num(row["input_tokens"]) + num(row["output_tokens"]),
    });
  }
  return rows;
}

export type GatewayUsageAnswer =
  | { readonly status: "metered"; readonly rows: ReadonlyArray<GatewayThreadUsage> }
  | { readonly status: "unavailable" | "no-key" | "unknown" };

/** Asks the gateway what these chats cost, with this computer's key. Never throws. */
export async function fetchGatewayThreadUsage(input: {
  readonly gateway: { readonly baseUrl: string; readonly key: string } | null;
  readonly threadIds: ReadonlyArray<string>;
  readonly fetchImpl?: typeof fetch;
}): Promise<GatewayUsageAnswer> {
  if (!input.gateway) return { status: "no-key" };
  if (input.threadIds.length === 0) return { status: "metered", rows: [] };
  try {
    const url = `${input.gateway.baseUrl.replace(/\/+$/, "")}/usage/threads?ids=${input.threadIds
      .map(encodeURIComponent)
      .join(",")}`;
    const response = await (input.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${input.gateway.key}` },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405) return { status: "unavailable" };
    if (!response.ok) return { status: "unknown" };
    const rows = parseGatewayThreadUsage(await response.json().catch(() => null));
    return rows === null ? { status: "unknown" } : { status: "metered", rows };
  } catch {
    return { status: "unknown" };
  }
}

/** The chats the assistant started, newest first, without usage yet. */
export function selectAssistantChats(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly limit?: number;
}): ReadonlyArray<OrchestrationThreadShell> {
  const projectOf = new Map(input.threads.map((thread) => [thread.id as string, thread.projectId]));
  return input.threads
    .filter((thread) => isAssistantStartedChat(thread, (id) => projectOf.get(id) ?? null))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, input.limit ?? ASSISTANT_CHATS_LIMIT);
}

export function buildAssistantChats(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Tokens per chat from its own usage reports. */
  readonly localTokens: ReadonlyMap<string, number | null>;
  readonly gateway: GatewayUsageAnswer;
}): AssistantChatsResult {
  const projectTitle = new Map(
    input.projects.map((project) => [project.id as string, project.title]),
  );
  const providerOf = new Map(
    input.providers.map((provider) => [provider.instanceId as string, provider]),
  );
  const usage =
    input.gateway.status === "metered"
      ? new Map(input.gateway.rows.map((row) => [row.thread, row]))
      : new Map<string, GatewayThreadUsage>();
  const chats: AssistantChatSummary[] = input.threads.map((thread) => {
    const provider = providerOf.get(thread.modelSelection.instanceId) ?? null;
    const billing = billingForDriver(provider?.driver ?? thread.modelSelection.instanceId);
    const priced = billing === "uno-ai" && input.gateway.status === "metered";
    const row = usage.get(thread.id) ?? null;
    const local = input.localTokens.get(thread.id) ?? null;
    return {
      threadId: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      projectTitle: projectTitle.get(thread.projectId) ?? "",
      instanceId: thread.modelSelection.instanceId,
      harness: provider?.displayName ?? thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      effort: chatEffort(thread.modelSelection),
      status: chatStatus(thread),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      billing,
      tokens: row && row.tokens > 0 ? row.tokens : local,
      // A metered Uno AI chat with no gateway rows yet cost nothing so far.
      costUsd: priced ? (row?.costUsd ?? 0) : null,
      aiHoursRequests: priced ? (row?.aiHoursRequests ?? 0) : null,
    };
  });
  return { chats, gateway: input.gateway.status };
}

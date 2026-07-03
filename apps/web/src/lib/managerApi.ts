/**
 * Thin client for the daemon's owner-facing manager routes
 * (`/api/manager/*`). Uses same-origin fetch with the session cookie — the
 * app is served by (or dev-proxied to) the environment daemon, so relative
 * URLs hit the right backend.
 */
import type {
  AssistantEditableFileName,
  ManagerActionProposal,
  ManagerAssistantSummary,
  ManagerCapabilityTokenDescriptor,
  ManagerCreateTokenInput,
  ManagerCreateTokenResult,
  ManagerProposalDecision,
  ManagerProposalId,
  ManagerTelegramConnectorStatus,
  ManagerTokenId,
  ProjectId,
} from "@t3tools/contracts";

export class ManagerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ManagerApiError";
  }
}

async function managerFetch<T>(input: {
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
}): Promise<T> {
  const response = await fetch(input.pathname, {
    method: input.method ?? "GET",
    credentials: "include",
    headers: input.body !== undefined ? { "content-type": "application/json" } : {},
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  if (!response.ok) {
    let detail = `Request failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (typeof payload.error === "string") detail = payload.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new ManagerApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export function listManagerProposals(): Promise<{
  proposals: ReadonlyArray<ManagerActionProposal>;
}> {
  return managerFetch({ pathname: "/api/manager/proposals" });
}

export function resolveManagerProposal(input: {
  readonly proposalId: ManagerProposalId;
  readonly decision: ManagerProposalDecision;
}): Promise<{ proposal: ManagerActionProposal }> {
  return managerFetch({
    pathname: "/api/manager/proposals/resolve",
    method: "POST",
    body: input,
  });
}

export function listManagerTokens(): Promise<{
  tokens: ReadonlyArray<ManagerCapabilityTokenDescriptor>;
}> {
  return managerFetch({ pathname: "/api/manager/tokens" });
}

export function createManagerToken(input: ManagerCreateTokenInput): Promise<ManagerCreateTokenResult> {
  return managerFetch({ pathname: "/api/manager/tokens", method: "POST", body: input });
}

export function revokeManagerToken(tokenId: ManagerTokenId): Promise<{ revoked: boolean }> {
  return managerFetch({
    pathname: "/api/manager/tokens/revoke",
    method: "POST",
    body: { tokenId },
  });
}

export function listAssistants(): Promise<{ assistants: ReadonlyArray<ManagerAssistantSummary> }> {
  return managerFetch({ pathname: "/api/manager/assistants" });
}

export function createAssistant(name: string): Promise<{ projectId: ProjectId }> {
  return managerFetch({ pathname: "/api/manager/assistants", method: "POST", body: { name } });
}

export function getAssistant(projectId: string): Promise<ManagerAssistantSummary> {
  return managerFetch({
    pathname: `/api/manager/assistant?projectId=${encodeURIComponent(projectId)}`,
  });
}

export function updateAssistantAccess(input: {
  readonly projectId: string;
  readonly projectAllowlist: "all" | ReadonlyArray<string>;
  readonly scopes?: ReadonlyArray<string>;
  readonly autoApprove?: boolean;
}): Promise<{ token: ManagerCapabilityTokenDescriptor | null }> {
  return managerFetch({ pathname: "/api/manager/assistant/access", method: "POST", body: input });
}

export function saveAssistantTelegram(input: {
  readonly projectId: string;
  readonly botToken?: string;
  readonly allowedChatIds: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly defaultModelSelection?: { instanceId: string; model: string } | null;
}): Promise<{ telegram: ManagerTelegramConnectorStatus }> {
  return managerFetch({
    pathname: "/api/manager/assistant/telegram",
    method: "POST",
    body: input,
  });
}

export function readAssistantFile(input: {
  readonly projectId: string;
  readonly name: AssistantEditableFileName;
}): Promise<{ content: string }> {
  return managerFetch({
    pathname: `/api/manager/assistant/file?projectId=${encodeURIComponent(input.projectId)}&name=${encodeURIComponent(input.name)}`,
  });
}

export function writeAssistantFile(input: {
  readonly projectId: string;
  readonly name: AssistantEditableFileName;
  readonly content: string;
}): Promise<{ saved: boolean }> {
  return managerFetch({ pathname: "/api/manager/assistant/file", method: "POST", body: input });
}

/** Compact project list for the access picker (owner snapshot route). */
export async function listProjectsForAccessPicker(): Promise<
  ReadonlyArray<{ id: ProjectId; title: string }>
> {
  const snapshot = await managerFetch<{
    projects: ReadonlyArray<{ id: ProjectId; title: string }>;
  }>({ pathname: "/api/orchestration/snapshot" });
  return snapshot.projects.map((project) => ({ id: project.id, title: project.title }));
}

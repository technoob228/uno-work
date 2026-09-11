/**
 * Client for a daemon's owner-facing manager routes (`/api/manager/*`).
 *
 * Every call names the environment it addresses. Assistants live on a
 * specific daemon and project ids are not unique across daemons, so an
 * un-targeted call is ambiguous by construction: it used to mean "whichever
 * backend serves this page", which on a desktop client viewing a remote
 * environment is the wrong machine. Routing goes through
 * {@link environmentFetchJson}, which resolves the target from the id and
 * fails rather than falling back.
 */
import type {
  AssistantEditableFileName,
  EnvironmentId,
  ManagerActionProposal,
  ManagerAssistantSummary,
  ManagerCapabilityTokenDescriptor,
  ManagerConnectorBindingKind,
  ManagerConnectorBindingTarget,
  ManagerConnectorBindingView,
  ManagerCreateTokenInput,
  ManagerCreateTokenResult,
  ManagerProposalDecision,
  ManagerProposalId,
  ManagerSlackConnectorStatus,
  ManagerTelegramConnectorStatus,
  ManagerTokenId,
  ProjectId,
} from "@t3tools/contracts";

import { environmentFetchJson } from "~/environments/http/target";

export {
  EnvironmentHttpError as ManagerApiError,
  isEnvironmentHttpError as isManagerApiError,
  isEnvironmentUnavailableError,
} from "~/environments/http/target";

/** Common head of every manager request: which daemon is being addressed. */
interface EnvironmentScoped {
  readonly environmentId: EnvironmentId;
}

interface ConnectorAddressing {
  readonly names: ReadonlyArray<string>;
  readonly requireMentionInGroups: boolean;
  readonly smartWake: boolean;
  readonly hotWindowSec: number;
}

export function listManagerProposals(input: EnvironmentScoped): Promise<{
  proposals: ReadonlyArray<ManagerActionProposal>;
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/proposals",
  });
}

export function resolveManagerProposal(
  input: EnvironmentScoped & {
    readonly proposalId: ManagerProposalId;
    readonly decision: ManagerProposalDecision;
  },
): Promise<{ proposal: ManagerActionProposal }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/proposals/resolve",
    method: "POST",
    body: { proposalId: input.proposalId, decision: input.decision },
  });
}

export function listManagerTokens(input: EnvironmentScoped): Promise<{
  tokens: ReadonlyArray<ManagerCapabilityTokenDescriptor>;
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/tokens",
  });
}

export function createManagerToken(
  input: EnvironmentScoped & { readonly token: ManagerCreateTokenInput },
): Promise<ManagerCreateTokenResult> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/tokens",
    method: "POST",
    body: input.token,
  });
}

export function revokeManagerToken(
  input: EnvironmentScoped & { readonly tokenId: ManagerTokenId },
): Promise<{ revoked: boolean }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/tokens/revoke",
    method: "POST",
    body: { tokenId: input.tokenId },
  });
}

export function listAssistants(input: EnvironmentScoped): Promise<{
  assistants: ReadonlyArray<ManagerAssistantSummary>;
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistants",
  });
}

export function createAssistant(
  input: EnvironmentScoped & { readonly name: string },
): Promise<{ projectId: ProjectId }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistants",
    method: "POST",
    body: { name: input.name },
  });
}

export function getAssistant(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<ManagerAssistantSummary> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant",
    searchParams: { projectId: input.projectId },
  });
}

export function updateAssistantAccess(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly projectAllowlist: "all" | ReadonlyArray<string>;
    readonly scopes?: ReadonlyArray<string>;
    readonly autoApprove?: boolean;
  },
): Promise<{ token: ManagerCapabilityTokenDescriptor | null }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/access",
    method: "POST",
    body,
  });
}

export function saveAssistantTelegram(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly botToken?: string;
    readonly allowedChatIds: ReadonlyArray<string>;
    readonly enabled: boolean;
    readonly defaultModelSelection?: { instanceId: string; model: string } | null;
    readonly addressing?: ConnectorAddressing;
  },
): Promise<{ telegram: ManagerTelegramConnectorStatus }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/telegram",
    method: "POST",
    body,
  });
}

export function saveAssistantSlack(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly botToken?: string;
    readonly appToken?: string;
    readonly allowedChannelIds: ReadonlyArray<string>;
    readonly enabled: boolean;
    readonly defaultModelSelection?: { instanceId: string; model: string } | null;
    readonly addressing?: ConnectorAddressing;
  },
): Promise<{ slack: ManagerSlackConnectorStatus }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/slack",
    method: "POST",
    body,
  });
}

export function readAssistantFile(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly name: AssistantEditableFileName;
  },
): Promise<{ content: string }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/file",
    searchParams: { projectId: input.projectId, name: input.name },
  });
}

export function writeAssistantFile(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly name: AssistantEditableFileName;
    readonly content: string;
  },
): Promise<{ saved: boolean }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/file",
    method: "POST",
    body,
  });
}

/** Chat → target bindings of the chats carried by this assistant's connectors. */
export function listConnectorBindings(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{ bindings: ReadonlyArray<ManagerConnectorBindingView> }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/connector-bindings",
    searchParams: { projectId: input.projectId },
  });
}

export function upsertConnectorBinding(
  input: EnvironmentScoped & {
    readonly kind: ManagerConnectorBindingKind;
    readonly chatId: string;
    readonly connectorProjectId: string;
    readonly target: ManagerConnectorBindingTarget;
    readonly notifyOnComplete?: boolean;
  },
): Promise<{ binding: ManagerConnectorBindingView | null }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/connector-bindings",
    method: "POST",
    body,
  });
}

export function removeConnectorBinding(
  input: EnvironmentScoped & {
    readonly kind: ManagerConnectorBindingKind;
    readonly chatId: string;
  },
): Promise<{ removed: boolean }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/connector-bindings/remove",
    method: "POST",
    body,
  });
}

/** Set the assistant project's default model (new chats + Telegram fallback). */
export function setAssistantDefaultModel(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly instanceId: string;
    readonly model: string;
  },
): Promise<{ sequence: number }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/orchestration/dispatch",
    method: "POST",
    body: {
      type: "project.meta.update",
      commandId: `assistant-default-model:${crypto.randomUUID()}`,
      projectId: input.projectId,
      defaultModelSelection: { instanceId: input.instanceId, model: input.model },
    },
  });
}

/** Compact project list for the access picker (owner snapshot route). */
export async function listProjectsForAccessPicker(
  input: EnvironmentScoped,
): Promise<ReadonlyArray<{ id: ProjectId; title: string }>> {
  const snapshot = await environmentFetchJson<{
    projects: ReadonlyArray<{ id: ProjectId; title: string }>;
  }>({
    environmentId: input.environmentId,
    pathname: "/api/orchestration/snapshot",
  });
  return snapshot.projects.map((project) => ({ id: project.id, title: project.title }));
}

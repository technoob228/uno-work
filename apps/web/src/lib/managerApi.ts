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
  AssistantAppAccess,
  AssistantAppLevel,
  AssistantInstructionsStatus,
  AssistantDraftInput,
  AssistantDraftResult,
  AssistantChatsResult,
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
  ManagerDeletedAssistant,
  ManagerProposalDecision,
  ManagerProposalId,
  ManagerSlackConnectorStatus,
  ManagerTelegramConnectorStatus,
  ManagerTokenId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

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

/** A new assistant on that computer (its folder in ~/UnoWork/Assistants). */
export function createAssistant(
  input: EnvironmentScoped & {
    readonly name: string;
    readonly emoji?: string;
    readonly template?: string | null;
  },
): Promise<{ projectId: ProjectId }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistants",
    method: "POST",
    body,
  });
}

/**
 * THE assistant chat ("Uno"): found, or set up now by the daemon. With the
 * `projectId` of another assistant of that computer: its latest conversation
 * (daemons from 0.0.106; older ones answer with the "Uno" chat).
 */
export function ensureAssistantChat(
  input: EnvironmentScoped & { readonly projectId?: ProjectId | string },
): Promise<{
  readonly threadId: ThreadId;
  readonly outcome: "existing" | "migrated" | "created";
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/chat",
    method: "POST",
    body:
      input.projectId && input.projectId !== ASSISTANT_PROJECT_ID
        ? { projectId: input.projectId }
        : {},
  });
}

/** Delete an assistant of that computer: kept 7 days with Restore. */
export function deleteLocalAssistant(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{ ok: boolean }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistants",
    method: "DELETE",
    searchParams: { projectId: input.projectId },
  });
}

export function listDeletedLocalAssistants(input: EnvironmentScoped): Promise<{
  readonly deleted: ReadonlyArray<ManagerDeletedAssistant>;
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistants/deleted",
  });
}

export function restoreLocalAssistant(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{ ok: boolean }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistants/restore",
    method: "POST",
    body: { projectId: input.projectId },
  });
}

/** Apps an assistant of that computer may open (checked by Work there). */
export function getAssistantApps(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<AssistantAppAccess> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/apps",
    searchParams: { projectId: input.projectId },
  });
}

export function putAssistantApps(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly permissions: Readonly<Record<string, AssistantAppLevel>>;
  },
): Promise<AssistantAppAccess> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/apps",
    method: "POST",
    body,
  });
}

/** AGENTS.md against Uno's newer instructions (0.0.106 daemons). */
export function getAssistantInstructions(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<AssistantInstructionsStatus> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/instructions",
    searchParams: { projectId: input.projectId },
  });
}

export function resolveAssistantInstructions(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly action: "update" | "replace" | "keep";
    readonly choices?: ReadonlyArray<"mine" | "theirs" | "both">;
  },
): Promise<{ readonly state: "current" | "edited"; readonly content: string }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/instructions",
    method: "POST",
    body,
  });
}

/** "New conversation" with Uno (0.0.85): another chat in its workspace, on its engine. */
export function createAssistantConversation(
  input: EnvironmentScoped & { readonly title?: string },
): Promise<{ readonly threadId: ThreadId }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/conversations",
    method: "POST",
    body: input.title ? { title: input.title } : {},
  });
}

/** A one-time code for the bot's deep link; pressing Start there links the chat. */
export function startTelegramPairing(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{
  readonly code: string;
  readonly expiresAt: string;
  readonly botUsername: string | null;
  readonly link: string | null;
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/telegram/pair",
    method: "POST",
    body: { projectId: input.projectId },
  });
}

/** Sends a test message to every linked Telegram chat. */
export function sendTelegramTestMessage(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{
  readonly results: ReadonlyArray<{
    readonly chatId: string;
    readonly ok: boolean;
    readonly error: string | null;
  }>;
}> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/telegram/test",
    method: "POST",
    body: { projectId: input.projectId },
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

/**
 * Writes an assistant file. Pass `base` (what the editor started from): if
 * the assistant wrote the file meanwhile, the daemon replays this edit onto
 * its version instead of overwriting it, and answers with what it wrote
 * (older daemons answer only `saved`).
 */
export function writeAssistantFile(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly name: AssistantEditableFileName;
    readonly content: string;
    readonly base?: string;
  },
): Promise<{ saved: boolean; content?: string; merged?: boolean }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/file",
    method: "POST",
    body,
  });
}

/**
 * "New assistant": Uno AI drafts a name, a job and ≤3 questions from one
 * sentence (assistants MVP). Fails on an older computer (404), without Uno AI
 * (503) or on a bad answer (502) — callers fall back to built-in questions.
 */
export function draftAssistant(
  input: EnvironmentScoped & AssistantDraftInput,
): Promise<AssistantDraftResult> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/draft",
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

/**
 * The Helper is the one assistant an account talks to from Telegram. It is
 * bootstrapped by the daemon on startup, so this normally just finds it; when
 * an environment has none (fresh state directory, deleted project) it is
 * created silently with defaults — the owner never sees "create assistant".
 */
export async function ensureHelper(input: EnvironmentScoped): Promise<{
  readonly helper: ManagerAssistantSummary;
  readonly assistants: ReadonlyArray<ManagerAssistantSummary>;
}> {
  const { assistants } = await listAssistants(input);
  const existing =
    assistants.find((assistant) => assistant.projectId === ASSISTANT_PROJECT_ID) ?? assistants[0];
  if (existing !== undefined) return { helper: existing, assistants };
  const created = await createAssistant({ environmentId: input.environmentId, name: "Helper" });
  const helper = await getAssistant({
    environmentId: input.environmentId,
    projectId: created.projectId,
  });
  return { helper, assistants: [helper] };
}

interface SnapshotShells {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  }>;
}

const fetchSnapshotShells = (input: EnvironmentScoped): Promise<SnapshotShells> =>
  environmentFetchJson<SnapshotShells>({
    environmentId: input.environmentId,
    pathname: "/api/orchestration/snapshot",
  });

/** Compact project list for the access picker (owner snapshot route). */
export async function listProjectsForAccessPicker(
  input: EnvironmentScoped,
): Promise<ReadonlyArray<{ id: ProjectId; title: string }>> {
  const snapshot = await fetchSnapshotShells(input);
  return snapshot.projects.map((project) => ({ id: project.id, title: project.title }));
}

export interface BindingPickerThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
}

/**
 * Live (non-archived) threads of every project, newest first, for the
 * "a specific chat" binding picker. One snapshot read serves all rows.
 */
export async function listThreadsForBindingPicker(
  input: EnvironmentScoped,
): Promise<ReadonlyArray<BindingPickerThread>> {
  const snapshot = await fetchSnapshotShells(input);
  return snapshot.threads
    .filter((thread) => thread.archivedAt === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((thread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title }));
}

/** The chats an assistant of that computer started, with model, status and tokens. */
export function listAssistantChats(
  input: EnvironmentScoped & { readonly projectId?: string },
): Promise<AssistantChatsResult> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/chats",
    ...(input.projectId ? { searchParams: { projectId: input.projectId } } : {}),
  });
}

export interface SlackChannelView {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isMember: boolean;
  /** The assistant of that computer that answers there; null = none yet. */
  readonly assistantProjectId: string | null;
}

/** The workspace's channels through Uno's Slack app, and whose each one is. */
export function listSlackChannels(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{ readonly channels: ReadonlyArray<SlackChannelView> }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/slack/channels",
    searchParams: { projectId: input.projectId },
  });
}

/** "Channels Ana answers in": exactly these (taken from other assistants of that computer). */
export function setSlackChannels(
  input: EnvironmentScoped & {
    readonly projectId: string;
    readonly channelIds: ReadonlyArray<string>;
  },
): Promise<{ readonly allowedChannelIds: ReadonlyArray<string> }> {
  const { environmentId, ...body } = input;
  return environmentFetchJson({
    environmentId,
    pathname: "/api/manager/assistant/slack/channels",
    method: "POST",
    body,
  });
}

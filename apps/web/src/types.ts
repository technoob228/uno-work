import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationSessionErrorClass,
  OrchestrationProposedPlanId,
  RepositoryIdentity,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ProjectId,
  TurnId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  CheckpointRef,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadAssistantRole,
  ThreadStartedBy,
  ThreadController,
  ThreadPullRequest,
} from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
  /** The person's copy in ~/Uploads/YYYY-MM on the chat's computer. */
  savedPath?: string;
}

/** A non-image file, saved in ~/Uploads/YYYY-MM on the chat's computer. */
export interface ChatFileAttachment {
  type: "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Absolute path on the chat's computer; empty while still being sent. */
  path: string;
}

export interface ChatVideoDigestAttachment {
  type: "video_digest";
  id: string;
  name: string;
  sourceMimeType: string;
  sourceSizeBytes: number;
  durationMs: number;
  digestId: string;
  jobId: string;
  frameCount: number;
  transcriptSegmentCount: number;
  posterPreviewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment | ChatVideoDigestAttachment | ChatFileAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  /** Set on a user-role message another thread's agent sent; absent = a human wrote it. */
  sentByThreadId?: ThreadId | null | undefined;
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  id: ProjectId;
  environmentId: EnvironmentId;
  name: string;
  cwd: string;
  repositoryIdentity?: RepositoryIdentity | null;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface Thread {
  id: ThreadId;
  environmentId: EnvironmentId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
  /** Thread whose agent created this one; absent/null for human-created threads. */
  spawnedByThreadId?: ThreadId | null | undefined;
  /** Who drives the thread; absent means "human". */
  controller?: ThreadController | undefined;
  controlChangedAt?: string | null | undefined;
  /** Set while the person keeps agents out ("Don't let agents write here"). */
  agentsClosedAt?: string | null | undefined;
  /** "chat": THE assistant chat (Uno); "spawned": a chat Uno started. */
  assistantRole?: ThreadAssistantRole | null | undefined;
}

export interface ThreadShell {
  id: ThreadId;
  environmentId: EnvironmentId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  updatedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
  /** Thread whose agent created this one; absent/null for human-created threads. */
  spawnedByThreadId?: ThreadId | null | undefined;
  /** Who drives the thread; absent means "human". */
  controller?: ThreadController | undefined;
  controlChangedAt?: string | null | undefined;
  /** Set while the person keeps agents out ("Don't let agents write here"). */
  agentsClosedAt?: string | null | undefined;
  /** "chat": THE assistant chat (Uno); "spawned": a chat Uno started. */
  assistantRole?: ThreadAssistantRole | null | undefined;
}

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  /** Dev mode's PR row. Empty for anyone who never turned Dev mode on. */
  pullRequests?: ReadonlyArray<ThreadPullRequest>;
  autoSettleDisabledAt?: string | null;
  pinnedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  /** Snooze wake time; absent/null when not snoozed or on pre-snooze servers. */
  snoozedUntil?: string | null | undefined;
  snoozedAt?: string | null | undefined;
  /** Manual settle override ("settled" parked, "active" pulled back out); absent on pre-settle servers. */
  settledOverride?: "settled" | "active" | null | undefined;
  settledAt?: string | null | undefined;
  /** When the person pressed Read in this browser (see threadReadMarks); it holds until a later turn finishes. */
  readAt?: string | null | undefined;
  /** Model the chat runs on; drives the provider icon on chat-list cards. */
  modelSelection?: { readonly instanceId: string; readonly model: string } | undefined;
  /** Thread whose agent created this one; absent/null for human-created threads. */
  spawnedByThreadId?: ThreadId | null | undefined;
  /** Who drives the thread; absent means "human". */
  controller?: ThreadController | undefined;
  controlChangedAt?: string | null | undefined;
  /** Set while the person keeps agents out ("Don't let agents write here"). */
  agentsClosedAt?: string | null | undefined;
  /** "chat": THE assistant chat (Uno); "spawned": a chat Uno started. */
  assistantRole?: ThreadAssistantRole | null | undefined;
  /** Who created the chat when it was not the person (see threadOwner.ts); absent on older servers. */
  startedBy?: ThreadStartedBy | null | undefined;
  /** The person's own latest message (not an agent's or Uno's). */
  latestPersonMessageAt?: string | null | undefined;
  /** An agent called the person into this chat; cleared when it says they are not needed. */
  personCalledAt?: string | null | undefined;
  personCalledByThreadId?: ThreadId | null | undefined;
  personCallReason?: string | null | undefined;
}

export interface ThreadSession {
  provider: ProviderDriverKind;
  providerInstanceId?: ProviderInstanceId | undefined;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  lastErrorClass?: OrchestrationSessionErrorClass;
  orchestrationStatus: OrchestrationSessionStatus;
}

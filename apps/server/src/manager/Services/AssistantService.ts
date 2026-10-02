/**
 * ManagerAssistantService - lifecycle of assistants.
 *
 * An assistant IS a project (`assistant-*`): threads are its chats, its
 * workspace holds instructions/notes/skills, and its own capability token
 * (label `assistant:<projectId>`) scopes what it may touch. Each assistant
 * also owns its connectors (its own Telegram bot).
 *
 * @module ManagerAssistantService
 */
import type {
  AssistantEditableFileName,
  ManagerAssistantSummary,
  ManagerDeletedAssistant,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class ManagerAssistantError extends Schema.TaggedErrorClass<ManagerAssistantError>()(
  "ManagerAssistantError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Assistant operation failed: ${this.detail}`;
  }
}

export interface ManagerAssistantServiceShape {
  /**
   * AGENTS.md against Uno's newer instructions (`assistantInstructions.ts`):
   * an untouched file is updated on the way; an edited one reports
   * `update-available` with the texts the page diffs and merges.
   */
  readonly instructionsStatus: (projectId: ProjectId) => Effect.Effect<
    {
      readonly state: "current" | "edited" | "update-available";
      readonly current: string;
      readonly base: string;
      readonly next: string;
      readonly conflicts: number;
    },
    ManagerAssistantError
  >;
  /**
   * The person's answer to "Uno has newer instructions": `update` (keep my
   * edits — three-way merge, conflicts by `choices`), `replace` (take Uno's),
   * `keep` (keep mine; asked again on the next version).
   */
  readonly resolveInstructions: (input: {
    readonly projectId: ProjectId;
    readonly action: "update" | "replace" | "keep";
    readonly choices?: ReadonlyArray<"mine" | "theirs" | "both"> | undefined;
  }) => Effect.Effect<
    { readonly state: "current" | "edited"; readonly content: string },
    ManagerAssistantError
  >;
  /** Start-up: newer instructions for every assistant that didn't edit them. */
  readonly syncAllInstructions: () => Effect.Effect<void, ManagerAssistantError>;
  /** Idempotently create workspace, token, and project for an assistant. */
  readonly ensureAssistant: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    /** Workspace folder to register for a NEW assistant; existing assistants keep theirs. */
    readonly workspaceRoot?: string;
  }) => Effect.Effect<void, ManagerAssistantError>;
  /**
   * Adopt user-created folders in ~/UnoWork/Assistants: a folder containing
   * AGENTS.md (and no foreign marker) becomes an assistant in place.
   */
  readonly scanWorkspaceFolders: () => Effect.Effect<
    { readonly adopted: ReadonlyArray<ProjectId> },
    ManagerAssistantError
  >;
  /**
   * Create a new assistant on this computer from a human name (and what
   * "New assistant" picked: emoji, template); returns its project id.
   */
  readonly createAssistant: (input: {
    readonly name: string;
    readonly emoji?: string | undefined;
    readonly template?: string | null | undefined;
  }) => Effect.Effect<{ readonly projectId: ProjectId }, ManagerAssistantError>;
  /**
   * Make sure THE assistant chat ("Uno", `assistantRole: "chat"`) exists and
   * is not archived. The first run on a computer with assistant history is
   * the migration: the assistant chat the person used last keeps its
   * history and becomes the pinned one (other assistant chats stay as they
   * are). With no history a fresh chat is created. Idempotent.
   */
  readonly ensureAssistantChat: () => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly outcome: "existing" | "migrated" | "created";
    },
    ManagerAssistantError
  >;
  /**
   * Start another conversation with the assistant ("New conversation",
   * 0.0.85): a chat in the assistant's workspace — same memory (AGENTS.md,
   * NOTES.md), same engine as the main chat. Telegram / Slack keep talking
   * to the main one.
   */
  readonly createConversation: (input: {
    readonly title?: string | undefined;
    /** Another assistant of this computer; the default one when absent. */
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<{ readonly threadId: ThreadId }, ManagerAssistantError>;
  /**
   * The chat "Chat" opens for an assistant of this computer that is not the
   * default one: its latest conversation (not a Telegram / Slack chat), or a
   * new one on the assistant engine.
   */
  readonly ensureConversation: (
    projectId: ProjectId,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly outcome: "existing" | "created" },
    ManagerAssistantError
  >;
  /**
   * Delete an assistant of this computer (never the default one): it stops
   * answering (connectors and chat bindings put aside, chats archived, token
   * revoked) and its folder moves to `~/UnoWork/Assistants/.trash` — kept
   * 7 days, then purged ({@link purgeDeletedAssistants}).
   */
  readonly deleteAssistant: (projectId: ProjectId) => Effect.Effect<void, ManagerAssistantError>;
  readonly restoreAssistant: (projectId: ProjectId) => Effect.Effect<void, ManagerAssistantError>;
  readonly listDeletedAssistants: () => Effect.Effect<
    ReadonlyArray<ManagerDeletedAssistant>,
    ManagerAssistantError
  >;
  /** Removes for good what was deleted more than 7 days ago. */
  readonly purgeDeletedAssistants: () => Effect.Effect<
    { readonly purged: ReadonlyArray<ProjectId> },
    ManagerAssistantError
  >;
  readonly listAssistants: () => Effect.Effect<
    ReadonlyArray<ManagerAssistantSummary>,
    ManagerAssistantError
  >;
  readonly getAssistant: (
    projectId: ProjectId,
  ) => Effect.Effect<ManagerAssistantSummary, ManagerAssistantError>;
  readonly readWorkspaceFile: (input: {
    readonly projectId: ProjectId;
    readonly name: AssistantEditableFileName;
  }) => Effect.Effect<{ readonly content: string }, ManagerAssistantError>;
  /**
   * Writes a workspace file. With `base` (the content the editor started
   * from), an edit that crossed the assistant's own write is replayed onto
   * the file as it is now (`rebaseEdit`) instead of overwriting it. Returns
   * what was written.
   */
  readonly writeWorkspaceFile: (input: {
    readonly projectId: ProjectId;
    readonly name: AssistantEditableFileName;
    readonly content: string;
    readonly base?: string | undefined;
  }) => Effect.Effect<
    { readonly content: string; readonly merged: boolean },
    ManagerAssistantError
  >;
}

export class ManagerAssistantService extends Context.Service<
  ManagerAssistantService,
  ManagerAssistantServiceShape
>()("t3/manager/Services/ManagerAssistantService") {}

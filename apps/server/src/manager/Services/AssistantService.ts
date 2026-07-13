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
  ProjectId,
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
  /** Create a new assistant from a human name; returns its project id. */
  readonly createAssistant: (input: {
    readonly name: string;
  }) => Effect.Effect<{ readonly projectId: ProjectId }, ManagerAssistantError>;
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
  readonly writeWorkspaceFile: (input: {
    readonly projectId: ProjectId;
    readonly name: AssistantEditableFileName;
    readonly content: string;
  }) => Effect.Effect<void, ManagerAssistantError>;
}

export class ManagerAssistantService extends Context.Service<
  ManagerAssistantService,
  ManagerAssistantServiceShape
>()("t3/manager/Services/ManagerAssistantService") {}

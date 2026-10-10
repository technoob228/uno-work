import { Effect, Schema } from "effect";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Server understands thread.snooze / thread.unsnooze. Absent on pre-snooze
      servers, so clients treat missing as unsupported and hide the Snooze
      actions. Same key as upstream T3 Code. */
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.settle / thread.unsettle and projects
      settledOverride. Same key as upstream T3 Code. */
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  /** Server tracks agent-spawned threads (spawnedByThreadId, controller,
      thread.control.set). Clients hide the control badge/handoff when absent. */
  agentThreads: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.meta.update `agentsClosedAt` ("Don't let
      agents write here", 0.0.115) and no longer locks agents out of a chat
      the person wrote in. Clients hide the switch when absent. */
  agentsCloseChat: Schema.optionalKey(Schema.Boolean),
  /** Server speaks the "Continue on <machine>" protocol that sends files
      through the client (thread.continue.snapshot / land) instead of pushing
      them to origin. Clients refuse to continue to or from a machine without
      it and ask to update that machine. */
  threadContinueDirect: Schema.optionalKey(Schema.Boolean),
  /** Server marks THE assistant chat (thread.assistantRole = "chat") and the
      chats the assistant starts ("spawned"). Absent on older servers: clients
      fall back to the newest chat of the default assistant project. */
  assistantChat: Schema.optionalKey(Schema.Boolean),
  /** The assistant chat runs on Hermes with a chosen LLM provider (0.0.84):
      `/api/manager/assistant/llm*` and `/api/ai-providers*` exist. Absent:
      clients keep the generic harness picker for that chat. */
  assistantLlm: Schema.optionalKey(Schema.Boolean),
  /** The assistant has conversations (0.0.85): `POST
      /api/manager/assistant/conversations`, every chat in its workspace runs
      on its engine, Telegram linking by code
      (`/api/manager/assistant/telegram/pair`) and a test message
      (`/api/manager/assistant/telegram/test`). Absent: clients show the one
      pinned chat and the manual chat-id Telegram setup. */
  assistantConversations: Schema.optionalKey(Schema.Boolean),
  /** Groups of owner HTTP routes this daemon serves, by name (see
      {@link HTTP_FEATURES}). One flag for every route family a newer
      interface may call, so an interface served by our address (newer than
      the daemon) hides the button and says "Update this computer" instead of
      getting a 404. Absent on daemons that predate the field: clients fall back to
      {@link HTTP_FEATURE_SINCE} by `serverVersion`. Plain strings, not
      literals: a newer daemon may list names this client does not know. */
  httpFeatures: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

/**
 * Named families of daemon HTTP routes ({@link ExecutionEnvironmentCapabilities.httpFeatures}).
 * Rule for a PR: a new owner HTTP route the web calls = a new name here, listed
 * by the daemon, checked by the client before it calls.
 */
export const HTTP_FEATURES = {
  /** `GET /api/self-update/status`, `POST /api/self-update/start` — the Update button. */
  selfUpdate: "self-update",
  /** `/api/manager/assistant/{apps,chats,draft,instructions}`. */
  assistantWorkspace: "assistant-workspace",
  /** `/api/manager/assistants/{deleted,restore}` — Restore of a deleted assistant. */
  assistantsTrash: "assistants-trash",
  /**
   * `POST /api/self-update/later` — "This evening" next to Update: the owner
   * agrees to the update and the computer installs it after that time, once
   * nothing is running on it. A computer without it keeps the single Update.
   */
  updateLater: "update-later",
} as const;
export type HttpFeature = (typeof HTTP_FEATURES)[keyof typeof HTTP_FEATURES];

/**
 * The Uno Work version that first served each feature: how a client judges a
 * daemon that predates `httpFeatures` (it never lists anything).
 */
export const HTTP_FEATURE_SINCE: Readonly<Record<HttpFeature, string>> = {
  "self-update": "0.0.113",
  "assistant-workspace": "0.0.106",
  "assistants-trash": "0.0.106",
  // Every daemon that has it also lists httpFeatures; the version only keeps
  // older ones (which never list anything) out.
  "update-later": "0.0.120",
};

/** Route prefix → feature, for the client's 404 handling and the pre-call check. */
export const HTTP_FEATURE_ROUTES: ReadonlyArray<{
  readonly prefix: string;
  readonly feature: HttpFeature;
}> = [
  // Before "/api/self-update/": the first matching prefix wins.
  { prefix: "/api/self-update/later", feature: "update-later" },
  { prefix: "/api/self-update/", feature: "self-update" },
  { prefix: "/api/manager/assistant/apps", feature: "assistant-workspace" },
  { prefix: "/api/manager/assistant/chats", feature: "assistant-workspace" },
  { prefix: "/api/manager/assistant/draft", feature: "assistant-workspace" },
  { prefix: "/api/manager/assistant/instructions", feature: "assistant-workspace" },
  { prefix: "/api/manager/assistants/deleted", feature: "assistants-trash" },
  { prefix: "/api/manager/assistants/restore", feature: "assistants-trash" },
];

/**
 * What kind of machine a daemon runs on, as the daemon itself reports it.
 *
 * `uno_box` is a managed Uno box, `computer` is a person's own laptop or
 * desktop (the Uno Work desktop app, or a macOS/Windows host), `server` is
 * anything else reachable over the network. Labels, icons and grouping in the
 * UI come from this, never from whether the daemon happens to be the one that
 * served the page.
 */
export const MachineKind = Schema.Literals(["uno_box", "computer", "server"]);
export type MachineKind = typeof MachineKind.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
  /** Optional so daemons older than this field keep working. */
  machineKind: Schema.optionalKey(MachineKind),
  /** The box id in the Uno control plane when `machineKind` is `uno_box` and known. */
  unoBoxId: Schema.optionalKey(Schema.Number),
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "reconnecting",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;

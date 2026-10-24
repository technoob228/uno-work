/**
 * An assistant's access on this computer — its preset (Full / Helper /
 * Observer) and the projects it applies to — as every enforcement point
 * reads it: the manager tools (`ManagerToolService`), the agent-threads
 * bridge (`agentThreads/`), the uno-work tools and connector checks
 * (`unoWork/http.ts`). The rules themselves are the shared table in
 * `@t3tools/shared/assistantPreset`.
 *
 * Source of truth: the assistant's live capability token (`assistant:<id>`),
 * so a preset change holds from the next call, without a restart. A copy in
 * the daemon's state dir (`access.json`) is what a re-issued token starts
 * from (port change, cloned computer, Restore).
 *
 * @module assistants/assistantAccess
 */
import {
  assistantTokenLabel,
  type AssistantPreset,
  type ManagerCapabilityTokenDescriptor,
  type ManagerProjectAllowlist,
} from "@t3tools/contracts";
import {
  DEFAULT_ASSISTANT_PRESET,
  presetOfScopes,
  presetTokenAccess,
  type AssistantTokenAccess,
} from "@t3tools/shared/assistantPreset";
import { Effect, Option } from "effect";

import type { ManagerRepositoryError } from "../persistence/Errors.ts";
import type { ManagerCapabilityTokenRepositoryShape } from "../persistence/Services/ManagerCapabilityTokens.ts";
import {
  owningAssistant,
  readStartedChats,
  readStoredAccess,
  writeStoredAccess,
  type OwnedThread,
} from "./localAssistantStore.ts";

/** What one assistant may do, as the enforcement points need it. */
export interface AssistantAccessView {
  readonly projectId: string;
  readonly preset: AssistantPreset;
  readonly allowlist: ManagerProjectAllowlist;
}

type TokenReader = Pick<ManagerCapabilityTokenRepositoryShape, "getActiveByLabel">;

/** The assistant project an `assistant:<projectId>` token label names, or null. */
export function assistantOfTokenLabel(label: string | undefined): string | null {
  const prefix = assistantTokenLabel("");
  if (label === undefined || !label.startsWith(prefix)) return null;
  const projectId = label.slice(prefix.length);
  return projectId.length > 0 ? projectId : null;
}

export function accessViewOf(
  projectId: string,
  access: Pick<AssistantTokenAccess, "scopes" | "projectAllowlist">,
): AssistantAccessView {
  return { projectId, preset: presetOfScopes(access.scopes), allowlist: access.projectAllowlist };
}

/**
 * The live token's access; without one, the stored copy; without that, Full
 * in its own workspace only (a missing token never widens access) — or
 * `unsetAllowlist` when the caller says otherwise (the sandbox: nothing set
 * means what a new token gets, All projects; see assistantSandboxPolicy.ts).
 */
export const readAssistantAccess = (
  deps: {
    readonly tokens: TokenReader;
    readonly stateDir: string;
    readonly unsetAllowlist?: ManagerProjectAllowlist;
  },
  projectId: string,
): Effect.Effect<AssistantAccessView> =>
  Effect.gen(function* () {
    const token = yield* deps.tokens
      .getActiveByLabel(assistantTokenLabel(projectId))
      .pipe(Effect.orElseSucceed(() => Option.none<ManagerCapabilityTokenDescriptor>()));
    if (Option.isSome(token)) return accessViewOf(projectId, token.value);
    const stored = yield* Effect.promise(() => readStoredAccess(deps.stateDir, projectId));
    if (stored !== null) return accessViewOf(projectId, stored);
    return { projectId, preset: DEFAULT_ASSISTANT_PRESET, allowlist: deps.unsetAllowlist ?? [] };
  });

/**
 * The assistant a chat belongs to (its workspace, a chat it started, a chat
 * one of those started) with its access; null for the person's own chats.
 */
export const assistantOfThread = (
  deps: {
    readonly tokens: TokenReader;
    readonly stateDir: string;
    readonly threads: ReadonlyArray<OwnedThread>;
    readonly unsetAllowlist?: ManagerProjectAllowlist;
  },
  threadId: string,
): Effect.Effect<AssistantAccessView | null> =>
  Effect.gen(function* () {
    const byId = new Map(deps.threads.map((thread) => [thread.id as string, thread]));
    const self = byId.get(threadId);
    if (self === undefined) return null;
    const startedBy = yield* Effect.promise(() => readStartedChats(deps.stateDir));
    const owner = owningAssistant(self, (id) => byId.get(id), startedBy);
    if (owner === null) return null;
    return yield* readAssistantAccess(deps, owner);
  });

/**
 * What a freshly issued token for this assistant gets: the access of the
 * token it replaces, else the stored copy, else Full on every project (Uno
 * and assistants made before presets: unchanged).
 */
export const accessForNewToken = (
  stateDir: string,
  projectId: string,
  replaced: Option.Option<ManagerCapabilityTokenDescriptor>,
): Effect.Effect<AssistantTokenAccess> =>
  Effect.gen(function* () {
    if (Option.isSome(replaced)) {
      const { scopes, projectAllowlist, autoApprove } = replaced.value;
      return { scopes, projectAllowlist, autoApprove };
    }
    const stored = yield* Effect.promise(() => readStoredAccess(stateDir, projectId));
    return stored ?? presetTokenAccess(DEFAULT_ASSISTANT_PRESET, "all", projectId);
  });

/**
 * Sets an assistant's access: the stored copy first (so a token issued in
 * between gets it), then the live token. Takes effect on the next call.
 * Returns the updated token, if the assistant has one yet.
 */
export const applyAssistantAccess = (
  deps: {
    readonly tokens: Pick<
      ManagerCapabilityTokenRepositoryShape,
      "getActiveByLabel" | "updateAccess"
    >;
    readonly stateDir: string;
  },
  projectId: string,
  access: AssistantTokenAccess,
): Effect.Effect<Option.Option<ManagerCapabilityTokenDescriptor>, ManagerRepositoryError> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => writeStoredAccess(deps.stateDir, projectId, access));
    const label = assistantTokenLabel(projectId);
    const token = yield* deps.tokens.getActiveByLabel(label);
    if (Option.isNone(token)) return Option.none();
    yield* deps.tokens.updateAccess({
      tokenId: token.value.tokenId,
      scopes: access.scopes,
      projectAllowlist: access.projectAllowlist,
      autoApprove: access.autoApprove,
    });
    return yield* deps.tokens.getActiveByLabel(label);
  });

/**
 * "Only selected projects" as a boundary, not a filter: which chats run
 * their harness in the assistant sandbox (sandbox/harnessSandbox.ts) and
 * what the sandbox lets them see.
 *
 * - A chat that belongs to an assistant (its conversations, chats it
 *   started, chats those started — {@link assistantOfThread}) whose projects
 *   are not "all" runs sandboxed: its allowed projects, its own folder and
 *   the chat's folder, nothing else of the person's.
 * - Everything else — the person's own chats, assistants on All projects —
 *   runs exactly as before (`none`).
 * - Fail closed: where the sandbox can't run (a Mac, no bwrap), such a chat
 *   is refused with a message, never run open. Making an assistant
 *   restricted there is refused when it is set ({@link requireAssistantSandboxForProjects}).
 *
 * @module assistants/assistantSandboxPolicy
 */
import * as os from "node:os";
import * as nodePath from "node:path";

import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { presetRuntimeCeiling } from "@t3tools/shared/assistantPreset";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { HarnessSandboxPolicy } from "../provider/Services/HarnessSandboxPolicy.ts";
import { assistantSandboxCapability } from "../sandbox/sandboxCapability.ts";
import { assistantOfThread } from "./assistantAccess.ts";
import {
  ASSISTANT_SANDBOX_CHECK_FAILED_MESSAGE,
  assistantSandboxGrantDenial,
  decideAssistantSandbox,
  isRestrictedAllowlist,
} from "./assistantSandboxRules.ts";

/** Whether this computer can run the assistant sandbox (cached probe). */
export const assistantSandboxAvailable: Effect.Effect<boolean> = Effect.promise(() =>
  assistantSandboxCapability(),
).pipe(
  Effect.map((capability) => capability.available),
  Effect.orElseSucceed(() => false),
);

/** Fails with the message when `projects` is restricted and the sandbox can't run here. */
export const requireAssistantSandboxForProjects = <E>(
  projects: "all" | ReadonlyArray<string>,
  onDenied: (message: string) => E,
): Effect.Effect<void, E> =>
  projects === "all"
    ? Effect.void
    : Effect.flatMap(assistantSandboxAvailable, (available) => {
        const denial = assistantSandboxGrantDenial(projects, available);
        return denial === null ? Effect.void : Effect.fail(onDenied(denial));
      });

/** Where assistants' private /tmp folders live (on the state disk, like TMPDIR). */
export const sandboxTmpRoot = (stateDir: string) => nodePath.join(stateDir, "sandbox", "tmp");

export const AssistantHarnessSandboxPolicyLive = Layer.effect(
  HarnessSandboxPolicy,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projections = yield* ProjectionSnapshotQuery;
    const tokens = yield* ManagerCapabilityTokenRepository;
    const home = os.homedir();
    // The chat and the chats that started it (the owner walk goes ≤ 6 up):
    // a few row reads per turn instead of the whole read model.
    const threadChain = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const chain: OrchestrationThreadShell[] = [];
        let next: ThreadId | null = threadId;
        while (next !== null && chain.length < 7) {
          const shell: OrchestrationThreadShell | null = Option.getOrNull(
            yield* projections.getThreadShellById(next),
          );
          if (shell === null) break;
          chain.push(shell);
          next = shell.spawnedByThreadId ?? null;
        }
        return chain;
      });
    return {
      runtimeCeiling: ({ threadId }) =>
        Effect.gen(function* () {
          const chain = yield* threadChain(threadId);
          const owner = yield* assistantOfThread(
            { tokens, stateDir: config.stateDir, threads: chain, unsetAllowlist: "all" },
            threadId,
          );
          return owner === null ? null : presetRuntimeCeiling(owner.preset);
        }).pipe(
          // Can't tell whose chat it is: no ceiling here — the sandbox decision
          // above already fails closed for the same read-model trouble.
          Effect.catchCause((cause) =>
            Effect.logWarning("assistant runtime ceiling unknown", { threadId, cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
      decide: ({ threadId, cwd }) =>
        Effect.gen(function* () {
          const chain = yield* threadChain(threadId);
          // An assistant with no access set at all (its token not issued
          // yet) gets All projects when it is: no sandbox for that gap. A
          // restricted list always holds its own folder, so it is never empty.
          const owner = yield* assistantOfThread(
            { tokens, stateDir: config.stateDir, threads: chain, unsetAllowlist: "all" },
            threadId,
          );
          // The person's own chats and All-projects assistants: no probe, no change.
          if (owner === null || !isRestrictedAllowlist(owner.allowlist)) {
            return { _tag: "none" } as const;
          }
          const capability = yield* Effect.promise(() => assistantSandboxCapability());
          if (!capability.available) {
            yield* Effect.logWarning("assistant sandbox unavailable", {
              threadId,
              assistant: owner.projectId,
              reason: capability.reason,
            });
          }
          const snapshot = yield* projections.getShellSnapshot();
          return decideAssistantSandbox({
            owner,
            threadProjectId: chain[0]?.projectId ?? null,
            cwd,
            projects: snapshot.projects.map((project) => ({
              id: project.id,
              workspaceRoot: project.workspaceRoot,
            })),
            home,
            daemonDirs: [config.stateDir, config.baseDir],
            worktreesDir: config.worktreesDir,
            capability,
            tmpRoot: sandboxTmpRoot(config.stateDir),
          });
        }).pipe(
          // Fail closed: an unreadable read model must not run a chat open.
          Effect.catchCause((cause) =>
            Effect.logError("assistant sandbox decision failed", { threadId, cause }).pipe(
              Effect.as({
                _tag: "refuse",
                message: ASSISTANT_SANDBOX_CHECK_FAILED_MESSAGE,
              } as const),
            ),
          ),
        ),
    };
  }),
).pipe(Layer.provide(ManagerCapabilityTokenRepositoryLive));

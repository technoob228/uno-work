/**
 * Where a chat's project lives (computers lifecycle, "brain in the cloud",
 * CONTRACT.md §3, §7.5): the policy `ProviderService` asks before a session
 * starts or a turn goes (`ComputerWorkspacePolicy`), and what the
 * `workspace_*` tools ask for the calling chat (`planOfThread`).
 *
 * A chat is on the person's computer when its project carries `computer`
 * (a folder opened there, or imported chats of a full computer), or — for chats
 * imported before projects carried it — when the chat's `source` names the
 * computer and the folder it ran in.
 *
 * What the computer is for: the console's word (`mode`, CONTRACT §7.1), else
 * the local choice (`<stateDir>/computers-lifecycle.json`, shared with the
 * computers lifecycle layer through {@link sharedPurposeStore}).
 *
 * @module myComputer/ComputerWorkspaces
 */
import type { ComputerPurpose, OrchestrationProjectShell, ThreadId } from "@t3tools/contracts";
import { ProjectId, ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { makePurposeStore, type PurposeStore } from "../computers/purposeStore.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ComputerWorkspacePolicy,
  type ComputerWorkspaceDecision,
  type ComputerWorkspacePlan,
} from "../provider/Services/ComputerWorkspacePolicy.ts";
import type { MyComputerCore } from "./myComputerCore.ts";
import { MyComputerService } from "./MyComputerService.ts";

// ── One purposes store per state folder ────────────────────────────────

const purposeStores = new Map<string, PurposeStore>();

/** The local purposes file, one in-memory copy per process (the store caches). */
export function sharedPurposeStore(stateDir: string): PurposeStore {
  let store = purposeStores.get(stateDir);
  if (store === undefined) {
    store = makePurposeStore(stateDir);
    purposeStores.set(stateDir, store);
  }
  return store;
}

/** What the computer is for: the console's word, else the local choice. */
export async function purposeOfComputer(
  core: MyComputerCore,
  store: PurposeStore,
  computerId: string,
): Promise<ComputerPurpose> {
  if (core.meta() === null) await core.cachedStatus(30_000).catch(() => undefined);
  return core.meta()?.computers.get(computerId)?.mode ?? store.purposeOf(computerId);
}

// ── Plans ──────────────────────────────────────────────────────────────

type ThreadLike = {
  readonly projectId: string;
  readonly source?:
    | {
        readonly computerId: string;
        readonly computerName: string;
        readonly cwd: string | null;
      }
    | null
    | undefined;
};

/** The plan of a chat from its shell and its project's (pure: tests). */
export function planOf(
  thread: ThreadLike,
  project: Pick<OrchestrationProjectShell, "computer"> | null,
): ComputerWorkspacePlan | null {
  const computer = project?.computer ?? null;
  if (computer !== null) {
    return {
      computerId: computer.computerId,
      computerName: computer.computerName,
      path: computer.path,
    };
  }
  const source = thread.source ?? null;
  if (source !== null && source.cwd !== null && source.cwd.length > 0) {
    return { computerId: source.computerId, computerName: source.computerName, path: source.cwd };
  }
  return null;
}

/** An imported chat whose folder the computer never said: it can only continue in the cloud. */
export const NO_FOLDER_MESSAGE =
  "This chat doesn't say which folder it ran in on the computer, so it can't go on there. Continue it in the cloud.";

export const toolModeMessage = (name: string) =>
  `${name} is used as a tool for agents. Continue in the cloud or make it a full computer.`;

export const removedComputerMessage = (name: string) =>
  `${name} was removed from your computers. Continue in the cloud.`;

export function makeComputerWorkspaceReader(input: {
  readonly projections: Pick<
    typeof ProjectionSnapshotQuery.Service,
    "getThreadShellById" | "getProjectShellById"
  >;
  readonly core: MyComputerCore;
  readonly purposes: PurposeStore;
}) {
  const planOfThread = (threadId: string) =>
    Effect.gen(function* () {
      const shell = Option.getOrNull(
        yield* input.projections
          .getThreadShellById(ThreadIdSchema.make(threadId))
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (shell === null) return { plan: null, imported: false } as const;
      const project = Option.getOrNull(
        yield* input.projections
          .getProjectShellById(ProjectId.make(shell.projectId))
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      return {
        plan: planOf(shell, project),
        imported: shell.source != null,
      } as const;
    });

  const decide = (threadId: ThreadId): Effect.Effect<ComputerWorkspaceDecision> =>
    Effect.gen(function* () {
      const { plan, imported } = yield* planOfThread(threadId);
      if (plan === null) {
        return imported
          ? ({ _tag: "refuse", message: NO_FOLDER_MESSAGE } as const)
          : ({ _tag: "local" } as const);
      }
      const status = yield* Effect.promise(() => input.core.cachedStatus(10_000).catch(() => null));
      if (status !== null && status.enabled) {
        const computer = status.computers.find((entry) => entry.id === plan.computerId);
        if (computer === undefined) {
          return { _tag: "refuse", message: removedComputerMessage(plan.computerName) } as const;
        }
      }
      // An unreachable console: go by what we knew; the tools wait or explain.
      const purpose = yield* Effect.promise(() =>
        purposeOfComputer(input.core, input.purposes, plan.computerId).catch(() =>
          input.purposes.purposeOf(plan.computerId),
        ),
      );
      if (purpose !== "full") {
        return { _tag: "refuse", message: toolModeMessage(plan.computerName) } as const;
      }
      return { _tag: "computer", plan } as const;
    });

  return {
    planOfThread: (threadId: string) =>
      planOfThread(threadId).pipe(Effect.map((answer) => answer.plan)),
    decide,
  };
}

/** `ComputerWorkspacePolicy` for `ProviderService`. */
export const ComputerWorkspacePolicyLive = Layer.effect(
  ComputerWorkspacePolicy,
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const myComputer = yield* MyComputerService;
    const config = yield* ServerConfig;
    const reader = makeComputerWorkspaceReader({
      projections,
      core: myComputer.core,
      purposes: sharedPurposeStore(config.stateDir),
    });
    return ComputerWorkspacePolicy.of({ decide: ({ threadId }) => reader.decide(threadId) });
  }),
);

// ── "Waiting for <name>…" ──────────────────────────────────────────────

/**
 * Several calls of one chat may wait at once: the mark goes up with the
 * first and down with the last.
 */
export function makeWaitMarks<Mark>(
  apply: (threadId: string, mark: Mark | null) => Effect.Effect<void>,
) {
  const waiting = new Map<string, number>();
  return (threadId: string, mark: Mark | null): Effect.Effect<void> =>
    Effect.suspend(() => {
      const count = waiting.get(threadId) ?? 0;
      if (mark !== null) {
        waiting.set(threadId, count + 1);
        return count === 0 ? apply(threadId, mark) : Effect.void;
      }
      if (count <= 1) {
        waiting.delete(threadId);
        return count === 1 ? apply(threadId, null) : Effect.void;
      }
      waiting.set(threadId, count - 1);
      return Effect.void;
    });
}

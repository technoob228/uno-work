/**
 * The folders a chat may send files from to Telegram / Slack, as roots for
 * `resolveConnectorOutgoingFile` (see `connectorOutgoingFiles.ts`): the
 * chat's own folder; for the person's own chats and assistants that reach
 * every project, the person's folders and all projects; for an assistant on
 * "only selected projects", only those.
 *
 * @module manager/threadSendableRoots
 */
import type { ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { assistantOfThread, type AssistantAccessView } from "../assistants/assistantAccess.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { sendableRoots } from "./connectorOutgoingFiles.ts";

export interface ThreadSendableRootsDeps {
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getShellSnapshot" | "getThreadCheckpointContext"
  >;
  readonly home: string;
  /** Token store + state dir for the chat's assistant; null: treat as the person's chat. */
  readonly access: Parameters<typeof assistantOfThread>[0] extends infer D
    ? Omit<D & object, "threads"> | null
    : never;
}

export const makeThreadSendableRoots =
  (deps: ThreadSendableRootsDeps) =>
  (threadId: ThreadId): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const context = yield* deps.projections
        .getThreadCheckpointContext(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const threadRoot = Option.isSome(context)
        ? (context.value.worktreePath ?? context.value.workspaceRoot)
        : null;
      const snapshot = yield* deps.projections
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => null));
      if (snapshot === null) return threadRoot === null ? [] : [threadRoot];
      const assistant: AssistantAccessView | null =
        deps.access === null
          ? null
          : yield* assistantOfThread({ ...deps.access, threads: snapshot.threads }, threadId);
      const reach =
        assistant === null || assistant.allowlist === "all"
          ? ("all" as const)
          : snapshot.projects
              .filter(
                (project) =>
                  project.id === assistant.projectId ||
                  (assistant.allowlist as ReadonlyArray<string>).includes(project.id),
              )
              .map((project) => project.workspaceRoot);
      return sendableRoots({
        threadRoot,
        home: deps.home,
        reach,
        allProjectRoots: snapshot.projects.map((project) => project.workspaceRoot),
      });
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

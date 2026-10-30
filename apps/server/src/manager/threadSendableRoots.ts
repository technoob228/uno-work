/**
 * The folders a chat may send files from to Telegram / Slack, as roots for
 * `resolveConnectorOutgoingFile` (see `connectorOutgoingFiles.ts`): the
 * chat's own folder; the folders of the chats it started; for the person's
 * own chats and assistants that reach every project, the person's folders and
 * all projects; for an assistant on "only selected projects", only those.
 *
 * @module manager/threadSendableRoots
 */
import type { ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { assistantOfThread, type AssistantAccessView } from "../assistants/assistantAccess.ts";
import { owningAssistant, readStartedChats } from "../assistants/localAssistantStore.ts";
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

/** Plenty for "the chat that just wrote it"; a relative path tries each. */
const MAX_CHILD_ROOTS = 20;

type ShellSnapshot = Effect.Success<ReturnType<ProjectionSnapshotQueryShape["getShellSnapshot"]>>;

/** The folders of the chats this one started, newest first. */
export const childFolders = (input: {
  readonly snapshot: ShellSnapshot;
  readonly threadId: ThreadId;
  /** The assistant of an assistant's conversation: every chat it started counts. */
  readonly assistantProjectId: string | null;
  readonly startedBy: ReadonlyMap<string, string>;
}): ReadonlyArray<string> => {
  const { snapshot, threadId, assistantProjectId, startedBy } = input;
  const byId = new Map<string, ShellSnapshot["threads"][number]>(
    snapshot.threads.map((thread) => [thread.id, thread]),
  );
  const projectRoot = new Map<string, string>(
    snapshot.projects.map((project) => [project.id, project.workspaceRoot]),
  );
  return snapshot.threads
    .filter(
      (thread) =>
        thread.id !== threadId &&
        (thread.spawnedByThreadId === threadId ||
          (assistantProjectId !== null &&
            thread.projectId !== assistantProjectId &&
            owningAssistant(thread, (id) => byId.get(id), startedBy) === assistantProjectId)),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((thread) => {
      const root = thread.worktreePath ?? projectRoot.get(thread.projectId);
      return root === undefined ? [] : [root];
    })
    .slice(0, MAX_CHILD_ROOTS);
};

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
      const self = snapshot.threads.find((thread) => thread.id === threadId);
      const conversationOf =
        assistant !== null && self?.projectId === assistant.projectId ? assistant.projectId : null;
      const startedBy =
        conversationOf !== null && deps.access !== null
          ? yield* Effect.promise(() => readStartedChats(deps.access!.stateDir)).pipe(
              Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
            )
          : new Map<string, string>();
      return sendableRoots({
        threadRoot,
        childRoots: childFolders({
          snapshot,
          threadId,
          assistantProjectId: conversationOf,
          startedBy,
        }),
        home: deps.home,
        reach,
        allProjectRoots: snapshot.projects.map((project) => project.workspaceRoot),
      });
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

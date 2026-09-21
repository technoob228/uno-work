import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
}

interface DraftThreadContextLike extends ThreadContextLike {
  envMode: DraftThreadEnvMode;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    },
  ): Promise<void>;
}

type NewThreadOptions = NonNullable<Parameters<NewThreadHandler>[1]>;

export interface ChatThreadActionContext {
  readonly activeDraftThread: DraftThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly handleNewThread: NewThreadHandler;
  readonly onMissingProject?: () => void;
  /**
   * The machine the person has selected. A new chat starts *there*: a thread
   * or draft still open from another machine, or a default project elsewhere,
   * must not pull it back to the primary machine. Unset = no preference.
   */
  readonly activeEnvironmentId?: EnvironmentId | null;
  /**
   * Makes a starter project on the selected machine when it has none yet
   * (a freshly connected box). Without it, an empty machine falls back to
   * `onMissingProject`.
   */
  readonly createStarterProject?: (environmentId: EnvironmentId) => Promise<ScopedProjectRef>;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  const activeEnvironmentId = context.activeEnvironmentId ?? null;
  const onSelectedMachine = (environmentId: EnvironmentId) =>
    activeEnvironmentId === null || environmentId === activeEnvironmentId;
  if (context.activeThread && onSelectedMachine(context.activeThread.environmentId)) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread && onSelectedMachine(context.activeDraftThread.environmentId)) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  if (context.defaultProjectRef && onSelectedMachine(context.defaultProjectRef.environmentId)) {
    return context.defaultProjectRef;
  }
  return null;
}

/** Only carry branch/worktree over from a thread on the machine the chat starts on. */
function contextOnMachine(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): ChatThreadActionContext {
  return {
    ...context,
    activeThread:
      context.activeThread?.environmentId === projectRef.environmentId
        ? context.activeThread
        : undefined,
    activeDraftThread:
      context.activeDraftThread?.environmentId === projectRef.environmentId
        ? context.activeDraftThread
        : null,
  };
}

async function resolveOrCreateThreadActionProjectRef(
  context: ChatThreadActionContext,
): Promise<ScopedProjectRef | null> {
  const resolved = resolveThreadActionProjectRef(context);
  if (resolved) return resolved;
  const activeEnvironmentId = context.activeEnvironmentId ?? null;
  if (activeEnvironmentId !== null && context.createStarterProject) {
    return context.createStarterProject(activeEnvironmentId);
  }
  return null;
}

function buildContextualThreadOptions(context: ChatThreadActionContext): NewThreadOptions {
  return {
    branch: context.activeThread?.branch ?? context.activeDraftThread?.branch ?? null,
    worktreePath:
      context.activeThread?.worktreePath ?? context.activeDraftThread?.worktreePath ?? null,
    envMode:
      context.activeDraftThread?.envMode ??
      (context.activeThread?.worktreePath ? "worktree" : "local"),
  };
}

function buildDefaultThreadOptions(context: ChatThreadActionContext): NewThreadOptions {
  return {
    envMode: context.defaultThreadEnvMode,
  };
}

export async function startNewThreadInProjectFromContext(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<void> {
  await context.handleNewThread(projectRef, buildContextualThreadOptions(context));
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = await resolveOrCreateThreadActionProjectRef(context);
  if (!projectRef) {
    context.onMissingProject?.();
    return false;
  }

  await startNewThreadInProjectFromContext(contextOnMachine(context, projectRef), projectRef);
  return true;
}

export async function startNewLocalThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = await resolveOrCreateThreadActionProjectRef(context);
  if (!projectRef) {
    context.onMissingProject?.();
    return false;
  }

  await context.handleNewThread(projectRef, buildDefaultThreadOptions(context));
  return true;
}

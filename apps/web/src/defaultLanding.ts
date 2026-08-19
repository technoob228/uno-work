/**
 * What the app should show when it opens with no thread in the URL.
 *
 * "Pick a thread to continue" is a dead end: the user has to make a choice
 * before doing anything. Instead, land on the most recently worked-on thread,
 * or — when there is nothing to resume — open a composer for the most relevant
 * project so the first keystroke starts the work.
 */

import type { ProjectId, EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface LandingThreadCandidate {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly latestUserMessageAt: string | null;
}

export interface LandingProjectCandidate {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  /** Key this project is stored under in the sidebar order (see getProjectOrderKey). */
  readonly orderKey?: string;
}

export type DefaultLandingTarget =
  | {
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "draft";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }
  | { readonly kind: "empty" };

function timestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Most recent human activity, falling back to thread updates and creation. */
export function landingThreadActivityAt(thread: LandingThreadCandidate): number {
  return Math.max(
    timestamp(thread.latestUserMessageAt),
    timestamp(thread.updatedAt),
    timestamp(thread.createdAt),
  );
}

export interface ResolveDefaultLandingInput {
  readonly threads: ReadonlyArray<LandingThreadCandidate>;
  readonly projects: ReadonlyArray<LandingProjectCandidate>;
  /** Environment the sidebar currently points at, when known. */
  readonly activeEnvironmentId?: EnvironmentId | null;
  /** Project ids in the user's preferred sidebar order. */
  readonly projectOrder?: ReadonlyArray<string>;
}

export function resolveDefaultLandingTarget(
  input: ResolveDefaultLandingInput,
): DefaultLandingTarget {
  const resumable = input.threads.filter((thread) => thread.archivedAt === null);

  if (resumable.length > 0) {
    const preferred = input.activeEnvironmentId
      ? resumable.filter((thread) => thread.environmentId === input.activeEnvironmentId)
      : [];
    const pool = preferred.length > 0 ? preferred : resumable;

    let best = pool[0]!;
    for (const thread of pool.slice(1)) {
      if (landingThreadActivityAt(thread) > landingThreadActivityAt(best)) {
        best = thread;
      }
    }
    return { kind: "thread", environmentId: best.environmentId, threadId: best.id };
  }

  const project = pickLandingProject(input);
  if (project) {
    return { kind: "draft", environmentId: project.environmentId, projectId: project.id };
  }

  return { kind: "empty" };
}

function pickLandingProject(
  input: ResolveDefaultLandingInput,
): LandingProjectCandidate | undefined {
  const inActiveEnvironment = input.activeEnvironmentId
    ? input.projects.filter((project) => project.environmentId === input.activeEnvironmentId)
    : [];
  const pool = inActiveEnvironment.length > 0 ? inActiveEnvironment : input.projects;
  if (pool.length === 0) return undefined;

  for (const preferredKey of input.projectOrder ?? []) {
    const match = pool.find(
      (project) => project.orderKey === preferredKey || project.id === preferredKey,
    );
    if (match) return match;
  }

  return pool[0];
}

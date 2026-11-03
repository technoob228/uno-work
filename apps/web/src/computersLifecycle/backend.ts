/**
 * Computers lifecycle: the parts that need a backend which doesn't exist yet
 * (SPEC "Порядок работ" 2–5) — the projects found on a computer and their
 * key names, syncing chosen projects and keys, a full computer's tunnel,
 * continuing a chat in the cloud, deleting a cloud computer from Work.
 *
 * In the demo each one is answered by `demo/assist/lifecycle.ts` through
 * `demoHooks.lc`; outside it they do the plain thing that exists today, or
 * nothing (the feature is off there, see flag.ts).
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { accountRequest } from "../account/unoAccount";
import { demoHooks } from "../demo/demoFlag";

export interface FoundProject {
  readonly name: string;
  readonly path: string;
  /** Names from the project's `.env`, never the values. Empty: no `.env`. */
  readonly keys: ReadonlyArray<string>;
  /** A chat found on the computer ran in it. */
  readonly fromChats: boolean;
}

export interface CloudContents {
  readonly apps: ReadonlyArray<string>;
  readonly sites: ReadonlyArray<string>;
}

export interface LifecycleDemoHooks {
  /** The person pressed Download or copied the command: the helper comes up in a moment. */
  installStarted(): void;
  /**
   * The desktop app makes this Mac one of the person's computers: a pair code
   * from their cloud computer, then the helper installed and paired locally.
   * Resolves with the new computer's id.
   */
  installHere(): Promise<string>;
  projects(computerId: string): ReadonlyArray<FoundProject>;
  bring(input: {
    computerId: string;
    purpose: "tool" | "full";
    projects: ReadonlyArray<{ name: string; keys: ReadonlyArray<string> }>;
  }): void;
  makeFull(computerId: string): Promise<string>;
  makeTool(computerId: string): Promise<void>;
  removeComputer(computerId: string): Promise<void>;
  continueInCloud(
    environmentId: string,
    threadId: string,
  ): Promise<{ environmentId: string; threadId: string }>;
  cloudContents(boxId: number): CloudContents | null;
  deleteBox(boxId: number): Promise<void>;
  sleepBox(boxId: number): Promise<void>;
  /** The chat shows "Waiting for …": the demo resumes it when the computer wakes. */
  waiting(environmentId: string, threadId: string): void;
}

function demo(): Partial<LifecycleDemoHooks> {
  return (demoHooks.lc ?? {}) as Partial<LifecycleDemoHooks>;
}

export const lifecycleBackend = {
  installStarted: () => demo().installStarted?.(),
  /** Null: this app can't set the Mac up by itself (not the desktop app, or no backend for it yet). */
  canInstallHere: () => demo().installHere !== undefined,
  installHere: async (): Promise<string | null> => (await demo().installHere?.()) ?? null,
  projects: (computerId: string): ReadonlyArray<FoundProject> =>
    demo().projects?.(computerId) ?? [],
  bring: (input: Parameters<LifecycleDemoHooks["bring"]>[0]) => demo().bring?.(input),
  /** A full computer: its chats start on it (the demo shows it as a computer of its own). */
  makeFull: async (computerId: string): Promise<string | null> =>
    (await demo().makeFull?.(computerId)) ?? null,
  makeTool: async (computerId: string) => {
    await demo().makeTool?.(computerId);
  },
  removeComputer: async (computerId: string) => {
    await demo().removeComputer?.(computerId);
  },
  canContinueInCloud: () => demo().continueInCloud !== undefined,
  continueInCloud: async (environmentId: EnvironmentId, threadId: string) =>
    (await demo().continueInCloud?.(environmentId, threadId)) ?? null,
  cloudContents: (boxId: number | null): CloudContents | null =>
    boxId === null ? null : (demo().cloudContents?.(boxId) ?? null),
  deleteBox: async (boxId: number) => {
    const hook = demo().deleteBox;
    if (hook) return hook(boxId);
    await accountRequest("DELETE", `/api/v1/boxes/${boxId}`);
  },
  sleepBox: async (boxId: number) => {
    const hook = demo().sleepBox;
    if (hook) return hook(boxId);
    await accountRequest("POST", `/api/v1/boxes/${boxId}/sleep`, {});
  },
  waiting: (environmentId: string, threadId: string) => demo().waiting?.(environmentId, threadId),
};

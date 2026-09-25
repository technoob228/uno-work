/**
 * What the guided setup leaves on Home:
 * - "Setup done" above the greeting (with "Finish N skipped steps"), until
 *   closed;
 * - "Working on <project>" under the greeting and the composer's folder set
 *   to that project;
 * - the project's three first tasks as the starters while it has no chats;
 * - the first task picked on the last setup step, typed into the composer.
 */
import { useMemo } from "react";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { HomeStarter } from "../computer/home/homeStarters";
import { FIRST_TASKS, SETUP_STEPS, parseWorkKind } from "./setupModel";
import { useSetupProgress } from "./useSetupProgress";

export interface SetupFolder {
  readonly cwd: string;
  readonly name: string;
}

interface SetupHandoffState {
  /** A task to type into Home's composer once, with its folder. */
  readonly pending: { readonly text: string; readonly folder: SetupFolder | null } | null;
  readonly handOff: (text: string, folder: SetupFolder | null) => void;
  readonly take: () => { readonly text: string; readonly folder: SetupFolder | null } | null;
}

export const useSetupHandoff = create<SetupHandoffState>((set, get) => ({
  pending: null,
  handOff: (text, folder) => set({ pending: { text, folder } }),
  take: () => {
    const pending = get().pending;
    if (pending) set({ pending: null });
    return pending;
  },
}));

const BANNER_KEY = "uno:setup:home-banner-closed";

export interface SetupHome {
  /** The setup's project (the AI path only). */
  readonly project: SetupFolder | null;
  /** Show "Setup done" on Home. */
  readonly banner: boolean;
  readonly closeBanner: () => void;
  /** Skipped steps still open. */
  readonly skippedCount: number;
  /** The project's first tasks, while it has no chats; empty otherwise. */
  readonly starters: ReadonlyArray<HomeStarter>;
  /** The project has no chats yet: Home leads with it. */
  readonly fresh: boolean;
}

export function useSetupHome(input: {
  /** Whether any chat already works in the setup's project. */
  readonly projectHasChats: (cwd: string) => boolean;
}): SetupHome {
  const progress = useSetupProgress();
  const [closed, setClosed] = useLocalStorage(BANNER_KEY, false, Schema.Boolean);
  const aiPath = progress.mode === "ai";
  const project = aiPath && progress.project ? progress.project : null;
  const skippedCount = SETUP_STEPS.filter((step) => progress.skipped.includes(step)).length;
  const hasChats = project ? input.projectHasChats(project.path) : true;
  const kind = parseWorkKind(project?.kind);
  const starters = useMemo<ReadonlyArray<HomeStarter>>(() => {
    if (!project || hasChats) return [];
    const folder = { cwd: project.path, name: project.name };
    return FIRST_TASKS[kind].map((task, index) => ({
      id: `setup-first-task-${index}`,
      label: task,
      prompt: task,
      source: "generic" as const,
      folder,
    }));
  }, [hasChats, kind, project]);
  return {
    project: project ? { cwd: project.path, name: project.name } : null,
    banner: aiPath && progress.finished && !progress.dismissed && !closed,
    closeBanner: () => setClosed(true),
    skippedCount,
    starters,
    fresh: project !== null && !hasChats,
  };
}

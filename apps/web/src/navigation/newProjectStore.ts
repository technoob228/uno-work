/**
 * "New project" dialog state, shared by every way in: the sidebar's New ▾, the
 * command palette's "New project", empty states, the rail, the start screen
 * (its Upload a project / drop zone) and the console's `?do=upload`. The old
 * T3 "Add project" palette flow is no longer reachable from the main UI (the
 * Labs legacy sidebar keeps it).
 */
import { create } from "zustand";

import type { NewProjectSource } from "../components/newProject/newProject.logic";
import type { ProjectUploadFile } from "../projectUpload";

export type NewProjectStep = "choose" | Exclude<NewProjectSource, "template">;

/** A project the Upload step just made. */
export interface UploadedProject {
  readonly name: string;
  /** Absolute folder on the computer. */
  readonly folder: string;
}

export interface NewProjectExtras {
  /** Files already dropped (the start screen's drop zone): Upload starts with them. */
  readonly files?: ReadonlyArray<ProjectUploadFile>;
  /**
   * Instead of an empty chat in the new project: e.g. the start screen sends
   * Uno a first task. Throwing falls back to the empty chat.
   */
  readonly afterUpload?: (project: UploadedProject) => Promise<void>;
}

interface NewProjectState {
  readonly open: boolean;
  readonly step: NewProjectStep;
  readonly files: ReadonlyArray<ProjectUploadFile> | null;
  readonly afterUpload: NewProjectExtras["afterUpload"] | null;
  readonly openNewProject: (step?: NewProjectStep, extras?: NewProjectExtras) => void;
  readonly setStep: (step: NewProjectStep) => void;
  /** The dropped files, once (the Upload step reads them when it mounts). */
  readonly takeFiles: () => ReadonlyArray<ProjectUploadFile> | null;
  readonly close: () => void;
}

export const useNewProjectStore = create<NewProjectState>((set, get) => ({
  open: false,
  step: "choose",
  files: null,
  afterUpload: null,
  openNewProject: (step = "choose", extras = {}) =>
    set({
      open: true,
      step,
      files: extras.files && extras.files.length > 0 ? extras.files : null,
      afterUpload: extras.afterUpload ?? null,
    }),
  setStep: (step) => set({ step }),
  takeFiles: () => {
    const files = get().files;
    if (files) set({ files: null });
    return files;
  },
  close: () => set({ open: false, files: null, afterUpload: null }),
}));

export function openNewProject(step?: NewProjectStep, extras?: NewProjectExtras): void {
  useNewProjectStore.getState().openNewProject(step, extras);
}

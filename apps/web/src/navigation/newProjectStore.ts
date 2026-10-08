/**
 * "New project" dialog state, shared by every way in: the sidebar's New ▾, the
 * command palette's "New project", empty states, the rail, the start screen
 * (its Upload a project / drop zone), the console's `?do=upload`, and the
 * "Home folder ▾" chip of a new chat (New folder… / Upload a folder… / Clone
 * from GitHub…, or a folder / .zip dropped on the chat box). The old T3 "Add
 * project" palette flow is no longer reachable from the main UI (the Labs
 * legacy sidebar keeps it).
 */
import type { ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { NewProjectSource } from "../components/newProject/newProject.logic";
import type { ProjectUploadFile } from "../projectUpload";

export type NewProjectStep = "choose" | Exclude<NewProjectSource, "template">;

/** A folder one of the steps just made (uploaded, cloned, created or picked). */
export interface CreatedProject {
  readonly name: string;
  /** Absolute folder on the computer. */
  readonly folder: string;
  /** Its project — already created, may not be in the store yet. */
  readonly projectRef: ScopedProjectRef;
}

/**
 * How the dialog talks: "project" from the sidebar and the palette; "folder"
 * from a chat's folder chip, where the word "project" never shows up.
 */
export type NewProjectWording = "project" | "folder";

export interface NewProjectExtras {
  /** Files already dropped (the start screen's drop zone): Upload starts with them. */
  readonly files?: ReadonlyArray<ProjectUploadFile>;
  /**
   * Instead of an empty chat in the new folder: e.g. the start screen sends
   * Uno a first task, the folder chip moves the chat being typed there.
   * Throwing falls back to the empty chat.
   */
  readonly afterCreate?: (project: CreatedProject) => Promise<void>;
  readonly wording?: NewProjectWording;
}

interface NewProjectState {
  readonly open: boolean;
  readonly step: NewProjectStep;
  readonly files: ReadonlyArray<ProjectUploadFile> | null;
  readonly afterCreate: NewProjectExtras["afterCreate"] | null;
  readonly wording: NewProjectWording;
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
  afterCreate: null,
  wording: "project",
  openNewProject: (step = "choose", extras = {}) =>
    set({
      open: true,
      step,
      files: extras.files && extras.files.length > 0 ? extras.files : null,
      afterCreate: extras.afterCreate ?? null,
      wording: extras.wording ?? "project",
    }),
  setStep: (step) => set({ step }),
  takeFiles: () => {
    const files = get().files;
    if (files) set({ files: null });
    return files;
  },
  close: () => set({ open: false, files: null, afterCreate: null }),
}));

export function openNewProject(step?: NewProjectStep, extras?: NewProjectExtras): void {
  useNewProjectStore.getState().openNewProject(step, extras);
}

/** A folder the chat chip offers to make: the matching step of the dialog. */
export type ChatFolderSource = "empty" | "upload" | "github";

/**
 * The folder chip of a new chat (Home's box or a new chat): make a folder in
 * `~/projects` — new, uploaded or cloned — and hand it to `onCreated` (the
 * chat moves there with what was typed) instead of opening another chat.
 */
export function openFolderForChat(
  source: ChatFolderSource,
  onCreated: (project: CreatedProject) => Promise<void> | void,
  files?: ReadonlyArray<ProjectUploadFile>,
): void {
  openNewProject(source, {
    wording: "folder",
    ...(files ? { files } : {}),
    afterCreate: async (project) => {
      await onCreated(project);
    },
  });
}

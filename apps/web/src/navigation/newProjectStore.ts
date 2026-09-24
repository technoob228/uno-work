/**
 * "New project" dialog state, shared by every way in: the sidebar's New ▾, the
 * command palette's "New project", empty states, the rail. The old T3 "Add
 * project" palette flow is no longer reachable from the main UI (the Labs
 * legacy sidebar keeps it).
 */
import { create } from "zustand";

import type { NewProjectSource } from "../components/newProject/newProject.logic";

export type NewProjectStep = "choose" | Exclude<NewProjectSource, "template">;

interface NewProjectState {
  readonly open: boolean;
  readonly step: NewProjectStep;
  readonly openNewProject: (step?: NewProjectStep) => void;
  readonly setStep: (step: NewProjectStep) => void;
  readonly close: () => void;
}

export const useNewProjectStore = create<NewProjectState>((set) => ({
  open: false,
  step: "choose",
  openNewProject: (step = "choose") => set({ open: true, step }),
  setStep: (step) => set({ step }),
  close: () => set({ open: false }),
}));

export function openNewProject(step?: NewProjectStep): void {
  useNewProjectStore.getState().openNewProject(step);
}

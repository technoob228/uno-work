/**
 * The mode picker (Misha 23.10: two modes — "Does it itself" / "Asks first",
 * the daemon's presets Full / Helper underneath) on an assistant's page and
 * in New assistant. The daemon enforces it (`@t3tools/shared/assistantPreset`
 * — the same table this file reads); here: the form, what is saved, how app
 * levels show under the cap, and when "Only selected projects" can hold.
 * Pure.
 */
import type {
  AssistantPreset,
  AssistantPresetAccess,
  ManagerCapabilityTokenDescriptor,
  ProjectId,
} from "@t3tools/contracts";
import {
  DEFAULT_ASSISTANT_PRESET,
  type AssistantMode,
  assistantModeOf,
  capAppLevel,
  presetConnectorCeiling,
  presetForMode,
  presetOfScopes,
} from "@t3tools/shared/assistantPreset";

import {
  allowlistFromScopeForm,
  scopeFormFromAllowlist,
  type AssistantScopeForm,
} from "../assistant/assistantScope.logic";
import type { ConnectorLevel } from "./assistantTemplates";

export interface PresetForm {
  readonly preset: AssistantPreset;
  /** Every project, or the ticked ones — whatever the mode. */
  readonly scope: AssistantScopeForm;
}

/** A new assistant: Full on every project (decision 14.10: full by default). */
export const DEFAULT_PRESET_FORM: PresetForm = {
  preset: DEFAULT_ASSISTANT_PRESET,
  scope: { mode: "all", selected: new Set() },
};

/** The form of what the assistant's token says now (no token yet: the default). */
export function presetFormFromToken(
  token: Pick<ManagerCapabilityTokenDescriptor, "scopes" | "projectAllowlist"> | null | undefined,
): PresetForm {
  if (!token) return DEFAULT_PRESET_FORM;
  return {
    preset: presetOfScopes(token.scopes),
    scope: scopeFormFromAllowlist(token.projectAllowlist),
  };
}

/** The mode the picker shows. */
export function modeOfForm(form: PresetForm): AssistantMode {
  return assistantModeOf(form.preset);
}

/** Picking a mode; its projects stay as they are. */
export function withMode(form: PresetForm, mode: AssistantMode): PresetForm {
  return { ...form, preset: presetForMode(mode, form.preset) };
}

/** What is saved (the daemon adds the assistant's own workspace itself). */
export function presetAccessFromForm(form: PresetForm): AssistantPresetAccess {
  return {
    preset: form.preset,
    projects: allowlistFromScopeForm(form.scope) as AssistantPresetAccess["projects"],
  };
}

export function samePresetForm(a: PresetForm, b: PresetForm): boolean {
  const left = presetAccessFromForm(a);
  const right = presetAccessFromForm(b);
  if (left.preset !== right.preset) return false;
  if (left.projects === "all" || right.projects === "all") return left.projects === right.projects;
  return (
    left.projects.length === right.projects.length &&
    left.projects.every((id: ProjectId) => right.projects.includes(id))
  );
}

/** The highest level an app may be set to under this preset. */
export function levelCeiling(preset: AssistantPreset): ConnectorLevel {
  return presetConnectorCeiling(preset);
}

/** The level the assistant actually gets: what the person picked, at most the cap. */
export function effectiveLevel(level: ConnectorLevel, preset: AssistantPreset): ConnectorLevel {
  return capAppLevel(level, preset);
}

/** One line under the picker for the projects part. */
export function projectsLine(form: PresetForm, name: string): string {
  if (form.scope.mode === "all") return `${name} works in every project.`;
  const count = form.scope.selected.size;
  if (count === 0) return `${name} sees only its own chats. Tick the projects it may work in.`;
  return count === 1 ? `${name} works in 1 project.` : `${name} works in ${count} projects.`;
}

/**
 * "Only selected projects" holds where something keeps the assistant out of
 * the rest: a sandbox on this computer (`assistantSandbox`), or a computer of
 * its own. Without either, on this computer it sees every file — the picker
 * says so instead of offering a limit that isn't one.
 */
export function projectsChoice(input: {
  readonly sandbox: boolean;
  readonly ownComputer: boolean;
  readonly scope: AssistantScopeForm;
}): { readonly canPickSome: boolean; readonly note: string | null } {
  if (input.sandbox || input.ownComputer) return { canPickSome: true, note: null };
  if (input.scope.mode === "only") {
    return {
      canPickSome: true,
      note: "Chats it starts stay in these projects, but on this computer it can still read every file. For a real limit, give it its own computer.",
    };
  }
  return {
    canPickSome: false,
    note: "Sees everything on this computer. Only selected projects needs its own computer.",
  };
}

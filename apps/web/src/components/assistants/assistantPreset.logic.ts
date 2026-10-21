/**
 * The preset picker (Full / Helper / Observer, decision 21.10) on the page of
 * an assistant on this computer and in New assistant. The daemon enforces the
 * preset (`@t3tools/shared/assistantPreset` — the same table this file reads);
 * here: the form, what is saved, and how app levels show under the cap.
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
  capAppLevel,
  presetConnectorCeiling,
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
  /** Full: all projects or ticked ones; Helper and Observer: always the ticked ones. */
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

/** Helper and Observer work only in projects the person picks. */
export function presetNeedsProjects(preset: AssistantPreset): boolean {
  return preset !== "full";
}

/** Switching the preset: Helper and Observer start from the ticked projects (none yet = none). */
export function withPreset(form: PresetForm, preset: AssistantPreset): PresetForm {
  if (!presetNeedsProjects(preset)) return { ...form, preset };
  return { preset, scope: { mode: "only", selected: form.scope.selected } };
}

/** What is saved (the daemon adds the assistant's own workspace itself). */
export function presetAccessFromForm(form: PresetForm): AssistantPresetAccess {
  const scope: AssistantScopeForm = presetNeedsProjects(form.preset)
    ? { mode: "only", selected: form.scope.selected }
    : form.scope;
  return {
    preset: form.preset,
    projects: allowlistFromScopeForm(scope) as AssistantPresetAccess["projects"],
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
  if (!presetNeedsProjects(form.preset) && form.scope.mode === "all") {
    return `${name} works in every project.`;
  }
  const count = form.scope.selected.size;
  if (count === 0) return `${name} sees only its own chats. Tick the projects it may work in.`;
  return count === 1 ? `${name} works in 1 project.` : `${name} works in ${count} projects.`;
}

/**
 * Settings → Assistant → "Can see and manage" (0.0.85): All projects, or
 * only the ones ticked. Stored as the assistant token's project allowlist —
 * the daemon enforces it in uno-manager and in the uno-work chat tools. The
 * assistant's own workspace is always in (its conversations live there), so
 * it is neither listed nor removable here. Pure.
 */
import { isAssistantProjectId } from "@t3tools/contracts";

export type AssistantScopeMode = "all" | "only";

export interface AssistantScopeForm {
  readonly mode: AssistantScopeMode;
  readonly selected: ReadonlySet<string>;
}

export function scopeFormFromAllowlist(
  allowlist: "all" | ReadonlyArray<string> | null | undefined,
): AssistantScopeForm {
  if (allowlist === undefined || allowlist === null || allowlist === "all") {
    return { mode: "all", selected: new Set() };
  }
  return {
    mode: "only",
    selected: new Set(allowlist.filter((projectId) => !isAssistantProjectId(projectId))),
  };
}

/** What is saved; the daemon adds the assistant's own workspace itself. */
export function allowlistFromScopeForm(form: AssistantScopeForm): "all" | ReadonlyArray<string> {
  return form.mode === "all" ? "all" : [...form.selected].toSorted();
}

/** Projects the picker lists: everything but the assistant workspaces. */
export function pickableProjects<T extends { readonly id: string; readonly title: string }>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return projects
    .filter((project) => !isAssistantProjectId(project.id))
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

/** One line for the current choice. */
export function describeScope(form: AssistantScopeForm): string {
  if (form.mode === "all") return "Uno can see and manage chats in every project.";
  if (form.selected.size === 0) {
    return "Uno sees only its own conversations. Tick projects it may work in.";
  }
  return form.selected.size === 1
    ? "Uno can see and manage chats in 1 project."
    : `Uno can see and manage chats in ${form.selected.size} projects.`;
}

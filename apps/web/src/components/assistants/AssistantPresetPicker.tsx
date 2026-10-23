/**
 * "What {name} may do" (Misha 23.10): two modes — "Does it itself" and "Asks
 * first" — as two small chips with the picked one's line under them, the
 * exact list of what it asks before under "Details", and its projects: every
 * project, or only the ticked ones where that limit holds (a sandbox here,
 * or a computer of its own — `projectsChoice`). Used on an assistant's page
 * and in New assistant. The daemon enforces the mode; the honest line says
 * what that is worth on a shared computer.
 */
import {
  ASSISTANT_MODES,
  ASSISTANT_MODE_COPY,
  ASSISTANT_PRESET_BOUNDARY_LINE,
  ASSISTANT_PRESET_COPY,
  type AssistantMode,
} from "@t3tools/shared/assistantPreset";
import { ChevronDownIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";

import { pickableProjects } from "../assistant/assistantScope.logic";
import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import {
  modeOfForm,
  projectsChoice,
  projectsLine,
  withMode,
  type PresetForm,
} from "./assistantPreset.logic";

export function AssistantPresetPicker({
  name,
  value,
  onChange,
  projects,
  disabled = false,
  sandbox = false,
  ownComputer = false,
  testId = "assistant-preset",
}: {
  name: string;
  value: PresetForm;
  onChange: (next: PresetForm) => void;
  /** Projects of this computer (assistant workspaces are left out here). */
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  disabled?: boolean;
  /** This computer can hold an assistant to its projects (`assistantSandbox`). */
  sandbox?: boolean;
  /** It lives on a computer of its own: its projects are all it has. */
  ownComputer?: boolean;
  testId?: string;
}) {
  const [details, setDetails] = useState(false);
  const listed = pickableProjects(projects);
  const mode = modeOfForm(value);
  const choice = projectsChoice({ sandbox, ownComputer, scope: value.scope });
  // An Observer set up before the two modes keeps its read-only rules.
  const readOnly = value.preset === "observer";

  const setScope = (scopeMode: "all" | "only") =>
    onChange({ ...value, scope: { mode: scopeMode, selected: value.scope.selected } });
  const toggleProject = (projectId: string, on: boolean) => {
    const selected = new Set(value.scope.selected);
    if (on) selected.add(projectId);
    else selected.delete(projectId);
    onChange({ ...value, scope: { mode: "only", selected } });
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`What ${name} may do`}>
        {ASSISTANT_MODES.map((option: AssistantMode) => {
          const selected = mode === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(withMode(value, option))}
              data-testid={`${testId}-${option}`}
              className={cn(
                "h-6 cursor-pointer rounded-md border px-2 text-xs transition-colors disabled:cursor-default disabled:opacity-60",
                selected
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {ASSISTANT_MODE_COPY[option].name}
            </button>
          );
        })}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground" data-testid={`${testId}-line`}>
        {readOnly ? ASSISTANT_PRESET_COPY.observer.line : ASSISTANT_MODE_COPY[mode].line}
      </p>

      <button
        type="button"
        className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setDetails((open) => !open)}
        aria-expanded={details}
        data-testid={`${testId}-details-toggle`}
      >
        {mode === "asks-first" && !readOnly ? "What it asks you before" : "Details"}
        <ChevronDownIcon className={cn("size-3.5 transition-transform", details && "rotate-180")} />
      </button>
      {details ? (
        <ul
          className="ml-1 flex flex-col gap-1 text-xs text-muted-foreground"
          data-testid={`${testId}-details`}
        >
          {(readOnly ? ASSISTANT_PRESET_COPY.observer : ASSISTANT_MODE_COPY[mode]).details.map(
            (line) => (
              <li key={line}>· {line}</li>
            ),
          )}
          {readOnly ? <li>· Set up before the two modes. Pick a mode to change it.</li> : null}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1.5 pt-1" data-testid={`${testId}-projects`}>
        <span className="text-xs font-medium">Projects</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Projects">
          {(
            [
              ["all", "All projects"],
              ["only", "Only selected projects"],
            ] as const
          ).map(([scopeMode, label]) => {
            const selected = value.scope.mode === scopeMode;
            const unavailable = scopeMode === "only" && !choice.canPickSome;
            return (
              <button
                key={scopeMode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled || unavailable}
                onClick={() => setScope(scopeMode)}
                data-testid={`${testId}-projects-${scopeMode}`}
                className={cn(
                  "h-6 cursor-pointer rounded-md border px-2 text-xs transition-colors disabled:cursor-default disabled:opacity-50",
                  selected
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        {value.scope.mode === "only" ? (
          listed.length === 0 ? (
            <span className="text-xs text-muted-foreground">No projects on this computer yet.</span>
          ) : (
            <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
              {listed.map((project) => {
                const id = `${testId}-project-${project.id}`;
                return (
                  <li key={project.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={id}
                      checked={value.scope.selected.has(project.id)}
                      disabled={disabled}
                      onCheckedChange={(checked) => toggleProject(project.id, checked === true)}
                    />
                    <label htmlFor={id} className="cursor-pointer truncate">
                      {project.title}
                    </label>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-projects-note`}>
          {choice.note ?? projectsLine(value, name)}
        </span>
      </div>

      <p
        className="flex gap-1.5 pt-1 text-xs text-muted-foreground"
        data-testid={`${testId}-honest`}
      >
        <ShieldIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>{ASSISTANT_PRESET_BOUNDARY_LINE}</span>
      </p>
    </div>
  );
}

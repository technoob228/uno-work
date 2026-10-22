/**
 * "What {name} may do": Full / Helper / Observer as three small chips with
 * the picked one's line under them (the prototype's row), the details under
 * "Details", and for Helper and Observer the projects it works
 * in. Used on an assistant's page and in New assistant (assistant on this
 * computer). Work on this computer enforces it; the honest line says what
 * that is worth.
 */
import type { AssistantPreset } from "@t3tools/contracts";
import {
  ASSISTANT_PRESETS,
  ASSISTANT_PRESET_BOUNDARY_LINE,
  ASSISTANT_PRESET_COPY,
} from "@t3tools/shared/assistantPreset";
import { ChevronDownIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";

import { pickableProjects } from "../assistant/assistantScope.logic";
import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import {
  presetNeedsProjects,
  projectsLine,
  withPreset,
  type PresetForm,
} from "./assistantPreset.logic";

export function AssistantPresetPicker({
  name,
  value,
  onChange,
  projects,
  disabled = false,
  testId = "assistant-preset",
}: {
  name: string;
  value: PresetForm;
  onChange: (next: PresetForm) => void;
  /** Projects of this computer (assistant workspaces are left out here). */
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  disabled?: boolean;
  testId?: string;
}) {
  const [details, setDetails] = useState(false);
  const listed = pickableProjects(projects);
  const needsProjects = presetNeedsProjects(value.preset);

  const toggleProject = (projectId: string, on: boolean) => {
    const selected = new Set(value.scope.selected);
    if (on) selected.add(projectId);
    else selected.delete(projectId);
    onChange({ preset: value.preset, scope: { mode: "only", selected } });
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {/* The prototype's row (w0138 p7): three small chips, one line under them. */}
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`What ${name} may do`}>
        {ASSISTANT_PRESETS.map((preset: AssistantPreset) => {
          const selected = value.preset === preset;
          return (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(withPreset(value, preset))}
              data-testid={`${testId}-${preset}`}
              className={cn(
                "h-6 cursor-pointer rounded-md border px-2 text-xs transition-colors disabled:cursor-default disabled:opacity-60",
                selected
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {ASSISTANT_PRESET_COPY[preset].name}
            </button>
          );
        })}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground" data-testid={`${testId}-line`}>
        {ASSISTANT_PRESET_COPY[value.preset].line}
      </p>

      <button
        type="button"
        className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setDetails((open) => !open)}
        aria-expanded={details}
        data-testid={`${testId}-details-toggle`}
      >
        Details
        <ChevronDownIcon className={cn("size-3.5 transition-transform", details && "rotate-180")} />
      </button>
      {details ? (
        <ul
          className="ml-1 flex flex-col gap-1 text-xs text-muted-foreground"
          data-testid={`${testId}-details`}
        >
          {ASSISTANT_PRESET_COPY[value.preset].details.map((line) => (
            <li key={line}>· {line}</li>
          ))}
          <li>· Never spends money, changes your account or deletes computers.</li>
        </ul>
      ) : null}

      {needsProjects ? (
        <div className="flex flex-col gap-1.5 pt-1" data-testid={`${testId}-projects`}>
          <span className="text-xs font-medium">Projects {name} works in</span>
          {listed.length === 0 ? (
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
          )}
          <span className="text-xs text-muted-foreground">{projectsLine(value, name)}</span>
        </div>
      ) : null}

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

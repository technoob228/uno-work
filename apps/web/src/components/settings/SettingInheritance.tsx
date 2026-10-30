/**
 * The small layers icon on a row: where the value comes from, on each computer
 * in the scope. Ported from T3 Code, without the t3.json layer and with the
 * app's own layer for the new-chat model.
 *
 * @module components/settings/SettingInheritance
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { CheckIcon, ChevronRightIcon, LayersIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { CHAT_WORKSPACE_MODE_LABELS, PERMISSION_MODES } from "../../plainLanguage";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type ScopedEnvironment, useOptionalSettingsScope } from "./SettingsScopeContext";
import {
  isProjectScopedSettingKey,
  type ProjectOverrideEntry,
  type ScopedSettingsTarget,
} from "./scopedSettings";

export interface InheritanceLayer {
  readonly key: "project" | "environment" | "app" | "built-in";
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

const BRANCH_NAMING_LABELS: Readonly<Record<string, string>> = {
  static: "Static prefix",
  semantic: "Semantic prefix",
  custom: "Custom instructions",
};

export function formatSettingValue(key: keyof ServerSettings, value: unknown): string {
  if (value === null || value === undefined) {
    return key === "defaultModelSelection" ? "Last picked" : "Not set";
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") {
    if (key === "defaultRuntimeMode") return PERMISSION_MODES[value as RuntimeMode].label;
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return CHAT_WORKSPACE_MODE_LABELS[value];
    }
    if (key === "branchNamingMode") return BRANCH_NAMING_LABELS[value] ?? value;
    return value === "" ? "Empty" : value;
  }
  if (typeof value === "object" && "model" in value && typeof value.model === "string") {
    return value.model;
  }
  return "Custom";
}

/** Most specific first; the order new chats and the server read them in. */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  computerSettings: ServerSettings,
  key: keyof ServerSettings,
  appModel: ModelSelection | null = null,
): readonly InheritanceLayer[] {
  const computerValue = computerSettings[key];
  const projectSet = isProjectScopedSettingKey(key) && target.sources[key] === "project";
  const computerSet = !Equal.equals(computerValue, DEFAULT_SERVER_SETTINGS[key]);
  const hasAppLayer = key === "defaultModelSelection";
  const layers: InheritanceLayer[] = [];
  if (target.projectId !== null && isProjectScopedSettingKey(key)) {
    layers.push({
      key: "project",
      label: "This project",
      value: projectSet ? formatSettingValue(key, target.settings[key]) : "Inherits",
      effective: projectSet,
      set: projectSet,
    });
  }
  layers.push({
    key: "environment",
    label: "This computer",
    value: computerSet ? formatSettingValue(key, computerValue) : "Inherits",
    effective: !projectSet && computerSet,
    set: computerSet,
  });
  if (hasAppLayer) {
    layers.push({
      key: "app",
      label: "All computers",
      value: appModel ? formatSettingValue(key, appModel) : "Inherits",
      effective: !projectSet && !computerSet && appModel !== null,
      set: appModel !== null,
    });
  }
  layers.push({
    key: "built-in",
    label: "Default",
    value: formatSettingValue(key, DEFAULT_SERVER_SETTINGS[key]),
    effective: !projectSet && !computerSet && !(hasAppLayer && appModel !== null),
    set: true,
  });
  return layers;
}

export type SettingInheritanceState =
  | "default"
  | "environment"
  | "inherited"
  | "overridden"
  | "mixed";

export interface SettingOverridingProject extends ProjectOverrideEntry {
  readonly label: string;
  readonly open: () => void;
}

function LayerChain({ layers }: { readonly layers: readonly InheritanceLayer[] }) {
  return (
    <ol role="list" className="text-sm">
      {layers.map((layer) => (
        <li
          key={layer.key}
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
            layer.effective && "bg-foreground/[0.06]",
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate",
              layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {layer.label}
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 tabular-nums",
              layer.effective
                ? "text-foreground"
                : layer.set
                  ? "text-muted-foreground"
                  : "text-muted-foreground/60",
            )}
          >
            <span className="max-w-36 truncate">{layer.value}</span>
            {layer.effective ? (
              <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
            ) : (
              <span aria-hidden className="size-3.5 shrink-0" />
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function SettingInheritance({
  state,
  summary,
  targets,
  environments,
  settingKey,
  appModel,
  overridingProjects = [],
  onClearOverrides,
}: {
  readonly state: SettingInheritanceState;
  readonly summary: string;
  readonly targets: readonly ScopedSettingsTarget[];
  readonly environments: readonly ScopedEnvironment[];
  readonly settingKey: keyof ServerSettings;
  readonly appModel: ModelSelection | null;
  readonly overridingProjects?: readonly SettingOverridingProject[];
  readonly onClearOverrides?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  const context = useOptionalSettingsScope();
  const unreachable = context?.unreachableEnvironments ?? [];
  if (targets.length === 0 && unreachable.length === 0) return null;
  const multiple = new Set(targets.map((target) => target.environmentId)).size > 1;
  const fullSummary =
    overridingProjects.length > 0
      ? `${summary} · ${overridingProjects.length} ${overridingProjects.length === 1 ? "project differs" : "projects differ"}`
      : summary;
  const chains = targets.flatMap((target) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === target.environmentId,
    );
    if (!environment?.serverConfig) return [];
    const layers = settingInheritanceLayers(
      target,
      environment.serverConfig.settings,
      settingKey,
      appModel,
    );
    const winner = layers.find((layer) => layer.effective);
    return [
      {
        id: `${target.environmentId}:${target.projectId ?? ""}`,
        target,
        kind: environment.kind,
        overrides: environment.serverConfig.settings.projectSettingsOverrides,
        layers,
        winner,
        resolution: {
          winner: winner?.key,
          layers: layers.map((layer) => [layer.key, layer.value]),
        },
      },
    ];
  });
  const groups: (typeof chains)[] = [];
  for (const chain of chains) {
    const group = groups.find(
      ([first]) => first && Equal.equals(first.resolution, chain.resolution),
    );
    if (group) group.push(chain);
    else groups.push([chain]);
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`${fullSummary}. Show where this value comes from`}
                  data-testid="settings-inheritance"
                />
              }
            />
          }
        >
          <LayersIcon
            className={cn(
              "size-3",
              state === "overridden" && "text-primary",
              state === "mixed" && "text-amber-600 dark:text-amber-400",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{fullSummary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="-mx-2 -my-2 divide-y divide-border/60">
          {groups.map((members) => {
            const first = members[0];
            if (!first) return null;
            const overriding = overridingProjects.filter((project) =>
              members.some((member) => member.target.environmentId === project.environmentId),
            );
            return (
              <section key={first.id} className="px-2 py-2">
                {multiple && groups.length > 1 ? (
                  <Collapsible>
                    <CollapsibleTrigger
                      render={<Button variant="ghost" size="sm" className="h-auto w-full py-1.5" />}
                    >
                      <span className="flex w-full min-w-0 flex-col text-left">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {first.winner?.value}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {first.winner?.label}
                          </span>
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3 shrink-0 text-muted-foreground [[data-panel-open]_&]:rotate-90"
                          />
                        </span>
                        {members.map((member) => {
                          const Icon = MACHINE_KIND_ICON[member.kind];
                          return (
                            <span
                              key={member.id}
                              className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
                            >
                              <Icon className="size-3 shrink-0" />
                              <span className="truncate">{member.target.label}</span>
                            </span>
                          );
                        })}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="pt-1.5">
                        <LayerChain layers={first.layers} />
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                ) : (
                  <>
                    <h4 className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-muted-foreground">
                      {multiple ? (
                        "Same on all computers"
                      ) : (
                        <span className="min-w-0 truncate">{first.target.label}</span>
                      )}
                    </h4>
                    <LayerChain layers={first.layers} />
                  </>
                )}
                {overriding.length > 0 ? (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
                      <span>Projects with their own value</span>
                      {onClearOverrides ? (
                        <InlineButton onClick={() => onClearOverrides(overriding)}>
                          Reset {overriding.length === 1 ? "it" : "all"}
                        </InlineButton>
                      ) : null}
                    </div>
                    <ul role="list" className="mt-0.5 max-h-48 overflow-y-auto text-sm">
                      {overriding.map((project) => (
                        <li
                          key={`${project.environmentId}:${project.projectId}`}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1"
                        >
                          <InlineButton
                            className="min-w-0 max-w-full justify-start"
                            onClick={project.open}
                          >
                            <span className="truncate">{project.label}</span>
                          </InlineButton>
                          <span className="max-w-32 truncate text-muted-foreground tabular-nums">
                            {isProjectScopedSettingKey(settingKey)
                              ? formatSettingValue(
                                  settingKey,
                                  members.find(
                                    (member) =>
                                      member.target.environmentId === project.environmentId,
                                  )?.overrides[project.projectId]?.[settingKey],
                                )
                              : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            );
          })}
          {unreachable.length > 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              Not shown: {unreachable.map((entry) => entry.label).join(", ")}{" "}
              {unreachable.length === 1 ? "is" : "are"} off.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

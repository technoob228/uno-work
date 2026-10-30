import type { ProjectScopedServerSettingKey, ServerSettings } from "@t3tools/contracts";
import { Undo2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { plainLabel } from "../../plainLanguage";
import { Explain } from "../Explain";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingInheritance,
  type SettingInheritanceState,
  type SettingOverridingProject,
} from "./SettingInheritance";
import { type SettingsScopeValue, useOptionalSettingsScope } from "./SettingsScopeContext";
import {
  isProjectScopedSettingKey,
  listProjectOverrides,
  scopedSettingsAreMixed,
  scopedSettingsSource,
} from "./scopedSettings";
import { useClearProjectOverrides, useClearScopedSettings } from "./useScopedSettings";
import { useSettingsScopeBadge } from "./useSettingsScope";

/**
 * Where a section's settings live: everywhere this app runs, or on one named
 * machine. Reads the scope the Settings layout provides, so every section
 * header inside Settings carries it and nothing outside Settings does.
 */
function SettingsScopeBadge() {
  const info = useSettingsScopeBadge();
  if (!info) return null;
  const term = info.kind === "app" ? "settingsScopeApp" : "settingsScopeMachine";
  const text =
    info.kind === "app"
      ? `${plainLabel("settingsScopeApp")} (this app)`
      : `${plainLabel("settingsScopeMachine")}: ${info.machineLabel}`;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 normal-case tracking-normal">
      <Badge
        variant="outline"
        size="sm"
        className="max-w-56 truncate font-medium text-muted-foreground"
        title={text}
      >
        {text}
      </Badge>
      <Explain term={term} />
    </span>
  );
}

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  icon,
  titleAddon,
  headerAction,
  children,
}: {
  title: string;
  icon?: ReactNode;
  /** Rendered right after the title — typically an `<Explain />` for the section's concept. */
  titleAddon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex h-5 items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
          <span className="inline-block h-px w-3 bg-border" aria-hidden />
          {icon}
          {title}
          {titleAddon}
        </h2>
        <div className="flex h-5 min-w-5 items-center justify-end gap-2">
          <SettingsScopeBadge />
          {headerAction}
        </div>
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:shadow-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

function overridingProjects(
  context: SettingsScopeValue,
  keys: readonly ProjectScopedServerSettingKey[],
): readonly SettingOverridingProject[] {
  return listProjectOverrides(context.connectedEnvironments, keys).flatMap((entry) => {
    const group = context.groups.find((candidate) =>
      candidate.memberProjects.some(
        (member) => member.id === entry.projectId && member.environmentId === entry.environmentId,
      ),
    );
    if (!group) return [];
    return [
      {
        ...entry,
        label: group.displayName,
        open: () =>
          context.selectScope({ project: group.projectKey, machine: entry.environmentId }),
      },
    ];
  });
}

/**
 * The reset and the source icon of a row tied to settings keys. On a project a
 * reset drops the project's own value; elsewhere the row's own reset stands.
 */
function ScopedRowMarks({
  settingKeys,
  title,
  mixed: mixedOverride,
  resetAction,
}: {
  readonly settingKeys: readonly (keyof ServerSettings)[];
  readonly title: ReactNode;
  readonly mixed: boolean | undefined;
  readonly resetAction: ReactNode;
}) {
  const context = useOptionalSettingsScope();
  const clearOverrides = useClearScopedSettings();
  const clearProjectOverrides = useClearProjectOverrides();
  const appModel = useSettings((settings) => settings.newChatModelSelection);
  const firstKey = settingKeys[0];
  if (context === null || firstKey === undefined) return resetAction;
  const isProjectScope = context.scope.kind === "project";
  const scopedKeys = settingKeys.filter(isProjectScopedSettingKey);
  const mixed = mixedOverride ?? scopedSettingsAreMixed(context.targets, settingKeys);
  const source = isProjectScope ? scopedSettingsSource(context.targets, scopedKeys) : null;
  const projects = isProjectScope ? [] : overridingProjects(context, scopedKeys);
  const reset =
    isProjectScope && scopedKeys.length > 0 ? (
      source === "project" || source === "mixed" ? (
        <SettingResetButton
          label={typeof title === "string" ? title : "value"}
          tooltip="Reset to inherited value"
          onClick={() => clearOverrides(scopedKeys)}
        />
      ) : null
    ) : (
      resetAction
    );
  const computerLabel = context.target?.label ?? "this computer";
  const inheritance: { state: SettingInheritanceState; summary: string } = mixed
    ? { state: "mixed", summary: "Different across these computers" }
    : source === "project"
      ? { state: "overridden", summary: "Set for this project" }
      : source === "environment"
        ? { state: "inherited", summary: `Inherited from ${computerLabel}` }
        : { state: "default", summary: "Where this value comes from" };
  // One computer, no project picked and no project with its own value: nothing to tell.
  const showMarker = !context.singleComputer || isProjectScope || projects.length > 0;
  return (
    <>
      {reset}
      {showMarker ? (
        <SettingInheritance
          state={inheritance.state}
          summary={inheritance.summary}
          targets={context.targets}
          environments={context.connectedEnvironments}
          settingKey={firstKey}
          appModel={appModel}
          overridingProjects={projects}
          onClearOverrides={(entries) => clearProjectOverrides(entries, scopedKeys)}
        />
      ) : null}
    </>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  settingKeys,
  mixed,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  /** The setting this row edits: adds the source icon and the reset to inherited. */
  settingKeys?: readonly (keyof ServerSettings)[];
  /** Set when the row works out "different across computers" on its own. */
  mixed?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-t border-border/60 px-4 first:border-t-0 sm:px-5",
        children ? "pt-4 pb-0" : "py-4",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h3>
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5">
              {settingKeys ? (
                <ScopedRowMarks
                  settingKeys={settingKeys}
                  title={title}
                  mixed={mixed}
                  resetAction={resetAction}
                />
              ) : (
                resetAction
              )}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground/80">{description}</p>
          {status ? <div className="pt-0.5 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({
  label,
  onClick,
  tooltip = "Reset to default",
}: {
  label: string;
  onClick: () => void;
  tooltip?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${tooltip}: ${label}`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto p-6 sm:p-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">{children}</div>
    </div>
  );
}

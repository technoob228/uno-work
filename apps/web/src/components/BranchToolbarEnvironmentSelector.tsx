import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  const isRemote = activeEnvironment?.isPrimary === false;
  const remoteAccentClasses =
    "border-primary/40 bg-primary/8 text-primary [&_svg]:opacity-100! [&_svg]:text-primary";

  if (envLocked) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs",
          isRemote && remoteAccentClasses,
        )}
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon className="size-3" />
        ) : (
          <CloudIcon className="size-3" />
        )}
        {activeEnvironment?.label ?? "Run on"}
        {isRemote ? (
          <span className="ml-1 rounded bg-primary/16 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary">
            Remote
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className={cn("font-medium", isRemote && remoteAccentClasses)}
        aria-label="Run on"
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon className="size-3" />
        ) : (
          <CloudIcon className="size-3" />
        )}
        <SelectValue />
        {isRemote ? (
          <span className="ml-1 rounded bg-primary/16 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary">
            Remote
          </span>
        ) : null}
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {env.isPrimary ? (
                  <MonitorIcon className="size-3" />
                ) : (
                  <CloudIcon className="size-3" />
                )}
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

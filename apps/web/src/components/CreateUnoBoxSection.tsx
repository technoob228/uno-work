/**
 * "Create a new box" — shared by the add-environment modal and the
 * "Move to a box…" dialog.
 *
 * Creating a box is billable, so the submit path is guarded twice: the button
 * is disabled while the mutation is pending, and the mutation itself is keyed
 * per environment so two mounted copies of this component cannot both fire.
 */
import type { EnvironmentId, UnoBoxCreateJobStatus } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, ServerIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "../lib/utils";
import { unoCloudCreateBoxMutationOptions } from "../lib/workspaceReactQuery";
import {
  UNO_BOX_NAME_MAX_LENGTH,
  UNO_BOX_SIZE_PRESETS,
  describeUnoBoxCreateJobState,
  normalizeUnoBoxName,
  type CreateUnoBoxResult,
  type UnoBoxSizePreset,
} from "../unoBoxCreation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const PRESET_ORDER: ReadonlyArray<UnoBoxSizePreset> = ["small", "medium"];

interface CreateUnoBoxSectionProps {
  /** Environment holding the Uno account (normally the primary one). */
  readonly environmentId: EnvironmentId | null;
  readonly defaultName?: string;
  readonly submitLabel?: string;
  readonly onCreated: (result: CreateUnoBoxResult) => void | Promise<void>;
  /** Disables the form while an enclosing flow is busy. */
  readonly disabled?: boolean;
}

export function CreateUnoBoxSection({
  environmentId,
  defaultName,
  submitLabel = "Create box",
  onCreated,
  disabled = false,
}: CreateUnoBoxSectionProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => normalizeUnoBoxName(defaultName ?? ""));
  const [preset, setPreset] = useState<UnoBoxSizePreset>("small");
  const [progress, setProgress] = useState<UnoBoxCreateJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createBox = useMutation(unoCloudCreateBoxMutationOptions(environmentId, queryClient));
  const isPending = createBox.isPending;
  const normalizedName = normalizeUnoBoxName(name);
  const canSubmit = !disabled && !isPending && environmentId !== null && normalizedName.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    setProgress(null);
    try {
      const result = await createBox.mutateAsync({
        name: normalizedName,
        preset,
        onStatus: setProgress,
      });
      await onCreated(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the box.");
    } finally {
      setProgress(null);
    }
  }, [canSubmit, createBox, normalizedName, onCreated, preset]);

  const progressLabel = progress
    ? (progress.message ?? describeUnoBoxCreateJobState(progress.state))
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="uno-box-name" className="text-xs text-muted-foreground">
          Box name
        </Label>
        <Input
          id="uno-box-name"
          value={name}
          maxLength={UNO_BOX_NAME_MAX_LENGTH}
          placeholder="my-app"
          disabled={disabled || isPending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSubmit();
          }}
        />
        {name.trim().length > 0 && normalizedName !== name.trim() ? (
          <p className="text-[11px] text-muted-foreground">
            Will be created as <span className="font-medium">{normalizedName || "—"}</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Size</span>
        <div className="grid grid-cols-2 gap-2">
          {PRESET_ORDER.map((option) => {
            const spec = UNO_BOX_SIZE_PRESETS[option];
            const selected = preset === option;
            return (
              <button
                key={option}
                type="button"
                disabled={disabled || isPending}
                aria-pressed={selected}
                onClick={() => setPreset(option)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                  selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
                )}
              >
                <span className="block text-sm font-medium text-foreground">{spec.label}</span>
                <span className="block text-[11px] text-muted-foreground">{spec.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      {progressLabel ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
          <RefreshCwIcon className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{progressLabel}</span>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive text-xs">
          {error}
        </div>
      ) : null}

      <Button
        size="sm"
        disabled={!canSubmit}
        onClick={() => {
          void handleSubmit();
        }}
      >
        {isPending ? (
          <RefreshCwIcon className="size-3.5 animate-spin" />
        ) : (
          <ServerIcon className="size-3.5" />
        )}
        {isPending ? "Creating…" : submitLabel}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        A new box is billed to your Uno account from the moment it starts.
      </p>
    </div>
  );
}

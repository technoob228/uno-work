/**
 * "Create a new box" — shared by the add-environment modal and the
 * "Move to a box…" dialog.
 *
 * Creating a box is billable, so the submit path is guarded twice: the button
 * is disabled while the mutation is pending, and the mutation itself is keyed
 * per environment so two mounted copies of this component cannot both fire.
 *
 * What a person sees: three steps (Creating your computer… → Starting… →
 * Connecting…). Once the box exists it is never reported as "failed" just
 * because it is slow: the section switches to "Still starting — we'll keep
 * trying", retries on its own, and offers "Try again now". The box is already
 * on the account list (and billed) at that point, and the list is refreshed as
 * soon as the box appears so it shows up in My machines right away.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import { describeMachineError } from "../machineErrors";
import {
  UNO_BOX_CREATE_STAGES,
  UNO_BOX_NAME_MAX_LENGTH,
  UNO_BOX_SIZE_PRESETS,
  normalizeUnoBoxName,
  type CreateUnoBoxResult,
  type UnoBoxSizePreset,
} from "../unoBoxCreation";
import { MachineErrorNotice } from "./machines/MachineErrorNotice";
import { MachineProgressSteps } from "./machines/MachineProgressSteps";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useCreateUnoBoxFlow } from "./useCreateUnoBoxFlow";

const PRESET_ORDER: ReadonlyArray<UnoBoxSizePreset> = ["medium"];

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
  submitLabel = "Create computer",
  onCreated,
  disabled = false,
}: CreateUnoBoxSectionProps) {
  const [name, setName] = useState(() => normalizeUnoBoxName(defaultName ?? ""));
  const [preset, setPreset] = useState<UnoBoxSizePreset>("medium");
  const flow = useCreateUnoBoxFlow(environmentId, onCreated);
  const { stage, error, stillStarting, retrying, isPending } = flow;
  const normalizedName = normalizeUnoBoxName(name);
  const canSubmit =
    !disabled &&
    !isPending &&
    stillStarting === null &&
    environmentId !== null &&
    normalizedName.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await flow.submit({ name: normalizedName, preset });
  };

  const stepStage = stage === "retrying" ? "connecting" : stage;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="uno-box-name" className="text-xs text-muted-foreground">
          Computer name
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
        {PRESET_ORDER.length === 1 ? (
          <p className="text-sm text-foreground">{UNO_BOX_SIZE_PRESETS[preset].description}</p>
        ) : (
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
                  <span className="block text-[11px] text-muted-foreground">
                    {spec.description}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {stepStage ? (
        <MachineProgressSteps
          steps={UNO_BOX_CREATE_STAGES}
          current={stepStage}
          note={stage === "retrying" ? "Still starting — trying again…" : null}
        />
      ) : null}

      {stillStarting && !retrying ? (
        <MachineErrorNotice
          tone="warning"
          human={{
            title: "Still starting, we'll keep trying",
            message: `${stillStarting.name} is created and already in your machines list. It is taking longer than usual to answer; we'll connect as soon as it does.`,
            details:
              stillStarting.lastError != null
                ? describeMachineError(stillStarting.lastError).details
                : null,
            transient: true,
          }}
          action={
            <Button
              size="xs"
              variant="outline"
              data-testid="still-starting-retry"
              onClick={flow.retryNow}
            >
              <RefreshCwIcon className="size-3" />
              Try again now
            </Button>
          }
        />
      ) : null}

      {error ? <MachineErrorNotice error={error} /> : null}

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
        {flow.creating ? "Creating…" : retrying ? "Connecting…" : submitLabel}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        A new computer is billed to your Uno account from the moment it starts.
      </p>
    </div>
  );
}

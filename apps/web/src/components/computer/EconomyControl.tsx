/**
 * Economy mode switch for one computer: "Economy — runs only when needed".
 * Shown on the computer screen and in the machine's settings, only when the
 * console offers economy mode for this computer (`box.economy` present).
 */
import type { EnvironmentId, UnoComputerEconomy } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LeafIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { computerEconomyMutationOptions, computerStateQueryOptions } from "./computerQueries";
import {
  ECONOMY_IDLE_CHOICES,
  economyChip,
  economyDescription,
  economyStatusLine,
  idleLabel,
} from "./economyModel";

const CHIP_TONE: Record<string, string> = {
  awake: "bg-success/12 text-success ring-success/30",
  sleeping: "bg-info/12 text-info ring-info/30",
  waking: "animate-pulse bg-warning/12 text-warning ring-warning/30",
  off: "bg-muted text-muted-foreground ring-border",
};

/** "Economy · awake" — the small pill next to the power state. */
export function EconomyChip({ economy }: { readonly economy: UnoComputerEconomy | undefined }) {
  const chip = economyChip(economy);
  if (!chip) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        CHIP_TONE[chip.tone],
      )}
      title="Economy mode: runs only when needed"
    >
      <LeafIcon className="size-3" aria-hidden />
      {chip.label}
    </span>
  );
}

export function useComputerEconomy(environmentId: EnvironmentId | null, boxId: number | null) {
  const queryClient = useQueryClient();
  const state = useQuery(computerStateQueryOptions(environmentId, boxId));
  const mutation = useMutation(computerEconomyMutationOptions(environmentId, boxId, queryClient));
  const economy = state.data?.box?.economy;
  return { economy, mutation };
}

/** The card: switch, timer, one line of what is happening now. */
export function EconomyCard({
  environmentId,
  boxId,
  className,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly boxId: number | null;
  readonly className?: string;
}) {
  const { economy, mutation } = useComputerEconomy(environmentId, boxId);
  if (!economy) return null;
  const status = economyStatusLine(economy);
  const choices = ECONOMY_IDLE_CHOICES.includes(economy.idleTimeoutS)
    ? ECONOMY_IDLE_CHOICES
    : [...ECONOMY_IDLE_CHOICES, economy.idleTimeoutS].toSorted((a, b) => a - b);
  return (
    <section
      className={cn("rounded-2xl border border-border/60 bg-card/40 p-4 sm:p-5", className)}
      aria-label="Economy mode"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success/12 text-success">
          <LeafIcon className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Economy — runs only when needed</h2>
            <EconomyChip economy={economy} />
          </div>
          <p className="text-xs text-muted-foreground">{economyDescription(economy)}</p>
          {status ? <p className="text-xs text-foreground/80">{status}</p> : null}
          {mutation.error instanceof Error ? (
            <p className="text-xs text-destructive" role="alert">
              {mutation.error.message}
            </p>
          ) : null}
        </div>
        <Switch
          aria-label="Economy mode"
          checked={economy.enabled}
          disabled={economy.locked || mutation.isPending}
          onCheckedChange={(checked: boolean) => mutation.mutate({ enabled: checked })}
        />
      </div>
      {economy.enabled ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>Sleep after</span>
          <Select
            value={String(economy.idleTimeoutS)}
            onValueChange={(value) => {
              const seconds = Number(value);
              if (Number.isFinite(seconds)) mutation.mutate({ idleTimeoutS: seconds });
            }}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Sleep after">
              <SelectValue>{idleLabel(economy.idleTimeoutS)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choices.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {idleLabel(seconds)}
                  {seconds === economy.defaultIdleTimeoutS ? " (default)" : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <span>without use</span>
        </div>
      ) : null}
    </section>
  );
}

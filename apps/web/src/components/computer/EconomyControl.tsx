/**
 * Economy mode for one computer: "Economy — runs only when needed".
 *
 * - `EconomyLine` — the quiet one-liner in the computer menu (Home's header):
 *   leaf, "Economy: on · sleeps after 10 min idle, wakes in ~1 s", an (i)
 *   that unfolds how it works (and how sleeping earns Boost hours), the switch.
 *   Economy is good for Uno and on by default: the person should notice it
 *   and think "ah, ok" — not be greeted by it.
 * - `EconomyCard` — the full card in the machine's settings.
 *
 * Only when the console offers economy mode for this computer (`box.economy`).
 */
import type { EnvironmentId, UnoComputerEconomy } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoIcon, LeafIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useBoostWording } from "../myuno/usePlanView";
import { economyEarnSentence } from "./boostModel";
import { computerEconomyMutationOptions, computerStateQueryOptions } from "./computerQueries";
import {
  ECONOMY_IDLE_CHOICES,
  economyChip,
  economyDescription,
  economyShortExplain,
  economyStatusLine,
  economySummary,
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
  const boost = state.data?.linked ? state.data?.box?.boost : undefined;
  const wording = useBoostWording();
  return { economy, boost, wording, mutation };
}

/** "Sleep after [10 minutes] without use". */
function SleepAfterSelect({
  economy,
  onPick,
}: {
  readonly economy: UnoComputerEconomy;
  readonly onPick: (seconds: number) => void;
}) {
  const choices = ECONOMY_IDLE_CHOICES.includes(economy.idleTimeoutS)
    ? ECONOMY_IDLE_CHOICES
    : [...ECONOMY_IDLE_CHOICES, economy.idleTimeoutS].toSorted((a, b) => a - b);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Sleep after</span>
      <Select
        value={String(economy.idleTimeoutS)}
        onValueChange={(value) => {
          const seconds = Number(value);
          if (Number.isFinite(seconds)) onPick(seconds);
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
  );
}

/** The quiet line in the computer menu; renders nothing when economy isn't offered. */
export function EconomyLine({
  environmentId,
  boxId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly boxId: number | null;
}) {
  const { economy, boost, wording, mutation } = useComputerEconomy(environmentId, boxId);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const summary = economySummary(economy);
  if (!economy || !summary) return null;
  const earn = economyEarnSentence(boost, wording);
  const status = economyStatusLine(economy);
  return (
    <div className="flex flex-col gap-1.5" data-testid="economy-line">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <LeafIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{summary}</span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label="How economy works"
          title="How economy works"
          className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <InfoIcon className="size-3.5" />
        </button>
        <Switch
          aria-label="Economy mode"
          checked={economy.enabled}
          disabled={economy.locked || mutation.isPending}
          onCheckedChange={(checked: boolean) => mutation.mutate({ enabled: checked })}
        />
      </div>
      {/* Always visible: what the switch does (the full story is behind "i"). */}
      {open ? null : (
        <p className="pl-5.5 text-[11px] leading-snug text-muted-foreground" data-testid="economy-explain">
          {economyShortExplain(economy)}
        </p>
      )}
      {open ? (
        <div id={detailsId} className="flex flex-col gap-1.5 pl-5.5 text-xs text-muted-foreground">
          <p>{economyDescription(economy)}</p>
          {earn ? <p>{earn}</p> : null}
          {status ? <p className="text-foreground/80">{status}</p> : null}
          {economy.enabled ? (
            <SleepAfterSelect
              economy={economy}
              onPick={(seconds) => mutation.mutate({ idleTimeoutS: seconds })}
            />
          ) : null}
        </div>
      ) : null}
      {mutation.error instanceof Error ? (
        <p className="pl-5.5 text-xs text-destructive" role="alert">
          {mutation.error.message}
        </p>
      ) : null}
    </div>
  );
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
  const { economy, boost, wording, mutation } = useComputerEconomy(environmentId, boxId);
  if (!economy) return null;
  const status = economyStatusLine(economy);
  const earn = economyEarnSentence(boost, wording);
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
          {earn ? <p className="text-xs text-muted-foreground">{earn}</p> : null}
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
        <div className="mt-3 flex justify-end">
          <SleepAfterSelect
            economy={economy}
            onPick={(seconds) => mutation.mutate({ idleTimeoutS: seconds })}
          />
        </div>
      ) : null}
    </section>
  );
}

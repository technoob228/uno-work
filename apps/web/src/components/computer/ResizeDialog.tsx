/**
 * "Add memory / cores": pick a bigger size for this computer and it grows.
 *
 * Choices are the sizes the plan allows plus a couple past it; the server
 * (control plane) decides. When it says the plan doesn't go that far, the
 * dialog turns into "Your plan goes up to …" with Upgrade plan (console
 * billing) — nothing here works around the plan.
 */
import type { EnvironmentId, UnoComputerResizeResult, UnoComputerShape } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
  CpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { ensureEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { formatGb, formatMemory } from "./computerFormat";
import { computerQueryKeys } from "./computerQueries";
import { coreChoices, diskChoices, ramChoices, resizeEffect, type SizeChoice } from "./resizeModel";

function ChoiceRow({
  icon,
  label,
  choices,
  value,
  format,
  onPick,
}: {
  icon: React.ReactNode;
  label: string;
  choices: ReadonlyArray<SizeChoice>;
  value: number;
  format: (value: number) => string;
  onPick: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onPick(choice.value)}
              className={cn(
                "relative rounded-lg px-3 py-1.5 text-xs tabular-nums ring-1 transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-primary text-primary-foreground ring-primary"
                  : "bg-background ring-border hover:bg-accent",
                choice.abovePlan && !selected && "text-muted-foreground",
              )}
              title={choice.abovePlan ? "Needs a bigger plan" : undefined}
            >
              {format(choice.value)}
              {choice.abovePlan ? (
                <SparklesIcon
                  className="ml-1 inline size-3 align-[-1px] opacity-70"
                  aria-label="bigger plan"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ResizeDialog({
  environmentId,
  boxId,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId | null;
  boxId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: ["uno-computer", "resize-options", environmentId, boxId],
    queryFn: () =>
      ensureEnvironmentApi(environmentId!).unoComputer.resizeOptions(
        boxId === null ? {} : { boxId },
      ),
    enabled: open && environmentId !== null,
  });
  const current = options.data?.current ?? null;
  const max = options.data?.max ?? null;
  const [shape, setShape] = useState<UnoComputerShape | null>(null);
  const [result, setResult] = useState<UnoComputerResizeResult | null>(null);
  /** What the submitted change does — fixed at submit, the size refetches after. */
  const [appliedEffect, setAppliedEffect] = useState<"live" | "restart">("live");

  useEffect(() => {
    if (!open) {
      setResult(null);
      setShape(null);
    }
  }, [open]);
  useEffect(() => {
    if (open && current && shape === null) setShape(current);
  }, [current, open, shape]);

  const resize = useMutation({
    mutationFn: (next: UnoComputerShape) =>
      ensureEnvironmentApi(environmentId!).unoComputer.resize({
        ...(boxId === null ? {} : { boxId }),
        ...next,
      }),
    onSuccess: (answer) => {
      setResult(answer);
      if (answer.outcome === "resized") {
        void queryClient.invalidateQueries({ queryKey: computerQueryKeys.all });
      }
    },
  });

  const effect = current && shape ? resizeEffect(current, shape) : "none";
  const planLimit = result?.outcome === "plan_limit" ? result : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        {planLimit ? (
          <PlanLimitScreen
            result={planLimit}
            onBack={() => setResult(null)}
            onClose={() => onOpenChange(false)}
          />
        ) : result?.outcome === "resized" ? (
          <>
            <DialogHeader>
              <DialogTitle>Your computer is bigger now</DialogTitle>
              <DialogDescription>
                {result.shape
                  ? `${formatMemory(result.shape.ramMb)} of memory · ${result.shape.vcpu} ${result.shape.vcpu === 1 ? "core" : "cores"} · ${formatGb(result.shape.diskGb)} disk.`
                  : null}{" "}
                {appliedEffect === "restart"
                  ? "It is restarting to use the new cores — about a minute. This screen reconnects by itself."
                  : "It keeps running; the new size is already in use."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add memory or cores</DialogTitle>
              <DialogDescription>
                Pick a bigger size. You pay for the new size only while the computer runs.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-5">
              {options.isPending ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-14 w-full rounded-xl" />
                  <Skeleton className="h-14 w-full rounded-xl" />
                  <Skeleton className="h-14 w-full rounded-xl" />
                </div>
              ) : options.data?.availability !== "ok" || !current || !max || !shape ? (
                <p className="text-sm text-muted-foreground">
                  {options.data?.message ?? "Can't read this computer's size right now."}
                </p>
              ) : (
                <>
                  <ChoiceRow
                    icon={<MemoryStickIcon />}
                    label="Memory"
                    choices={ramChoices(current.ramMb, max.ramMb)}
                    value={shape.ramMb}
                    format={formatMemory}
                    onPick={(ramMb) => setShape({ ...shape, ramMb })}
                  />
                  <ChoiceRow
                    icon={<CpuIcon />}
                    label="Processor cores"
                    choices={coreChoices(current.vcpu, max.vcpu)}
                    value={shape.vcpu}
                    format={(v) => String(v)}
                    onPick={(vcpu) => setShape({ ...shape, vcpu })}
                  />
                  <ChoiceRow
                    icon={<HardDriveIcon />}
                    label="Disk"
                    choices={diskChoices(current.diskGb, max.diskGb)}
                    value={shape.diskGb}
                    format={formatGb}
                    onPick={(diskGb) => setShape({ ...shape, diskGb })}
                  />
                  <p className="rounded-xl bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                    {effect === "restart"
                      ? "New cores need a restart: the computer restarts by itself — about a minute. Your files and apps stay; this screen reconnects."
                      : effect === "live"
                        ? "Memory and disk are added while the computer keeps running. A very large jump in memory may still restart it for a minute."
                        : "This is the current size. Pick something bigger."}{" "}
                    Disk can only grow.
                    {options.data.planName ? (
                      <>
                        {" "}
                        Sizes marked <SparklesIcon className="inline size-3 align-[-1px]" /> need a
                        bigger plan than {options.data.planName}.
                      </>
                    ) : null}
                  </p>
                  {result ? (
                    <p className="text-xs text-destructive" role="alert">
                      {result.message}
                    </p>
                  ) : null}
                  {resize.error ? (
                    <p className="text-xs text-destructive" role="alert">
                      {resize.error instanceof Error ? resize.error.message : "Couldn't resize."}
                    </p>
                  ) : null}
                </>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={effect === "none" || resize.isPending || !shape}
                onClick={() => {
                  if (!shape) return;
                  setAppliedEffect(effect === "restart" ? "restart" : "live");
                  resize.mutate(shape);
                }}
              >
                {resize.isPending ? <Spinner className="size-3.5" /> : null}
                {effect === "restart" ? "Resize and restart" : "Resize"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function PlanLimitScreen({
  result,
  onBack,
  onClose,
}: {
  result: UnoComputerResizeResult;
  onBack: () => void;
  onClose: () => void;
}) {
  const limit = result.limit;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8">
          {limit
            ? `On your plan, a computer goes up to ${formatMemory(limit.ramMb)} and ${limit.vcpu} ${limit.vcpu === 1 ? "core" : "cores"}`
            : "That's bigger than your plan allows"}
        </DialogTitle>
        <DialogDescription>
          {result.message}
          {result.planName ? ` You're on ${result.planName}.` : ""} A bigger plan gives your
          computer more room.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {limit ? (
          <ul className="grid grid-cols-3 gap-2 text-center text-xs">
            <li className="rounded-xl bg-muted/40 px-2 py-3">
              <div className="text-base font-semibold tabular-nums">
                {formatMemory(limit.ramMb)}
              </div>
              <div className="text-muted-foreground">memory</div>
            </li>
            <li className="rounded-xl bg-muted/40 px-2 py-3">
              <div className="text-base font-semibold tabular-nums">{limit.vcpu}</div>
              <div className="text-muted-foreground">cores</div>
            </li>
            <li className="rounded-xl bg-muted/40 px-2 py-3">
              <div className="text-base font-semibold tabular-nums">{formatGb(limit.diskGb)}</div>
              <div className="text-muted-foreground">disk on the plan</div>
            </li>
          </ul>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Pick a smaller size
        </Button>
        <Button
          render={<a href={result.upgradeUrl} target="_blank" rel="noopener noreferrer" />}
          onClick={onClose}
        >
          Upgrade plan
          <ArrowUpRightIcon />
        </Button>
      </DialogFooter>
    </>
  );
}

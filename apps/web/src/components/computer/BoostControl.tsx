/**
 * "Boost ×2 for 1 hour" next to "Add memory": the button (greyed out with the
 * reason when Uno can't boost), the honest confirm — the computer restarts
 * twice — and, while boosted, a pill with the time left and "End boost".
 */
import { useNavigate } from "@tanstack/react-router";
import { RocketIcon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  BOOST_NO_HOURS_REASON,
  BOOST_RESTART_WARNING,
  boostConfirmCopy,
  boostDisabledReason,
  boostPillLabel,
} from "./boostModel";
import type { ComputerBoostControls } from "./useComputerBoost";

/** Ticks the countdown; a boost is counted in minutes, so a few seconds is plenty. */
function useNow(active: boolean, everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

export function BoostControl({
  controls,
  size = "sm",
}: {
  controls: ComputerBoostControls;
  size?: "sm" | "xs";
}) {
  const { boost, state } = controls;
  const [confirm, setConfirm] = useState<"start" | "end" | null>(null);
  const now = useNow(state === "active");
  const copy = boostConfirmCopy(boost);
  const disabledReason = state === "off" ? boostDisabledReason(boost) : null;
  const navigate = useNavigate();
  // A plan without boost hours: the button stays (greyed) as a pointer to a bigger plan.
  const seePlans =
    disabledReason === BOOST_NO_HOURS_REASON ? (
      <Button
        size={size}
        variant="link"
        className="px-1"
        onClick={() => void navigate({ to: "/my-uno", search: { tab: "billing" } })}
      >
        See plans
      </Button>
    ) : null;

  const body =
    state === "off" ? (
      disabledReason ? (
        <TooltipProvider delay={0} closeDelay={0}>
          <Tooltip>
            <TooltipTrigger
              render={<span tabIndex={0} className="inline-flex rounded-md outline-hidden" />}
            >
              <Button size={size} variant="outline" disabled aria-label="Boost ×2 for 1 hour">
                <ZapIcon />
                Boost ×2 for 1 hour
              </Button>
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-64">
              {disabledReason}
            </TooltipPopup>
          </Tooltip>
          {seePlans}
        </TooltipProvider>
      ) : (
        <Button
          size={size}
          variant="outline"
          disabled={controls.busy}
          onClick={() => {
            controls.clearError();
            setConfirm("start");
          }}
        >
          <ZapIcon />
          Boost ×2 for 1 hour
        </Button>
      )
    ) : (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span
          role="status"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1",
            state === "active"
              ? "bg-primary/10 text-primary ring-primary/30"
              : "bg-warning/10 text-foreground ring-warning/30",
          )}
        >
          {state === "active" ? (
            <RocketIcon className="size-3.5" />
          ) : (
            <Spinner className="size-3.5" />
          )}
          <span className="tabular-nums">{boostPillLabel(state, boost.endsAt, now)}</span>
        </span>
        {state === "active" ? (
          <Button
            size={size}
            variant="ghost"
            disabled={controls.busy}
            onClick={() => {
              controls.clearError();
              setConfirm("end");
            }}
          >
            End boost
          </Button>
        ) : null}
      </span>
    );

  return (
    <>
      {body}
      {controls.error ? (
        <p className="basis-full text-right text-xs text-destructive" role="alert">
          {controls.error}
        </p>
      ) : null}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup>
          {confirm === "end" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>End boost now?</AlertDialogTitle>
              <AlertDialogDescription>{BOOST_RESTART_WARNING}</AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.body}</AlertDialogDescription>
              <AlertDialogDescription className="text-foreground/80">
                {copy.allowance}
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (confirm === "start") controls.start();
                if (confirm === "end") controls.end();
                setConfirm(null);
              }}
            >
              {confirm === "end" ? "End boost" : copy.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

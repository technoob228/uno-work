/**
 * "This computer" — Uno Work as the screen of the user's computer.
 *
 * One page, desktop-like rather than admin-like: who the computer is and
 * whether it's on (hero), how hard it's working (Monitor), what's installed and
 * a one-click catalog (Apps), what it's doing right now (activity), and a
 * closed "For engineers" door. Everything is read through this environment's
 * daemon (`uno.computer.*`), which talks to the Uno cloud on the computer's
 * behalf; the browser never holds the account key.
 *
 * On a laptop daemon (not an Uno computer) the page offers the account's
 * computers to look at instead of pretending the laptop is one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MonitorIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { ComputerActivityCard } from "./ComputerActivityCard";
import { ComputerAppsCard } from "./ComputerAppsCard";
import { ComputerEngineersDoor } from "./ComputerEngineersDoor";
import { ComputerHero } from "./ComputerHero";
import { ComputerMonitorCard } from "./ComputerMonitorCard";
import { computerPowerState } from "./computerFormat";
import {
  computerActivityQueryOptions,
  computerAppsQueryOptions,
  computerMetricsQueryOptions,
  computerPowerMutationOptions,
  computerQueryKeys,
  computerStateQueryOptions,
} from "./computerQueries";
import { useAppInstalls } from "./useAppInstalls";

export function ComputerView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const queryClient = useQueryClient();
  /** Only set when the daemon is not an Uno computer and the user picked one. */
  const [pickedBoxId, setPickedBoxId] = useState<number | null>(null);

  const stateQuery = useQuery(computerStateQueryOptions(environmentId, pickedBoxId));
  const computer = stateQuery.data;
  const box = computer?.box ?? null;
  const power = computerPowerState(box?.status);
  const hasBox = box !== null;

  const metricsQuery = useQuery(computerMetricsQueryOptions(environmentId, pickedBoxId, hasBox));
  const activityQuery = useQuery(computerActivityQueryOptions(environmentId, pickedBoxId, hasBox));
  const appsQuery = useQuery(computerAppsQueryOptions(environmentId, pickedBoxId, hasBox));

  const powerMutation = useMutation(
    computerPowerMutationOptions(environmentId, pickedBoxId, queryClient),
  );
  const installs = useAppInstalls({
    environmentId,
    boxId: pickedBoxId,
    inFlight: appsQuery.data?.installed.apps ?? [],
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: computerQueryKeys.all });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <MonitorIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">This computer</span>
            {pickedBoxId !== null ? (
              <Button size="xs" variant="ghost" onClick={() => setPickedBoxId(null)}>
                Choose another
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={refresh} aria-label="Refresh">
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
            {stateQuery.isPending ? (
              <>
                <Skeleton className="h-40 w-full rounded-3xl" />
                <div className="grid gap-5 md:grid-cols-2">
                  <Skeleton className="h-56 rounded-2xl" />
                  <Skeleton className="h-56 rounded-2xl" />
                </div>
              </>
            ) : stateQuery.isError ? (
              <Notice title="This screen can't reach your computer right now">
                {stateQuery.error instanceof Error ? stateQuery.error.message : null} It will try
                again by itself.
              </Notice>
            ) : !computer?.linked ? (
              <Notice title="Connect your Uno account">
                This screen shows your computer in the Uno cloud — whether it&apos;s on, how busy it
                is and which apps it runs. Add your Uno account key in{" "}
                <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                  Settings
                </Link>{" "}
                to see it here.
              </Notice>
            ) : box === null && computer.error && computer.candidates.length === 0 ? (
              <Notice title="This screen can't reach your computer right now">
                {computer.error}
              </Notice>
            ) : box === null ? (
              <ComputerPicker
                candidates={computer.candidates}
                error={computer.error}
                onPick={setPickedBoxId}
              />
            ) : (
              <>
                <ComputerHero
                  box={box}
                  own={computer.own}
                  pendingAction={
                    powerMutation.isPending ? (powerMutation.variables?.action ?? null) : null
                  }
                  powerError={
                    powerMutation.error instanceof Error ? powerMutation.error.message : null
                  }
                  onPower={(action) => powerMutation.mutate({ action })}
                />
                <div className="grid gap-5 md:grid-cols-2">
                  <ComputerMonitorCard
                    metrics={metricsQuery.data}
                    loading={metricsQuery.isPending}
                    diskGbFallback={box.diskGb}
                  />
                  <ComputerAppsCard
                    apps={appsQuery.data}
                    loading={appsQuery.isPending}
                    installs={installs.installs}
                    starting={installs.starting}
                    startError={installs.startError}
                    computerOn={power === "on"}
                    onInstall={installs.install}
                    onDismissInstall={installs.dismiss}
                    onClearStartError={installs.clearStartError}
                  />
                </div>
                <ComputerActivityCard
                  activity={activityQuery.data}
                  loading={activityQuery.isPending}
                />
                <ComputerEngineersDoor box={box} />
              </>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-border/60 bg-card/40 p-7">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <MonitorIcon className="size-6" />
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function ComputerPicker({
  candidates,
  error,
  onPick,
}: {
  candidates: ReadonlyArray<{ id: number; name: string; status: string }>;
  error: string | null;
  onPick: (boxId: number) => void;
}) {
  return (
    <Notice title="This machine isn't an Uno computer">
      {error ??
        (candidates.length > 0
          ? "It runs Uno Work on its own hardware. Pick one of your Uno computers to look at:"
          : "It runs Uno Work on its own hardware, and your account has no Uno computers yet.")}
      {candidates.length > 0 ? (
        <span className="mt-4 flex flex-wrap gap-2">
          {candidates.map((candidate) => (
            <Button
              key={candidate.id}
              size="sm"
              variant="outline"
              onClick={() => onPick(candidate.id)}
            >
              <MonitorIcon />
              {candidate.name}
              <span className="text-muted-foreground">
                · {computerPowerState(candidate.status) === "on" ? "on" : candidate.status}
              </span>
            </Button>
          ))}
        </span>
      ) : null}
    </Notice>
  );
}

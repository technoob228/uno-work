/**
 * "Update everything": one list of the person's computers, one button.
 * What each computer needs comes from the computer itself, so a row is true
 * until the moment it runs; a computer that's asleep wakes up to answer.
 */
import {
  CheckIcon,
  HourglassIcon,
  MonitorIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { SELF_UPDATE_COPY, type SelfUpdateWhen } from "../selfUpdate/selfUpdate";
import {
  planCount,
  planNeedsWork,
  planRowSummary,
  planStoppedChats,
  planWaitableAgents,
  runUpdatePlan,
  type PlanRow,
  type RowProgress,
} from "./updateEverything.logic";
import { useUpdateEverything } from "./useUpdateEverything";

const COPY = {
  title: "Update everything",
  description: "Uno Work and your agents, on all your computers. Your chats and files stay.",
  time: "About two minutes a computer.",
  stopped: (count: number) =>
    `${count === 1 ? "1 chat is" : `${count} chats are`} working now. They stop once when Uno Work restarts, and you can continue them after.`,
  upToDate: "Everything is up to date.",
  keepOpen: "Keep this window open until it finishes.",
  thisApp: "This app",
  appRestarts: (version: string | null) =>
    `Uno Work${version ? ` ${version}` : ""}. Restarts when the rest is done.`,
  update: (count: number) => `Update ${count} ${count === 1 ? "item" : "items"}`,
  updating: "Updating…",
  close: "Close",
  cancel: "Not now",
  finished: "Done. Reloading…",
} as const;

function ProgressMark({ progress }: { progress: RowProgress | undefined }) {
  if (progress?.kind === "working") return <Spinner className="size-3.5" />;
  if (progress?.kind === "done") return <CheckIcon className="size-3.5 text-success" />;
  if (progress?.kind === "held") return <HourglassIcon className="size-3.5 text-muted-foreground" />;
  if (progress?.kind === "failed") {
    return <TriangleAlertIcon className="size-3.5 text-warning-foreground" />;
  }
  return <MonitorIcon className="size-3.5 text-muted-foreground" />;
}

function progressText(row: PlanRow, progress: RowProgress | undefined): string {
  switch (progress?.kind) {
    case "working":
      return `${progress.step}…`;
    case "done":
    case "held":
      return progress.note;
    case "failed":
      return progress.message;
    case "waiting":
      return "Waiting";
    default:
      return planRowSummary(row);
  }
}

function Row(props: {
  readonly label: string;
  readonly text: string;
  readonly mark: React.ReactNode;
  readonly quiet: boolean;
}) {
  return (
    <li className="flex items-start gap-2.5 py-2" data-testid="update-everything-row">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">{props.mark}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{props.label}</span>
        <span
          className={cn(
            "block text-xs break-words",
            props.quiet ? "text-muted-foreground/70" : "text-muted-foreground",
          )}
        >
          {props.text}
        </span>
      </span>
    </li>
  );
}

export function UpdateEverythingDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { rows, app, runDeps, updateApp, checking } = useUpdateEverything();
  const [progress, setProgress] = useState<ReadonlyMap<string, RowProgress>>(new Map());
  const [phase, setPhase] = useState<"plan" | "running" | "finished">("plan");
  const [appError, setAppError] = useState<string | null>(null);

  const count = planCount(rows) + (app ? 1 : 0);
  const stopped = planStoppedChats(rows);
  const waitable = planWaitableAgents(rows);

  const start = useCallback(
    async (when: SelfUpdateWhen) => {
      setPhase("running");
      const plan = rows;
      const notUpdated = new Set<string>();
      await runUpdatePlan(plan, {
        ...runDeps,
        updateWork: (environmentId) => runDeps.updateWork(environmentId, when),
        onProgress: (key, next) => {
          if (next.kind === "failed" || next.kind === "held") notUpdated.add(key);
          setProgress((current) => new Map(current).set(key, next));
        },
      });
      if (app) {
        try {
          await updateApp();
        } catch (error) {
          setAppError(error instanceof Error ? error.message : "The update didn't finish.");
        }
      }
      setPhase("finished");
      // The page came from a computer that just restarted: it needs the new one.
      const pageUpdated = plan.some(
        (row) => row.isPrimary && row.work !== null && !notUpdated.has(row.key),
      );
      if (pageUpdated && !isElectron) setTimeout(() => window.location.reload(), 1_500);
    },
    [app, rows, runDeps, updateApp],
  );

  const running = phase === "running";
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!running) props.onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="update-everything-dialog">
        <DialogHeader>
          <DialogTitle>{COPY.title}</DialogTitle>
          <DialogDescription>{COPY.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <ul className="flex flex-col divide-y divide-border/60">
            {rows.map((row) => {
              const current = progress.get(row.key);
              return (
                <Row
                  key={row.key}
                  label={row.label}
                  text={progressText(row, current)}
                  mark={<ProgressMark progress={current} />}
                  quiet={!planNeedsWork(row) && current === undefined}
                />
              );
            })}
            {app ? (
              <Row
                label={COPY.thisApp}
                text={appError ?? COPY.appRestarts(app.version)}
                mark={<RefreshCwIcon className="size-3.5 text-muted-foreground" />}
                quiet={false}
              />
            ) : null}
          </ul>
          {phase === "plan" && count > 0 ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                {COPY.time} {SELF_UPDATE_COPY.confirmSafety}
              </p>
              {waitable > 0 ? (
                <p data-testid="self-update-agents-working">
                  {SELF_UPDATE_COPY.agentsWorking(stopped)} {SELF_UPDATE_COPY.confirmBodyAgents}
                </p>
              ) : stopped > 0 ? (
                <p>{COPY.stopped(stopped)}</p>
              ) : null}
            </div>
          ) : null}
          {phase === "plan" && count === 0 && !checking ? (
            <p className="text-sm text-muted-foreground">{COPY.upToDate}</p>
          ) : null}
          {running ? <p className="text-sm text-muted-foreground">{COPY.keepOpen}</p> : null}
        </DialogPanel>
        <DialogFooter>
          {phase === "plan" ? (
            <>
              <Button
                variant={waitable > 0 ? "ghost" : "outline"}
                onClick={() => props.onOpenChange(false)}
              >
                {count > 0 ? COPY.cancel : COPY.close}
              </Button>
              {count > 0 && waitable > 0 ? (
                <>
                  <Button
                    variant="outline"
                    data-testid="self-update-confirm-now"
                    onClick={() => void start("now")}
                  >
                    {SELF_UPDATE_COPY.confirm}
                  </Button>
                  <Button
                    autoFocus
                    data-testid="self-update-confirm"
                    onClick={() => void start("after-agents")}
                  >
                    {SELF_UPDATE_COPY.updateWhenDone(waitable)}
                  </Button>
                </>
              ) : count > 0 ? (
                <Button data-testid="self-update-confirm" onClick={() => void start("now")}>
                  {COPY.update(count)}
                </Button>
              ) : null}
            </>
          ) : (
            <Button disabled={running} onClick={() => props.onOpenChange(false)}>
              {running ? COPY.updating : COPY.close}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

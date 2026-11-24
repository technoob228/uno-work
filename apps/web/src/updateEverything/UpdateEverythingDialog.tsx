/**
 * Updating Uno Work, two ways:
 *
 *   - "This computer" (the notice's Update): the computer the notice is about,
 *     plus this app when it has an update. One click, no list.
 *   - "Update everything" (Settings, or "Other computers" here): every
 *     computer on the account. The ones that are on and need an update are
 *     ticked; a sleeping one stays as it is unless the person ticks it.
 *
 * The run lives in `updateRun.ts`, not here: the window can be closed and
 * opened again without stopping it. Each computer has its own time limits
 * (updateEverything.logic.ts), so one that doesn't answer fails its own row.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CheckIcon,
  HourglassIcon,
  MonitorIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
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
  isSelectedByDefault,
  planNeedsWork,
  planRowLine,
  planRowSummary,
  planStoppedChats,
  planWaitableAgents,
  runUpdatePlan,
  type PlanRow,
  type RowProgress,
} from "./updateEverything.logic";
import {
  beginUpdateRun,
  clearUpdateRun,
  finishUpdateRun,
  reportAppError,
  reportUpdateProgress,
  useUpdateRun,
} from "./updateRun";
import { useUpdateEverything } from "./useUpdateEverything";

export const UPDATE_COPY = {
  thisTitle: "Update Uno Work",
  thisDescription: "This computer and this app. Your chats and files stay.",
  allTitle: "Update everything",
  allDescription:
    "Ticked computers update, three at a time. The ones not open here stay as they are unless you tick them.",
  time: "About two minutes.",
  stopped: (count: number) =>
    `${count === 1 ? "1 chat is" : `${count} chats are`} working now. They stop once when Uno Work restarts, and you can continue them after.`,
  upToDate: "Everything is up to date.",
  thisUpToDate: "This computer is up to date.",
  others: (count: number) =>
    count > 0
      ? `Other computers (${count} ${count === 1 ? "has" : "have"} updates)`
      : "Other computers",
  canClose: "You can close this window: the update goes on and this list keeps its result.",
  thisApp: "This app",
  appRestarts: (version: string | null) =>
    `Uno Work${version ? ` ${version}` : ""}. Restarts when the rest is done.`,
  update: (count: number) => `Update ${count} ${count === 1 ? "item" : "items"}`,
  updateThis: "Update",
  close: "Close",
  cancel: "Not now",
  result: (done: number, failed: number, held: number) =>
    [
      done > 0 ? `${done} updated` : null,
      held > 0 ? `${held} will update when their agents finish` : null,
      failed > 0 ? `${failed} not updated, see why above` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Nothing was updated.",
} as const;

function primaryFirst(rows: ReadonlyArray<PlanRow>): ReadonlyArray<PlanRow> {
  return rows.toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

function ProgressMark({ progress }: { progress: RowProgress | undefined }) {
  if (progress?.kind === "working") return <Spinner className="size-3.5" />;
  if (progress?.kind === "done") return <CheckIcon className="size-3.5 text-success" />;
  if (progress?.kind === "held")
    return <HourglassIcon className="size-3.5 text-muted-foreground" />;
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
  readonly tone?: "warning";
}) {
  return (
    <li className="flex items-start gap-2.5 py-2" data-testid="update-everything-row">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">{props.mark}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{props.label}</span>
        <span
          className={cn(
            "block text-xs break-words",
            props.tone === "warning"
              ? "text-warning-foreground"
              : props.quiet
                ? "text-muted-foreground/70"
                : "text-muted-foreground",
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
  /**
   * The computer the notice's Update is about: the dialog opens on it alone.
   * Absent: the full list (Settings → Update everything).
   */
  readonly focusEnvironmentId?: EnvironmentId | null | undefined;
}) {
  const { rows, app, runDeps, updateApp, checking } = useUpdateEverything();
  const run = useUpdateRun();
  const [scope, setScope] = useState<"this" | "all">(props.focusEnvironmentId ? "this" : "all");
  /** What the person ticked or unticked; the rest follows the defaults. */
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(new Map());

  const focusRow = useMemo(() => {
    if (!props.focusEnvironmentId) return null;
    return (
      rows.find((row) => row.environmentId === props.focusEnvironmentId) ??
      rows.find((row) => row.isPrimary) ??
      null
    );
  }, [props.focusEnvironmentId, rows]);

  const isSelected = useCallback(
    (row: PlanRow) => {
      if (!planNeedsWork(row)) return false;
      if (scope === "this") return row.key === focusRow?.key;
      return picked.get(row.key) ?? isSelectedByDefault(row);
    },
    [focusRow, picked, scope],
  );

  // The plan runs this page's computer last; the list shows it first.
  const shownRows = scope === "this" ? (focusRow ? [focusRow] : []) : primaryFirst(rows);
  const chosen = shownRows.filter(isSelected);
  const otherCount = focusRow
    ? rows.filter((row) => row.key !== focusRow.key && planNeedsWork(row) && !row.wakes).length
    : 0;
  const count = chosen.length + (app ? 1 : 0);
  const stopped = planStoppedChats(chosen);
  const waitable = planWaitableAgents(chosen);

  const start = useCallback(
    async (when: SelfUpdateWhen) => {
      const plan = chosen;
      if (!beginUpdateRun(plan, app)) return;
      const notUpdated = new Set<string>();
      await runUpdatePlan(plan, {
        ...runDeps,
        updateWork: (environmentId) => runDeps.updateWork(environmentId, when),
        onProgress: (key, next) => {
          if (next.kind === "failed" || next.kind === "held") notUpdated.add(key);
          else notUpdated.delete(key);
          reportUpdateProgress(key, next);
        },
      });
      if (app) {
        try {
          await updateApp();
        } catch (error) {
          reportAppError(error instanceof Error ? error.message : "The update didn't finish.");
        }
      }
      finishUpdateRun();
      // The page came from a computer that just restarted: it needs the new one.
      const pageUpdated = plan.some(
        (row) => row.isPrimary && row.work !== null && !notUpdated.has(row.key),
      );
      if (pageUpdated && !isElectron) setTimeout(() => window.location.reload(), 1_500);
    },
    [app, chosen, runDeps, updateApp],
  );

  const close = () => {
    // A finished run was seen; a running one goes on without the window.
    if (run.phase === "finished") clearUpdateRun();
    props.onOpenChange(false);
  };

  const inRun = run.phase !== "idle";
  const running = run.phase === "running";
  const runRows = run.rows;
  const results = [...run.progress.values()];
  const summary = UPDATE_COPY.result(
    results.filter((entry) => entry.kind === "done").length,
    results.filter((entry) => entry.kind === "failed").length,
    results.filter((entry) => entry.kind === "held").length,
  );

  const title = (inRun ? runRows.length > 1 : scope === "all")
    ? UPDATE_COPY.allTitle
    : UPDATE_COPY.thisTitle;
  const description = inRun
    ? running
      ? UPDATE_COPY.canClose
      : summary
    : scope === "this"
      ? UPDATE_COPY.thisDescription
      : UPDATE_COPY.allDescription;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="update-everything-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription data-testid="update-everything-description">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <ul className="flex flex-col divide-y divide-border/60">
            {inRun
              ? primaryFirst(runRows).map((row) => {
                  const current = run.progress.get(row.key);
                  return (
                    <Row
                      key={row.key}
                      label={row.label}
                      text={progressText(row, current)}
                      mark={<ProgressMark progress={current} />}
                      quiet={false}
                      {...(current?.kind === "failed" ? { tone: "warning" as const } : {})}
                    />
                  );
                })
              : shownRows.map((row) => {
                  const selected = isSelected(row);
                  const selectable = scope === "all" && planNeedsWork(row);
                  return (
                    <Row
                      key={row.key}
                      label={row.label}
                      text={planRowLine(row, selected)}
                      mark={
                        selectable ? (
                          <Checkbox
                            aria-label={`Update ${row.label}`}
                            data-testid="update-everything-pick"
                            checked={selected}
                            onCheckedChange={(checked) =>
                              setPicked((current) =>
                                new Map(current).set(row.key, checked === true),
                              )
                            }
                          />
                        ) : (
                          <MonitorIcon className="size-3.5 text-muted-foreground" />
                        )
                      }
                      quiet={!selected}
                    />
                  );
                })}
            {(inRun ? run.app : app) ? (
              <Row
                label={UPDATE_COPY.thisApp}
                text={
                  run.app?.error ??
                  UPDATE_COPY.appRestarts((inRun ? run.app?.version : app?.version) ?? null)
                }
                mark={<RefreshCwIcon className="size-3.5 text-muted-foreground" />}
                quiet={false}
                {...(run.app?.error ? { tone: "warning" as const } : {})}
              />
            ) : null}
          </ul>
          {!inRun && count > 0 ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                {UPDATE_COPY.time} {SELF_UPDATE_COPY.confirmSafety}
              </p>
              {waitable > 0 ? (
                <p data-testid="self-update-agents-working">
                  {SELF_UPDATE_COPY.agentsWorking(stopped)} {SELF_UPDATE_COPY.confirmBodyAgents}
                </p>
              ) : stopped > 0 ? (
                <p>{UPDATE_COPY.stopped(stopped)}</p>
              ) : null}
            </div>
          ) : null}
          {!inRun && count === 0 && !checking ? (
            <p className="text-sm text-muted-foreground">
              {scope === "this" ? UPDATE_COPY.thisUpToDate : UPDATE_COPY.upToDate}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {!inRun && scope === "this" && rows.length > 1 ? (
            <Button
              variant="link"
              className="mr-auto px-0"
              data-testid="update-everything-others"
              onClick={() => setScope("all")}
            >
              {UPDATE_COPY.others(otherCount)}
            </Button>
          ) : null}
          {!inRun ? (
            <>
              <Button variant={waitable > 0 ? "ghost" : "outline"} onClick={close}>
                {count > 0 ? UPDATE_COPY.cancel : UPDATE_COPY.close}
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
                  {scope === "this" ? UPDATE_COPY.updateThis : UPDATE_COPY.update(count)}
                </Button>
              ) : null}
            </>
          ) : (
            <Button variant={running ? "outline" : "default"} onClick={close}>
              {UPDATE_COPY.close}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
